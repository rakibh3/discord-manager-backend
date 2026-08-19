import { Prisma } from '@generated/prisma/client';

import { prisma } from '@/lib/prisma';
import {
  accountAttendanceSource,
  accountUpdateSource,
  DAILY_STATUS,
  rangeCtes,
} from '@/repositories/dailyStatus.repository';
import { discordPairingMismatchReportRepository } from '@/repositories/discordPairingMismatchReport.repository';

/**
 * The roster engagement read model.
 *
 * ── `roster_entries` is the FROM, not a join target ────────────────────────
 * The denominator is ENROLMENT — the question this answers is "which enrolled
 * people are doing the work". A `LEFT JOIN` from the roster onto the
 * account-keyed activity means an unpaired entry survives the join with nulls
 * instead of vanishing from its own report, and a paired entry whose account
 * has done nothing today appears as MISSING_BOTH (or one of its three siblings)
 * rather than being excluded by the join.
 *
 * ── Roster totals deliberately do NOT equal dashboard totals ───────────────
 * The dashboard counts Discord accounts; this counts enrolled people. They
 * diverge in both directions — enrolled people who never joined, and members
 * who are in a server without being on the roll — and neither figure is wrong.
 * This is the same class of apparent bug as "combined totals do not equal the
 * sum of `byServer`" in `dailyStatus.repository.ts`, and it gets the same
 * treatment: written down here, in the service header, and in `CLAUDE.md`.
 *
 * ── Credit sources are IMPORTED, not re-written ────────────────────────────
 * `accountAttendanceSource`, `accountUpdateSource`, and `rangeCtes` come from
 * `dailyStatus.repository.ts`. Re-implementing them here would create a second
 * definition of "posted a daily update", and the two would answer differently
 * the first time either was touched. Both consumers must agree on who did the
 * work; importing is the only way to enforce that by construction.
 *
 * The credit sources stay keyed on `discord_user_id` with no `guild_id` and
 * no `is_in_guild` filter: an enrolled person who posted in any server has
 * done the work, and that rule has to match the dashboard's.
 *
 * ── Status is `NEVER_LINKED` when `discord_user_id IS NULL` ────────────────
 * Otherwise the existing four-bucket derivation from the dashboard is reused
 * verbatim — `BOTH_COMPLETE` / `MISSING_UPDATE` / `MISSING_ATTENDANCE` /
 * `MISSING_BOTH`. `NEVER_LINKED` is its OWN bucket rather than a reuse of
 * `MISSING_BOTH`, because the two call for opposite actions: one is on Discord
 * and behind, the other cannot be reached on Discord at all.
 *
 * A linked entry whose account is currently in no server is reported as
 * linked with an empty `servers` array. That is a real state — enrolled, once
 * on Discord, now gone — and collapsing it into `NEVER_LINKED` would erase the
 * difference between someone who left and someone who never arrived.
 *
 * ── Columns these queries depend on ───────────────────────────────────────
 * A rename in `prisma/schema/*.prisma` will NOT break `$queryRaw` at compile
 * time, so every column named below must be checked by hand after a schema
 * change:
 *   roster_entries:    id, email, name, phone, is_active, discord_user_id,
 *                      linked_at
 *   discord_members:   id, guild_id, discord_user_id, is_in_guild
 *   attendances:       member_id, attendance_date
 *   daily_updates:     member_id, message_date
 *
 * ── The new repository must contain no `AppError` ──────────────────────────
 * Repositories own Prisma and nothing else. Business-rule failures (a weekday
 * set that leaves zero counted days, an unknown sort column) belong to the
 * service.
 */

export const ROSTER_STATUS = {
  ...DAILY_STATUS,
  /** Entry has no Discord account on file — its own bucket. */
  NEVER_LINKED: 'NEVER_LINKED',
} as const;

export type RosterStatus =
  (typeof ROSTER_STATUS)[keyof typeof ROSTER_STATUS];

/** The four pairing-related filters the listing accepts. */
export const PAIRING_STATE = {
  ALL: 'all',
  PAIRED: 'paired',
  UNPAIRED: 'unpaired',
} as const;

export type PairingState = (typeof PAIRING_STATE)[keyof typeof PAIRING_STATE];

/**
 * Row shape returned by the page query — ONE PER ROSTER ENTRY.
 *
 * Declared by hand because `$queryRaw` gives no inference; keep it in step
 * with the SELECT. The `openDiscordPairingMismatchReports` field is
 * populated OUT of the `$queryRaw` block by a single batched count query
 * against `discord_pairing_mismatch_reports`, since that table is not
 * part of the join core and adding it would complicate the GROUP BY.
 * Unpaired entries report zero without an additional read.
 */
export type RosterStatusRow = {
  entryId: string;
  name: string;
  email: string;
  phone: string | null;
  isActive: boolean;
  discordUserId: string | null;
  linkedAt: Date | null;
  /** Servers the paired account is currently a member of. Empty when unpaired. */
  guildIds: string[];
  /** How many configured servers currently hold this account. Zero when unpaired. */
  serverCount: number;
  /** The account's Discord profile, taken from the lowest-numbered server. */
  discordUsername: string | null;
  displayName: string | null;
  /** Whether the paired account is in any configured server right now. */
  isInGuild: boolean;
  hasAttendance: boolean;
  hasDailyUpdate: boolean;
  status: RosterStatus;
  /**
   * How many open discord-pairing-mismatch reports are filed against this
   * entry right now. Zero for unpaired entries without an additional read;
   * a positive value surfaces as a dashboard "needs attention" cue.
   */
  openDiscordPairingMismatchReports: number;
};

export type RosterStatusFigures = {
  enrolled: number;
  paired: number;
  unpaired: number;
  /** Paired entries only — the four buckets the dashboard uses. */
  bothComplete: number;
  missingUpdateOnly: number;
  missingAttendanceOnly: number;
  missingBoth: number;
};

export type RosterStatusCounts = RosterStatusFigures & {
  /**
   * The date the figures cover, echoed back so a client never has to infer it.
   * `null` in range mode (echoed under the range meta instead).
   */
  date: string | null;
  /**
   * The range these figures cover when in range mode — null when a single
   * date. The `daysInRange` denominator is here too.
   */
  from: string | null;
  to: string | null;
  daysInRange: number | null;
};

export type RosterStatusQuery = {
  /** `YYYY-MM-DD`, Asia/Dhaka. */
  date: string;
  pairingState?: PairingState;
  status?: RosterStatus;
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: RosterStatusSortColumn;
  sortDir?: 'asc' | 'desc';
};

export type RosterStatusRangeQuery = {
  /** The counted days, already resolved from `from`/`to`/`daysOfWeek`. */
  days: string[];
  pairingState?: PairingState;
  status?: RosterStatus;
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: RosterStatusSortColumn;
  sortDir?: 'asc' | 'desc';
};

/**
 * Closed allowlist. Sort column and direction cannot be bound as query
 * parameters, so they are the one place raw SQL is assembled from input — they
 * are therefore mapped through these maps and never interpolated from a string.
 */
export type RosterStatusSortColumn = keyof typeof SORT_COLUMNS;

const SORT_COLUMNS = {
  name: Prisma.sql`ranked."name"`,
  email: Prisma.sql`ranked."email"`,
  status: Prisma.sql`ranked."status"`,
  linkedAt: Prisma.sql`ranked."linkedAt"`,
} as const;

const SORT_DIRECTIONS = {
  asc: Prisma.sql`ASC`,
  desc: Prisma.sql`DESC`,
} as const;

/**
 * The status column when the entry IS paired — the dashboard's four-bucket
 * verdict, reused verbatim so the two cannot disagree.
 *
 * `a` and `du` are already LEFT JOINed from the credit sources, so they are
 * NULLs when the account did nothing today and BOOL_OR sees a single value.
 */
const pairedStatusExpression = Prisma.sql`
  CASE
    WHEN BOOL_OR(a.discord_user_id IS NOT NULL) AND BOOL_OR(du.discord_user_id IS NOT NULL) THEN 'COMPLETE'
    WHEN BOOL_OR(a.discord_user_id IS NOT NULL)                                  THEN 'MISSING_UPDATE'
    WHEN BOOL_OR(du.discord_user_id IS NOT NULL)                                  THEN 'MISSING_ATTENDANCE'
    ELSE 'MISSING_BOTH'
  END
`;

/**
 * Whether `discord_user_id IS NULL` (the unpaired cohort) survives the join.
 *
 * Always `TRUE` for `roster_entries` because `discord_user_id` is the column
 * they are LEFT JOINed through — every entry has it (as a value or a NULL).
 *
 * A previous version of this query referenced the inner subquery alias (the
 * `(...) ranked` wrapping below). PostgreSQL forbids a subquery from naming
 * itself in its own SELECT — the alias is bound AFTER the SELECT is parsed —
 * so `CASE WHEN ranked."discordUserId" IS NULL` raised `42P01 missing
 * FROM-clause entry for table "ranked"`. The CASE now references the
 * underlying `re.discord_user_id` directly.
 */
const rosterStatusFor = Prisma.sql`
  CASE
    WHEN re.discord_user_id IS NULL THEN 'NEVER_LINKED'
    ELSE ${pairedStatusExpression}
  END
`;

/**
 * The per-entry SELECT list, shared by the page and counts queries.
 *
 * `BOOL_OR(dm.is_in_guild)` describes whether the paired account is in any
 * configured server right now. `serverCount` is computed outside the grouping
 * so a future per-server view of the roster would not silently change it.
 */
const entrySelect = Prisma.sql`
  re.id              AS "entryId",
  re.name            AS "name",
  re.email           AS "email",
  re.phone           AS "phone",
  re.is_active       AS "isActive",
  re.discord_user_id AS "discordUserId",
  re.linked_at       AS "linkedAt",
  -- Paired entry's current servers. Empty array when unpaired.
  COALESCE(
    ARRAY_AGG(dm.guild_id ORDER BY dm.guild_id) FILTER (WHERE dm.id IS NOT NULL),
    ARRAY[]::text[]
  )                  AS "guildIds",
  (
    SELECT COUNT(*)::int FROM discord_members o
     WHERE o.discord_user_id = re.discord_user_id
       AND o.is_in_guild = TRUE
  )                  AS "serverCount",
  -- The paired account's profile from its lowest-numbered server. NULL when
  -- unpaired — unpaired entries have no Discord identity at all.
  (ARRAY_AGG(dm.discord_username ORDER BY dm.guild_id) FILTER (WHERE dm.id IS NOT NULL))[1] AS "discordUsername",
  (ARRAY_AGG(dm.display_name     ORDER BY dm.guild_id) FILTER (WHERE dm.id IS NOT NULL))[1] AS "displayName",
  BOOL_OR(dm.is_in_guild) AS "isInGuild",
  BOOL_OR(a.discord_user_id IS NOT NULL) AS "hasAttendance",
  BOOL_OR(du.discord_user_id IS NOT NULL) AS "hasDailyUpdate",
  ${pairedStatusExpression} AS "pairStatus"
`;

/**
 * The shared FROM/JOIN/WHERE core.
 *
 * `roster_entries` is the driving table — every active entry produces a row,
 * paired or not. The LEFT JOINs onto the credit sources are scoped to the
 * account when paired and produce NULLs when unpaired, which is what makes
 * `NEVER_LINKED` and the empty `guildIds` array fall out naturally.
 *
 * Paired entries are also LEFT JOINed onto `discord_members` so the report
 * can name the servers the account is currently in. The match is by
 * `discord_user_id` with no `guild_id` filter — same reason as the credit
 * sources: a paired account has one identity across servers, and narrowing by
 * a specific server would reintroduce the per-server split the roster's
 * missing `guild_id` exists to avoid.
 */
const sourceFor = (date: string) => Prisma.sql`
  FROM roster_entries re
  LEFT JOIN (${accountAttendanceSource(date)}) a
    ON a.discord_user_id = re.discord_user_id
  LEFT JOIN (${accountUpdateSource(date)}) du
    ON du.discord_user_id = re.discord_user_id
  LEFT JOIN discord_members dm
    ON dm.discord_user_id = re.discord_user_id
   AND dm.is_in_guild = TRUE
  WHERE re.is_active = TRUE
`;

/**
 * The search filter, as a HAVING rather than a WHERE.
 *
 * A WHERE would let a partial name match in one server accidentally drop
 * unpaired entries (the LEFT JOIN produces NULLs that the predicate skips).
 * A HAVING sees the assembled row and matches across the always-present
 * `re.name` / `re.email` columns regardless of pairing state.
 */
const searchHaving = (search?: string): Prisma.Sql => {
  const term = search?.trim();

  if (!term) return Prisma.empty;

  const like = `%${term}%`;

  return Prisma.sql`HAVING
    re.name  ILIKE ${like}
    OR re.email ILIKE ${like}
  `;
};

/**
 * The pairing-state filter.
 *
 * Applied as an outer WHERE because it tests the assembled `discordUserId`
 * column rather than an input column. `NEVER_LINKED` is its own value so the
 * filter and the status filter share a vocabulary.
 */
const pairingStateFilter = (
  pairingState?: PairingState,
): Prisma.Sql => {
  switch (pairingState) {
    case PAIRING_STATE.PAIRED:
      return Prisma.sql`WHERE ranked."discordUserId" IS NOT NULL`;
    case PAIRING_STATE.UNPAIRED:
      return Prisma.sql`WHERE ranked."discordUserId" IS NULL`;
    case PAIRING_STATE.ALL:
    default:
      return Prisma.empty;
  }
};

/**
 * One page of per-entry engagement for a date, plus the total matching the
 * filters so the caller can derive the page count.
 *
 * Two queries regardless of how many entries exist — never one per entry.
 *
 * The open-discord-pairing-mismatch-report count is fetched in a SINGLE
 * batched query against the page's entry identifiers, indexed on
 * `roster_entry_id` filtered by `status = 'OPEN'`. Unpaired entries
 * report zero without an additional read (the count map only has entries
 * for paired ones; the row defaults to 0 when no entry exists in the map).
 */
const getRosterStatusPage = async ({
  date,
  pairingState,
  status,
  search,
  page = 1,
  limit = 50,
  sortBy = 'name',
  sortDir = 'asc',
}: RosterStatusQuery): Promise<{ rows: RosterStatusRow[]; total: number }> => {
  const source = sourceFor(date);
  const having = searchHaving(search);

  // The status filter tests the FINAL status column (NEVER_LINKED or one of
  // the four paired buckets), so it has to sit outside the SELECT that
  // defines it — hence the wrapping subquery.
  const statusFilter = status
    ? Prisma.sql`AND ranked."status" = ${status}`
    : Prisma.empty;

  const orderBy = Prisma.sql`ORDER BY ${SORT_COLUMNS[sortBy] ?? SORT_COLUMNS.name} ${
    SORT_DIRECTIONS[sortDir] ?? SORT_DIRECTIONS.asc
  } NULLS LAST`;

  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 500);
  const safePage = Math.max(Math.trunc(page) || 1, 1);
  const offset = (safePage - 1) * safeLimit;

  const [rawRows, totalResult] = await Promise.all([
    prisma.$queryRaw<Omit<RosterStatusRow, 'openDiscordPairingMismatchReports'>[]>`
      SELECT * FROM (
        SELECT
          ${entrySelect},
          ${rosterStatusFor} AS "status"
        ${source}
        GROUP BY re.id
        ${having}
      ) ranked
      ${pairingStateFilter(pairingState)}
      ${statusFilter ? Prisma.sql`WHERE TRUE ${statusFilter}` : Prisma.empty}
      ${orderBy}
      LIMIT ${safeLimit} OFFSET ${offset}
    `,
    prisma.$queryRaw<{ total: bigint }[]>`
      SELECT COUNT(*)::bigint AS total FROM (
        SELECT
          re.id,
          ${rosterStatusFor} AS "status"
        ${source}
        GROUP BY re.id
        ${having}
      ) ranked
      ${pairingStateFilter(pairingState)}
      ${statusFilter ? Prisma.sql`WHERE TRUE ${statusFilter}` : Prisma.empty}
    `,
  ]);

  // One indexed, batched count query against the reports table — keyed
  // on the page's entry identifiers and filtered to `status = 'OPEN'`.
  // Unpaired entries default to zero because the count map only carries
  // entries that have at least one open report.
  const entryIds = rawRows.map((row) => row.entryId);
  const openCounts =
    await discordPairingMismatchReportRepository.countOpenByEntryIds(entryIds);

  const rows: RosterStatusRow[] = rawRows.map((row) => ({
    ...row,
    openDiscordPairingMismatchReports: openCounts.get(row.entryId) ?? 0,
  }));

  return { rows, total: Number(totalResult[0]?.total ?? 0) };
};

/**
 * The seven overview figures for a date, over the whole date — not counted
 * from a page, which would describe only that page.
 *
 * The four paired buckets sum to `paired` by construction; `paired + unpaired`
 * sums to `enrolled`. Both invariants are the reason the counts query is its
 * own statement rather than a sum over a page.
 */
const getRosterStatusCounts = async (
  date: string,
): Promise<RosterStatusCounts> => {
  const source = sourceFor(date);

  const [result] = await prisma.$queryRaw<
    {
      enrolled: bigint;
      paired: bigint;
      unpaired: bigint;
      bothComplete: bigint;
      missingUpdateOnly: bigint;
      missingAttendanceOnly: bigint;
      missingBoth: bigint;
    }[]
  >`
    SELECT
      COUNT(*)::bigint AS "enrolled",
      COUNT(*) FILTER (WHERE grouped."discordUserId" IS NOT NULL)::bigint AS "paired",
      COUNT(*) FILTER (WHERE grouped."discordUserId" IS NULL)::bigint AS "unpaired",
      COUNT(*) FILTER (
        WHERE grouped."discordUserId" IS NOT NULL AND grouped."status" = 'COMPLETE'
      )::bigint AS "bothComplete",
      COUNT(*) FILTER (
        WHERE grouped."discordUserId" IS NOT NULL AND grouped."status" = 'MISSING_UPDATE'
      )::bigint AS "missingUpdateOnly",
      COUNT(*) FILTER (
        WHERE grouped."discordUserId" IS NOT NULL AND grouped."status" = 'MISSING_ATTENDANCE'
      )::bigint AS "missingAttendanceOnly",
      COUNT(*) FILTER (
        WHERE grouped."discordUserId" IS NOT NULL AND grouped."status" = 'MISSING_BOTH'
      )::bigint AS "missingBoth"
    FROM (
      SELECT
        re.discord_user_id AS "discordUserId",
        ${rosterStatusFor} AS "status"
      ${source}
      GROUP BY re.id, re.discord_user_id
    ) grouped
  `;

  return {
    date,
    from: null,
    to: null,
    daysInRange: null,
    enrolled: Number(result?.enrolled ?? 0),
    paired: Number(result?.paired ?? 0),
    unpaired: Number(result?.unpaired ?? 0),
    bothComplete: Number(result?.bothComplete ?? 0),
    missingUpdateOnly: Number(result?.missingUpdateOnly ?? 0),
    missingAttendanceOnly: Number(result?.missingAttendanceOnly ?? 0),
    missingBoth: Number(result?.missingBoth ?? 0),
  };
};

/**
 * Range mode — one row per enrolled entry, with the per-day roll-up the
 * dashboard uses.
 *
 * `rangeCtes` (imported from `dailyStatus.repository.ts`) provides the
 * `account_totals` CTE; the query here LEFT JOINs the roster onto it the same
 * way the single-date query LEFT JOINs onto `accountAttendanceSource` /
 * `accountUpdateSource`. An unpaired entry survives with NULLs and rolls up to
 * `NEVER_LINKED`; a paired entry whose account did nothing in the range rolls
 * up to one of the dashboard's four buckets.
 *
 * `daysInRange` is bound as a parameter and guaranteed non-zero by the
 * service. `range_contact` is deliberately NOT joined here — the roster
 * report carries the entry's stored `name`, `phone`, `email`, not the
 * submission's; the import is the source of contact details, and a re-import
 * is what changes them.
 */
const entryRangeSelect = (daysInRange: number) => Prisma.sql`
  re.id              AS "entryId",
  re.name            AS "name",
  re.email           AS "email",
  re.phone           AS "phone",
  re.is_active       AS "isActive",
  re.discord_user_id AS "discordUserId",
  re.linked_at       AS "linkedAt",
  COALESCE(
    ARRAY_AGG(dm.guild_id ORDER BY dm.guild_id) FILTER (WHERE dm.id IS NOT NULL),
    ARRAY[]::text[]
  )                  AS "guildIds",
  (
    SELECT COUNT(*)::int FROM discord_members o
     WHERE o.discord_user_id = re.discord_user_id
       AND o.is_in_guild = TRUE
  )                  AS "serverCount",
  (ARRAY_AGG(dm.discord_username ORDER BY dm.guild_id) FILTER (WHERE dm.id IS NOT NULL))[1] AS "discordUsername",
  (ARRAY_AGG(dm.display_name     ORDER BY dm.guild_id) FILTER (WHERE dm.id IS NOT NULL))[1] AS "displayName",
  BOOL_OR(dm.is_in_guild) AS "isInGuild",
  -- Day counts from the shared CTE. COALESCE turns "no row in account_totals"
  -- into a zero rather than a NULL that would poison every subtraction below.
  COALESCE(MAX(at.attendance_days), 0) AS "attendanceDays",
  COALESCE(MAX(at.update_days), 0)     AS "updateDays",
  COALESCE(MAX(at.complete_days), 0)   AS "completeDays",
  COALESCE(MAX(at.active_days), 0)     AS "activeDays",
  ${daysInRange}::int                  AS "daysInRange",
  (${daysInRange} - COALESCE(MAX(at.complete_days), 0)) AS "incompleteDays",
  (${daysInRange} - COALESCE(MAX(at.active_days), 0))   AS "missedBothDays",
  (${daysInRange} - COALESCE(MAX(at.update_days), 0))   AS "missedUpdateDays"
`;

/**
 * Range-mode status — `NEVER_LINKED` when unpaired, else the dashboard bucket.
 *
 * The inner `CASE` cannot reference a sibling SELECT item (PostgreSQL forbids
 * items in the same SELECT list from naming each other), so the range bucket
 * is computed inline here rather than pulled from a `rangeStatus` column that
 * `entryRangeSelect` would have to define. The expression is aliased under
 * BOTH `"status"` (the outer filter column) and `"rangeStatus"` (the value
 * the service echoes back) — duplicate SELECT items are allowed when each
 * has its own alias.
 */
const rangeStatusFor = (daysInRange: number) => Prisma.sql`
  CASE
    WHEN re.discord_user_id IS NULL THEN 'NEVER_LINKED'
    WHEN COALESCE(MAX(at.complete_days), 0) = ${daysInRange} THEN 'ALL_COMPLETE'
    WHEN COALESCE(MAX(at.complete_days), 0) = 0              THEN 'NONE'
    ELSE 'PARTIAL'
  END
`;

/** One row of the range report. */
export type RosterStatusRangeRow = RosterStatusRow & {
  daysInRange: number;
  attendanceDays: number;
  updateDays: number;
  completeDays: number;
  incompleteDays: number;
  missedBothDays: number;
  missedUpdateDays: number;
  rangeStatus: 'ALL_COMPLETE' | 'PARTIAL' | 'NONE';
};

/** Range overview figures — paired counts replaced by the dashboard's buckets. */
export type RosterStatusRangeFigures = {
  enrolled: number;
  paired: number;
  unpaired: number;
  allComplete: number;
  partial: number;
  none: number;
  attendanceDays: number;
  updateDays: number;
  completeDays: number;
  missedBothDays: number;
};

export type RosterStatusRangeCounts = RosterStatusRangeFigures & {
  date: null;
  from: string;
  to: string;
  daysInRange: number;
};

/**
 * The shared FROM/JOIN/WHERE core for range mode.
 *
 * `rangeCtes` (imported from `dailyStatus.repository.ts`) provides the
 * `account_totals` CTE; it must be hoisted to the top of the query — a
 * `WITH … FROM …` is a syntax error — so each range query opens with
 * `${rangeCtes(days)}` before any `SELECT`.
 */
const rangeSourceFor = Prisma.sql`
  FROM roster_entries re
  LEFT JOIN account_totals at ON at.discord_user_id = re.discord_user_id
  LEFT JOIN discord_members dm
    ON dm.discord_user_id = re.discord_user_id
   AND dm.is_in_guild = TRUE
  WHERE re.is_active = TRUE
`;

const rangeSearchHaving = (search?: string): Prisma.Sql => {
  const term = search?.trim();

  if (!term) return Prisma.empty;

  const like = `%${term}%`;

  return Prisma.sql`HAVING
    re.name  ILIKE ${like}
    OR re.email ILIKE ${like}
  `;
};

/**
 * One page of per-entry engagement for a range.
 *
 * Same shape as `getRosterStatusPage`: the open-report count is fetched
 * in one batched query against the page's entry identifiers and merged
 * onto each row. Unpaired entries default to zero.
 */
const getRosterStatusRangePage = async ({
  days,
  pairingState,
  status,
  search,
  page = 1,
  limit = 50,
  sortBy = 'name',
  sortDir = 'asc',
}: RosterStatusRangeQuery): Promise<{
  rows: RosterStatusRangeRow[];
  total: number;
}> => {
  const daysInRange = days.length;
  const ctes = rangeCtes(days);
  const source = rangeSourceFor;
  const having = rangeSearchHaving(search);

  const statusFilter = status
    ? Prisma.sql`AND ranked."status" = ${status}`
    : Prisma.empty;

  const orderBy = Prisma.sql`ORDER BY ${SORT_COLUMNS[sortBy] ?? SORT_COLUMNS.name} ${
    SORT_DIRECTIONS[sortDir] ?? SORT_DIRECTIONS.asc
  } NULLS LAST`;

  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 500);
  const safePage = Math.max(Math.trunc(page) || 1, 1);
  const offset = (safePage - 1) * safeLimit;

  const [rawRows, totalResult] = await Promise.all([
    prisma.$queryRaw<
      Omit<RosterStatusRangeRow, 'openDiscordPairingMismatchReports'>[]
    >`
      ${ctes}
      SELECT * FROM (
        SELECT
          ${entryRangeSelect(daysInRange)},
          ${rangeStatusFor(daysInRange)} AS "status",
          ${rangeStatusFor(daysInRange)} AS "rangeStatus"
        ${source}
        GROUP BY re.id
        ${having}
      ) ranked
      ${pairingStateFilter(pairingState)}
      ${statusFilter ? Prisma.sql`WHERE TRUE ${statusFilter}` : Prisma.empty}
      ${orderBy}
      LIMIT ${safeLimit} OFFSET ${offset}
    `,
    prisma.$queryRaw<{ total: bigint }[]>`
      ${ctes}
      SELECT COUNT(*)::bigint AS total FROM (
        SELECT
          re.id,
          ${rangeStatusFor(daysInRange)} AS "status"
        ${source}
        GROUP BY re.id
        ${having}
      ) ranked
      ${pairingStateFilter(pairingState)}
      ${statusFilter ? Prisma.sql`WHERE TRUE ${statusFilter}` : Prisma.empty}
    `,
  ]);

  const entryIds = rawRows.map((row) => row.entryId);
  const openCounts =
    await discordPairingMismatchReportRepository.countOpenByEntryIds(entryIds);

  const rows: RosterStatusRangeRow[] = rawRows.map((row) => ({
    ...row,
    openDiscordPairingMismatchReports: openCounts.get(row.entryId) ?? 0,
  }));

  return { rows, total: Number(totalResult[0]?.total ?? 0) };
};

/**
 * Range overview figures — the same rollup the dashboard produces, but with
 * enrolment as the denominator instead of Discord membership.
 *
 * The paired buckets sum to `paired`; `paired + unpaired` sums to `enrolled`.
 */
const getRosterStatusRangeCounts = async (
  days: string[],
): Promise<RosterStatusRangeCounts> => {
  const daysInRange = days.length;
  const ctes = rangeCtes(days);
  const source = rangeSourceFor;

  const [result] = await prisma.$queryRaw<
    {
      enrolled: bigint;
      paired: bigint;
      unpaired: bigint;
      allComplete: bigint;
      partial: bigint;
      none: bigint;
      attendanceDays: bigint;
      updateDays: bigint;
      completeDays: bigint;
      missedBothDays: bigint;
    }[]
  >`
    ${ctes}
    SELECT
      COUNT(*)::bigint AS "enrolled",
      COUNT(*) FILTER (WHERE ranked."discordUserId" IS NOT NULL)::bigint AS "paired",
      COUNT(*) FILTER (WHERE ranked."discordUserId" IS NULL)::bigint AS "unpaired",
      COUNT(*) FILTER (
        WHERE ranked."discordUserId" IS NOT NULL AND ranked."status" = 'ALL_COMPLETE'
      )::bigint AS "allComplete",
      COUNT(*) FILTER (
        WHERE ranked."discordUserId" IS NOT NULL AND ranked."status" = 'PARTIAL'
      )::bigint AS "partial",
      COUNT(*) FILTER (
        WHERE ranked."discordUserId" IS NOT NULL AND ranked."status" = 'NONE'
      )::bigint AS "none",
      COALESCE(SUM(ranked."attendanceDays"), 0)::bigint AS "attendanceDays",
      COALESCE(SUM(ranked."updateDays"), 0)::bigint     AS "updateDays",
      COALESCE(SUM(ranked."completeDays"), 0)::bigint   AS "completeDays",
      COALESCE(SUM(ranked."missedBothDays"), 0)::bigint AS "missedBothDays"
    FROM (
      SELECT
        ${entryRangeSelect(daysInRange)},
        ${rangeStatusFor(daysInRange)} AS "status",
        ${rangeStatusFor(daysInRange)} AS "rangeStatus"
      ${source}
      GROUP BY re.id
    ) ranked
    GROUP BY ranked."status", ranked."discordUserId"
  `;

  return {
    date: null,
    from: days[0] as string,
    to: days[days.length - 1] as string,
    daysInRange,
    enrolled: Number(result?.enrolled ?? 0),
    paired: Number(result?.paired ?? 0),
    unpaired: Number(result?.unpaired ?? 0),
    allComplete: Number(result?.allComplete ?? 0),
    partial: Number(result?.partial ?? 0),
    none: Number(result?.none ?? 0),
    attendanceDays: Number(result?.attendanceDays ?? 0),
    updateDays: Number(result?.updateDays ?? 0),
    completeDays: Number(result?.completeDays ?? 0),
    missedBothDays: Number(result?.missedBothDays ?? 0),
  };
};

export const rosterStatusRepository = {
  getRosterStatusPage,
  getRosterStatusCounts,
  getRosterStatusRangePage,
  getRosterStatusRangeCounts,
};