## Context

Two features read the same two tables to answer "did this person do their work": `dailyStatus.repository.ts` renders the dashboard, and its `listMembersMissingUpdate` produces the reminder DM target list. Both take exactly one `date: string`. Every query in that file is `$queryRaw`, groups by `discord_user_id` (one row per PERSON, not per membership), and credits work done in ANY server to the account everywhere — the "one Discord account is one person, one person owes one day's work" rule from CLAUDE.md.

Widening `date` to `from`/`to` touches every query in that file plus the reminder log's schema, because the log currently stores one `reminder_date`. The constraint that decides most of this design is that the dashboard and the DM must never disagree about who is behind: they already derive it from the same two tables the same way, and that has to stay true when "behind" becomes a count over a span.

Constraints inherited and not up for renegotiation here:

- Civil dates are `String` `YYYY-MM-DD` in Asia/Dhaka. They sort and range-scan lexicographically, which is what makes `BETWEEN ${from} AND ${to}` correct without a cast. Never a `DateTime`, never `now()` inside SQL.
- The credit sources are keyed on `discord_user_id` with no `guild_id` and no `is_in_guild` filter. A server filter selects who is LISTED, never what their status IS.
- Combined totals count accounts; `byServer` counts memberships; the two do not sum, and that gap is the overlap.
- Reminder sends are irreversible mass DMs against a single global bot budget. Every widening of the target set is a widening of the blast radius.

## Goals / Non-Goals

**Goals:**

- A date-range mode on all four daily-status endpoints, alongside the existing single-date mode, with the single-date mode's responses byte-identical to today's.
- Per-person per-day counts over a range, with a rollup status, in a bounded number of queries — never one query per day and never one per member.
- An admin-selectable set of weekdays that count inside a range, so days the programme does not run are not held against anyone.
- Reminder broadcasts targeted at a range with a missed-day threshold, so "missed two of the past three days" is expressible, with the target set visible on the dashboard before it is sent.
- One shared derivation behind the dashboard number and the DM target list.

**Non-Goals:**

- No change to single-date reminder behaviour. Today's send targets accounts missing a daily update; that stays the default (see Decision 6).
- No new placeholders or templating in the reminder message. The message stays admin-supplied free text.
- No history for `channel_schedules`. Which weekdays count comes from the request, not from a reconstruction of what the schedule was on a past day.
- No change to `ReminderRecipient`, the queue payload, the per-account DM grouping, the closed-DM fallback, the rate limiter, or `GET /api/attendance/window`.
- No SSE progress stream. That is still the separate outstanding piece named in CLAUDE.md.

## Decisions

### 1. `from`/`to` is a second mode, not a replacement for `date`

The four dashboard endpoints and the two reminder endpoints accept **either** `date` **or** `from`+`to`, never both, never a lone `from`. Both supplied, or only one of the pair, or `to < from`, is a 400 naming the conflict.

The response carries an explicit `mode: 'date' | 'range'` and echoes the parameters it resolved, because the row shape differs between the two and a client must not have to infer which it received from the presence of a field.

_Alternative rejected:_ making `date` sugar for `from = to = date` and returning the range shape always. It is the smaller amount of code and the larger amount of breakage — every existing consumer of `status`, and the export's CSV header, would change on a release that was supposed to add a feature. The single-date path is also genuinely a different question ("what is the state of today"), and its four-bucket status is the right answer to it.

### 2. The counted-day set is enumerated in TypeScript and bound into SQL

`rangeDays({ from, to, daysOfWeek })` in `src/utils/dhakaDate.ts` returns the explicit list of `YYYY-MM-DD` days that count. That array is bound into every range query as a parameter, and the queries restrict their date columns to it.

The weekday is computed from the civil date through `Date.UTC`, exactly as `getDhakaWeekday` already does, so the numbering is 0-is-Sunday — the **same numbering** `channel_schedules.daysOfWeek` uses, the same cron uses, and the same Postgres's `EXTRACT(DOW …)` would give. One array feeds every consumer with no translation layer to get backwards.

`daysInRange` is the length of that array. It is returned in every range response and is the denominator of every figure below; an admin who cannot see it cannot check the arithmetic.

_Alternative rejected:_ building the day set in SQL with `generate_series(${from}::date, ${to}::date, interval '1 day')` filtered by `EXTRACT(DOW FROM d)`. It works, but it puts a second definition of "which days count" in SQL that has to be kept in step with the one in the service — which needs the count anyway, to reject a weekday set that leaves no days. Enumerating once in the module that is already the single producer of Dhaka civil dates gives one definition, makes `daysInRange` known before any query runs (so the zero-day rejection costs nothing and every derived figure is arithmetic against a bound integer rather than a scalar subquery), and keeps timezone reasoning out of SQL entirely. The 92-day cap is what keeps the bound array small.

Within the queries, the restriction is expressed as `BETWEEN ${from} AND ${to}` — which is what the existing single-column indexes on `attendances.attendance_date` and `daily_updates.message_date` range-scan on — plus `= ANY(${days})` to prune the excluded weekdays. When no weekday is excluded the `ANY` is omitted rather than enumerating every day for nothing.

_Alternative rejected:_ deriving the counted weekdays from the `channel_schedules` row. The schedule is one mutable row with no history, so judging last month by today's weekday setting produces a number that silently changes when an admin edits the schedule, on a screen whose whole purpose is a stable historical record. The admin picking the days is both honest and, per their answer, what they want.

_Alternative rejected:_ counting every calendar day always. If the programme is closed on Fridays, every student "misses" every Friday and the threshold becomes meaningless. Omitting `daysOfWeek` still gives exactly this behaviour for anyone who wants it.

### 3. Per-day facts are aggregated once per account, without a cross join

The credit sources widen from a single date to a range and gain the day as a second key. Still no `guild_id`, still no `is_in_guild`:

```sql
day_facts AS (
  SELECT discord_user_id, day,
         BOOL_OR(kind = 'A') AS has_attendance,
         BOOL_OR(kind = 'U') AS has_update
  FROM (
    SELECT o.discord_user_id, a.attendance_date AS day, 'A' AS kind
      FROM attendances a JOIN discord_members o ON o.id = a.member_id
     WHERE a.attendance_date BETWEEN ${from} AND ${to}   -- plus = ANY(${days}) when weekdays are excluded
    UNION ALL
    SELECT o.discord_user_id, du.message_date AS day, 'U' AS kind
      FROM daily_updates du JOIN discord_members o ON o.id = du.member_id
     WHERE du.message_date BETWEEN ${from} AND ${to}
  ) t
  GROUP BY discord_user_id, day
)
```

Collapsed to one row per account:

```sql
account_totals AS (
  SELECT discord_user_id,
    COUNT(*) FILTER (WHERE has_attendance)                  AS attendance_days,
    COUNT(*) FILTER (WHERE has_update)                      AS update_days,
    COUNT(*) FILTER (WHERE has_attendance AND has_update)   AS complete_days,
    COUNT(*)                                                AS active_days
  FROM day_facts GROUP BY discord_user_id
)
```

The two remaining figures are arithmetic against `daysInRange`, not another scan:

- `missedBothDays = daysInRange − active_days` — days the account did **neither**.
- `missedUpdateDays = daysInRange − update_days` — days with no daily update, whatever attendance says.
- `incompleteDays = daysInRange − complete_days` — days not fully done.

An account with no activity has no `account_totals` row, so the outer LEFT JOIN coalesces to zero and `missedBothDays` becomes `daysInRange`. That is the worst case and it must appear at the top of the list, never be filtered out by an inner join.

_Alternative rejected:_ `CROSS JOIN` every in-scope account against `day_scope` to materialise a row per person per day. It is a more obvious query and it is 5,000 × 92 = 460,000 rows to aggregate on every dashboard load, for facts that are already sparse. The subtraction gives the same answers because the counted-day list bounds both sides.

The existing indexes on `attendances(attendance_date)` and `daily_updates(message_date)` serve the range scan; neither needs to change.

### 4. `missedBothDays` and `incompleteDays` are BOTH reported, and they are different numbers

The reminder's threshold counts days the person did **neither** — the admin's stated rule. That is not the same as "days they were not fully done": someone who submits attendance daily and never posts an update has `incompleteDays = daysInRange` and `missedBothDays = 0`.

Both are returned, named apart, because the dashboard is where an admin decides what to send. A screen that showed only one of them would let them set `minMissedDays: 2` while reading a column that counts something else, and the first they would learn of it is the size of the broadcast. This is the same "dashboard and DM must agree on missing an update" rule from CLAUDE.md, extended: the column the threshold acts on is on screen under its own name.

The rollup status is derived from `complete_days` alone:

| `rangeStatus` | condition |
| --- | --- |
| `ALL_COMPLETE` | `complete_days = daysInRange` |
| `NONE` | `complete_days = 0` |
| `PARTIAL` | otherwise |

`daysInRange = 0` (every day excluded by `daysOfWeek`) is refused as a 400 rather than making everyone `ALL_COMPLETE` by vacuous truth.

### 5. Range filters are the range's own vocabulary, not the four single-day buckets

In range mode `status` is rejected and `rangeStatus` (`ALL_COMPLETE|PARTIAL|NONE`) takes its place; in date mode the reverse. Range mode additionally accepts `minMissedBothDays`, applied to the same computed column the reminder thresholds on — so the admin previews the exact target set on the dashboard, in the list they already know how to read, before opening the send dialog.

`search` keeps its `HAVING BOOL_OR(…)` form for the reason it already has one: nicknames are per server, and a `WHERE` would drop a person's second membership from their own row. `guildId`, `includeDeparted`, paging, and the per-server breakdown are unchanged in meaning.

`sortBy` gains `missedBothDays`, `completeDays`, and `rangeStatus`, added to the same closed `Prisma.sql` allowlist — sort input is still never interpolated.

Form contact details (`name`/`email`/`phone`/`submittedAt`) in range mode come from the account's **most recent** submission inside the range (`DISTINCT ON … ORDER BY submitted_at DESC`), where date mode takes that day's earliest. These are contact details for reaching a student, so the freshest wins.

### 6. The reminder criterion is explicit and defaults to today's behaviour

`POST /api/reminders/send` gains `criterion: 'MISSING_UPDATE' | 'MISSING_BOTH'`, defaulting to `MISSING_UPDATE`, and `minMissedDays` (integer ≥ 1, default 1).

- `MISSING_UPDATE` + `date` is exactly today's broadcast, unchanged.
- `MISSING_BOTH` + `from`/`to` + `minMissedDays: 2` over three days is the admin's stated case.

Making `MISSING_BOTH` the single universal rule was considered and rejected. It would silently narrow the existing daily broadcast: a student who fills the attendance form and never posts an update would stop being reminded, and the daily-update channel is the thing the reminder exists to drive. That is a regression dressed as a default. Both criteria are persisted on the run, so the audit says which rule produced which recipient list. If a uniform rule is wanted later it is a change of one default value.

The threshold and criterion are applied inside the shared aggregation, so `GET /api/reminders/targets` and `POST /api/reminders/send` and the dashboard's `minMissedBothDays` filter are three callers of one query. The target list still returns **one row per member record** — that contract is unchanged, because it is what gives each server an auditable recipient row and lets the closed-DM fallback post where the person actually is. The queue still groups by `discordUserId`, so it is still one DM per account.

### 7. `reminder_logs` stores a span and its criteria, replacing `reminder_date`

```
reminderStartDate  String   @map("reminder_start_date")   // YYYY-MM-DD
reminderEndDate    String   @map("reminder_end_date")     // YYYY-MM-DD
criterion          ReminderCriterion @default(MISSING_UPDATE)
minMissedDays      Int      @default(1) @map("min_missed_days")
daysOfWeek         Int[]    @default([]) @map("days_of_week")
@@index([reminderStartDate, reminderEndDate])
```

A single-date send stores `start = end = date`. `reminder_date` is dropped rather than kept alongside: a third column holding a value derivable from the other two is a copy that can disagree, and CLAUDE.md's rule against a second `guild_id` on child tables is the same rule.

`daysOfWeek` empty means "every day in the span counted", mirroring the omitted query parameter. This is deliberately the opposite of `ChannelSchedule.daysOfWeek`, where an empty array is rejected because pausing is what `enabled: false` is for — here there is no second switch and no ambiguity, since a run that counted no days could not have existed.

The criteria are stored for the same reason the message is: the run's audit record must say what it did, and recomputing "who would this have targeted" from today's data would give a different answer as members join and leave.

### 8. The conflict guard becomes an overlap check

`findActiveReminderForDate(date)` becomes `findActiveReminderOverlapping(from, to)`:

```sql
status IN ('PENDING','PROCESSING')
  AND reminder_start_date <= ${to}
  AND reminder_end_date   >= ${from}
```

String comparison is a valid date comparison for `YYYY-MM-DD`, the same property the range scan relies on.

The guard exists to protect the bot's single global DM budget, and that budget does not care what span a run covers — two overlapping 40-minute blasts are still two blasts at once. The 409 names the conflicting run's id and its span, so an admin can find and cancel it rather than guessing which date is blocked.

### 9. The range is capped, on both paths

`to` may not precede `from`; `to` may not be in the future on the reminder path (today's rule, retained); and the span is capped at **92 days** on every endpoint. The cap is not about query cost — it is that `from`/`to` on the reminder path is a blast-radius control, and a typo'd year on an irreversible mass DM must be a validation error rather than a broadcast. The dashboard shares the cap so the preview an admin looks at is always a range they can actually send.

### 10. Every new query stays in `dailyStatus.repository.ts`

The range aggregation, the range counts, the per-account per-day breakdown, and the reminder target query are all built from one shared `day_scope` / `day_facts` CTE pair in that file. The reminder service continues to reach the target list through `dailyStatusRepository` rather than assembling a convenience count of its own — the existing rule, and the reason the dashboard and the DM agree today.

The comment block listing the columns each `$queryRaw` depends on gains the new ones. `$queryRaw` does not break at compile time on a rename, so that list is the only thing standing between a column rename and a silently wrong dashboard.

## Risks / Trade-offs

- **A widened reminder is a wider mass DM.** A three-day range at `minMissedDays: 1` targets strictly more people than any single day in it. → The threshold defaults to 1 but the criterion defaults to `MISSING_UPDATE`, so no existing call widens by itself; `GET /api/reminders/targets` accepts the identical parameters and must be the shape the UI shows before the send; the dashboard exposes `minMissedBothDays` so the same set is visible in the list; the span is capped; the overlap guard prevents two runs at once.
- **`missedBothDays` and `incompleteDays` look interchangeable and are not.** An admin who conflates them sets a threshold against the wrong column. → Both are returned under distinct names, `criterion` is echoed in the send response and stored on the run, and the response never returns a bare `missedDays`.
- **`daysOfWeek` is per request, so two admins can compute different numbers for the same span.** → Every range response echoes the `daysOfWeek` it used and the resulting `daysInRange`; every reminder run persists the array it ran with. The figure is always accompanied by its denominator.
- **The migration drops a column.** A rollback after `reminder_date` is gone loses the old shape. → Split into two migrations: the first is purely additive and backfills, and the deployment can sit there indefinitely; the second enforces and drops. Verify on a copy of production between them.
- **Range queries scan more of `attendances` and `daily_updates` than a single day.** A 92-day range over ~5,000 members is bounded, uses the existing date indexes, and aggregates before returning — but it is not the same cost as one day. → Measure the 92-day worst case before enabling long ranges in the UI; the query count per request stays fixed at two regardless of span.
- **Rollup status hides the shape of a range.** `PARTIAL` covers "missed one day of thirty" and "missed twenty-nine of thirty". → The counts are on the same row, and sorting by `missedBothDays` is what the admin actually acts on; the rollup is a badge, not the report.
- **The `#daily-update` channel's real open days are still not recorded anywhere.** `daysOfWeek` is the admin's assertion about the past, not evidence. → Documented as such in the API docs and in the repository header; a schedule-history table is a separate change if the assertion turns out to be wrong often.

## Migration Plan

1. Add the five columns to `ReminderLog` as a migration that is **additive only**: `reminder_start_date` and `reminder_end_date` nullable, `criterion` / `min_missed_days` / `days_of_week` with defaults that reproduce today's behaviour. Add the span index.
2. Backfill in the same migration: `reminder_start_date = reminder_date`, `reminder_end_date = reminder_date`, for every existing row.
3. Verify on a copy of production data that no `reminder_logs` row is left with a null start or end, that every row has `start = end`, and that the row count is unchanged.
4. Second migration: set both date columns `NOT NULL`, drop `reminder_date` and its index.
5. `bunx prisma generate` and confirm the project typechecks against the regenerated client.

Rollback: between steps 1 and 4 the old column is still present and authoritative, so reverting the application code is sufficient. After step 4, rollback requires re-adding `reminder_date` and backfilling it from `reminder_end_date` — lossless for every row written by the old code, and lossy only for genuinely multi-day runs, which the old code could not have represented anyway.

## Open Questions

- Should the 92-day cap be configurable, or is a constant enough until an admin asks for a longer window?
- Should the range export include a per-day matrix (one column per date) rather than the summary counts? The summary is what the dashboard shows; a matrix is what a spreadsheet user may actually want, and it is a bigger CSV writer than this change assumes.
- Does the range detail route need the full per-day breakdown for a member, or only the days they missed? The full breakdown is bounded by the span cap, so it is affordable, but most of it is rows saying "fine".
