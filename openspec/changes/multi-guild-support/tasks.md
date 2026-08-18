## 1. Configuration: a list of servers

- [x] 1.1 Rewrite `src/config/discord.ts` to parse the plural lists (`DISCORD_GUILD_IDS`, `DAILY_UPDATE_CHANNEL_IDS`, `ATTENDANCE_CHANNEL_IDS`, `REMINDER_CHANNEL_IDS`, optional `DISCORD_GUILD_LABELS`) into `TGuildConfig[]`, keeping `TDiscordConfig` as `{ botToken, guilds }`.
- [x] 1.2 Accept the singular `DISCORD_GUILD_ID` / `*_CHANNEL_ID` variables as a one-element list, so the current `.env` boots unchanged.
- [x] 1.3 Add the cross-list validation: equal lengths (error names both lists and their counts), no repeated guild ID, no channel ID appearing under two servers, every entry a 17–20 digit snowflake with its list position in the message.
- [x] 1.4 Update `.env.example` with the plural variables, a worked two-server example, and a note that the lists are positional.
- [x] 1.5 Verify a deliberately mismatched configuration refuses bot startup while the HTTP API still serves.
- [x] 1.6 Document in `.env.example` that the lists are **positional**, that every server names its channels identically, and that a swapped pair is therefore caught by the boot-time ownership check in 3.7 rather than by this static validation.

## 2. Schema and migration

- [x] 2.1 Add `guildId` to `DiscordMember` in `prisma/schema/discord.prisma`; replace the global `@unique` on `discordUserId` and `discordUsername` with `@@unique([guildId, discordUserId])` and `@@unique([guildId, discordUsername])`; add `@@index([guildId, isInGuild])` and `@@index([discordUserId])`.
- [x] 2.2 Add `guildId` to `AnnouncementLog` in `prisma/schema/announcement.prisma`; widen the claim to `@@unique([guildId, key, announcementDate, attempt])` and update `@@index([key, announcementDate])` to include the guild.
- [x] 2.3 Create migration `add_guild_id_nullable`: add both columns as nullable, add the new indexes, then backfill both from the **deployed** `DISCORD_GUILD_ID` written literally into the SQL. Read that snowflake from the running environment, not from a document.
- [x] 2.4 Create migration `enforce_guild_scope`: set both columns NOT NULL, drop the two old `discord_members` uniques and the old `announcement_logs` unique, add the guild-scoped replacements.
- [x] 2.5 Run `bunx prisma generate` and confirm the project typechecks against the regenerated client.
- [x] 2.6 Verify on a copy of production data that no `discord_members` or `announcement_logs` row is left without a guild ID, and that row counts are unchanged.

## 3. Discord client: many guilds, one connection

- [x] 3.1 Replace the singular accessors in `src/lib/discord/client.ts` with `getConfiguredGuilds()`, `getGuildConfig(guildId)`, `fetchGuild(guildId)` and `getReadyGuilds()`; delete `isConfiguredGuild` and the singular `getGuild`.
- [x] 3.2 On `ClientReady`, fetch every configured guild, log each with its name and member count, record unreachable ones with their reason, and kick off a sync per reachable guild (still unawaited).
- [x] 3.3 Route `guildMemberAdd`, `guildMemberRemove`, `guildMemberUpdate` through `getGuildConfig(event.guild.id)`, ignoring events from unconfigured guilds and passing the resolved server config to the handler.
- [x] 3.4 Register the `messageCreate` listener once and resolve the server inside it, so a message is ingested only when its channel is the daily-update channel of the guild it came from.
- [x] 3.5 Rework `userUpdate` so a handle change updates that account's record in every configured server that holds one.
- [x] 3.6 Confirm the degraded-intent retry still rebuilds the client, re-registers handlers, and applies to every server at once.
- [x] 3.7 On ready, verify every configured channel ID (attendance, daily-update, reminder) resolves to a text channel in the server it was configured under; report and exclude a server that fails, leaving the others running.
- [ ] 3.8 Verify a deliberately swapped configuration is caught: exchange the two servers' daily-update channel IDs and confirm startup refuses both servers, rather than the mistake first surfacing as ingestion silently dropping every message.
- [x] 3.9 Surface channel-verification failures on `/api/discord/sync/status` alongside reachability, naming the channel and the reason.

## 4. Member sync per server (highest-risk work)

- [x] 4.1 Change `syncGuildMembers(guild)` so every read and write it performs carries that guild's ID; upserts key on `guildId_discordUserId`.
- [x] 4.2 Scope the departure guard baseline to `count({ where: { guildId, isInGuild: true } })`, keeping the zero check and the 50% ratio unchanged.
- [x] 4.3 Scope the reconcile to `updateMany({ where: { guildId, isInGuild: true, discordUserId: { notIn: fetchedIds } } })`.
- [x] 4.4 Scope `releaseConflictingUsername` to `guildId_discordUsername`, so the same handle in another server is never treated as a collision.
- [x] 4.5 Fix `isUsernameConflict` to detect P2002 through `JSON.stringify(error.meta ?? {}).includes('discord_username')` — `meta.target` is undefined under `@prisma/adapter-pg`, so the repair never fires today.
- [x] 4.6 Turn the module-level sync state into a per-guild map and expose it keyed by guild; keep the concurrent-sync guard per guild.
- [x] 4.7 **Verify the scoping deliberately**: seed two servers, run a sync of server A, and confirm server B's active member count, `leftAt` values, and directory rows are byte-for-byte unchanged.
- [x] 4.8 Verify a truncated fetch in server A trips the guard for A alone and leaves B untouched.

## 5. Fan-out helper

- [x] 5.1 Add `src/lib/discord/fanout.ts` exporting `forEachGuild<T>()` returning `GuildOutcome<T>[]` — sequential, every server attempted, never throws.
- [x] 5.2 Add a shared serializer that turns `GuildOutcome[]` into the `{ servers, summary }` envelope used inside `data` by every fan-out endpoint.
- [x] 5.3 Add a shared service helper that raises `AppError` only when every server failed, and otherwise returns the partial-success envelope.

## 6. Channel scheduler across servers

- [x] 6.1 Change `setDailyUpdateChannelOpen` and `isDailyUpdateChannelOpen` in `channel.state.ts` to take a `TGuildConfig`, resolving that server's channel and verifying it belongs to that server.
- [x] 6.2 Keep `channel.state.ts` the only module that edits a channel overwrite; add the fan-out at the caller, not inside it.
- [x] 6.3 Fan out the timed open and lock jobs in `channelSchedule.scheduler.ts` from one registered task, recording a per-server result in `lastRun`.
- [x] 6.4 Fan out the boot reconcile per server, each in its own try/catch, still with `announce: false`.
- [x] 6.5 Extend `/api/schedule/daily-update` to report every configured server's live channel state and last-run outcome.
- [x] 6.6 Extend the manual open/lock endpoints to fan out by default and accept an optional `guildIds` array, refusing an unconfigured server ID.
- [ ] 6.7 Verify that a server missing `Manage Roles` fails alone: the other server opens, and the failure is visible on the status read.

## 7. Daily-update ingestion per server

- [x] 7.1 Change `events/messageCreate.ts` to resolve the server from `message.guild.id` and compare the channel against that server's daily-update channel only.
- [x] 7.2 Change `message.ingest.ts` to take the resolved server and look the author up with `findMemberByDiscordUserId(guildId, discordUserId)`.
- [x] 7.3 Scope the unknown-author repair to fetching from that server and upserting through `upsertMemberPayload` with that server's ID.
- [x] 7.4 Verify a member of both servers who posts in one is credited only there and still shows as missing in the other.
- [ ] 7.5 Verify a message in server B's daily-update channel is ingested when only server A was previously configured — that is, that no residual single-channel check remains.

## 8. Repositories

- [x] 8.1 Replace `findActiveMemberByUsername` with `findActiveMembersByUsername` returning one verified member per server, and update `member.repository.ts`'s doc comment about the deliberate `isInGuild` asymmetry to say it is now also per server.
- [x] 8.2 Add `guildId` to `findMemberByDiscordUserId`, keeping it deliberately unfiltered by `isInGuild`.
- [x] 8.3 Add `guild_id` to the `SELECT`, an optional bound `guildId` filter, and the `serverCount` correlated subquery in `dailyStatus.repository.ts`'s shared `statusSource`.
- [x] 8.4 Extend `getDailyStatusCounts` to return the existing seven figures plus a `byServer` breakdown produced in the same pass.
- [x] 8.5 Add `guildId` to the closed `SORT_COLUMNS` allowlist; confirm the filter is a bound parameter and nothing new is interpolated.
- [x] 8.6 Update the "Columns these queries depend on" comment at the top of `dailyStatus.repository.ts` to include `discord_members.guild_id`.
- [x] 8.7 Extend the reminder target query to return the member's `guildId` and to span every server, or one named server.
- [x] 8.8 Add `guildId` to the announcement repository's claim, reclaim, and today-status reads.
- [x] 8.9 Verify the page query and the counts query return the same totals under every combination of server filter, status filter, and search.

## 9. Attendance form across servers

- [x] 9.1 Change the shared verification helper in `attendance.service.ts` to resolve a handle to the set of servers it is a current member of, used by both `verify-user` and `submit`.
- [x] 9.2 Extend `verify-user` to report `verified`, the member profile, `servers`, and a per-server `alreadySubmitted`, keeping the 200-for-unknown-handle behaviour and the not-found/departed collapse.
- [x] 9.3 Change `submit` to write one attendance row per resolved server inside one `$transaction`, plus the contact-detail update on each server's directory entry.
- [x] 9.4 Implement the duplicate rule: all servers already recorded → duplicate error naming the date; some recorded → write the missing ones and return success naming the servers recorded.
- [x] 9.5 Confirm P2002 detection still matches the documented `JSON.stringify(err.meta)` contains `attendance_date` path under the driver adapter.
- [x] 9.6 Leave `GET /api/attendance/window` untouched and confirm it still performs no Discord call.
- [x] 9.7 Verify a handle in both servers submits once and appears present in both; verify a handle in one server is unaffected.

## 10. Reminder broadcast and queue

- [x] 10.1 Build the target list across servers, creating one recipient row per member record, and group by `discordUserId` before enqueuing.
- [x] 10.2 Change the job ID to `<reminderId>__<discordUserId>` and the payload to `{ reminderId, discordUserId, memberIds }`; confirm no `:` appears in the ID.
- [x] 10.3 Make the pre-send re-read check every recipient row the job settles, and the outcome write settle them all in one `updateMany`.
- [x] 10.4 Report `targetCount` (recipient rows) and `uniqueRecipients` (jobs) separately on the status read, plus a per-server breakdown.
- [x] 10.5 Group `DM_CLOSED` recipients by `guildId` and post each group to that server's reminder channel, keeping `allowedMentions: { parse: [], users }` and the 50-mention chunking.
- [x] 10.6 Report `lastFallback` per server so a missing `Send Messages` in one server is visible.
- [x] 10.7 Accept an optional `guildIds` restriction on `POST /send`, keeping the same-date 409 global.
- [x] 10.8 Verify a member of both servers who missed in both receives exactly one DM and has both recipient rows settled.
- [ ] 10.9 Verify the rate limiter still paces the whole queue rather than per server.

## 11. Announcement across servers

- [x] 11.1 Change `announcement.ts` to post to one named server's attendance channel, resolving mentions within that server.
- [x] 11.2 Change `announcement.dispatch.ts` to claim, send, and record per server, using `forEachGuild`.
- [x] 11.3 Change the nonce to `<guildId>-<announcementDate>-<attempt>` and keep `enforceNonce: true` on every send.
- [x] 11.4 Keep the template, its schedule, its mention allowlist, and the `mentionEveryone` flag as one shared row; register the cron task once and fan out inside it.
- [x] 11.5 Record unresolved mention targets per server, and keep an unresolved target from ever withholding that server's message.
- [x] 11.6 Change `findUnsupportedPlaceholders` validation unchanged, but validate saved mention handles against the union of configured servers.
- [x] 11.7 Extend `GET /api/announcement/attendance` to report `today.posted` and the last outcome per server, and the manual send to accept an optional `guildIds`.
- [ ] 11.8 Verify a forced second send claims the next attempt number for the named server only.

## 12. HTTP surface and validation

- [x] 12.1 Add the optional `guildId` query parameter to the daily-status list, counts, and export validation schemas, rejecting an unconfigured value with a 400 that names it.
- [x] 12.2 Add `guildId`, `serverLabel`, and `serverCount` to the daily-status row serialization and a `server` column to the CSV export, including the server in the export filename when filtered.
- [x] 12.3 Add the admin-only endpoint that lists the configured servers with their labels and reachability.
- [x] 12.4 Extend `/api/discord/sync/status` to report per-server sync state and reachability, and `POST /sync` to accept an optional `guildId`.
- [ ] 12.5 Confirm every fan-out controller answers 200 with `summary.failed > 0` on partial success and an error status only when every server failed.
- [ ] 12.6 Update `postman-collection.json` with the new parameters and per-server response shapes.

## 13. Documentation

- [ ] 13.1 Add a multi-server section to `CLAUDE.md` covering the guild-scoped directory, the fan-out rules, the per-server departure guard, the one-DM-per-account rule, and the per-server announcement claim.
- [ ] 13.2 Correct every existing `CLAUDE.md` rule that says "the guild", "the configured guild", or names a single channel ID.
- [ ] 13.3 Update `API_INTEGRATION.md` and `BACKEND_REQUIREMENTS.md` with the per-server response shapes and the server filter.

## 14. Deployment and verification

- [ ] 14.1 Deploy the migrations and the application while still configured for one server, and confirm behaviour is unchanged.
- [ ] 14.2 Invite the bot to the second server with `Manage Roles` on `#daily-update` and `Send Messages` on `#attendance` and `#daily-update-reminder`.
- [ ] 14.3 Add the plural environment variables, restart, and confirm startup logs both servers and that both syncs complete with `guardTripped: false` and plausible member counts.
- [ ] 14.4 Walk the verification sequence before an evening cycle: sync status shows two servers; the schedule read shows both channels' live state; a manual lock then open moves both channels; the announcement status shows `today.posted` per server; `verify-user` on a handle in both returns both servers.
- [ ] 14.5 Run one reminder broadcast against a past date with a tiny target list and confirm one DM per account, both recipient rows settled, and the fallback posted in the right server.
