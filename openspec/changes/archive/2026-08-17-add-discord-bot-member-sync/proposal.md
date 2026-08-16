## Why

Every downstream feature in the PID depends on the backend knowing who is actually in the Discord server. The web attendance form must reject a username that is not a live guild member, daily-update ingestion must resolve a message author to a stored member row, and the reminder queue must have a Discord snowflake ID to DM. None of that is possible today: the backend has no Discord connection at all, and the only `User` model in the schema is the admin login account.

This change lands Phase 1 of the roadmap — the bot process itself and a member directory in PostgreSQL that stays accurate while the bot runs — so Phases 3 through 6 have something to build on.

## What Changes

- Add `discord.js` v14 as a runtime dependency and a bot client that boots inside the existing Express process (`src/server.ts`), with the `Guilds` and `GuildMembers` privileged intents.
- Add Discord configuration to `.env` / `.env.example` and `src/config/index.ts`: `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `ATTENDANCE_CHANNEL_ID`, `DAILY_UPDATE_CHANNEL_ID`, `REMINDER_CHANNEL_ID`. Startup fails fast with a clear error when a required value is missing.
- Add a `DiscordMember` Prisma model (new `prisma/schema/discord.prisma`, table `discord_members`) holding `discordUserId`, normalized `discordUsername`, `displayName`, `avatarUrl`, and guild-membership state, plus a migration. The existing `User` model stays exactly as it is and continues to mean "admin account".
- Add a shared Discord username utility — the official Pomelo regex and `normalizeDiscordUsername()` from the PID — used by every write path so stored usernames are always trimmed, `@`-stripped, and lowercased.
- On `ClientReady`, run a full `guild.members.fetch()` sync that upserts all non-bot members in batched transactions, and marks members no longer present in the guild as departed rather than deleting their rows.
- Keep the directory fresh while the process runs via `GuildMemberAdd`, `GuildMemberRemove`, `GuildMemberUpdate`, and `UserUpdate` listeners.
- Add an admin-only `GET /api/discord/sync/status` endpoint and a `POST /api/discord/sync` manual re-sync trigger, following the existing module pattern.
- Bot failure is isolated: a login or sync error is logged and leaves the HTTP API serving normally.

## Capabilities

### New Capabilities

- `discord-bot-runtime`: Bot client lifecycle — configuration and validation of Discord env vars, gateway intents, login, ready/error/shutdown handling, and the guarantee that bot problems never take down the REST API.
- `discord-member-sync`: The member directory — username normalization rules, the initial full guild sync, incremental lifecycle events, departure handling, and the admin endpoints that expose and trigger sync.

### Modified Capabilities

None. This change adds new behavior only; no existing requirement changes.

## Impact

- **Dependencies**: adds `discord.js` (^14).
- **Schema**: new `discord_members` table and one migration. No change to `users`, `refresh_tokens`, or `profiles`. Requires `bunx prisma generate` after pulling.
- **Code**: new `src/lib/discord/` (client, sync, event handlers), new `src/modules/discord/` module, new `src/utils/discordUsername.ts`; edits to `src/config/index.ts`, `src/server.ts`, `src/app.ts`.
- **Ops**: the bot token must be issued in the Discord Developer Portal with the **Server Members** privileged intent enabled, and the bot must be invited to the guild. Without that, `guild.members.fetch()` returns only a partial member list.
- **Operational note**: fetching ~5,000 members over the gateway takes tens of seconds. The sync runs in the background after `app.listen()` so it never delays the server accepting traffic.
- **Not in scope**: message ingestion, channel open/lock scheduling, the attendance endpoints and form, and the BullMQ reminder system. Those are later phases.
