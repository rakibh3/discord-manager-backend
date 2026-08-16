## 1. Dhaka Date Utility

- [x] 1.1 Create `src/utils/dhakaDate.ts` exporting `DHAKA_TIMEZONE = 'Asia/Dhaka'` and `getDhakaDate(instant?: Date): string` built on `Intl.DateTimeFormat('en-CA', { timeZone: DHAKA_TIMEZONE, ... })`, returning `YYYY-MM-DD`
- [x] 1.2 Export `isValidDhakaDate(value: string): boolean` that checks the `YYYY-MM-DD` shape and that the value is a real calendar date (rejects `2026-13-01`, `2026-02-30`)
- [x] 1.3 Export a reusable Zod schema (e.g. `dhakaDateSchema`) so Phase 3 request validation and repository arguments share one definition
- [x] 1.4 Verify the boundary cases from the spec: `2026-08-17T19:00:00Z` → `2026-08-18`, `2026-08-17T17:59:00Z` → `2026-08-17`, and that both hold with the process started under `TZ=UTC` and under `TZ=America/New_York`
- [x] 1.5 Confirm the running Node build has full ICU (`Intl.DateTimeFormat().resolvedOptions().timeZone` and an explicit `Asia/Dhaka` format both work) — small-ICU would silently fall back to UTC

## 2. Attendance & Daily Update Schema

- [x] 2.1 Create `prisma/schema/attendance.prisma` with `enum AttendanceStatus { PRESENT LATE EXCUSED }`
- [x] 2.2 Add the `Attendance` model: `id`, `memberId` → `DiscordMember`, denormalized `name` / `email` / `phone`, `attendanceDate String`, `status AttendanceStatus @default(PRESENT)`, `submittedAt`, `createdAt`; `@@map("attendances")` with snake_case `@map` on every column
- [x] 2.3 Add `@@unique([memberId, attendanceDate])` and `@@index([attendanceDate])` to `Attendance`
- [x] 2.4 Add the `DailyUpdate` model: `id`, `memberId` → `DiscordMember`, `discordMessageId String @unique`, `channelId`, `message String @db.Text`, `messageDate String`, `messageCreatedAt DateTime`, `createdAt`; `@@map("daily_updates")`
- [x] 2.5 Add `@@index([messageDate])` and `@@index([memberId, messageDate])` to `DailyUpdate`
- [x] 2.6 Set `onDelete: Cascade` on both member relations

## 3. Reminder Schema

- [x] 3.1 Create `prisma/schema/reminder.prisma` with `enum ReminderStatus { PENDING PROCESSING COMPLETED FAILED }` and `enum ReminderDeliveryStatus { PENDING DELIVERED DM_CLOSED FAILED }`
- [x] 3.2 Add the `ReminderLog` model: `id`, `reminderDate String`, `message String @db.Text`, `targetCount`, `sentCount @default(0)`, `failedCount @default(0)`, `status ReminderStatus @default(PENDING)`, `createdById String?`, `startedAt`/`completedAt` nullable, `createdAt`; `@@index([reminderDate])`; `@@map("reminder_logs")`
- [x] 3.3 Relate `ReminderLog.createdBy` to the admin `User` with `onDelete: SetNull` so deleting an admin never deletes broadcast history
- [x] 3.4 Add the `ReminderRecipient` model: `id`, `reminderId` → `ReminderLog` (`onDelete: Cascade`), `memberId` → `DiscordMember` (`onDelete: Cascade`), `status ReminderDeliveryStatus @default(PENDING)`, `errorMessage String?`, `sentAt DateTime?`, `createdAt`; `@@map("reminder_recipients")`
- [x] 3.5 Add `@@unique([reminderId, memberId])` and `@@index([reminderId, status])` to `ReminderRecipient`

## 4. Relations & Migration

- [x] 4.1 Add reverse relations `attendances`, `dailyUpdates`, `reminderRecipients` to `DiscordMember` in `prisma/schema/discord.prisma`, leaving its existing fields and indexes untouched
- [x] 4.2 Add the reverse relation `reminderLogs` to `User` in `prisma/schema/auth.prisma` — no other field on `User` changes
- [x] 4.3 Run `bunx prisma generate` and confirm `Attendance`, `DailyUpdate`, `ReminderLog`, `ReminderRecipient` and the three enums import cleanly from `@generated/prisma/client` and `@generated/prisma/enums`
- [x] 4.4 Run `bunx prisma migrate dev --name add_attendance_domain` and read the generated SQL: every unique and index from design decision 8 present, and no `DROP` or destructive `ALTER` against `users`, `refresh_tokens`, `profiles`, or `discord_members`
- [x] 4.5 Confirm in `bunx prisma studio` (or psql) that the four tables exist with the expected constraints

## 5. Attendance & Daily Update Repositories

- [x] 5.1 Create `src/repositories/attendance.repository.ts` using the shared `prisma` singleton — no `AppError`, no HTTP status codes, no `req` anywhere in this directory
- [x] 5.2 Implement `createAttendance(input)` returning the created row and letting a P2002 propagate for the central handler to shape as a duplicate
- [x] 5.3 Implement `findAttendanceByMemberAndDate(memberId, date)` returning the row or `null` — this is what Phase 3's verify endpoint calls for `alreadySubmitted`
- [x] 5.4 Implement `listAttendanceByDate(date)` for reporting
- [x] 5.5 Create `src/repositories/dailyUpdate.repository.ts` with `createDailyUpdate(input)` that is idempotent on `discordMessageId` (upsert or catch-P2002-and-ignore), so a replayed gateway event writes nothing new
- [x] 5.6 Implement `hasUpdateOnDate(memberId, date)` and `listUpdatesByMemberAndDate(memberId, date)` (ordered by `messageCreatedAt`, for the user-detail modal)
- [x] 5.7 Verify idempotency directly: insert the same `discordMessageId` twice and confirm exactly one row exists

## 6. Daily Status Aggregation

- [x] 6.1 Create `src/repositories/dailyStatus.repository.ts` and declare the returned row shape as an explicit TypeScript interface next to the query
- [x] 6.2 Transcribe the PID §11 SQL against `discord_members` — `FROM discord_members dm`, `dm.id = a.member_id`, `dm.discord_username`, `dm.discord_user_id` — do not copy the PID's `users` / `user_id` names verbatim
- [x] 6.3 Join the daily-update side through a `SELECT DISTINCT member_id FROM daily_updates WHERE message_date = $1` subquery so a member with several messages yields exactly one row
- [x] 6.4 Implement `getDailyStatusPage({ date, status?, search?, page, limit, includeDeparted? })` with `$queryRaw` tagged templates for all values; default to `dm.is_in_guild = true` and map any status filter, sort column, and sort direction from a closed allowlist — never interpolate them from input
- [x] 6.5 Make the search term match display name, Discord username, submitted phone, and submitted email, case-insensitively
- [x] 6.6 Return the total matching count alongside the page so the caller can derive page count
- [x] 6.7 Implement `getDailyStatusCounts(date, options?)` as a separate aggregate over the whole date — total members, attendance submitted, update submitted, both, missing-update-only, missing-attendance-only, missing-both — and confirm the four buckets sum to the total
- [x] 6.8 Implement `listMembersMissingUpdate(date)` returning `discordUserId`, `discordUsername`, and `displayName` for current guild members only — this is Phase 6's DM target list
- [x] 6.9 List every column name the raw SQL references in a comment above each query, since a schema rename will not break `$queryRaw` at compile time
- [x] 6.10 Add a comment on the raw query recording that it depends on the `member.sync.ts` departure guard: a truncated fetch that mass-flagged members would silently shrink both the denominator and the reminder target list

## 7. Reminder Repository

- [x] 7.1 Create `src/repositories/reminder.repository.ts` with `createReminderLog({ reminderDate, message, targetCount, createdById })`
- [x] 7.2 Implement recipient creation that is idempotent on `(reminderId, memberId)`, so a retried queue job cannot add a second row for the same member
- [x] 7.3 Implement `markRecipientOutcome(reminderId, memberId, status, { errorMessage?, sentAt? })` for the `DELIVERED` / `DM_CLOSED` / `FAILED` transitions
- [x] 7.4 Implement atomic `sentCount` / `failedCount` increments on `ReminderLog` for the SSE progress read, plus a `finalizeReminderLog(reminderId)` that recomputes both counts from `reminder_recipients` and sets the terminal status — so a crashed worker cannot leave the cached counts permanently wrong
- [x] 7.5 Implement `listClosedDmRecipients(reminderId)` returning each member's `discordUserId`, for Phase 6's `#daily-update-reminder` fallback mention

## 8. Verification & Documentation

- [x] 8.1 Write a throwaway script under the scratchpad that seeds a handful of `discord_members` (including one departed), attendance rows, and multiple daily updates for one member, then run every repository helper against it
- [x] 8.2 Confirm each spec scenario holds against that data: duplicate attendance rejected, replayed message ID stored once, multi-message member appears once with one status, departed member excluded by default and included when asked, counts sum to the total, empty date returns all-zero counts with everyone in missing-both
- [x] 8.3 Run `EXPLAIN` on the aggregation for a single date and confirm the `attendance_date` and `message_date` indexes are used rather than sequential scans
- [x] 8.4 Run `bun run lint` and `bun run build` clean, then delete the seed data
- [x] 8.5 Update `CLAUDE.md`: document `src/repositories/` and the controller → service → repository rule, the `memberId` FK convention, the `String` `YYYY-MM-DD` date rule and `dhakaDate.ts` as its sole producer, and the tie between the `member.sync.ts` departure guard and aggregation correctness
