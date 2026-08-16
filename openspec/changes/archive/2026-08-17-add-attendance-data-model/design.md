## Context

After Phase 1 the schema holds four tables: `users` (admin login accounts), `refresh_tokens`, `profiles`, and `discord_members` (the synced guild directory, ~2,200 rows today, sized for ~5,000). The attendance domain does not exist. Phase 2 adds it.

Constraints that shape the design:

- **The PID's `User` is this repo's `DiscordMember`.** PID §10 lists a single `User` model that merges the synced Discord member with form-submitted contact details. Phase 1 deliberately split those: `users` is the ADMIN account with a password, `discord_members` is the directory that never authenticates. Every `userId` in the PID's schema listing therefore becomes `memberId → discord_members.id` here.
- **Not every consumer is HTTP-scoped.** Phase 4 writes `DailyUpdate` rows from a `messageCreate` gateway handler inside `src/lib/discord/`. Phase 6 writes `ReminderRecipient` rows from a BullMQ worker. Neither has a `req`, so neither belongs behind a module service — but both must share the same queries as the Phase 3 and Phase 7 HTTP paths.
- **Scale and shape of reads.** The dashboard's primary read is "status of every member for one date" over ~5,000 members. PID §11 already specifies this as one SQL statement; the anti-pattern to avoid is a per-member query loop.
- **Existing conventions.** Split Prisma schema files under `prisma/schema/`, the `prisma-client` generator emitting to gitignored `generated/prisma`, the `@/*` and `@generated/*` aliases, `AppError` plus the central `globalErrorHandler` (which already maps P2002 → duplicate, P2003 → FK, P2025 → not found), and the shared `prisma` singleton from `@/lib/prisma`.
- **Golden Rules that are database concerns.** Rule 5 (all dates in `Asia/Dhaka`), Rule 7 (uniqueness on `discord_message_id` and `(member, date)`), and Rule 1 (snowflake is the DM identity) all land in this change.

## Goals / Non-Goals

**Goals:**

- A complete attendance-domain schema whose constraints make every write in Phases 3–6 safe to retry without a read-then-write check.
- One shared, typed data-access layer both the Express modules and the bot can call, so the same query is never written twice.
- Daily status derivable for the whole directory in a bounded number of queries, with the indexes that keep it that way.
- A single definition of "today" that no consumer can accidentally bypass.
- History that stays complete and attributable after a member leaves the guild.

**Non-Goals:**

- Any HTTP endpoint, Zod request schema, route, or controller. Phase 3 and Phase 7.
- The `messageCreate` listener and its ✅ reaction. Phase 4.
- Redis, BullMQ, the rate limiter, and DM sending. Phase 6.
- CSV/Excel serialization. The repository returns rows; Phase 7 formats them.
- Backfilling historical attendance. There is none — this is the first day of the domain.
- Partitioning, archival, or retention policies. At ~5,000 members × one row per day, `attendances` grows by ~1.8M rows/year at full participation; well within a single unpartitioned table for years.

## Decisions

### 1. Foreign keys point at `DiscordMember`, and the field is named `memberId`

```prisma
memberId String        @map("member_id")
member   DiscordMember @relation(fields: [memberId], references: [id], onDelete: Cascade)
```

*Why:* Phase 1 already resolved the `User` name collision, and CLAUDE.md records the rule ("Attendance/daily-update FKs belong on `DiscordMember`"). Naming the field `userId` while it points at `discord_members` would be a permanent readability trap — every future reader would have to remember which `User` is meant.

*Alternative considered:* keep `userId` for literal fidelity to PID §10. Rejected: the PID's `userId` refers to the PID's merged `User`, which does not exist here. Fidelity to the name would cost fidelity to the meaning.

*Consequence:* the PID §11 aggregation SQL becomes `FROM discord_members dm ... ON dm.id = a.member_id`. Called out in the tasks so it is transcribed, not copied.

### 2. `onDelete: Cascade` on member-owned records, `SetNull` on the admin author

Attendance, daily updates, and reminder recipients cascade from their member. This is not a way members get deleted — `discord-member-sync` guarantees departures are flagged, never deleted — it is a safety net so a row can never outlive its owner and orphan the join.

`ReminderLog.createdById` is nullable with `onDelete: SetNull`: deleting a retired admin must not delete the audit trail of broadcasts they sent.

`ReminderRecipient` cascades from `ReminderLog` (deleting a session removes its recipients) *and* from `DiscordMember`.

### 3. Civil dates stay `String` in `YYYY-MM-DD`, not `DateTime @db.Date`

*Why:* the value is a Dhaka-local civil date, not an instant. Stored as `DateTime`, Prisma and `@prisma/adapter-pg` would round-trip it through a JS `Date`, which carries a timezone — the classic source of a submission at 23:58 Dhaka landing on the wrong day when the server runs in UTC. A `String` cannot be silently shifted by a driver. It sorts and range-scans correctly (`YYYY-MM-DD` is lexicographically ordered), indexes identically, and equality-matches exactly what the PID specifies.

*Trade-off:* no database-level date arithmetic. Month or week ranges become `attendanceDate >= '2026-08-01' AND attendanceDate <= '2026-08-31'` string comparisons, which is correct for this format but reads less naturally. Accepted — every query in the PID is either a single date or a contiguous range.

*Mitigation for the real risk (a malformed string reaching the column):* `src/utils/dhakaDate.ts` is the only producer, and a Zod `.regex()` plus a real-calendar check validates any date arriving from a request or a query parameter.

### 4. `src/utils/dhakaDate.ts` derives dates with `Intl.DateTimeFormat`, not a date library

```ts
export const DHAKA_TIMEZONE = 'Asia/Dhaka';
export const getDhakaDate = (instant: Date = new Date()): string => // 'en-CA' yields YYYY-MM-DD
  new Intl.DateTimeFormat('en-CA', { timeZone: DHAKA_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
```

*Why:* Node 20's full-ICU build gives correct `Asia/Dhaka` conversion with no dependency, and `en-CA` formats as `YYYY-MM-DD` by locale definition. `date-fns-tz` or `luxon` would add a dependency to do the same thing.

*Alternative considered:* a fixed `UTC+6` offset. Rejected on principle even though Bangladesh currently observes no DST — hard-coding an offset means a future DST decision silently corrupts the day boundary. The IANA zone is the durable form.

*Deliberately taking an `instant` parameter:* Phase 4 must attribute a message to `message.createdAt`, not to now, and Phase 6 runs after midnight for the day that just closed. A no-argument-only helper would push callers to reimplement the conversion.

### 5. Enums in Prisma, not free-text status strings

PID §10 types every status as `String` with the allowed values in a comment. This repo already uses Prisma enums (`UserRole`, `UserStatus`), and the generated union types make an invalid status a compile error rather than a runtime surprise.

```prisma
enum AttendanceStatus       { PRESENT LATE EXCUSED }
enum ReminderStatus         { PENDING PROCESSING COMPLETED FAILED }
enum ReminderDeliveryStatus { PENDING DELIVERED DM_CLOSED FAILED }
```

`AttendanceStatus` keeps `PRESENT` as the default; `LATE` and `EXCUSED` are included now because adding an enum value later is a migration, and these are the two the dashboard will plausibly want. `ReminderDeliveryStatus` adds `PENDING` to the PID's three — a recipient row is created when the broadcast is queued and only reaches a terminal state when its job runs, so there must be a state for "queued, not yet attempted".

*Derived status (`COMPLETE` / `MISSING_UPDATE` / …) is deliberately not an enum column.* It is computed from the presence of rows, never stored — storing it would create a value that goes stale the moment a late message arrives.

### 6. `src/repositories/` as a shared data-access layer

New directory, one file per aggregate:

```
src/repositories/
  attendance.repository.ts    createAttendance, findAttendanceByMemberAndDate, listAttendanceByDate
  dailyUpdate.repository.ts   createDailyUpdate (idempotent), hasUpdateOnDate, listUpdatesByMemberAndDate
  reminder.repository.ts      createReminderLog, upsertRecipient, markRecipientOutcome, incrementCounts, listClosedDmRecipients
  dailyStatus.repository.ts   getDailyStatusPage, getDailyStatusCounts, listMembersMissingUpdate
```

*Why a new layer at all:* CLAUDE.md's module pattern puts Prisma access in `*.service.ts`. That rule assumes an HTTP-scoped caller. Phase 4's gateway handler and Phase 6's queue worker are not, and `src/lib/discord/` already lives outside the module pattern for exactly that reason. The two bad alternatives are the bot importing `attendanceService` (dragging HTTP-shaped `AppError` semantics into a gateway handler) or each caller writing its own Prisma query (two definitions of "has this member submitted today", guaranteed to drift).

*The rule this establishes:* controllers never touch Prisma (unchanged); services own business rules and delegate persistence to repositories; repositories own Prisma and nothing else — no `AppError`, no HTTP status codes, no `req`. A repository returns data or `null`; deciding that `null` is a 404 stays in the service. This needs a CLAUDE.md update in the same change so the convention is documented where the next reader looks.

### 7. Daily status aggregation: one raw SQL query via `$queryRaw`

PID §11's statement, adapted to `discord_members`, run through `prisma.$queryRaw` with parameterized date and filter values.

*Why raw SQL over Prisma's query builder:* the shape is a `LEFT JOIN` against two date-filtered subqueries producing a computed `CASE` column. Prisma's fluent API cannot express a derived status column, so the alternatives are (a) three queries plus an in-memory join over 5,000 rows in Node, or (b) a raw query. The raw query is what the PID specifies, keeps the work in Postgres where the indexes are, and returns exactly the rows the dashboard renders.

*Why this is acceptable despite losing Prisma's type inference:* the row shape is declared once as a TypeScript interface next to the query, and `$queryRaw` tagged templates are parameterized, so there is no injection surface. Filter and sort values that cannot be parameters (column names, sort direction) are mapped from a closed allowlist, never interpolated from input.

*Counts:* a second, separate aggregate query rather than counting the page result in Node — the counts must describe the whole date, not the current page.

*The `DISTINCT` matters:* a member with three messages must not multiply into three rows. The daily-update side joins a `SELECT DISTINCT member_id FROM daily_updates WHERE message_date = $1` subquery, not the table.

### 8. Indexes chosen for the four real access paths

| Table | Index | Serves |
|---|---|---|
| `attendances` | `@@unique([memberId, attendanceDate])` | duplicate prevention, and the per-member "already submitted today?" lookup in Phase 3's verify endpoint |
| `attendances` | `@@index([attendanceDate])` | the date-filtered join side of the aggregation |
| `daily_updates` | `@unique(discordMessageId)` | Golden Rule 7 idempotent ingestion |
| `daily_updates` | `@@index([messageDate])` | the date-filtered `DISTINCT` subquery |
| `daily_updates` | `@@index([memberId, messageDate])` | the user-detail modal's "this member's messages on this day" |
| `reminder_logs` | `@@index([reminderDate])` | broadcast history for a date |
| `reminder_recipients` | `@@unique([reminderId, memberId])` | retry idempotency |
| `reminder_recipients` | `@@index([reminderId, status])` | the closed-DM fallback list and live progress counts |

No index is added speculatively for the Phase 7 search term — search runs over the already-joined result set, and a trigram index is a decision to make with a real slow query in hand, not before the feature exists.

### 9. Denormalized name / phone / email on `Attendance`

The form's four fields are stored on the attendance row itself, not resolved from `discord_members` at read time.

*Why:* they are a point-in-time declaration. A student who corrects their phone number in October must not retroactively change what September's export says they submitted. Phase 3 will *also* update the member's `email` / `phone` (the columns Phase 1 already added for this) so the directory holds the latest known contact details — the two serve different purposes and both are wanted.

### 10. Delivery counts on `ReminderLog` are incremented, not recomputed

`sentCount` / `failedCount` are maintained with atomic `increment` writes as jobs complete, so the SSE progress bar in PID §13.2 reads one small row instead of aggregating `reminder_recipients` on every poll. They are a cache of the recipient rows, which remain the source of truth; a final reconciliation at broadcast completion sets the counts from the recipient table so a crashed worker cannot leave them permanently wrong.

## Risks / Trade-offs

- **The departure guard is now load-bearing for real data.** A truncated `guild.members.fetch()` that mass-flagged members departed would previously have corrupted only the directory; with attendance rows in place it also silently shrinks the dashboard's denominator and empties the reminder target list. → The guard in `member.sync.ts` (skip reconcile below 50% of the stored active count) already exists and must not be removed. This change adds a note to CLAUDE.md tying the guard to the aggregation's correctness, so the connection is visible to whoever next edits sync.
- **Raw SQL drifts from the Prisma schema silently.** Renaming a column in `schema.prisma` will not break `$queryRaw` at compile time. → Every column the raw query names is listed in a comment above it, and the tasks include running the query against a seeded database before the change is considered done.
- **`String` dates permit a malformed value at the database level.** Postgres will happily store `'not-a-date'`. → `dhakaDate.ts` is the sole producer and a shared Zod schema validates any externally supplied date. A `CHECK` constraint was considered and rejected as a second place to maintain the format.
- **`onDelete: Cascade` would destroy history if a member row were ever deleted.** → Nothing in the codebase deletes a `DiscordMember`, and `discord-member-sync` specifies departures as flag-only. The cascade exists to prevent orphans, not as an expected path. A manual `DELETE` from a psql session remains destructive; that is true of any table.
- **The `repositories/` layer adds indirection for the simple HTTP cases.** Phase 3's submit path now goes controller → service → repository where controller → service would have sufficed. → Accepted: the cost is one thin file per aggregate, and it is what stops Phase 4's bot code from duplicating queries.
- **`attendances` grows unboundedly.** ~1.8M rows/year at full participation. → Not a problem at this scale within the project's horizon; the date index keeps single-day reads flat. Revisit if a multi-year range report becomes a requirement.

## Migration Plan

1. Add the two schema files and the relation fields on `DiscordMember` and `User`; `bunx prisma generate` and confirm the new models and enums are importable from `@generated/prisma/client`.
2. `bunx prisma migrate dev --name add_attendance_domain` and read the generated SQL — every unique and index from decision 8 must be present, and the migration must contain no `DROP` against an existing table.
3. Deploy is additive: four new tables, three new types, and nullable relation columns only. No existing table is altered in a way that affects running code, so the migration can be applied before the new code ships.
4. Rollback: no production data exists in these tables yet, so a rollback is `DROP TABLE` on the four new tables and their enums. Once Phase 3 is live and real submissions exist, rollback stops being safe and forward-fix is the only option — worth noting because this is the last change where dropping is free.

## Open Questions

- **Late-submission policy.** `AttendanceStatus.LATE` exists in the enum but nothing sets it — the PID defines no cutoff for a late attendance submission (the 6 PM–11:59 PM window in §7 governs the Discord channel, not the web form). Phase 3 needs an answer; the column is ready either way and the default `PRESENT` is correct until then.
- **Retention of message content.** `DailyUpdate.message` stores full message text indefinitely. If a policy on deleting or redacting message content after N months is wanted, it is cheaper to decide before Phase 4 starts writing rows than after.
