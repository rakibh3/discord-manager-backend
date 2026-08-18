## 0. Sequencing

- [x] 0.1 Confirm `multi-guild-support` is archived before archiving this change. The `daily-status-aggregation`, `reminder-broadcast` and `attendance-data-model` deltas here are written against that change's intended spec text, so archiving this one first would revert it.
- [x] 0.2 Read `openspec/changes/date-range-filtering/design.md` end to end before touching `dailyStatus.repository.ts`; the day-scope and day-facts CTEs are the whole change and everything else is plumbing.

## 1. Shared range primitives

- [x] 1.1 Add `MAX_RANGE_DAYS = 92` and a `TDateRange = { from: string; to: string; daysOfWeek?: number[] }` type to a shared location both modules import — `src/utils/dhakaDate.ts` alongside the existing date guards, not a new module.
- [x] 1.2 Add `dhakaRangeSchema` to `src/utils/dhakaDate.ts`: both ends `dhakaDateSchema`, `to >= from`, span ≤ `MAX_RANGE_DAYS`, and an optional `daysOfWeek` of unique integers 0–6. Compute the span from the two strings without constructing a timezone-carrying `Date` for anything other than the day count.
- [x] 1.3 Add a `dateOrRange` refinement helper that rejects `date` together with `from`/`to`, a lone `from` or `to`, `daysOfWeek` without a range, and neither form supplied — each with its own message naming the conflict, since Zod messages are title-cased downstream and a generic one would be useless.
- [x] 1.4 Verify by hand that `dhakaRangeSchema` accepts a 92-day span and rejects a 93-day one, and that a reversed range and a `daysOfWeek` of `[7]` are both 400s.

## 2. Range aggregation in `dailyStatus.repository.ts`

- [x] 2.1 Add `rangeDays({ from, to, daysOfWeek })` to `src/utils/dhakaDate.ts`, returning the explicit list of counted `YYYY-MM-DD` days, and a `withinCountedDays()` SQL fragment that restricts a date column to it — `BETWEEN` for the index range-scan plus `= ANY` only when weekdays are excluded. Every value bound, nothing interpolated. (Replaces the `generate_series` day-scope CTE originally planned; see design.md Decision 2.)
- [x] 2.2 Add the `day_facts` CTE: the `UNION ALL` of the attendance and daily-update sources keyed `(discord_user_id, day)`, restricted to the counted days, grouped to `has_attendance` / `has_update` per account-day. Keep it free of `guild_id` and `is_in_guild` filters and state in a comment why.
- [x] 2.3 Add `accountTotals` on top of `dayFacts`: `attendance_days`, `update_days`, `complete_days`, `active_days`.
- [x] 2.4 Add `getDailyStatusRangePage(query)` — the `statusSource` core LEFT JOINed to `accountTotals`, grouped by `dm.discord_user_id`, returning the account identity columns unchanged plus `daysInRange`, `attendanceDays`, `updateDays`, `completeDays`, `incompleteDays`, `missedBothDays`, `missedUpdateDays`, `rangeStatus`. COALESCE every count so an account with no activity is a zero row, never an absent one.
- [x] 2.5 Derive `missedBothDays` as `daysInRange - active_days`, `missedUpdateDays` as `daysInRange - update_days`, `incompleteDays` as `daysInRange - complete_days`. Do not add a second scan for any of them.
- [x] 2.6 Derive `rangeStatus` in SQL: `ALL_COMPLETE` when `complete_days = daysInRange`, `NONE` when `complete_days = 0`, else `PARTIAL`.
- [x] 2.7 Take the form contact details from the account's most recent submission inside the range (`DISTINCT ON (discord_user_id) … ORDER BY submitted_at DESC`), and note in a comment that date mode deliberately takes the earliest of that one day.
- [x] 2.8 Add `rangeStatus` and `minMissedBothDays` as outer filters on the wrapping subquery, alongside the existing search `HAVING BOOL_OR(…)` which stays exactly as it is.
- [x] 2.9 Extend `SORT_COLUMNS` with `missedBothDays`, `completeDays` and `rangeStatus`, keeping the closed `Prisma.sql` allowlist — no new interpolation path.
- [x] 2.10 Add `getDailyStatusRangeCounts(range, filters)` returning `totalMembers`, `allCompleteMembers`, `partialMembers`, `noneMembers`, `daysInRange` and the person-day totals, plus `byServer` with the same figures per server, built from the SAME `statusSource` so a filter applied to one applies to both.
- [x] 2.11 Add `getDailyStatusRangeForMember(memberId, range)` returning the account's range counts plus one entry per counted day — resolve the member back to its account first, exactly as the single-date detail read does.
- [x] 2.12 Update the file-header comment block listing the columns every `$queryRaw` depends on to include `attendances.attendance_date` and `daily_updates.message_date` in their range-scan role. This list is the only thing standing between a column rename and a silently wrong dashboard.
- [x] 2.13 Restate in the file header that combined range totals count ACCOUNTS while `byServer` counts MEMBERSHIPS, so the array still does not sum to the totals.

## 3. Reminder target selection

- [x] 3.1 Add `listReminderTargets({ from, to, daysOfWeek, criterion, minMissedDays, guildId })` to `dailyStatus.repository.ts`, built from the same `dayScope` / `dayFacts` builders as the dashboard. Do not add a second definition of "missing" anywhere.
- [x] 3.2 Return one row PER MEMBER RECORD as `listMembersMissingUpdate` does today — that is what gives each server an auditable recipient row and lets the closed-DM fallback post where the person actually is. Add `missedDays` to each row so the audit records why it was targeted.
- [x] 3.3 Keep the account-level `NOT EXISTS`/threshold keyed on `discord_user_id`, so an account that did the work anywhere is not targeted for the server it did not do it in.
- [x] 3.4 Keep `dm.is_in_guild = TRUE` and the optional `guild_id` filter on the member-record side only.
- [x] 3.5 Reimplement `listMembersMissingUpdate(date, guildId)` as a thin call into `listReminderTargets` with `from = to = date`, criterion `MISSING_UPDATE`, `minMissedDays: 1` — then verify against the old query that it returns an identical set on real data before deleting the old SQL.
- [x] 3.6 Verify the dashboard and the target list agree: filter the range page to `minMissedBothDays=2` and confirm the accounts listed are exactly the distinct accounts a target list for the same range at `MISSING_BOTH`/2 produces.

## 4. Schema and migration

- [x] 4.1 Add `ReminderCriterion { MISSING_UPDATE MISSING_BOTH }` to `prisma/schema/reminder.prisma`.
- [x] 4.2 Add `reminderStartDate`, `reminderEndDate`, `criterion`, `minMissedDays`, `daysOfWeek` to `ReminderLog`; add `@@index([reminderStartDate, reminderEndDate])`. Document that an empty `daysOfWeek` means every day counted — deliberately the opposite of `ChannelSchedule.daysOfWeek`, which rejects empty because `enabled: false` is its pause switch.
- [x] 4.3 Create migration `reminder_range_nullable`: both date columns nullable, the three criteria columns with defaults reproducing today's behaviour, the new index, and a backfill setting both dates from `reminder_date`.
- [x] 4.4 Verify on a copy of production data that no `reminder_logs` row is left with a null start or end, that every existing row has `start = end`, and that the row count is unchanged.
- [x] 4.5 Create migration `reminder_range_enforce`: set both date columns NOT NULL, drop `reminder_date` and its index.
- [x] 4.6 Run `bunx prisma generate` and confirm the project typechecks against the regenerated client.

## 5. Reminder repository

- [x] 5.1 Change `createReminderLog` to take and store the period and criteria instead of a single date.
- [x] 5.2 Replace `findActiveReminderForDate(date)` with `findActiveReminderOverlapping(from, to)`: `status IN (PENDING, PROCESSING) AND reminder_start_date <= ${to} AND reminder_end_date >= ${from}`. Note in a comment that string comparison is a valid date comparison here for the same reason the range scan is.
- [x] 5.3 Update `listReminderLogs`, `findReminderLogById` and `findRecipients` to surface the period and criteria on every read.
- [x] 5.4 Leave `ReminderRecipient`, `markRecipientOutcome(s)`, `incrementCounts`, `countPendingRecipients`, `finalizeReminderLog`, `cancelReminderLog` and `markReminderProcessing` untouched — including the `status: PENDING` and `status: PROCESSING` scoping on the last two, which is load-bearing and unrelated to this change.

## 6. Daily-status module

- [x] 6.1 Rewrite `dailyStatus.validation.ts` so all four schemas accept `date` XOR `from`+`to`, plus `daysOfWeek`, `rangeStatus` and `minMissedBothDays` in range mode and `status` in date mode only. Reuse the shared helpers from task 1, do not re-declare the guild snowflake rule four times.
- [x] 6.2 Branch in `dailyStatus.service.ts` on the mode, keeping the existing `assertConfiguredGuild` check and the existing single-date code path literally unchanged. Reject a `daysOfWeek` that leaves `daysInRange` at zero with a 400 naming the range and the weekday set.
- [x] 6.3 Have every range response carry `mode: 'range'`, `from`, `to`, `daysOfWeek` and `daysInRange`; have every date response carry `mode: 'date'` and `date`. Convert every BigInt to a JSON number in the service, as the single-date path already does.
- [x] 6.4 Extend the export to write the range header row and range columns when in range mode, leaving the single-date header byte-identical, and name the file after the range.
- [x] 6.5 Extend `/members/:memberId` to return the per-day breakdown and the range's merged message timeline in range mode.
- [x] 6.6 Leave `dailyStatus.routes.ts` unchanged apart from the schemas — no new routes; range is a mode of the existing four.

## 7. Reminder module

- [x] 7.1 Extend `sendReminderValidationSchema` with `from`/`to`, `daysOfWeek`, `criterion` (default `MISSING_UPDATE`) and `minMissedDays` (integer ≥ 1, default 1), reusing the shared range schema so the cap and the future-end rule cannot drift from the dashboard's.
- [x] 7.2 Extend `targetsQueryValidationSchema` with the identical fields, so the preview cannot be computed from criteria the send would reject.
- [x] 7.3 Update `selectTargets` and `previewTargets` in `reminder.service.ts` to pass the period and criteria through to `dailyStatusRepository.listReminderTargets`, keeping the routing through that repository rather than assembling a count locally.
- [x] 7.4 Replace the same-date conflict check with the overlap check, and make the 409 message name the conflicting run's id and its period so an admin can find and cancel it.
- [x] 7.5 Keep the guard order exactly as it is — Redis first, then the overlap conflict, then the empty-target refusal — and keep the Redis check before anything is written.
- [x] 7.6 Store the period and criteria on the log at creation, and surface them on `GET /api/reminders/:id`, `GET /api/reminders/status` and the history list.
- [x] 7.7 Leave the queue untouched: the payload stays identity-only, the job ID stays `<reminderId>__<discordUserId>` with no `:`, grouping by account stays, and the message is still read from the log row inside the job.
- [x] 7.8 Confirm the closed-DM fallback still groups by `guildId` and still sets `allowedMentions: { parse: [], users: … }` — nothing in this change may touch that path.

## 8. Verification

- [x] 8.1 Seed a three-day window with a known mix: an account complete on all three, one complete on two, one that submitted attendance only, and one that did nothing. Confirm every per-day count and every rollup status by hand against the seeded data.
- [x] 8.2 Confirm the attendance-only account has `incompleteDays = 3` and `missedBothDays = 0`, and is therefore NOT targeted at `MISSING_BOTH`/1 but IS targeted at `MISSING_UPDATE`/1. This is the distinction the whole design turns on.
- [x] 8.3 Confirm an account in two servers appears once with both servers listed, that posting in one server credits the day in both, and that a `guildId` filter changes who is listed without changing anyone's counts.
- [x] 8.4 Confirm a `daysOfWeek` set excluding a day removes it from `daysInRange` and from every account's missed counts, and that a set matching no day is a 400.
- [x] 8.5 Confirm the combined range totals do not equal the sum of `byServer` when anyone is in two servers, and that the gap is exactly the overlap.
- [x] 8.6 Confirm the overlap guard: start a run for 16–18 August, then attempt 18–20 August, a single 17 August, and 19–21 August; the first two are 409 and the third succeeds.
- [x] 8.7 Confirm every single-date request — page, counts, export, member detail, reminder send, reminder targets — returns exactly what it returned before this change, field for field.
- [x] 8.8 Time a 92-day range page and counts request against a full-size directory and record the numbers; confirm the query count is unchanged from a one-day request.
- [x] 8.9 Confirm a reversed range, a 93-day range, a future range end, and a `date` supplied together with `from` are each a 400 with a message naming the specific problem.

## 9. Documentation

- [x] 9.1 Add the range parameters, the range row shape, the range counts shape, and the reminder criterion and threshold to `API_INTEGRATION.md`, including a worked "missed two of the past three days" example.
- [x] 9.2 State plainly in the docs that `daysOfWeek` is the administrator's assertion about which days counted, not a record of when the channel was actually open, and that no such record exists.
- [x] 9.3 Add range requests for all four dashboard endpoints and both reminder endpoints to `postman-collection.json`.
- [x] 9.4 Update the "Dates and the attendance domain" and "Reminder DM queue" sections of `CLAUDE.md` with the range mode, the two distinct missed-day figures, the criterion default and why it is `MISSING_UPDATE`, and the overlap guard.
