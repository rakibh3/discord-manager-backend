## Why

The program now runs out of **two identical Discord servers** — same channel names, same daily cycle, two separate member populations that mostly do not overlap. Every part of this system is hard-wired to exactly one guild: `DISCORD_GUILD_ID` is a single snowflake, `discord_members.discord_user_id` is globally unique, the scheduler edits one channel's overwrite, the announcement claims one row per day, and every dashboard query counts one directory. Running a second copy of the application is not an option — it would mean two databases, two dashboards, two attendance forms, two sets of admin credentials, and a reminder queue whose DM budget is no longer shared, which is precisely the thing Golden Rule 4 forbids splitting.

One admin action must therefore reach every server: one open, one lock, one announcement, one reminder broadcast, one dashboard.

## What Changes

- **BREAKING** — **The member directory becomes guild-scoped.** `discord_members` gains a `guild_id`, and its uniqueness moves from `discord_user_id` / `discord_username` to `(guild_id, discord_user_id)` and `(guild_id, discord_username)`. A person in both servers is two rows, one per server, because their membership, departure date, and attendance history are per server. Requires a data migration that backfills the existing guild ID onto every stored row.
- **The configured servers come from the environment as parallel lists**: `DISCORD_GUILD_IDS`, `DAILY_UPDATE_CHANNEL_IDS`, `ATTENDANCE_CHANNEL_IDS`, `REMINDER_CHANNEL_IDS`, plus optional `DISCORD_GUILD_LABELS`. All lists must be the same length and are validated together. Because the servers are clones that name their channels identically, a **misaligned list is invisible to inspection** and no static check can catch a swapped pair — so each channel ID is additionally verified at boot to resolve into the server it was configured under. Between the two, a paste error is a refused startup rather than a bot that quietly posts one server's announcement into the other's channel, or ignores every daily update in both. The existing singular variables keep working as a one-server list.
- **One bot, many guilds.** The single `DISCORD_BOT_TOKEN` client is invited to both servers. No second login, no second gateway, and — the reason this matters — one shared Discord rate-limit budget rather than two independent ones racing each other toward a ban.
- **Every shared setting stays a single stored row and fans out.** One `channel_schedules` row opens and locks the `#daily-update` channel in **every** server at 18:00. One `announcement_templates` row posts to **every** `#attendance` at 19:00. There is no per-server time and no per-server message, so the two servers cannot drift apart.
- **Every per-server outcome is recorded and reported per server.** `announcement_logs` gains a `guild_id` and its once-per-day claim becomes `(guild_id, key, announcement_date, attempt)`, so a failed post in one server neither blocks nor is hidden by a successful post in the other. The scheduler, sync, and announcement status endpoints all return an array of per-server results instead of one.
- **Failure is isolated per server.** A missing `Manage Roles` in server B must not stop server A's channel from opening; each server's step runs in its own try/catch and reports its own error. An action that succeeded in some servers and failed in others is a partial success with a named breakdown, never a bare 500.
- **Member sync runs per server, and its departure guard is per server.** The "0 non-bots, or under 50% of the stored active count" check compares against *that server's* stored count, and the reconcile `updateMany` is scoped to that server's rows. Without this, one truncated fetch would mark the other server's entire directory departed.
- **Daily-update ingestion accepts the configured channel of any server** and resolves the author inside *that server's* directory, repairing that server's directory on a miss.
- **The attendance form works across servers.** `verify-user` resolves a handle to the servers it is active in; `submit` records the day's attendance in **every** server that handle is currently in, so one submission by a student who is in both never leaves them showing as missing in one of them.
- **One reminder broadcast covers every server**, and a person who is in both servers and missed in both receives **exactly one DM** — the job is keyed on the Discord account, and its outcome settles that account's recipient rows in every server. The closed-DM fallback posts to each server's own reminder channel, naming only that server's members.
- **The dashboard gains a server dimension.** Daily status rows carry their server, the counts are available per server and combined, the list and export accept an optional server filter, and a row whose Discord account also appears in another server is flagged so the overlap is visible rather than looking like a duplicate.

Not in scope: per-server schedules, per-server announcement bodies, per-server admin permissions, and a database-backed server registry with dashboard CRUD. All four are deliberate deferrals — the requirement is that the two servers behave identically, and every one of these introduces a way for them to stop doing so. The schema keeps them reachable later without another breaking migration.

## Capabilities

### New Capabilities

- `multi-guild-registry`: the configured set of servers — how they are declared in the environment, validated together, labelled, resolved at runtime, and reported when one is unreachable; and the rule that no code path may name a single "the guild".
- `multi-guild-fanout`: what "one action applies to every server" means — per-server isolation of failure, partial success with a named per-server breakdown, per-server outcome records under a shared setting, and the ordering and idempotency guarantees a fan-out must hold.
- `cross-server-member-identity`: one directory row per (server, Discord account); why the same person in two servers is two rows; per-server uniqueness, per-server departure and tombstoning; and how the overlap is made visible without merging the rows.

### Modified Capabilities

- `attendance-data-model`: the directory is keyed by server; uniqueness, ownership, and the survives-a-departure guarantee are per server.
- `discord-bot-runtime`: configuration validates a list of servers rather than one; readiness verifies every configured guild; gateway events are routed by which configured server they came from.
- `discord-member-sync`: sync runs per server, and the departure guard, the reconcile, and username tombstoning are all scoped to the server being synced.
- `daily-update-ingestion`: a message is ingested when it lands in the configured daily-update channel of *any* server, and the author is resolved and repaired within that server's directory.
- `channel-schedule-automation`: one schedule opens, locks, and reconciles the channel in every server, with per-server results and per-server failure isolation.
- `schedule-configuration`: the stored schedule stays single and shared; the read reports the live channel state of every server.
- `web-attendance-submission`: verification reports the servers a handle is active in, and an accepted submission records attendance in every one of them.
- `daily-status-aggregation`: every query carries a server dimension — optional filter, per-server and combined counts, and a cross-server overlap flag.
- `daily-status-http`: the status, export, and member endpoints accept an optional server filter and report the server on every row.
- `reminder-broadcast`: one broadcast targets members across every server, and its progress and history report the per-server breakdown.
- `reminder-dm-delivery`: exactly one DM per Discord account per broadcast regardless of how many servers they are in, and the fallback posts to each server's own reminder channel.
- `reminder-queue-runtime`: the deterministic job identity moves from the member row to the Discord account, and one job settles every recipient row for that account.
- `attendance-announcement-delivery`: the once-per-day claim, the send, and the recorded outcome are per server, under one shared template and one shared schedule.
- `attendance-announcement-template`: mention targets are validated against the union of the configured servers and resolved separately inside each server at post time.

## Impact

- **Schema (BREAKING, needs a data migration)**: `discord.prisma` — `DiscordMember.guildId`, drop the two global `@unique`s, add `@@unique([guildId, discordUserId])` and `@@unique([guildId, discordUsername])`, add `@@index([guildId, isInGuild])` and `@@index([discordUserId])` for overlap detection. `announcement.prisma` — `AnnouncementLog.guildId` and the widened `@@unique([guildId, key, announcementDate, attempt])`. Backfill both from the current `DISCORD_GUILD_ID` before the NOT NULL constraint lands. `bunx prisma generate` afterwards.
- **Config**: `src/config/discord.ts` returns a list of servers instead of one; `.env` and `.env.example` gain the plural variables. Startup refuses to run on mismatched list lengths, a duplicate guild ID, or a channel ID reused across servers; and once the gateway is ready, every configured channel is verified to belong to the server it was configured under, which is the only check that catches a swapped pair.
- **Discord layer**: `client.ts` (guild allowlist, per-guild ready verification, per-guild sync kick-off), `member.sync.ts` (per-guild sync and guard), `message.ingest.ts` and `events/*` (guild-aware routing), `channel.state.ts` (takes a server, gains a fan-out caller), `announcement.ts` and `dm.ts` (take a server).
- **Repositories**: `member.repository.ts` (guild-scoped lookups plus a handle-to-servers resolver), `dailyStatus.repository.ts` (raw SQL gains the guild join and the overlap subquery — recheck the column list in its header comment), `announcement.repository.ts`, `reminder.repository.ts`.
- **Queue**: `reminder.queue.ts` / `reminder.worker.ts` — job identity per Discord account, payload carries the member rows it settles, fallback grouped by server.
- **HTTP**: `/api/schedule`, `/api/announcement`, `/api/discord/sync/status`, `/api/reminders`, `/api/daily-status` all gain per-server results or an optional server filter; `/api/attendance/verify-user` and `/submit` gain the server list. `/api/attendance/window` is unchanged — the schedule is shared, so the window is one answer.
- **Discord permissions**: the bot needs `Manage Roles` on every `#daily-update` and `Send Messages` on every `#attendance` and `#daily-update-reminder`. A gap in one server is now a per-server error on the status reads rather than a blanket failure.
- **Docs**: `CLAUDE.md` gains a multi-server section and every existing rule that says "the guild" is corrected; `postman-collection.json` gains the server parameters; `API_INTEGRATION.md` and `BACKEND_REQUIREMENTS.md` gain the per-server response shapes.
