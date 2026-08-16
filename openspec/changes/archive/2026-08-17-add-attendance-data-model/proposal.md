## Why

Phase 1 landed the Discord bot and the `discord_members` directory, so the backend now knows who is in the server. Everything the PID promises after that — the web attendance form, real-time `#daily-update` ingestion, the dashboard's status counts, and the rate-limited DM reminder queue — writes to or reads from tables that do not exist yet. Four separate later phases are blocked on one schema.

This change lands Phase 2 of the roadmap: the complete attendance-domain schema with its uniqueness and idempotency constraints, the indexes the 5,000-member dashboard queries need, and a shared data-access layer that both the HTTP modules and the Discord bot can call. No HTTP endpoint, no bot listener, and no queue ships here — only the persistence layer they all sit on.

## What Changes

- Add `prisma/schema/attendance.prisma` with `Attendance` (form submissions) and `DailyUpdate` (ingested `#daily-update` messages), plus an `AttendanceStatus` enum.
- Add `prisma/schema/reminder.prisma` with `ReminderLog` (one broadcast session) and `ReminderRecipient` (per-member delivery outcome), plus `ReminderStatus` and `ReminderDeliveryStatus` enums.
- Point every attendance-domain foreign key at `DiscordMember`, not at the admin `User` model. The PID's schema listing calls the member model `User`; this repo already resolved that name collision in Phase 1, so `memberId → discord_members.id` is the form the PID's intent takes here.
- Add the reverse relations to `DiscordMember` (`attendances`, `dailyUpdates`, `reminderRecipients`) and a nullable `createdBy` relation from `ReminderLog` to the admin `User`, so the dashboard can show who sent a broadcast.
- Enforce the PID's Golden Rule 7 at the database level: `@@unique([memberId, attendanceDate])` on attendances, `@unique` on `discord_message_id`, and `@@unique([reminderId, memberId])` so a retried queue job cannot DM the same person twice.
- Store civil dates as `String` in `YYYY-MM-DD` form, always computed in `Asia/Dhaka`, and add `src/utils/dhakaDate.ts` as the single place that derives them.
- Add `src/repositories/` — a shared data-access layer (`attendance.repository.ts`, `dailyUpdate.repository.ts`, `reminder.repository.ts`, `dailyStatus.repository.ts`) callable from both `src/modules/*` services and the non-HTTP `src/lib/discord/*` bot code.
- Implement the PID §11 single-query daily status aggregation and its counts variant as repository helpers, so no consumer ever loops 5,000 members.
- Add one Prisma migration creating all four tables, their enums, and their indexes.

## Capabilities

### New Capabilities

- `dhaka-calendar-date`: The single definition of "today" for the whole system — how a `YYYY-MM-DD` civil date is derived in `Asia/Dhaka`, which day a message or submission belongs to, and the rule that no consumer computes a date any other way.
- `attendance-data-model`: The persisted attendance domain — attendance submissions, ingested daily updates, reminder broadcasts and their per-recipient outcomes; ownership by `DiscordMember`; the uniqueness and idempotency constraints that make writes safe to retry; and the retention rules that keep history valid after a member leaves the guild.
- `daily-status-aggregation`: The read side — deriving each member's `COMPLETE` / `MISSING_UPDATE` / `MISSING_ATTENDANCE` / `MISSING_BOTH` status for a given date, and the summary counts behind the dashboard cards, in a bounded number of queries regardless of member count.

### Modified Capabilities

None. Phase 1's `discord-bot-runtime` and `discord-member-sync` requirements are unchanged; this change only adds relations that depend on the never-delete guarantee `discord-member-sync` already specifies.

## Impact

- **Schema**: four new tables (`attendances`, `daily_updates`, `reminder_logs`, `reminder_recipients`), three new enums, and new relation fields on `discord_members` and `users`. One migration. Requires `bunx prisma generate` after pulling.
- **Code**: new `prisma/schema/attendance.prisma` and `prisma/schema/reminder.prisma`; new `src/repositories/`; new `src/utils/dhakaDate.ts`. Existing modules, middleware, and the bot are untouched.
- **New layer**: `src/repositories/` is a deliberate addition to the documented architecture. Phase 4 ingestion runs inside `src/lib/discord/` and Phase 6 runs inside a BullMQ worker — neither is HTTP-scoped, so neither should reach into a module service. CLAUDE.md's "controllers never touch Prisma / services own Prisma" rule still holds; module services now delegate to repositories instead of calling Prisma directly.
- **Dependencies**: none added. Dhaka dates are derived with `Intl.DateTimeFormat`, already in Node's ICU build.
- **Data safety**: the departure guard in `member.sync.ts` becomes load-bearing for real history — once attendance rows exist, a truncated fetch that mass-flagged members would corrupt the dashboard's active-member denominator, not just the directory.
- **Not in scope**: `GET /api/attendance/verify-user`, `POST /api/attendance/submit`, the Next.js form, the `messageCreate` listener, the channel open/lock scheduler, and the BullMQ queue. Phases 3 through 6 consume this layer; none of them ships here.
