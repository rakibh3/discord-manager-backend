## Context

Every layer of this system was written against exactly one guild, and each layer encodes that assumption differently:

- `src/config/discord.ts` returns `{ guildId, channels: { attendance, dailyUpdate, reminder } }` — one snowflake, three channel IDs.
- `client.ts` holds `isConfiguredGuild(id)` as an equality check and `getGuild()` as a singular fetch.
- `discord_members.discord_user_id` and `.discord_username` are **globally** unique, so the same person cannot exist twice.
- `member.sync.ts` counts `where: { isInGuild: true }` across the whole table for its departure guard, and reconciles with an unscoped `updateMany`.
- `channel.state.ts` resolves one channel and returns one result.
- `announcement_logs` claims a day with `@@unique([key, announcementDate, attempt])` — one claim, one server.
- `dailyStatus.repository.ts` aggregates `FROM discord_members dm` with no server dimension at all.

The user now runs **two identical servers**: same channel names, same daily cycle, two mostly-disjoint student populations with a small overlap (moderators, a few students in both). The two must behave as one system — one open, one lock, one announcement, one broadcast, one dashboard.

The constraints that shape everything below:

1. **One bot process, one Discord rate-limit budget.** A ban earned by bursting in one server stops member sync and the attendance form for *both*. Fan-out multiplies Discord calls; nothing here may multiply DMs.
2. **Failure must not cross servers.** A missing `Manage Roles` in server B is a normal Tuesday. It must not stop server A's channel from opening.
3. **The departure guard is the most dangerous code in this change.** It already decides whether ~5,000 students can submit. Guild-scoping it wrong turns "one truncated fetch" into "every member of the *other* server is marked departed", which locks that server out of the form and empties the dashboard denominator with no error raised anywhere.
4. **Nothing may double-post or double-DM.** Fan-out is precisely the shape of change that produces two announcements in one channel and two DMs to one person.

## Goals / Non-Goals

**Goals:**

- One admin action reaches every configured server, with a per-server result the admin can read.
- Two servers cannot drift: shared settings are stored exactly once.
- A person who is in both servers gets one DM, and one attendance submission covers them in both.
- Adding a third server is an environment change and a restart, not a code change.
- The current single-server deployment keeps working through the migration and through a rollback.

**Non-Goals:**

- Per-server schedules, per-server announcement bodies, per-server mention lists. The requirement is that the servers behave identically; every one of these is a way for them to stop.
- A database-backed server registry with dashboard CRUD. Deferred, and the design keeps it reachable.
- Multiple bot tokens / multiple gateway clients. One bot, invited twice.
- Per-server admin scoping. Every `ADMIN` sees and acts on every server.
- Merging the two directory rows of a person who is in both servers into one identity. They stay two rows; the overlap is reported, not collapsed.
- Sharding. discord.js only requires it past ~2,500 guilds.

## Decisions

### The unit of scoping is the guild ID, carried on the member row

`DiscordMember` gains `guildId String @map("guild_id")`. The global uniques become:

```prisma
@@unique([guildId, discordUserId])
@@unique([guildId, discordUsername])
@@index([guildId, isInGuild])
@@index([discordUserId])          // cross-server overlap lookups
```

Everything downstream inherits the scope for free: `Attendance`, `DailyUpdate`, and `ReminderRecipient` all hang off `memberId`, so a row that points at a member row is already pointing at a server. `@@unique([memberId, attendanceDate])` therefore keeps meaning exactly what it did — one attendance per member per day — and now additionally means one per server.

*Why not a global member row with a separate `guild_memberships` join table:* that models a person who is in two servers as one identity with two memberships, which is tidier in the abstract. It is the wrong fit here. `isInGuild`, `joinedAt`, `leftAt`, `displayName`, and the tombstoned-username repair are all per-server facts that would have to move to the join table anyway, leaving `discord_members` holding an avatar URL. Attendance and daily updates would then need their own `guild_id` column to stay per-server, and every existing query would need a join it does not need today. The chosen shape is one column and two index changes; the alternative is a new table plus a `guild_id` on three more.

*Why not denormalize `guild_id` onto `attendances` and `daily_updates`:* the join to `discord_members` is already present in every query that would want it — the dashboard aggregation joins the directory to compute status, and the reminder target list starts from it. A second copy of the guild ID is a second thing that can disagree.

*Cost:* `discord_username` is no longer globally unique, so `findActiveMemberByUsername` can return more than one row. That is not a defect — Discord handles are globally unique **accounts**, so two rows with the same handle are the same person in two servers, which is exactly the fact the attendance form needs (see below).

### Servers come from parallel environment lists, validated as a unit

```
DISCORD_GUILD_IDS=111…,222…
DAILY_UPDATE_CHANNEL_IDS=333…,444…
ATTENDANCE_CHANNEL_IDS=555…,666…
REMINDER_CHANNEL_IDS=777…,888…
DISCORD_GUILD_LABELS=Batch A,Batch B     # optional, display only
```

`loadDiscordConfig()` returns `{ botToken, guilds: TGuildConfig[] }` where each entry is `{ guildId, label, channels: { attendance, dailyUpdate, reminder } }`. Validation is deliberately strict and happens once, at startup:

- every entry is a 17–20 digit snowflake (unchanged rule);
- **all four lists have the same length** — a mismatch is a refused startup naming the two lists and their counts;
- **no guild ID repeats**, and **no channel ID repeats across servers** — a copy-paste that leaves server B pointing at server A's `#attendance` would post the announcement twice into one channel and never into the other, and would look completely healthy in the logs;
- the singular `DISCORD_GUILD_ID` / `*_CHANNEL_ID` variables are accepted as a one-element list, so the current `.env` boots unchanged.

*Why positional lists over per-guild-suffixed keys* (`DAILY_UPDATE_CHANNEL_ID_111…=…`): the suffixed form is self-describing and cannot misalign, but it makes the variable names depend on data, which no `.env.example` can document and no schema can validate as a set. The positional form's one failure mode — misalignment — is fully caught by the cross-list checks above, and those checks run before the bot ever logs in.

*Why not the database registry:* deferred by decision. The shape chosen here keeps it a drop-in later: everything downstream consumes `getConfiguredGuilds(): TGuildConfig[]`, so a future registry only has to change what that function reads.

### Channel names are identical across servers, so IDs stay the source of truth — and ownership is verified at boot

The servers are clones: `#attendance`, `#daily-update`, and `#daily-update-reminder` are named identically in each. That makes name-based lookup tempting — configure three names once, resolve them per guild, and adding a server becomes a single guild ID. It is rejected, for the reason `CLAUDE.md` already gives: a channel name is mutable and non-unique. A rename, an archived duplicate, or a second channel of the same name in another category redirects or breaks the feature with nothing in the logs, and the blast radius includes the path ~5,000 students submit through.

But identical names create a hazard the ID-based configuration does not carry on its own. The four lists are positional, and the cross-list checks above catch a length mismatch, a repeated guild, and a channel ID reused across servers. **They cannot catch a swap.** If server A's slot holds server B's daily-update channel ID and B's holds A's, every list is the same length, every entry is a distinct well-formed snowflake, and no check fires. Because both channels are called `#daily-update`, the mistake is invisible to a human reading either the configuration or Discord.

A swap is silent and severe in three directions at once:

- **Ingestion** compares an incoming message's channel against the configuration of the guild it came from, so *every* message in *both* servers is ignored and every member shows `MISSING_UPDATE`.
- **The scheduler** opens and locks the wrong server's channel: one server never opens, and the other is edited twice.
- **The announcement** posts into the wrong server's channel, and because the message is identical it looks correct.

Each configured channel ID is therefore verified once, when the gateway reports ready: fetch it and assert `channel.guild.id` equals the server it was configured under. Three fetches per server, at startup only, before any of these features runs. It is the only check that can catch a swap, because no static validation of the strings can. A server that fails verification is reported and excluded exactly like an unreachable one — the others keep running.

*Why the existing check is not enough:* `channel.state.ts` already compares `channel.guild.id` against the configured guild when it resolves the daily-update channel. That stays, because it also guards a configuration reloaded at runtime. But it covers one of the three channels, it fires at 18:00 rather than at boot, and ingestion never calls it at all — so on its own it would let a swap run undetected until the evening, and would never detect it in the path that matters most.

### `getConfiguredGuilds()` is the only way to learn about servers

`client.ts` stops exposing a singular guild. It exports:

- `getConfiguredGuilds(): TGuildConfig[]` — configuration, available before login;
- `getGuildConfig(guildId): TGuildConfig | null` — the routing check that replaces `isConfiguredGuild`;
- `fetchGuild(guildId): Promise<Guild | null>` — one server's live gateway object, `null` when unreachable;
- `getReadyGuilds(): TGuildConfig[]` — the configured servers the bot is actually in, which is what fan-out iterates.

A configured guild the bot has not been invited to is logged loudly at ready, reported through `/api/discord/sync/status`, and **skipped** — not fatal. Half the program working beats none of it, and the status read is where an operator finds out.

*The gateway itself needs no change:* one client with `Guilds` + `GuildMembers` already receives events from every guild it is in. The degraded-intent retry, which rebuilds the client without `MessageContent`, is untouched and still applies to all servers at once — it is a property of the token, not of a guild.

### Fan-out is one helper with fixed semantics, not a loop written five times

`src/lib/discord/fanout.ts`:

```ts
type GuildOutcome<T> =
  | { guildId: string; label: string; ok: true; value: T }
  | { guildId: string; label: string; ok: false; error: string };

forEachGuild<T>(fn: (guild: TGuildConfig) => Promise<T>): Promise<GuildOutcome<T>[]>
```

Rules it enforces, so no caller has to remember them:

- **Sequential, not `Promise.all`.** Fan-out doubles Discord API calls; running them in parallel doubles the burst. Two servers, one request each, sequentially, is well inside any budget, and it keeps failures readable in order.
- **Every server runs.** One server's rejection is caught, recorded as `ok: false`, and the next server still runs. A `forEachGuild` that short-circuits would recreate exactly the cross-server coupling this change exists to prevent.
- **It never throws.** Callers get an array. Services turn a fully-failed array into an `AppError`; cron callbacks log it into `lastRun`.

Every fan-out endpoint answers with the same envelope inside `data`:

```json
{ "servers": [ { "guildId": "…", "label": "…", "ok": true,  "…": … },
               { "guildId": "…", "label": "…", "ok": false, "error": "Missing Permissions" } ],
  "summary": { "total": 2, "succeeded": 1, "failed": 1 } }
```

**Partial success answers 207-shaped success, not 500.** The channel *did* open in server A, and a 500 would tell the admin nothing happened. The HTTP status stays 200 with `summary.failed > 0`; only "failed everywhere" is an error status. This is stated once here and enforced in every fan-out controller.

### Shared settings stay one row; per-server outcomes get a `guild_id`

The split is: **configuration is shared, history is per server.**

- `channel_schedules` — one row, `key = 'DAILY_UPDATE'`, unchanged. One time picker drives every server.
- `announcement_templates` — one row, `key = 'ATTENDANCE_DAILY'`, unchanged. One body, one time, one mention list.
- `announcement_logs` — gains `guildId`; the claim widens to `@@unique([guildId, key, announcementDate, attempt])`.
- `reminder_logs` — **no** `guildId`. One broadcast spans every server; the per-server dimension is reachable through `reminder_recipients → discord_members.guild_id`, and the progress bar the admin watches is one bar.

*Why the announcement claim is per server and the broadcast is not:* the claim answers "has this server's channel been posted to today?" — a per-server question, and making it global would let a failure in server A silently consume server B's day. The broadcast answers "is a mass DM already running?" — a question about the bot's DM budget, which is global. Scoping the broadcast per server would let an admin start two 40-minute blasts at once, which is the exact thing the existing 409 exists to prevent.

*The announcement nonce becomes `<guildId>-<announcementDate>-<attempt>`.* Discord matches `enforceNonce` per channel, so per-day would already be sufficient, but the guild ID makes the two servers' nonces visibly distinct in logs and removes any doubt.

### The departure guard is scoped per server, and that scoping is the change's highest-risk edit

`syncGuildMembers(guild)` already takes a `Guild`. Every query inside it gains `guildId`:

- the guard's baseline becomes `count({ where: { guildId, isInGuild: true } })`;
- the reconcile becomes `updateMany({ where: { guildId, isInGuild: true, discordUserId: { notIn: fetchedIds } }, … })`;
- the upsert key becomes `where: { guildId_discordUserId: { guildId, discordUserId } }`;
- `releaseConflictingUsername` looks up `where: { guildId_discordUsername: { guildId, discordUsername } }` and tombstones only within that server.

The ratio and the zero check are unchanged; only their scope moves. **An unscoped reconcile is now catastrophic rather than merely wrong**: server A's fetch would mark every member of server B departed, and both servers' dashboards would go to zero while the form refused everybody. This is called out here, in the specs, and in the tasks because it is the one edit where a missing `where` clause produces a total outage with no error.

Sync state becomes `Record<guildId, TSyncState>`, and `/api/discord/sync/status` reports an array. `POST /sync` runs every server; an optional `guildId` body field re-syncs one.

*Related latent bug to fix while here:* `isUsernameConflict` matches on `error.meta?.target`, which `CLAUDE.md` documents as **`undefined` under `@prisma/adapter-pg`** — so the username-collision repair never actually fires today. The constraint name changes with this migration anyway, so the check moves to the documented-working form: `JSON.stringify(error.meta ?? {}).includes('discord_username')`.

### One submission covers every server the student is in

`verify-user` and `submit` both resolve a handle through one new repository function:

```ts
findActiveMembersByUsername(normalizedUsername): Promise<VerifiedMember[]>  // one row per server
```

- **`verify-user`** returns `verified: true` when the array is non-empty, plus `servers: [{ guildId, label }]` and a per-server `alreadySubmitted`. Empty array is still a 200 with `verified: false` — the read path's not-found semantics are unchanged, and the collapse of "no such handle" and "left the server" still holds, now per server.
- **`submit`** writes **one attendance row per returned member**, in a single `$transaction`. A student in both servers submits once and is present in both; a student in one is unaffected.

*Why fan out the write rather than make the student choose a server:* the form is public and holds no credential, so a server picker would have to list the servers a handle is in before the student is authenticated in any sense — leaking membership to anyone who can type a handle. It would also produce the failure this whole change exists to remove: a person marked missing in server B because they picked server A.

*Duplicate semantics.* The existing rule is "a second submission the same day is a duplicate error naming the date". With fan-out:

- **every** target already has a row → duplicate error, unchanged behaviour;
- **some** targets have a row (they joined the second server after submitting) → the missing rows are created and the response is a success naming which servers were recorded;
- P2002 inside the transaction is still detected by the documented `JSON.stringify(err.meta)` contains `attendance_date` path — the constraint name does not change.

### One DM per Discord account per broadcast, whatever the server count

The target list comes from the dashboard aggregation, which now returns one row per (server, member) — so a person missing in both servers appears twice. Left alone, the queue would DM them twice from the same bot within one broadcast. Three changes prevent it:

- **Recipient rows stay per member row.** `reminder_recipients` keeps `@@unique([reminderId, memberId])`, because the per-server audit ("was this member reminded?") must stay answerable per server, and the dashboard reads it that way.
- **Jobs are keyed on the account, not the row.** `jobId` moves from `<reminderId>__<memberId>` to `<reminderId>__<discordUserId>` — still no `:`, which BullMQ rejects. Targets are grouped by `discordUserId` before `addBulk`, so N servers produce one job.
- **One job settles every recipient row for that account.** The payload carries `{ reminderId, discordUserId, memberIds: string[] }`; the pre-send re-read checks that at least one of those rows is still `PENDING`, and the outcome write updates all of them in one `updateMany`. `targetCount` counts recipient rows (the audit truth); the queue's job count is reported separately as `uniqueRecipients`, so the two numbers differing is explained rather than looking like a bug.

The **closed-DM fallback** groups `DM_CLOSED` recipients by their member row's `guildId` and posts to *that* server's `REMINDER_CHANNEL_ID`. A member is only ever mentioned in the server they are in. `allowedMentions: { parse: [], users: [...] }` and the 50-mention chunking are unchanged — `parse: []` stays the structural guarantee that this path can never become an `@everyone`.

The drain claim (`finalizeReminderLog` as an `updateMany` scoped to `status: PROCESSING`) is unchanged and still global to the broadcast; only the fallback it triggers is now a per-server fan-out.

### The dashboard reports PEOPLE, and credits work done in any server

The unit of the dashboard is the Discord account, not the membership row. A student in both servers is one person with one day's work to do, so `dailyStatus.repository.ts` groups by `discord_user_id` and derives status from account-level facts:

- two credit sources keyed by account — everyone who submitted attendance on the date, and everyone who posted a daily update on the date — each built by joining `attendances` / `daily_updates` back to `discord_members` and keying on `discord_user_id`;
- **neither credit source is filtered by server or by `is_in_guild`.** "Posted in any server" has to mean any server. Narrowing the credit to the server being viewed would put the double obligation straight back, and would make a `guildId` filter change a person's status rather than only which people are listed;
- the main source keeps its `AND dm.guild_id = ${guildId}` filter, bound as a parameter and applied identically to the page and counts queries. It selects **who is listed**, never **what they are credited with**;
- `GROUP BY dm.discord_user_id` collapses the memberships, with `ARRAY_AGG(… ORDER BY dm.guild_id)` producing `memberIds` and `guildIds` and `[1]` picking a deterministic representative `memberId` for the detail route;
- the search filter moves from `WHERE` to `HAVING BOOL_OR(…)`. Per-server nicknames differ, and a `WHERE` would drop the non-matching membership from the person's own row — leaving `guildIds` naming one server while `serverCount` said two;
- overlap stays a correlated count, `(SELECT COUNT(*) FROM discord_members o WHERE o.discord_user_id = dm.discord_user_id AND o.is_in_guild = TRUE) AS "serverCount"` — served by the new `discord_user_id` index, and deliberately outside the grouping so a server filter narrows `guildIds` without hiding that the person is elsewhere too.

`getDailyStatusCounts` returns the seven figures for the selected scope **plus** `byServer: [{ guildId, label, …the same seven }]`, computed from the same source so they cannot drift. The two are different units on purpose: the combined figures count accounts, `byServer` counts each server's own memberships. **They do not sum**, and the gap is exactly the overlap. Both are wanted — the combined figures answer "how many students are done today", the breakdown answers "how is each server doing" with a denominator that server's admin can act on.

The sort allowlist keeps `guildId`, now pointing at the aggregated `guildIds`; it stays a closed `Prisma.sql` map, and the filter stays a bound parameter.

The reminder target query gets the same treatment: its `NOT EXISTS` is keyed by `discord_user_id` rather than `member_id`, so someone who posted in server A is not reminded on server B's behalf. It still returns one row per member record — that is what gives each server an auditable recipient row and lets the closed-DM fallback post in every server the person is in — and the queue's existing grouping by account still turns those rows into one DM.

`SORT_COLUMNS` and the header comment listing every column the raw SQL depends on both get `guild_id` added — that comment is the only compile-time protection this file has.

**The labels are not in the database.** Rows carry `guildId`; the human label comes from config at serialization time. A label is a display string, and storing it would make it a second copy that goes stale when `.env` changes.

### The window endpoint is deliberately untouched

`GET /api/attendance/window` reads the shared `channel_schedules` row and the Dhaka clock. One schedule means one window, so the answer is identical for every server and needs no server parameter. It still performs no Discord call — with two servers the live read it must not do would now be two live reads on the hottest public path in the system.

## Risks / Trade-offs

- **An unscoped `where` in the departure reconcile wipes the other server's directory** → The single highest-risk edit. Scoped in `member.sync.ts` at the guard baseline, the reconcile, the upsert key, and the tombstone lookup; called out in the spec and given its own verification task (sync server A, confirm server B's active count is unchanged).
- **A positional swap in the channel lists is invisible, because every server names its channels identically** → No static validation of the strings can catch it: the lists are the same length, every entry is a distinct well-formed snowflake, and both channels really are called `#daily-update`. The boot-time ownership check (`channel.guild.id` equals the server it was configured under, verified once at ready) exists for this case alone, and a verification task deliberately swaps two servers' daily-update IDs to confirm startup catches it rather than 18:00 doing so.
- **Migration backfill picks the wrong guild ID** → Every existing `discord_members` and `announcement_logs` row belongs to the one currently configured server. The migration writes that literal snowflake, taken from the deployed `.env`, and the task list requires reading it from the running environment rather than from a document. A wrong value orphans the entire directory from the running bot: the form refuses everyone and sync creates ~5,000 duplicate rows.
- **Dropping the global `discord_username` unique loses a real protection** → It was doing two jobs: preventing duplicate rows for one person, and backing the tombstone repair. The composite unique keeps both **within** a server, which is where handle collisions actually occur. Across servers, two rows with one handle is the correct state.
- **Fan-out doubles Discord API calls per action** → Sequential execution, unchanged per-call cost, and no new polling. The one path that must never multiply — DMs — is de-duplicated by account rather than fanned out.
- **The combined totals no longer equal the sum of `byServer`** → Deliberate, and the one invariant that looks like a bug. They are different units: `totalMembers` counts people, `byServer` counts memberships. Anyone in exactly one server contributes equally to both, so the gap between them is precisely the overlap. Stated in the API docs, in the response type, and at the top of the repository, because an admin who spots it will otherwise file it.
- **Credit is account-wide while membership is per server** → A person in two servers who posts one update is COMPLETE in both, and is not reminded at all. That is the requirement: one person, one day's work. The per-server records are unchanged and each still owns its own history — what changed is which obligations they imply, not who owns what.
- **Partial success is easy to misread as full success** → Every fan-out response carries `summary.succeeded` / `summary.failed`, and a failed server appears with its Discord error text. Status reads (`/api/schedule/daily-update`, `/api/announcement/attendance`, `/api/discord/sync/status`, `/api/reminders/status`) all report per server, so a permission gap in one server surfaces where an operator already looks.
- **`SCHEDULER_ENABLED` still gates cron per process, and now one tick does N servers' work** → Unchanged constraint, larger blast radius if two replicas run cron: two announcements per server rather than two total. Documented; the fix stays the same (move cron to BullMQ repeatable jobs).
- **`node-cron` fires one task that fans out, rather than one task per server** → Deliberate: one shared schedule must produce one firing. Per-server tasks would be N cron expressions derived from one row, and a reload that destroys some but not others leaves a task firing on a schedule no row describes.
- **Rollback after the migration is not free** → The `guild_id` column and the composite uniques are additive-then-restrictive. Rollback is documented below and is only safe while exactly one server has data.

## Migration Plan

1. **Ship the schema in two migrations, not one.**
   - `add_guild_id_nullable`: add `guild_id` to `discord_members` and `announcement_logs` as nullable; add the new indexes. Nothing breaks; the running single-server code ignores the column.
   - Backfill inside that same migration: `UPDATE discord_members SET guild_id = '<the deployed DISCORD_GUILD_ID>' WHERE guild_id IS NULL;` and the same for `announcement_logs`. The snowflake is read from the deployed environment and written literally into the SQL — a migration cannot read `.env`.
   - `enforce_guild_scope`: set both columns `NOT NULL`, drop `discord_members_discord_user_id_key` and `discord_members_discord_username_key`, add `@@unique([guildId, discordUserId])` / `@@unique([guildId, discordUsername])`, drop `announcement_logs_key_announcement_date_attempt_key` and add the guild-scoped one.
2. `bunx prisma generate`, then deploy the application. Config still accepts the singular env variables, so this step is a same-behaviour deploy that can be verified before any second server exists.
3. **Invite the bot to server B** with `Manage Roles` on `#daily-update` and `Send Messages` on `#attendance` and `#daily-update-reminder`.
4. Add the plural env variables (both servers), restart, and watch startup: the config validation output, then per-guild sync completing with a plausible member count for each, and `guardTripped: false` on both.
5. **Verify before the evening cycle:** `GET /api/discord/sync/status` shows two servers; `GET /api/schedule/daily-update` shows both channels' live state; `POST /api/schedule/daily-update/lock` then `/open` and confirm both channels move; `GET /api/announcement/attendance` shows `today.posted` per server; `GET /api/attendance/verify-user` on a handle that is in both returns both servers.
6. **Rollback.** Before step 4, redeploy the previous build — the extra column is ignored, and the composite uniques are satisfied by the single-server data. After step 4, rollback also requires deleting server B's `discord_members` rows (and their cascaded attendance rows), because the old code's global unique on `discord_username` would be violated by the overlap. Cheapest safe path once server B has real data is forward-fix, and that asymmetry is the reason step 2 is a standalone deploy.

## Open Questions

- **Does the DM text need to name the server?** One shared message today, so a person in both servers receives one generic reminder. If it turns out the two servers need to be told apart in the DM, a `{{server}}` placeholder is a small addition — but it would force the de-duplicated single DM back into one-per-server, so it needs a deliberate decision rather than a patch.
- **Should `verify-user` disclose server labels to an anonymous caller?** It currently reveals only membership. Returning `servers` reveals which server. The chosen answer is yes — the admin owns both servers, the form is theirs, and the badge is more useful for it — but it can be reduced to a count without touching the write path.
- **Announcement mention roles are guild-specific IDs in one shared list.** A role ID from server A cannot resolve in server B, so it lands in that post's `unresolvedTargets` every evening. Acceptable while the intent is "the same roles exist in both", noisy if the two servers' role sets diverge. If they do, the shared list is the first thing that should become per-server.
