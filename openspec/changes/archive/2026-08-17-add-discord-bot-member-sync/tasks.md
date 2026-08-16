## 1. Dependencies & Environment

- [x] 1.1 Install `discord.js` v14 (`bun add discord.js`) and confirm it resolves under ESM with the project's `tsconfig.json`
- [x] 1.2 Add `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `ATTENDANCE_CHANNEL_ID`, `DAILY_UPDATE_CHANNEL_ID`, `REMINDER_CHANNEL_ID` placeholders to `.env.example` under a `# Discord Bot` heading
- [x] 1.3 Add the same keys with real values to local `.env` (token from the Developer Portal; IDs via Discord Developer Mode → Copy ID)
- [x] 1.4 Verify in the Developer Portal that the **Server Members Intent** is enabled and the bot is invited to the guild with View Channels + Read Message History

## 2. Username Utility

- [x] 2.1 Create `src/utils/discordUsername.ts` exporting `DISCORD_USERNAME_REGEX` (`/^(?!.*\.{2})[a-z0-9_.]{2,32}$/`), `normalizeDiscordUsername(raw)`, and `isValidDiscordUsername(raw)`
- [x] 2.2 Make `normalizeDiscordUsername` trim whitespace, strip leading `@` characters, and lowercase — matching the PID reference implementation
- [x] 2.3 Sanity-check normalization and validation against the spec cases: `@Rakib_Dev ` → `rakib_dev`; accept `itzazad_`, `.rabbil`, `shahriarratul.`; reject `ab..c`, `a`, a 33-character name, `user#0000`, and any name containing a space
- [x] 2.4 Validate the regex against every synced member: 0 of 2189 live guild usernames may be rejected

## 3. Prisma Schema & Migration

- [x] 3.1 Create `prisma/schema/discord.prisma` with the `DiscordMember` model from design decision 1 (`@@map("discord_members")`, unique `discord_user_id` and `discord_username`, indexes on `discord_username` and `is_in_guild`)
- [x] 3.2 Leave `prisma/schema/auth.prisma` and `prisma/schema/user.prisma` untouched — `User` stays the admin account model
- [x] 3.3 Run `bunx prisma migrate dev --name add_discord_members` and review the generated SQL for the expected uniques and indexes
- [x] 3.4 Run `bunx prisma generate` and confirm `DiscordMember` is importable from `@generated/prisma/client`

## 4. Discord Configuration

- [x] 4.1 Create `src/config/discord.ts` that reads the five Discord env vars and validates them with Zod — non-empty token, and each ID a 17–20 digit numeric string
- [x] 4.2 On validation failure, throw or log an error naming the specific offending variable rather than a generic message
- [x] 4.3 Export the validated object from `src/config/index.ts` as `discord` so it is reachable through the existing shared config
- [x] 4.4 Expose a helper (e.g. `isDiscordConfigured()`) so startup can skip the bot cleanly when the token is absent

## 5. Bot Client Lifecycle

- [x] 5.1 Create `src/lib/discord/client.ts` exporting a single shared `Client` built with `GatewayIntentBits.Guilds` and `GatewayIntentBits.GuildMembers`
- [x] 5.2 Implement `startDiscordBot()`: skip with a warning when unconfigured, otherwise register handlers and `client.login()`, catching login rejection so it never propagates
- [x] 5.3 Wire `Events.ClientReady` to log the bot tag, fetch the configured guild, log its name and member count, then kick off the initial sync
- [x] 5.4 Log a specific, actionable message when login fails on a disabled privileged intent and when the configured guild cannot be fetched (skipping sync in the latter case)
- [x] 5.5 Wire `Events.Error` and `Events.ShardError` to log without exiting the process
- [x] 5.6 Implement `stopDiscordBot()` that destroys the client, and export a connection-state helper for the status endpoint

## 6. Member Sync Engine

- [x] 6.1 Create `src/lib/discord/member.mapper.ts` mapping a `GuildMember` to the DB payload — normalized username, `displayName`, `globalName`, `member.user.displayAvatarURL()`, `joinedAt`
- [x] 6.2 Create `src/lib/discord/member.sync.ts` with `syncGuildMembers()` that calls `guild.members.fetch()` and filters out `member.user.bot`
- [x] 6.3 Upsert **on `discordUserId`** (not username), in chunks of 200 wrapped in `prisma.$transaction([...])`
- [x] 6.4 On a chunk transaction failure, retry that chunk's members individually so one bad row does not discard the rest; log each individual failure with its member ID
- [x] 6.5 Handle P2002 on the username unique constraint by suffixing the stale row's username (`<name>#departed-<id>`) and retrying the upsert once
- [x] 6.6 Reconcile departures: one `updateMany` setting `isInGuild: false` and `leftAt` for active rows whose `discordUserId` is not in the fetched set
- [x] 6.7 **Safety guard** — skip the departure reconcile entirely and log a loud warning when the fetched non-bot count is 0 or below 50% of the currently active stored count (this is what a disabled Server Members intent looks like)
- [x] 6.8 Track module-level sync state (running flag, `startedAt`, `finishedAt`, `durationMs`, `synced`, `failed`, `markedDeparted`, `lastError`) and reject a sync request while one is already running
- [x] 6.9 Log a single summary line on completion with counts and elapsed time

## 7. Live Member Events

- [x] 7.1 Create `src/lib/discord/events/guildMemberAdd.ts` — skip bots, create or reactivate the member (clear `leftAt`, set `isInGuild: true`)
- [x] 7.2 Create `src/lib/discord/events/guildMemberRemove.ts` — mark `isInGuild: false` with `leftAt`, never delete
- [x] 7.3 Create `src/lib/discord/events/guildMemberUpdate.ts` — update `displayName` and `avatarUrl`, leaving the normalized username alone
- [x] 7.4 Create `src/lib/discord/events/userUpdate.ts` — update the normalized `discordUsername` when the account handle changes, reusing the P2002 collision handling from 6.5
- [x] 7.5 Make every handler upsert rather than update, so an event for an unknown member creates the record instead of being dropped
- [x] 7.6 Wrap each handler body in try/catch so a handler error is logged and never crashes the process
- [x] 7.7 Register all four handlers in `client.ts` using the `Events` enum, guarding that the event's guild matches `DISCORD_GUILD_ID`

## 8. Admin API Module

- [x] 8.1 Create `src/modules/discord/discord.service.ts` with `getSyncStatus()` (bot connection state, total and active member counts, last-sync summary) and `triggerSync()`, throwing `AppError` when the bot is not connected or a sync is already running
- [x] 8.2 Create `src/modules/discord/discord.controller.ts` wrapped in `catchAsync`, returning through `sendResponse`, touching no Prisma directly
- [x] 8.3 Create `src/modules/discord/discord.routes.ts` exporting `discordRouter` with `GET /sync/status` and `POST /sync`, both behind `auth(UserRole.ADMIN)`
- [x] 8.4 Register `app.use('/api/discord', discordRouter)` in `src/app.ts` above `notFoundRoute` and `errorHandler`

## 9. Server Wiring

- [x] 9.1 In `src/server.ts`, start the bot **after** `app.listen()` and without awaiting the sync, so member fetching never delays readiness
- [x] 9.2 Keep the bot start inside its own catch so a Discord failure leaves the HTTP API serving
- [x] 9.3 Add `SIGINT`/`SIGTERM` handlers that close the HTTP server, call `stopDiscordBot()`, then `prisma.$disconnect()` before exit

## 10. Verification

- [x] 10.1 `bun run lint` and `bun run build` both pass
- [x] 10.2 Start with `DISCORD_BOT_TOKEN` unset — the API serves normally and the log explains the bot was skipped
- [x] 10.3 Start with a deliberately invalid token — the error is logged, the process stays alive, and `GET /` still responds
- [x] 10.4 Start configured correctly — verify in `bunx prisma studio` that `discord_members` row count matches the guild's non-bot member count and that usernames are stored lowercase
- [x] 10.5 Call `GET /api/discord/sync/status` with an admin token and confirm the counts and last-sync summary; confirm it returns 401 without a token
- [x] 10.6 Live-event check: have a test account join and leave the guild, and confirm the row is created then flipped to `isInGuild: false` with `leftAt` set rather than deleted
- [x] 10.7 Rename a test account's Discord username and confirm the stored normalized username updates in place with no duplicate row
- [x] 10.8 Guard check: temporarily disable the Server Members intent, restart, and confirm the departure reconcile is skipped with a warning and no member is wrongly marked departed
- [x] 10.9 Add the two new endpoints to `postman-collection.json`
- [x] 10.10 Update `CLAUDE.md` with the Discord bot layout, the `DiscordMember`-vs-`User` distinction, and the required privileged intent
