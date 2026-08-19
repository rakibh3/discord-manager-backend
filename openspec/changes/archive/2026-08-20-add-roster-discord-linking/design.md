## Context

Three tables already hold every fact this change needs, and none of them is joined to the others.

- `roster_entries` — who enrolled. Keyed on a normalized email address, global (no `guild_id`), carrying no Discord identity at all.
- `discord_members` — who is present in a server. Keyed `(guild_id, discord_user_id)`, so one person in two servers is two rows.
- `attendances` / `daily_updates` — who did the work. Both reach a Discord account through `member_id`, and every aggregation in `dailyStatus.repository.ts` groups on `discord_user_id` because **one account is one person and one person owes one day's work**.

`POST /api/attendance/submit` is the only place in the system where an enrolled email address and a Discord handle arrive in the same request. It checks each against its own table — the roster gate, then the membership lookup — and then discards the fact that they were presented together. That discarded fact is the entire subject of this change.

The constraint that shapes everything below: **the submit endpoint is unauthenticated, is the path ~5,000 students use, and already carries four distinguishable failure outcomes (400 / 403 / 404 / 409).** Nothing added here may create a fifth, slow one down, or make one fail that would have succeeded.

## Goals / Non-Goals

**Goals:**

- Record the email-to-Discord-account pairing when an accepted submission reveals it, at zero risk to the submission.
- Give administrators a read model whose denominator is **enrolment**, so a person who never appeared on Discord is a visible row rather than an absence.
- Make "enrolled, no Discord account on file" a list that can be exported and acted on by email, outside this system.
- Share the credit sources with the existing dashboard, so the roster report and the daily-status dashboard can never disagree about who submitted or posted.

**Non-Goals:**

- **Identity enforcement.** The link never decides whether a submission is accepted. The two existing gates stay independent, and this change refuses nobody who can submit today.
- **A second delivery channel.** No email sender, no change to `reminder_logs`, the DM queue, the rate limiter, or `listReminderTargets`.
- **Changing any existing dashboard figure.** `dailyStatus.repository.ts` keeps deriving every denominator from `discord_members`; the roster denominator lives in its own queries.
- **A backfill or a manual link/unlink endpoint.** Both are pure additions later; see Risks.
- **Per-server roster reporting.** The roster has no `guild_id` and an unlinked entry has no server, so "enrolled in which server" stays a question with no answer.

## Decisions

### 1. The link is a column on `roster_entries` holding a Discord **account** snowflake

`discord_user_id String? @unique @map("discord_user_id")` plus `linkedAt DateTime? @map("linked_at")`.

- **An account, never a `discord_members.id`.** A member row is a membership — one person in two servers has two of them, and picking one would make the roster point at a presence rather than a person, reintroducing exactly the per-server split the roster's missing `guild_id` exists to avoid. The account snowflake is the key every dashboard query already groups on.
- **No foreign key.** `discord_user_id` is unique *per server* in `discord_members` (`@@unique([guild_id, discord_user_id])`), not globally, so there is no unique parent column to reference. A person can also be linked before or after any particular membership row exists.
- **No join table.** A join table models many-to-many; this is at most one account per enrolled person and at most one enrolled person per account. Modelling it as a table would make the "at most one" a rule enforced by application code rather than by an index.
- **`linked_at` is kept even though `updated_at` exists.** An import rewrites `updated_at` on every row it touches, so `updated_at` cannot answer "when did we learn this person's account".

*Alternative rejected — derive the link entirely in SQL from `attendances.email`.* Tempting (no column, no write path, an import could not possibly clobber it), but `attendances.email` stores the address exactly as the student typed it, so deriving would require `LOWER(TRIM(email))` inside every query — a second implementation of the normalization that `normalizeRosterEmail` is documented as the single producer of. It would also need a functional index Prisma cannot express, and it would make the pairing flap with the most recent submission instead of being a stable, auditable record.

### 2. First observation wins, enforced by a scoped `updateMany` and a unique index

The write is one statement:

```
updateMany({
  where: { email: <normalized>, isActive: true, discordUserId: null },
  data:  { discordUserId, linkedAt: new Date() },
})
```

- **The `discordUserId: null` in the WHERE is the claim.** It is the same scoped-claim shape as `markReminderProcessing` (scoped to `PENDING`) and `reclaimFailedDay` (scoped to `FAILED`): a read-then-write "is it already linked?" check does not survive two students submitting in the same millisecond, and this is a path that sees a burst every evening.
- **The `@unique` handles the other direction.** An account already linked to a *different* entry raises P2002, which is caught and swallowed. Without the constraint, one Discord account could be recorded as two different enrolled people and would then be counted twice in the report.
- **A conflict is discarded, never merged and never overwritten.** Overwriting would let the most recent submission decide, so a student borrowing a classmate's address could silently move that classmate's link onto their own account. The entry stays unlinked, which is the honest answer and puts it in the outreach list where a human sees it.
- The statement runs with no prior read, so its cost is one indexed update whether or not the address is on the roster and whether or not the gate is armed.

### 3. The link attempt runs **after** the attendance write, and cannot fail the request

`submitAttendance` records the link after `createAttendanceForMembers` returns, wrapped so that no error escapes — the same discipline `message.ingest.ts` and everything under `src/lib/discord/` follow, and for the same reason: the valuable work is already committed, and a bookkeeping failure must not undo it or surface to the student.

- **Not inside the attendance `$transaction`.** That transaction is all-or-nothing across every server the handle belongs to, deliberately, so a student is never recorded in one server and missing in another. Putting a nice-to-have write inside it means a roster hiccup discards a real submission.
- **Not before the write.** The link is only meaningful for a submission that succeeded.
- **It runs regardless of `enforceEmail`.** The gate decides whether an unenrolled address is refused; it has nothing to do with whether a matching address should be remembered. If the address is not on the roster the `updateMany` matches zero rows and costs one indexed statement.
- **The response is unchanged.** No new field, no new status code, no new failure mode. The form cannot tell whether a link was recorded, which is correct — it is not the student's business.

### 4. An ambiguous handle is not linked

`resolveActiveMembers` returns one row per server, and those rows normally carry the same `discord_user_id` because they describe one account. They can disagree when the directory is stale in one server — a rename observed in server A but not yet in server B leaves the old handle pointing at two different accounts.

If the resolved rows do not all carry the same `discord_user_id`, **no link is written** and the fact is logged. Guessing would attach an enrolled person to an account that is not theirs, and a wrong link is worse than no link: no link is visible as "unlinked" and gets chased, while a wrong link reads as a healthy, participating student. (The attendance rows are still written to every resolved server — that is existing behaviour and is not changed here.)

### 5. The read model is a new repository driven **from** `roster_entries`

`src/repositories/rosterStatus.repository.ts`, in `$queryRaw` for the same reason `dailyStatus.repository.ts` is: a computed status column is not expressible in Prisma's fluent API. Sort column and direction come from a closed `Prisma.sql` allowlist; every other value is a bound parameter.

- **`roster_entries` is the FROM, not a join target.** The denominator is enrolment. `LEFT JOIN` onto the account-keyed activity, so an unlinked entry survives the join with nulls instead of vanishing from its own report.
- **The credit sources are imported, not re-written.** `accountAttendanceSource`, `accountUpdateSource`, and the `day_facts` / `account_totals` range CTEs are `export`ed from `dailyStatus.repository.ts` and reused verbatim. Re-implementing them here would create a second definition of "posted a daily update", and the two would answer differently the first time either was touched — the precise drift the repository layer exists to prevent. They are keyed on `discord_user_id` with no `guild_id` and no `is_in_guild` filter, and that stays true here: an enrolled person who posted in any server has done the work.
- **Status is `NEVER_LINKED` when `discord_user_id IS NULL`**, and otherwise the existing four-way bucket (`BOTH_COMPLETE` / `MISSING_UPDATE` / `MISSING_ATTENDANCE` / `MISSING_BOTH`) computed exactly as the dashboard computes it. `NEVER_LINKED` is its own bucket rather than a reuse of `MISSING_BOTH`, because the two call for opposite actions: one person is on Discord and behind, the other cannot be reached on Discord at all.
- **Both single-date and range modes**, matching the dashboard: the same 92-day cap, the same `daysOfWeek` semantics, the same `rangeDays()` enumeration in TypeScript, and the same rule that a weekday set leaving zero counted days is a 400.
- **A linked entry that is linked to an account with no current membership anywhere** is reported as linked with an empty `servers` array. That is a real and interesting state — enrolled, once on Discord, now gone — and collapsing it into `NEVER_LINKED` would erase the difference between someone who left and someone who never arrived.

### 6. Roster totals will not equal dashboard totals, and both stay

`totalEnrolled` counts roster entries; the dashboard's `totalMembers` counts Discord accounts. They diverge in both directions — enrolled people who never joined, and members who are in a server without being on the roll — and neither figure is wrong. This is the same class of apparent bug as "combined totals do not equal the sum of `byServer`", and it gets the same treatment: written down in the spec, in the repository header, and in `CLAUDE.md`.

The roster figures are **added alongside** the dashboard's, never substituted for them. `dailyStatus.repository.ts` keeps deriving its denominators from `discord_members`.

### 7. No `guildId` filter on the roster status endpoints

The dashboard's `guildId` narrows *who is listed* and never *what their status is*. There is no coherent equivalent here: an unlinked entry belongs to no server, so any guild filter would silently drop exactly the cohort this feature exists to surface. Linked rows still carry `servers[]` so a reader can see where each person is; filtering on it is not offered.

### 8. HTTP surface: three routes on the existing admin-only `rosterRouter`

`GET /api/roster/status/counts`, `GET /api/roster/status`, `GET /api/roster/status/export`.

- **On `rosterRouter` because that router is admin-only by construction**, and this is roster data — names, addresses, phone numbers — joined to Discord activity. It is strictly more sensitive than either half alone. A public route on this router would be a data breach, not a feature.
- **Declared before `/:id`**, or Express matches `status` as an entry ID and answers 404 — the trap `/settings` already documents in this file.
- **`verify-user` still takes no email parameter and gains nothing here.** It carries a 60/min per-IP budget; an email parameter there is a roster oracle, and now it would also be a Discord-account oracle.
- **Export is CSV only**, returning the same "XLSX not supported yet" 400 as the daily-status export, and reuses the formula-injection escaping already written there — lifted to `src/utils/csv.ts` so there is one escaper rather than a third copy.

## Risks / Trade-offs

**A student submits under a classmate's enrolled address → the classmate's entry links to the wrong account, and the real owner of that account can never link their own entry (it is taken).** → Not preventable without an identity check the roster cannot perform (it stores no Discord identity). Both anomalies are *visible*: one entry reports as active when its person is not, and one entry stays in the outreach list. The evidence is retained permanently — `attendances` holds the email typed and the member it was written for — so a later repair tool can reconstruct the truth from history. Accepted, and stated in the spec rather than hidden.

**A re-imported enrolment sheet clears every learned link.** → Highest-consequence failure in this change, because it is silent and bulk. Three guards: the import's update payload names its fields explicitly and does not include the link; a spec requirement forbids it; and a task verifies it by re-importing a sheet after linking and asserting the links survive.

**Reading the roster report as the participation denominator.** → The roster and the dashboard count different populations. Mitigated only by documentation, in three places, because it is the number that looks like a bug.

**No repair path in this change.** → A wrong link stays wrong until a manual link/unlink endpoint exists. The blast radius is one entry and one account, it is visible in the report, and nothing is gated on it — a wrong link cannot refuse anybody's attendance.

**Nothing is linked on day one.** → Deliberate: no backfill was requested. Links accumulate as students submit, so the report is thin for the first cycle and the unlinked list initially contains everybody. The backfill is a pure addition later, and the data it needs already exists.

**Query cost: roster entries joined against attendance history over up to 92 days.** → Same shape and same order of magnitude as the existing range dashboard query, which already spans the same rows. The unique index on `discord_user_id` serves the join; the existing `is_active` index serves the filter.

**The unique index creation locks `roster_entries` during migration.** → A table of a few thousand rows; the lock is brief. The roster is read on the submit path, so the migration is deployed like any other — but it is worth knowing that this is the one new index on a table a student-facing request reads.

## Migration Plan

1. `bunx prisma migrate dev --name add_roster_discord_link` — two nullable columns, one unique index, one index on `discord_user_id IS NULL`-style filtering. Purely additive; no data migration.
2. `bunx prisma generate`.
3. Deploy. The link write begins recording immediately for every accepted submission; nothing else changes behaviour.
4. Verify by submitting a test attendance with an enrolled address and confirming the entry reports as linked on `GET /api/roster/status`.

**Rollback:** drop the two columns. Nothing reads them outside the new endpoints, nothing gates on them, and no other feature degrades — the cost is losing the links learned so far, which the submit path relearns as students submit again.

## Open Questions

- **Should a backfill from `attendances` ship as a follow-up?** It would make the report immediately useful instead of after a full cycle. It needs a decision about which submission wins when one address was submitted under several accounts (earliest, most frequent, or leave unlinked).
- **Should a manual link/unlink endpoint follow?** It is the only repair path for a wrong pairing, and it is also the tool an administrator would use for a student who genuinely cannot submit.
- **Should "enrolled but never on Discord" ever become a dashboard denominator?** Still no in this change. It is a real state and the report now names it, but folding it into the daily-status figures changes numbers the dashboard already publishes and deserves its own decision.
