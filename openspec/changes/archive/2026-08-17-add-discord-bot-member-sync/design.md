## Context

The backend today is an Express 5 + Prisma 7 API with only auth and admin-user modules. There is no Discord connection and no representation of guild members. Phase 1 of the PID roadmap adds both.

Constraints that shape the design:

- **A name collision exists.** `prisma/schema/auth.prisma` already defines `User` (table `users`) as the administrator login account, with `password`, `role`, `status`, and refresh-token relations. The PID's schema also calls its Discord-member model `User`. These are different things with different lifecycles — one is created by a seeder and logs in, the other is synced from Discord and never authenticates.
- **Scale.** The guild holds roughly 5,000 members. A full `guild.members.fetch()` is a gateway operation that streams the whole list and takes tens of seconds; naive per-member `await` writes would mean 5,000 sequential round trips.
- **Existing conventions.** ESM with `@/*` and `@generated/*` aliases, the four-file module pattern, `AppError` + central `globalErrorHandler`, `sendResponse` for every response, the shared `prisma` singleton, and split Prisma schema files picked up from the `prisma/schema/` directory.
- **Privileged intents.** `GuildMembers` is a privileged intent that must be enabled in the Developer Portal. *Verified behavior:* with it disabled, Discord rejects the gateway connection outright (`Used disallowed intents`) rather than connecting with a truncated member list — so login fails loudly and sync never runs. The truncated-fetch case is still guarded against separately, since a partial fetch from any other cause would be far more dangerous than a failed login.

## Goals / Non-Goals

**Goals:**

- A single shared, typed `discord.js` client whose lifecycle is tied to the server process but whose failures cannot take the API down.
- A `discord_members` directory in PostgreSQL that is accurate at boot and stays accurate while the process runs.
- One canonical username normalization function, used by every write path, so Phase 3's form lookup can be a plain unique-key query.
- Fail-fast, specific configuration errors — the common setup mistakes (missing token, uninvited bot, disabled intent) should each produce a message that names the fix.

**Non-Goals:**

- Message ingestion, channel open/lock scheduling, attendance endpoints, and the BullMQ reminder queue. Later phases.
- Slash commands or any interaction handling.
- Multi-guild support. Exactly one guild, from `DISCORD_GUILD_ID`.
- Sharding. Required by Discord only above 2,500 *guilds*, not members.
- Periodic scheduled re-sync. Boot sync plus live events covers Phase 1; a cron re-sync arrives with the Phase 5 scheduler.

## Decisions

### 1. New `DiscordMember` model; the admin `User` model is left alone

`discord_members` is a new table; `users` keeps its current meaning.

*Why:* The alternative — renaming the admin model to `Admin` and giving `User` to Discord members, matching the PID text literally — touches `auth.service.ts`, `auth.controller.ts`, `middlewares/auth.ts`, `user.service.ts`, the seeder, and both existing migrations, all to rename a working, tested subsystem. The two entities are genuinely different: admins have passwords and log in; Discord members never authenticate. Separate models is also safer for cascades — deleting an admin must never cascade into attendance history.

*Trade-off:* Field names diverge from the PID's schema listing. Later phases must point their `userId` foreign keys at `DiscordMember`, and the aggregation SQL in PID §11 becomes `FROM discord_members dm`.

Shape:

```prisma
model DiscordMember {
  id              String    @id @default(uuid())
  discordUserId   String    @unique @map("discord_user_id")
  discordUsername String    @unique @map("discord_username")
  displayName     String?   @map("display_name")
  globalName      String?   @map("global_name")
  avatarUrl       String?   @map("avatar_url")
  email           String?
  phone           String?
  isInGuild       Boolean   @default(true) @map("is_in_guild")
  joinedAt        DateTime? @map("joined_at")
  leftAt          DateTime? @map("left_at")
  lastSyncedAt    DateTime  @default(now()) @map("last_synced_at")
  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @updatedAt @map("updated_at")

  @@index([discordUsername])
  @@index([isInGuild])
  @@map("discord_members")
}
```

`discordUserId` is non-nullable and unique — the PID's Golden Rule 1 makes the snowflake the identity for DMs, and every row here originates from a real gateway member, so there is no reason to allow null. `email` and `phone` are present now so Phase 3's attendance form enriches a member in place without another migration.

### 2. Upsert on `discordUserId`, not on username

*Why:* Usernames are mutable — Discord's Pomelo migration lets users change their handle. The snowflake is permanent. Upserting on username, as the PID's example code does, would create a duplicate row every time someone renames, and would leave the old username squatting a unique index that the renamed user's new row cannot claim. Upserting on the snowflake makes a rename a plain field update.

*Handling the rename collision:* username has its own unique constraint, so a rename onto a username still held by a stale departed row would violate it. Sync catches P2002 on that constraint, clears the stale row's username by suffixing it (`<name>#departed-<id>`), and retries once.

### 3. Batched transactions, not per-member awaits

The fetched collection is chunked (≈200 members) and each chunk is written in one `prisma.$transaction([...upserts])`.

*Why:* 5,000 sequential awaits against a single connection is the dominant cost of the sync. Batching cuts the round trips by two orders of magnitude while keeping transaction sizes small enough not to hold locks for long. Chunk failures are caught per chunk, and on a chunk failure the members in it are retried individually so one bad row does not discard 199 good ones.

*Alternative rejected:* `createMany({ skipDuplicates: true })` is faster still, but it cannot update existing rows — it would leave display names and avatars permanently stale after the first run.

### 4. Departure by flag, not delete

Full sync collects the snowflakes it saw, then issues one `updateMany` marking every `isInGuild: true` row *not* in that set as departed.

*Why:* Attendance and daily-update rows will hold foreign keys to `discord_members`. Deleting a member who leaves would cascade away their history and corrupt every historical report. A boolean flag preserves the record, and `isInGuild` is exactly the predicate the Phase 3 verification endpoint needs.

*Note:* `updateMany` with `notIn` on a 5,000-element array is a single statement; Postgres handles it fine at this size.

### 5. Bot in the API process, started after `listen()`

`src/server.ts` connects Prisma → `app.listen()` → *then* `startDiscordBot()` without awaiting the sync.

*Why:* One deploy unit, and later phases (the attendance endpoint's live verification, the admin dashboard's reminder trigger) need in-process access to the client anyway. Starting the bot after `listen()` means the tens of seconds of member fetching never delay readiness or a container health check.

*Trade-off:* Bot and API share a process, so an API crash takes the bot with it. Acceptable at this scale, and the module boundary (`src/lib/discord/`) keeps extraction to a separate entrypoint cheap if that changes.

### 6. Sync state in memory, not the database

Last-sync outcome lives in a module-level object in `discord.sync.ts`, also serving as the concurrency guard.

*Why:* Single process, and the value is diagnostic rather than authoritative — it resets on restart, which is correct, since a restart triggers a fresh sync anyway. A `sync_logs` table is warranted once syncs are scheduled and historically auditable; that belongs with Phase 5.

### 7. `Events.*` enum and typed config, no string literals

Event names come from the `Events` enum, and Discord config is validated once into a typed object exported from `src/config/index.ts`.

*Why:* Consistent with the codebase's Zod-validated boundaries, and it turns the three classic setup failures into named startup errors instead of confusing runtime behavior.

### 8. Module layout

```
src/utils/discordUsername.ts        # DISCORD_USERNAME_REGEX, normalize, isValid
src/config/discord.ts               # validated Discord env (re-exported via config/index.ts)
src/lib/discord/client.ts           # shared Client, start/stop, ready + error wiring
src/lib/discord/member.mapper.ts    # GuildMember -> DB payload
src/lib/discord/member.sync.ts      # full sync, chunked upserts, departure reconcile
src/lib/discord/events/*.ts         # guildMemberAdd / Remove / Update, userUpdate
src/modules/discord/discord.{routes,controller,service,validation}.ts
```

The `src/modules/discord/` module follows the existing four-file pattern exactly — routes compose `auth(UserRole.ADMIN)`, the controller is wrapped in `catchAsync` and returns via `sendResponse`, the service holds all Prisma access and throws `AppError`. Sync logic lives in `src/lib/discord/` rather than the module service because the gateway event handlers need it and they are not HTTP-scoped.

## Risks / Trade-offs

- **A truncated member fetch** → the departure reconcile would mark every missing member as departed, which at full scale means wiping the active status of the entire directory in one `updateMany` and locking every student out of the attendance form. Mitigation: refuse to run the reconcile when the fetched non-bot count is 0, or under 50% of the currently active stored count, and log loudly instead. This guard matters more than any other in the change. *Both layers verified against the live guild:* disabling the Server Members intent produced a hard login rejection (sync never ran, 2188 active rows untouched), and a simulated empty fetch tripped the ratio guard with `markedDeparted: 0`.
- **Bot offline for a stretch** → members who joined and left during the outage are missed. Mitigation: boot sync fully reconciles on every restart, so the window closes at the next start.
- **Rate limits during full fetch** → discord.js queues and respects gateway limits internally; no manual throttling is needed for a single `members.fetch()`.
- **Long-running transaction on a slow database** → chunk size 200 keeps each transaction short; the value is a named constant so it can be tuned without touching logic.
- **A username fails the official regex** → *this fired in practice.* The PID's regex forbade a leading or trailing `_` / `.`, which rejected 115 of 2189 live members (5.3%): `itzazad_`, `.rabbil`, `shahriarratul.`. Snowflake timestamps show 59 of those accounts were created after Discord's Pomelo rollout, so they are current valid handles, not grandfathered legacy names — the rule was simply wrong. The regex is now `/^(?!.*\.{2})[a-z0-9_.]{2,32}$/`, which accepts all 2189 observed members while keeping the charset, length, and consecutive-period rules (the latter had zero violations). The mitigation below is what contained the damage and stays in place: store the normalized value regardless and log a warning; never drop the member, since a missing member means a student who cannot submit attendance.
- **Prisma client not regenerated** → the new model will not typecheck until `bunx prisma generate` runs. Called out in tasks and already documented in `CLAUDE.md`.

## Migration Plan

1. Create the Discord application, enable the **Server Members** privileged intent, and invite the bot to the guild with View Channels and Read Message History.
2. Add the five Discord variables to `.env`; `.env.example` ships placeholders.
3. `bunx prisma migrate dev --name add_discord_members` then `bunx prisma generate`.
4. Deploy. On boot, the log line should read `Synced N members` with N close to the guild's real member count.

**Rollback:** unset `DISCORD_BOT_TOKEN` — the bot is then skipped at startup and the API runs exactly as it does today. The `discord_members` table is additive and can be left in place; no existing table or code path is modified.

## Open Questions

- Should a member who leaves the guild still count toward "missing update" reporting in later phases? Assumed no — `isInGuild: false` excludes them from status aggregation — but this is a Phase 7 reporting decision.
- Whether the Phase 3 verification endpoint should fall back to a live `guild.members.fetch({ query })` when the DB has no match, covering the seconds-wide gap between a join and its gateway event. Deferred to Phase 3; the event listeners here make the gap small enough that a fallback is likely unnecessary.
