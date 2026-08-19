## Why

The roster answers "who enrolled" and `discord_members` answers "who is present in a server", and today nothing connects the two. An administrator can see that 4,800 accounts are missing a daily update and that 5,000 people are enrolled, but cannot answer the question the program actually runs on: **which enrolled people are doing the work, and which have gone dark.**

The gap is worst for the people who matter most. A student who never submits attendance never supplies a Discord handle, so they exist only as an email address — invisible to every dashboard figure, absent from every reminder target list, and indistinguishable from someone who enrolled and never joined Discord at all. The reminder broadcast cannot reach them, because a DM needs an account and no account is known. They are precisely the cohort that has stopped participating, and they are the one cohort the system currently cannot name.

The submission payload already carries both halves of the pair — an enrolled email address and a Discord handle, in the same request. The link is being thrown away on every submission. Recording it turns the roster from a gate into a directory, and makes "enrolled but unreachable" a list an administrator can act on instead of a silence.

## What Changes

- **A roster entry gains a nullable Discord account.** `roster_entries` gets `discord_user_id` (unique, nullable) and `linked_at`. The column holds a Discord **account** snowflake, never a `discord_members.id` — one account is one person across every configured server, the same key the whole dashboard is grouped on. No foreign key, because `discord_user_id` is unique per server in `discord_members` and not globally.
- **The link is learned from an accepted attendance submission, as a best-effort side effect.** `POST /api/attendance/submit` already resolves an email to a roster entry and a handle to member rows; after the attendance write commits, the pairing is recorded. **The linking step can never fail, delay, or alter the submission outcome** — a student's attendance is not held hostage to bookkeeping.
- **First observation wins, and a conflicting one is discarded rather than merged.** An entry already linked to a different account is left alone; an account already linked to a different entry does not steal a second one. The unique constraint is what enforces it, not a read-then-write check.
- **The link is observational only and gates nothing.** `submitAttendance` does **not** require the email's entry and the submitting account to describe the same person. The two existing checks stay independent exactly as they are documented today, so this change cannot refuse a single student who can submit now.
- **A new roster engagement read model.** Per **enrolled person** — not per Discord member — for a single Dhaka date or a date range: whether they are linked, which servers they are in, and their attendance / daily-update figures. Unlinked entries appear as first-class rows with zero activity and an explicit `NEVER_LINKED` status, rather than being filtered out of their own report.
- **New admin-only endpoints** under `/api/roster`: `GET /status/counts`, `GET /status` (paginated, searchable, filterable by link state and status bucket), and `GET /status/export` (CSV attachment, same shape as the daily-status export).
- **An outreach list for the unreachable.** The export is the deliverable for people with no Discord account on file: name, email, phone, and the fact that nothing has ever been recorded for them. Contacting them happens by email, outside this system.
- **No new delivery channel and no change to the reminder broadcast.** `reminder_logs`, the DM queue, the rate limiter, and the target query are untouched. An unlinked person has no Discord account, so there is nothing to DM; inventing an email sender here would add an external dependency, a second rate budget, and a second definition of "who is behind".
- **Imports never touch the link.** `upsertEntriesInChunks` writes name, phone, and `isActive` and must not write or clear `discord_user_id` — a routine re-upload of the enrolment sheet would otherwise erase every pairing the system had learned, silently and in bulk.
- Not breaking. Every column is nullable, every endpoint is new, and every existing response keeps its shape apart from additive fields.

## Capabilities

### New Capabilities

- `roster-discord-linking`: the pairing between an enrolled email address and a Discord account — where it is stored, how it is learned from an accepted submission, why it is first-write-wins and unique per account, why it survives an import, and why it gates nothing.
- `roster-engagement-status`: the roster-scoped read model. Answers "is this enrolled person submitting attendance and posting daily updates" for a date or a range, keeps unlinked people visible as their own status rather than dropping them, and shares its credit sources with the existing dashboard so the two cannot disagree about who did the work.

### Modified Capabilities

- `attendance-roster-directory`: a roster entry may now carry a Discord account identifier and the instant it was learned. The roster stays global (still no `guild_id`), removal stays a flag, and the new column is additive and nullable.
- `web-attendance-submission`: an accepted submission additionally records the email-to-account pairing. New requirement that this step is best-effort — it cannot fail the request, change the response, or block the transaction — and that it still performs no identity comparison between the roster entry and the account.
- `roster-spreadsheet-import`: an import SHALL NOT write or clear an entry's Discord account. Explicit because the import already forces `isActive: true` on update, and the obvious extension of that pattern to the new column is exactly the destructive behaviour this forbids.
- `roster-admin-http`: three new admin-only endpoints for the engagement read model, and link state exposed on the existing entry listing.

## Impact

**Schema** — `prisma/schema/roster.prisma`: two columns on `RosterEntry` plus a unique index on `discord_user_id` and an index supporting the linked/unlinked split. One migration. No data backfill (see the deferral below).

**Code**
- `src/repositories/roster.repository.ts` — the link write and the entry reads that expose it.
- `src/repositories/rosterStatus.repository.ts` (new) — the aggregation, in `$queryRaw`, built on the same credit sources as `dailyStatus.repository.ts`.
- `src/modules/attendance/attendance.service.ts` — the post-write link attempt on `submitAttendance`.
- `src/modules/roster/*` — the three new routes, their query schemas, controllers, and service rules.
- `prisma/schema/roster.prisma`, `CLAUDE.md`, `postman-collection.json`.

**Untouched, deliberately** — the reminder queue and `dm.ts`, `dailyStatus.repository.ts` and every existing dashboard figure, the public `verify-user` and `window` endpoints, the roster enforcement gate, and the CORS / rate-limit configuration.

**Dependencies** — none added. CSV writing reuses the escaping already in `dailyStatus.service.ts`.

**Deferred, with the consequence stated plainly**: there is no backfill from existing `attendances` rows, so on the day this ships every entry is unlinked and links accumulate only as students submit. Existing attendance rows already hold the email typed and the member they were written for, so a backfill remains possible later as a pure addition. There is also no manual admin link/unlink endpoint, so a pairing that lands wrong — a student submitting under a classmate's enrolled address — cannot be repaired through the API in this change; the affected entry simply stays unlinked and shows up in the outreach list.
