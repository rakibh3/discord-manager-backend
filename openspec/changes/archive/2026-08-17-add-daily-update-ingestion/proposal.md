## Why

Half of every student's daily obligation — the `#daily-update` message — is never recorded. The `daily_updates` table, its repository, and the dashboard aggregation that reads it all exist, but nothing writes to them: the bot has no `messageCreate` listener, so `getDailyStatusCounts` reports every member as missing their update and the reminder queue would target the entire server. Attendance ingestion (Phase 3) shipped; this is the other half of the data the dashboard and reminders are built on.

Golden Rule 6 requires instant ingestion — messages can never be batch-collected at night — so this has to be a live gateway listener, not a scheduled backfill.

## What Changes

- Add a `messageCreate` gateway listener scoped to `DAILY_UPDATE_CHANNEL_ID`, writing one `daily_updates` row per message via the existing `dailyUpdateRepository.createDailyUpdate`.
- Resolve the message author to a `DiscordMember` by **Discord snowflake**, not by handle. When the author has no directory row (joined during a gateway gap, or the initial sync has not reached them), fetch the `GuildMember` and upsert them through the existing `upsertMemberPayload` before storing, so no student loses credit for a sync gap.
- Derive `message_date` from `message.createdAt` via `getDhakaDate(instant)`, never from "now" — a message sent at 23:58 and persisted at 00:01 belongs to the day it was sent.
- React with ✅ on first successful ingestion only. A replayed gateway event resolves to the existing row (`created: false`) and is not re-acknowledged.
- Add the `GuildMessages` and `MessageContent` gateway intents to the shared client, with a **fail-safe login retry**: if Discord rejects the connection with `disallowed intents`, log the exact Developer Portal toggle to enable, then retry login once *without* `MessageContent` so member sync and the attendance form keep working with ingestion disabled and loudly logged.
- Expose the resulting degraded state so it is observable rather than silent.

Not in scope: message edits and deletions (`messageUpdate` / `messageDelete`). The stored row is the message as originally sent — an audit record. The 6:00 PM / 11:59 PM channel open-lock schedule remains Phase 5; ingestion stores whatever arrives whenever it arrives.

## Capabilities

### New Capabilities

- `daily-update-ingestion`: Real-time capture of `#daily-update` messages into `daily_updates` — channel and author filtering, author resolution and just-in-time directory repair, Dhaka message-date derivation, idempotent storage on `discord_message_id`, and the ✅ acknowledgement reaction.

### Modified Capabilities

- `discord-bot-runtime`: The client's required intents change (adding `GuildMessages` and `MessageContent`), and the "privileged intent not enabled" behavior changes from *fail and log* to *degrade and continue* — the bot must now retry login without `MessageContent` so member sync survives a missing portal toggle.
- `discord-member-sync`: The directory gains a second write trigger. Message ingestion may upsert a member the scheduled/event sync has not yet recorded, so "the directory is written by sync events only" no longer holds.

## Impact

**Code**

- `src/lib/discord/client.ts` — intents, the `messageCreate` registration, the degraded-login retry and its reported state.
- `src/lib/discord/events/messageCreate.ts` — new handler.
- `src/lib/discord/message.ingest.ts` (new) — author resolution + persistence, kept out of the handler so it stays testable and reusable.
- `src/repositories/member.repository.ts` — new `findMemberByDiscordUserId` lookup (ingestion resolves by snowflake; the existing handle lookup stays the form's path).
- `src/modules/discord/*` — the bot-status endpoint reports whether ingestion is active.

**Data** — writes only to existing tables (`daily_updates`, `discord_members`). No schema change, no migration.

**Configuration** — no new environment variables. `DAILY_UPDATE_CHANNEL_ID` is already validated by `src/config/discord.ts`. **Operational prerequisite:** the *Message Content Intent* must be enabled in the Discord Developer Portal; without it the bot runs in the degraded, ingestion-off mode.

**Downstream** — `getDailyStatusCounts` starts returning non-zero daily-update figures, which is what makes the Phase 7 dashboard and the Phase 6 reminder targeting correct rather than uniformly "everyone is missing".
