import { Prisma } from '@generated/prisma/client';

import { prisma } from '@/lib/prisma';
import { countDhakaDaysInclusive } from '@/utils/dhakaDate';

/**
 * The read side of the attendance domain: each PERSON's status for one Dhaka
 * day, the dashboard's summary counts, and the reminder target list.
 *
 * These are raw SQL because the shape — a LEFT JOIN against two date-filtered
 * subqueries producing a computed status column — is not expressible in
 * Prisma's fluent API. The alternative would be three queries plus an
 * in-memory join over ~5,000 rows in Node on every dashboard load.
 *
 * ── The unit of this report is the ACCOUNT, not the membership row ────────
 * A person in two servers is two `discord_members` rows (see the "Multiple
 * Discord servers" section of CLAUDE.md — membership is a per-server fact and
 * that stays true). But they are ONE student with ONE daily obligation, so
 * every query here groups by `discord_user_id` and credits work done in ANY
 * server to the account everywhere:
 *
 *   - one daily update posted in server A makes the account COMPLETE in
 *     server B too, rather than MISSING_UPDATE there;
 *   - the account appears ONCE in the list and counts ONCE in the totals,
 *     carrying `guildIds` for the servers it belongs to;
 *   - the reminder target list skips an account that posted anywhere, so
 *     nobody is DM'd about a day they actually submitted.
 *
 * The credit sources (`accountAttendanceSource`, `accountUpdateSource`) are
 * deliberately NOT filtered by server or by `is_in_guild`. "Posted an update
 * in any server" has to mean any server — narrowing the credit to the server
 * being viewed would reintroduce exactly the double-obligation this grouping
 * exists to remove, and would make a `guildId` filter change a person's status
 * rather than just which people are listed.
 *
 * ── Combined totals do NOT equal the sum of `byServer` ────────────────────
 * Deliberate, and the one invariant worth stating out loud because it looks
 * like a bug. `totalMembers` counts accounts; `byServer` counts each server's
 * own membership, so a person in two servers is counted once combined and once
 * in each server. Anyone in exactly one server contributes equally to both, so
 * the gap between the two is precisely the overlap.
 *
 * ── Columns these queries depend on ───────────────────────────────────────
 * A rename in `prisma/schema/*.prisma` will NOT break `$queryRaw` at compile
 * time, so every column named below must be checked by hand after a schema
 * change:
 *   discord_members: id, guild_id, discord_user_id, discord_username,
 *                    display_name, is_in_guild
 *   attendances:     id, member_id, attendance_date, name, email, phone,
 *                    submitted_at
 *   daily_updates:   member_id, message_date
 *
 * ── Dependency on the member sync departure guard ─────────────────────────
 * Every query here filters on `dm.is_in_guild` by default. That makes the
 * departure guard in `src/lib/discord/member.sync.ts` (skip the reconcile when
 * a fetch returns 0 non-bots, or under 50% of the stored active count)
 * load-bearing for correctness here, not just for the directory: a truncated
 * fetch that mass-flagged members departed would silently shrink the
 * completion-rate denominator AND empty the reminder target list, with no
 * error anywhere. Never remove that guard.
 *
 * ── Second consumer: roster engagement status ──────────────────────────────
 * `accountAttendanceSource`, `accountUpdateSource`, and `rangeCtes` are
 * EXPORTED so `src/repositories/rosterStatus.repository.ts` can build the
 * roster engagement report on the SAME definitions of "submitted attendance"
 * and "posted a daily update". Two implementations of those facts would
 * answer differently the first time either was touched, and an administrator
 * comparing the roster report against the dashboard would have no way to tell
 * which was right. The shared sources are still keyed on `discord_user_id`
 * with no `guild_id` and no `is_in_guild` filter, and that stays true on the
 * roster side: an enrolled person who posted in any server has done the work.
 */

/** The four buckets a person falls into on a given day. */
export const DAILY_STATUS = {
  COMPLETE: 'COMPLETE',
  MISSING_UPDATE: 'MISSING_UPDATE',
  MISSING_ATTENDANCE: 'MISSING_ATTENDANCE',
  MISSING_BOTH: 'MISSING_BOTH',
} as const;

export type DailyStatus = (typeof DAILY_STATUS)[keyof typeof DAILY_STATUS];

/**
 * Row shape returned by the aggregation — ONE PER DISCORD ACCOUNT. Declared by
 * hand because `$queryRaw` gives no inference; keep it in step with the SELECT.
 */
export type DailyStatusRow = {
  /** The account this row is about. The real identity of a student. */
  discordUserId: string;
  /**
   * One representative member record, the account's row in its
   * lowest-numbered server. Deterministic, and what the per-member detail
   * route keys off — a URL that survives the account joining another server.
   */
  memberId: string;
  /**
   * Every member record backing this row, in the same order as `guildIds`.
   * The detail view reads each server's messages through these.
   */
  memberIds: string[];
  /**
   * The servers this account is in, restricted to the current filters. Under a
   * `guildId` filter this holds just that one, while `serverCount` still
   * reports the true total — so an admin looking at one server can still see
   * that the person is also in another.
   */
  guildIds: string[];
  /** How many configured servers currently hold this account, ignoring filters. */
  serverCount: number;
  /**
   * Taken from the account's lowest-numbered server. Per-server rows carry
   * per-server nicknames, and the handle itself can differ for as long as it
   * takes member sync to catch a rename in the other server.
   */
  discordUsername: string;
  displayName: string | null;
  /** True when the account is still in at least one of the servers in scope. */
  isInGuild: boolean;
  /** Submitted on the form that day, not the member's directory contact details. */
  name: string | null;
  email: string | null;
  phone: string | null;
  submittedAt: Date | null;
  hasAttendance: boolean;
  hasDailyUpdate: boolean;
  status: DailyStatus;
};

export type DailyStatusFigures = {
  totalMembers: number;
  attendanceSubmitted: number;
  dailyUpdateSubmitted: number;
  bothCompleted: number;
  missingUpdateOnly: number;
  missingAttendanceOnly: number;
  missingBoth: number;
};

export type DailyStatusCounts = DailyStatusFigures & {
  /**
   * The same seven figures per configured server, produced from the SAME
   * source as the totals so the two can never describe different people.
   *
   * These count MEMBERSHIPS, while the combined figures above count ACCOUNTS,
   * so the array does NOT sum to the totals whenever anyone is in two servers.
   * That gap is the overlap, and it is the point — see the file header.
   */
  byServer: (DailyStatusFigures & { guildId: string })[];
};

export type DailyStatusQuery = {
  /** `YYYY-MM-DD`, Asia/Dhaka. */
  date: string;
  /** Narrow to people in one configured server. Omitted means every server. */
  guildId?: string;
  status?: DailyStatus;
  search?: string;
  page?: number;
  limit?: number;
  /** Include people who have since left every guild. Off by default. */
  includeDeparted?: boolean;
  sortBy?: DailyStatusSortColumn;
  sortDir?: 'asc' | 'desc';
};

/**
 * Closed allowlist. Sort column and direction cannot be bound as query
 * parameters, so they are the one place raw SQL is assembled from input — they
 * are therefore mapped through these maps and never interpolated from a string.
 */
export type DailyStatusSortColumn = keyof typeof SORT_COLUMNS;

// These name the OUTPUT columns of the wrapping subquery, not the underlying
// tables — `dm` and `a` are not in scope outside it.
const SORT_COLUMNS = {
  guildId: Prisma.sql`ranked."guildIds"`,
  username: Prisma.sql`ranked."discordUsername"`,
  displayName: Prisma.sql`ranked."displayName"`,
  status: Prisma.sql`ranked."status"`,
  submittedAt: Prisma.sql`ranked."submittedAt"`,
} as const;

const SORT_DIRECTIONS = {
  asc: Prisma.sql`ASC`,
  desc: Prisma.sql`DESC`,
} as const;

/**
 * Every ACCOUNT that submitted the attendance form on `date`, with the form
 * details of its earliest submission.
 *
 * `DISTINCT ON` collapses the fan-out write (one submission records a row in
 * every server the handle belongs to) back to the single act it was, so the
 * dashboard shows one name/phone/email and one timestamp rather than the same
 * details repeated per server.
 *
 * Not filtered by server or by `is_in_guild`: a person who submitted and then
 * left one server still submitted, and the attendance they filed in server A
 * is the same attendance when viewed from server B.
 */
/**
 * EXPORTED — reused by `rosterStatus.repository.ts` so the roster engagement
 * report and this dashboard derive "submitted attendance" from the same query.
 * Any change here ripples to the roster report; check both consumers before
 * renaming or scoping this further.
 */
const accountAttendanceSource = (date: string) => Prisma.sql`
  SELECT DISTINCT ON (o.discord_user_id)
    o.discord_user_id,
    a.id,
    a.name,
    a.email,
    a.phone,
    a.submitted_at
  FROM attendances a
  JOIN discord_members o ON o.id = a.member_id
  WHERE a.attendance_date = ${date}
  ORDER BY o.discord_user_id, a.submitted_at ASC, a.id ASC
`;

/**
 * Every ACCOUNT that posted at least one daily update on `date`, in any server.
 *
 * This is the query the whole "one person, one obligation" rule turns on: it is
 * keyed by account and scoped to no server, so posting in one server satisfies
 * the day everywhere. `DISTINCT` because someone who posted five messages must
 * produce one row, not five.
 *
 * EXPORTED — reused by `rosterStatus.repository.ts`; see the file header.
 */
const accountUpdateSource = (date: string) => Prisma.sql`
  SELECT DISTINCT o.discord_user_id
  FROM daily_updates du
  JOIN discord_members o ON o.id = du.member_id
  WHERE du.message_date = ${date}
`;

/**
 * Shared FROM/JOIN/WHERE core, so the page query and the counts query can
 * never disagree about which people and records they consider.
 *
 * Still row-per-membership at this point — the callers add the
 * `GROUP BY dm.discord_user_id` that turns it into row-per-account, because
 * the `byServer` breakdown needs the ungrouped form.
 */
const statusSource = (
  date: string,
  {
    includeDeparted = false,
    guildId,
  }: Pick<DailyStatusQuery, 'includeDeparted' | 'guildId'>,
) => {
  const inGuildFilter = includeDeparted
    ? Prisma.empty
    : Prisma.sql`AND dm.is_in_guild = TRUE`;

  // Bound as a parameter, never interpolated, and applied through this shared
  // source so the page query and the counts query can never describe different
  // sets of people. It selects WHICH accounts are listed; it deliberately does
  // not touch the credit sources above, so it never changes anyone's status.
  const serverFilter = guildId
    ? Prisma.sql`AND dm.guild_id = ${guildId}`
    : Prisma.empty;

  return Prisma.sql`
    FROM discord_members dm
    LEFT JOIN (${accountAttendanceSource(date)}) a
      ON a.discord_user_id = dm.discord_user_id
    LEFT JOIN (${accountUpdateSource(date)}) du
      ON du.discord_user_id = dm.discord_user_id
    WHERE TRUE ${inGuildFilter} ${serverFilter}
  `;
};

/**
 * The search filter, as a HAVING rather than a WHERE.
 *
 * It has to run after the grouping: a nickname that matches in one server and
 * not the other would otherwise drop that person's second membership from
 * their own row, leaving `guildIds` naming one server while `serverCount` says
 * two. `BOOL_OR` keeps the whole account when any of its memberships match.
 *
 * ILIKE gives the case-insensitive match the spec requires. The term is bound
 * as a parameter, so a `%` or `_` typed by a user is a literal wildcard within
 * their own search, never SQL.
 */
const searchHaving = (search?: string) => {
  const term = search?.trim();

  if (!term) return Prisma.empty;

  const like = `%${term}%`;

  return Prisma.sql`HAVING BOOL_OR(
    dm.display_name ILIKE ${like}
    OR dm.discord_username ILIKE ${like}
    OR a.name ILIKE ${like}
    OR a.phone ILIKE ${like}
    OR a.email ILIKE ${like}
  )`;
};

// The two facts the status is derived from, as aggregates over an account's
// memberships. `a` and `du` are already account-level, so these are constant
// within each group — BOOL_OR is how they survive the GROUP BY, not a choice
// between differing values.
const HAS_ATTENDANCE = Prisma.sql`BOOL_OR(a.id IS NOT NULL)`;
const HAS_DAILY_UPDATE = Prisma.sql`BOOL_OR(du.discord_user_id IS NOT NULL)`;

/** The computed status column, shared by the page and count queries. */
const statusExpression = Prisma.sql`
  CASE
    WHEN ${HAS_ATTENDANCE} AND ${HAS_DAILY_UPDATE}     THEN 'COMPLETE'
    WHEN ${HAS_ATTENDANCE} AND NOT ${HAS_DAILY_UPDATE} THEN 'MISSING_UPDATE'
    WHEN NOT ${HAS_ATTENDANCE} AND ${HAS_DAILY_UPDATE} THEN 'MISSING_ATTENDANCE'
    ELSE 'MISSING_BOTH'
  END
`;

/**
 * The per-account SELECT list, shared by the page query and the single-account
 * read so the detail view can never derive a status the list disagrees with.
 *
 * `MAX(a.…)` over the form details is exact rather than arbitrary: `a` is one
 * row per account, so every membership in the group sees the same values.
 */
const accountSelect = Prisma.sql`
  dm.discord_user_id AS "discordUserId",
  (ARRAY_AGG(dm.id ORDER BY dm.guild_id))[1]               AS "memberId",
  ARRAY_AGG(dm.id ORDER BY dm.guild_id)                    AS "memberIds",
  ARRAY_AGG(dm.guild_id ORDER BY dm.guild_id)              AS "guildIds",
  -- Cross-server presence, served by the discord_user_id index. Deliberately
  -- outside the grouping so it ignores any server filter and keeps reporting
  -- the true number of servers holding this account.
  (
    SELECT COUNT(*)::int FROM discord_members o
     WHERE o.discord_user_id = dm.discord_user_id
       AND o.is_in_guild = TRUE
  )                                                        AS "serverCount",
  (ARRAY_AGG(dm.discord_username ORDER BY dm.guild_id))[1] AS "discordUsername",
  (ARRAY_AGG(dm.display_name ORDER BY dm.guild_id))[1]     AS "displayName",
  BOOL_OR(dm.is_in_guild)   AS "isInGuild",
  MAX(a.name)               AS "name",
  MAX(a.email)              AS "email",
  MAX(a.phone)              AS "phone",
  MAX(a.submitted_at)       AS "submittedAt",
  ${HAS_ATTENDANCE}         AS "hasAttendance",
  ${HAS_DAILY_UPDATE}       AS "hasDailyUpdate",
  ${statusExpression}       AS "status"
`;

/**
 * One page of per-account status for a date, plus the total number of accounts
 * matching the filters so the caller can derive the page count.
 *
 * Two queries regardless of member count — never one per member.
 */
const getDailyStatusPage = async ({
  date,
  guildId,
  status,
  search,
  page = 1,
  limit = 50,
  includeDeparted = false,
  sortBy = 'username',
  sortDir = 'asc',
}: DailyStatusQuery): Promise<{ rows: DailyStatusRow[]; total: number }> => {
  const source = statusSource(date, { includeDeparted, guildId });
  const having = searchHaving(search);

  // Filtering on the computed status has to happen outside the SELECT that
  // defines it, hence the wrapping subquery.
  const statusFilter = status
    ? Prisma.sql`WHERE ranked.status = ${status}`
    : Prisma.empty;

  const orderBy = Prisma.sql`ORDER BY ${SORT_COLUMNS[sortBy] ?? SORT_COLUMNS.username} ${
    SORT_DIRECTIONS[sortDir] ?? SORT_DIRECTIONS.asc
  } NULLS LAST`;

  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 500);
  const safePage = Math.max(Math.trunc(page) || 1, 1);
  const offset = (safePage - 1) * safeLimit;

  const [rows, totalResult] = await Promise.all([
    prisma.$queryRaw<DailyStatusRow[]>`
      SELECT * FROM (
        SELECT ${accountSelect}
        ${source}
        GROUP BY dm.discord_user_id
        ${having}
      ) ranked
      ${statusFilter}
      ${orderBy}
      LIMIT ${safeLimit} OFFSET ${offset}
    `,
    prisma.$queryRaw<{ total: bigint }[]>`
      SELECT COUNT(*)::bigint AS total FROM (
        SELECT ${statusExpression} AS status
        ${source}
        GROUP BY dm.discord_user_id
        ${having}
      ) ranked
      ${statusFilter}
    `,
  ]);

  // Postgres COUNT is bigint; the pg driver hands it back as bigint, which
  // does not survive JSON serialization.
  return { rows, total: Number(totalResult[0]?.total ?? 0) };
};

/**
 * The seven dashboard overview figures for a date, over the whole date — not
 * counted from a page, which would describe only that page.
 *
 * The four status buckets sum to `totalMembers` by construction: every account
 * matched by the source falls into exactly one CASE branch. `byServer` is a
 * different unit and does NOT sum to the totals — see the file header.
 */
const getDailyStatusCounts = async (
  date: string,
  {
    includeDeparted = false,
    guildId,
  }: Pick<DailyStatusQuery, 'includeDeparted' | 'guildId'> = {},
): Promise<DailyStatusCounts> => {
  const source = statusSource(date, { includeDeparted, guildId });

  const [result] = await prisma.$queryRaw<
    {
      totalMembers: bigint;
      attendanceSubmitted: bigint;
      dailyUpdateSubmitted: bigint;
      bothCompleted: bigint;
      missingUpdateOnly: bigint;
      missingAttendanceOnly: bigint;
      missingBoth: bigint;
    }[]
  >`
    SELECT
      COUNT(*)::bigint AS "totalMembers",
      COUNT(*) FILTER (WHERE grouped."hasAttendance")::bigint AS "attendanceSubmitted",
      COUNT(*) FILTER (WHERE grouped."hasDailyUpdate")::bigint AS "dailyUpdateSubmitted",
      COUNT(*) FILTER (WHERE grouped."hasAttendance" AND grouped."hasDailyUpdate")::bigint AS "bothCompleted",
      COUNT(*) FILTER (WHERE grouped."hasAttendance" AND NOT grouped."hasDailyUpdate")::bigint AS "missingUpdateOnly",
      COUNT(*) FILTER (WHERE NOT grouped."hasAttendance" AND grouped."hasDailyUpdate")::bigint AS "missingAttendanceOnly",
      COUNT(*) FILTER (WHERE NOT grouped."hasAttendance" AND NOT grouped."hasDailyUpdate")::bigint AS "missingBoth"
    FROM (
      SELECT
        ${HAS_ATTENDANCE}   AS "hasAttendance",
        ${HAS_DAILY_UPDATE} AS "hasDailyUpdate"
      ${source}
      GROUP BY dm.discord_user_id
    ) grouped
  `;

  // The same seven figures per server. Deliberately built from the same
  // `source`, so a filter that applies to one applies to both.
  //
  // Ungrouped by account on purpose: this answers "of the people in THIS
  // server, how many are done" — a per-server denominator an admin can act on.
  // The status being credited is still account-level, so someone who posted in
  // the other server counts as complete here too.
  const perServer = await prisma.$queryRaw<
    {
      guildId: string;
      totalMembers: bigint;
      attendanceSubmitted: bigint;
      dailyUpdateSubmitted: bigint;
      bothCompleted: bigint;
      missingUpdateOnly: bigint;
      missingAttendanceOnly: bigint;
      missingBoth: bigint;
    }[]
  >`
    SELECT
      dm.guild_id AS "guildId",
      COUNT(*)::bigint AS "totalMembers",
      COUNT(*) FILTER (WHERE a.id IS NOT NULL)::bigint AS "attendanceSubmitted",
      COUNT(*) FILTER (WHERE du.discord_user_id IS NOT NULL)::bigint AS "dailyUpdateSubmitted",
      COUNT(*) FILTER (WHERE a.id IS NOT NULL AND du.discord_user_id IS NOT NULL)::bigint AS "bothCompleted",
      COUNT(*) FILTER (WHERE a.id IS NOT NULL AND du.discord_user_id IS NULL)::bigint AS "missingUpdateOnly",
      COUNT(*) FILTER (WHERE a.id IS NULL AND du.discord_user_id IS NOT NULL)::bigint AS "missingAttendanceOnly",
      COUNT(*) FILTER (WHERE a.id IS NULL AND du.discord_user_id IS NULL)::bigint AS "missingBoth"
    ${source}
    GROUP BY dm.guild_id
    ORDER BY dm.guild_id ASC
  `;

  return {
    totalMembers: Number(result?.totalMembers ?? 0),
    attendanceSubmitted: Number(result?.attendanceSubmitted ?? 0),
    dailyUpdateSubmitted: Number(result?.dailyUpdateSubmitted ?? 0),
    bothCompleted: Number(result?.bothCompleted ?? 0),
    missingUpdateOnly: Number(result?.missingUpdateOnly ?? 0),
    missingAttendanceOnly: Number(result?.missingAttendanceOnly ?? 0),
    missingBoth: Number(result?.missingBoth ?? 0),
    byServer: perServer.map((row) => ({
      guildId: row.guildId,
      totalMembers: Number(row.totalMembers),
      attendanceSubmitted: Number(row.attendanceSubmitted),
      dailyUpdateSubmitted: Number(row.dailyUpdateSubmitted),
      bothCompleted: Number(row.bothCompleted),
      missingUpdateOnly: Number(row.missingUpdateOnly),
      missingAttendanceOnly: Number(row.missingAttendanceOnly),
      missingBoth: Number(row.missingBoth),
    })),
  };
};

export type ReminderTarget = {
  /** The server this member record belongs to. */
  guildId: string;
  memberId: string;
  discordUserId: string;
  discordUsername: string;
  displayName: string | null;
  /**
   * How many counted days this account failed the criterion on — the reason it
   * was targeted, carried through to the recipient audit so a past broadcast
   * can be read back without recomputing it against changed data.
   */
  missedDays: number;
};

/**
 * Member records whose ACCOUNT posted no daily update anywhere on a date.
 *
 * The single-date form of `listReminderTargets`, kept as its own name because
 * this is the shape every existing caller asks for. It is deliberately a thin
 * call rather than its own SQL: two queries answering "who is missing an
 * update" would be two definitions that can drift, and this one is what the
 * dashboard's figures are reconciled against.
 *
 * A single date is one counted day, so the threshold of 1 means "failed that
 * day" — exactly what the query it replaces meant.
 */
const listMembersMissingUpdate = async (
  date: string,
  guildId?: string,
): Promise<ReminderTarget[]> =>
  listReminderTargets({
    days: [date],
    criterion: REMINDER_CRITERION.MISSING_UPDATE,
    minMissedDays: 1,
    guildId,
  });

/**
 * One account's daily status for a date, using the exact same derivation as the
 * page and counts queries.
 *
 * Takes any one of the account's member records and reports on the whole
 * account, so a link built from server A's row shows the update posted in
 * server B rather than an unexplained MISSING_UPDATE.
 *
 * No `is_in_guild` filter: the detail view is reachable for someone who has
 * since left, and their history is still theirs.
 */
const getDailyStatusForMember = async (
  memberId: string,
  date: string,
): Promise<DailyStatusRow | null> => {
  const rows = await prisma.$queryRaw<DailyStatusRow[]>`
    SELECT ${accountSelect}
    FROM discord_members dm
    LEFT JOIN (${accountAttendanceSource(date)}) a
      ON a.discord_user_id = dm.discord_user_id
    LEFT JOIN (${accountUpdateSource(date)}) du
      ON du.discord_user_id = dm.discord_user_id
    WHERE dm.discord_user_id = (
      SELECT target.discord_user_id FROM discord_members target
       WHERE target.id = ${memberId}
    )
    GROUP BY dm.discord_user_id
    LIMIT 1
  `;

  return rows[0] ?? null;
};

/* ────────────────────────────────────────────────────────────────────────────
 * RANGE MODE
 *
 * Everything above answers "what happened on this one day". Everything below
 * answers "what happened across this span of days", and it is the same report
 * with the day count as a second dimension: still one row per ACCOUNT, still
 * crediting work done in any server to the account everywhere, still filtered
 * and paged the same way.
 *
 * ── The counted-day set is enumerated in TypeScript, not in SQL ───────────
 * `rangeDays()` in `src/utils/dhakaDate.ts` turns `from`/`to`/`daysOfWeek`
 * into the explicit list of `YYYY-MM-DD` days that count, and that list is
 * bound into every query below as a parameter. There is deliberately no
 * `generate_series` + `EXTRACT(DOW …)` here:
 *
 *   - it keeps ONE definition of "which days count", in the module that is
 *     already the single producer of Dhaka days, rather than one in SQL and a
 *     second in the service that has to reject an empty set;
 *   - `daysInRange` is then known before any query runs, so the zero-counted-
 *     days rejection costs nothing and every derived figure below is
 *     arithmetic against a bound integer rather than a scalar subquery;
 *   - no timezone reasoning enters SQL at all.
 *
 * The span cap (92 days) is what keeps the bound array small.
 *
 * ── Additional columns these queries depend on ────────────────────────────
 * Same tables as the single-date queries; the range scans read
 * `attendances.attendance_date` and `daily_updates.message_date` as RANGE
 * predicates rather than equality ones, served by the existing single-column
 * indexes on both. Re-check by hand after any schema change — `$queryRaw`
 * will not break at compile time on a rename.
 *
 * ── Combined totals still do NOT equal the sum of `byServer` ──────────────
 * Unchanged from date mode and for the same reason: the combined figures count
 * ACCOUNTS, `byServer` counts each server's own MEMBERSHIPS, and the gap is
 * precisely the overlap.
 * ──────────────────────────────────────────────────────────────────────── */

/** How an account fared over a whole range, rolled up from its counted days. */
export const RANGE_STATUS = {
  /** Every counted day had both an attendance submission and an update. */
  ALL_COMPLETE: 'ALL_COMPLETE',
  /** Some counted days were complete, some were not. */
  PARTIAL: 'PARTIAL',
  /** No counted day was complete, whatever was submitted on some of them. */
  NONE: 'NONE',
} as const;

export type RangeStatus = (typeof RANGE_STATUS)[keyof typeof RANGE_STATUS];

/**
 * A range row — ONE PER DISCORD ACCOUNT, carrying the same identity columns as
 * `DailyStatusRow` with the single-day verdict replaced by per-day counts.
 *
 * `incompleteDays` and `missedBothDays` are DIFFERENT figures and both are
 * reported. Someone who submits attendance daily and never posts an update has
 * `incompleteDays = daysInRange` and `missedBothDays = 0`. The reminder
 * threshold acts on `missedBothDays`, so an admin reading only `incompleteDays`
 * would set a threshold against a number the broadcast does not use — which is
 * why there is deliberately no field called `missedDays`.
 */
export type DailyStatusRangeRow = {
  discordUserId: string;
  memberId: string;
  memberIds: string[];
  guildIds: string[];
  serverCount: number;
  discordUsername: string;
  displayName: string | null;
  isInGuild: boolean;
  /** Contact details from the account's MOST RECENT submission in the range. */
  name: string | null;
  email: string | null;
  phone: string | null;
  submittedAt: Date | null;
  /** Counted days in the range — the denominator of everything below. */
  daysInRange: number;
  attendanceDays: number;
  updateDays: number;
  completeDays: number;
  /** Counted days that were not fully done: `daysInRange - completeDays`. */
  incompleteDays: number;
  /** Counted days the account did NEITHER thing. The reminder's unit. */
  missedBothDays: number;
  /** Counted days with no daily update, whatever attendance says. */
  missedUpdateDays: number;
  rangeStatus: RangeStatus;
};

export type DailyStatusRangeFigures = {
  totalMembers: number;
  allCompleteMembers: number;
  partialMembers: number;
  noneMembers: number;
  /** Person-day totals: summed across accounts, so they scale with the span. */
  attendanceDays: number;
  updateDays: number;
  completeDays: number;
  missedBothDays: number;
};

export type DailyStatusRangeCounts = DailyStatusRangeFigures & {
  daysInRange: number;
  byServer: (DailyStatusRangeFigures & { guildId: string })[];
};

export type DailyStatusRangeQuery = {
  /** The counted days, already resolved from `from`/`to`/`daysOfWeek`. */
  days: string[];
  guildId?: string;
  rangeStatus?: RangeStatus;
  /** Keep only accounts that did neither thing on at least this many days. */
  minMissedBothDays?: number;
  search?: string;
  page?: number;
  limit?: number;
  includeDeparted?: boolean;
  sortBy?: DailyStatusRangeSortColumn;
  sortDir?: 'asc' | 'desc';
};

export type DailyStatusRangeSortColumn = keyof typeof RANGE_SORT_COLUMNS;

// Closed allowlist, exactly as in date mode: sort column and direction are the
// one thing that cannot be bound as a parameter, so they are mapped through
// here and never interpolated from client input.
const RANGE_SORT_COLUMNS = {
  guildId: Prisma.sql`ranked."guildIds"`,
  username: Prisma.sql`ranked."discordUsername"`,
  displayName: Prisma.sql`ranked."displayName"`,
  rangeStatus: Prisma.sql`ranked."rangeStatus"`,
  missedBothDays: Prisma.sql`ranked."missedBothDays"`,
  completeDays: Prisma.sql`ranked."completeDays"`,
  submittedAt: Prisma.sql`ranked."submittedAt"`,
} as const;

/**
 * Restricts a date column to the counted days.
 *
 * Both predicates are deliberate: `BETWEEN` is what the existing single-column
 * index range-scans on, and `= ANY` then prunes the weekdays the admin
 * excluded. With no exclusions the `ANY` is omitted entirely rather than
 * enumerating every day for nothing.
 */
const withinCountedDays = (column: Prisma.Sql, days: string[]): Prisma.Sql => {
  const from = days[0];
  const to = days[days.length - 1];
  const contiguous =
    days.length === countDhakaDaysInclusive(from as string, to as string);

  return contiguous
    ? Prisma.sql`${column} BETWEEN ${from} AND ${to}`
    : Prisma.sql`${column} BETWEEN ${from} AND ${to} AND ${column} = ANY(${days})`;
};

/**
 * The CTEs every range query is built on.
 *
 * `day_facts` is one row per (ACCOUNT, counted day on which it did something),
 * carrying which of the two things it did. Like the single-date credit sources
 * it is keyed on `discord_user_id` and filtered by NOTHING else — no
 * `guild_id`, no `is_in_guild`. "Posted an update in any server" has to mean
 * any server, and adding a server filter here would restore the per-server
 * obligation this grouping exists to remove: a `guildId` filter would start
 * changing people's STATUS rather than only who is listed.
 *
 * `range_contact` takes the account's MOST RECENT submission in the range —
 * where date mode takes that one day's EARLIEST. These are contact details for
 * reaching a student, so over a span the freshest wins; within a single day
 * the earliest is the submission itself.
 *
 * EXPORTED — reused by `rosterStatus.repository.ts`; see the file header.
 */
const rangeCtes = (days: string[]): Prisma.Sql => Prisma.sql`
  WITH day_facts AS (
    SELECT
      t.discord_user_id,
      t.day,
      BOOL_OR(t.kind = 'A') AS has_attendance,
      BOOL_OR(t.kind = 'U') AS has_update
    FROM (
      SELECT o.discord_user_id, a.attendance_date AS day, 'A' AS kind
        FROM attendances a
        JOIN discord_members o ON o.id = a.member_id
       WHERE ${withinCountedDays(Prisma.sql`a.attendance_date`, days)}
      UNION ALL
      SELECT o.discord_user_id, du.message_date AS day, 'U' AS kind
        FROM daily_updates du
        JOIN discord_members o ON o.id = du.member_id
       WHERE ${withinCountedDays(Prisma.sql`du.message_date`, days)}
    ) t
    GROUP BY t.discord_user_id, t.day
  ),
  account_totals AS (
    SELECT
      discord_user_id,
      COUNT(*) FILTER (WHERE has_attendance)::int              AS attendance_days,
      COUNT(*) FILTER (WHERE has_update)::int                  AS update_days,
      COUNT(*) FILTER (WHERE has_attendance AND has_update)::int AS complete_days,
      COUNT(*)::int                                            AS active_days
    FROM day_facts
    GROUP BY discord_user_id
  ),
  range_contact AS (
    SELECT DISTINCT ON (o.discord_user_id)
      o.discord_user_id,
      a.name,
      a.email,
      a.phone,
      a.submitted_at
    FROM attendances a
    JOIN discord_members o ON o.id = a.member_id
    WHERE ${withinCountedDays(Prisma.sql`a.attendance_date`, days)}
    ORDER BY o.discord_user_id, a.submitted_at DESC, a.id DESC
  )
`;

/**
 * Shared FROM/JOIN/WHERE core for range mode, the sibling of `statusSource`.
 *
 * The joins are LEFT joins onto account-level CTEs, so an account that did
 * nothing at all in the range still produces a row — with `missedBothDays`
 * equal to the whole range. That is the worst case and the one an admin most
 * needs to see; an inner join would silently drop exactly those people.
 */
const rangeSource = ({
  includeDeparted = false,
  guildId,
}: Pick<DailyStatusRangeQuery, 'includeDeparted' | 'guildId'>): Prisma.Sql => {
  const inGuildFilter = includeDeparted
    ? Prisma.empty
    : Prisma.sql`AND dm.is_in_guild = TRUE`;

  // Selects WHICH accounts are listed. Deliberately not applied to the CTEs
  // above, so it never changes anyone's counts.
  const serverFilter = guildId
    ? Prisma.sql`AND dm.guild_id = ${guildId}`
    : Prisma.empty;

  return Prisma.sql`
    FROM discord_members dm
    LEFT JOIN account_totals at ON at.discord_user_id = dm.discord_user_id
    LEFT JOIN range_contact  rc ON rc.discord_user_id = dm.discord_user_id
    WHERE TRUE ${inGuildFilter} ${serverFilter}
  `;
};

/**
 * The search filter for range mode.
 *
 * A `HAVING BOOL_OR(…)` for the same reason date mode uses one: nicknames are
 * per server, so a `WHERE` would keep the matching membership and drop the
 * other one from that person's own row, leaving `guildIds` naming one server
 * while `serverCount` says two.
 */
const rangeSearchHaving = (search?: string): Prisma.Sql => {
  const term = search?.trim();

  if (!term) return Prisma.empty;

  const like = `%${term}%`;

  return Prisma.sql`HAVING BOOL_OR(
    dm.display_name ILIKE ${like}
    OR dm.discord_username ILIKE ${like}
    OR rc.name ILIKE ${like}
    OR rc.phone ILIKE ${like}
    OR rc.email ILIKE ${like}
  )`;
};

// `at` is already one row per account, so it is constant within each group —
// MAX is how it survives the GROUP BY, not a choice between differing values.
// COALESCE is what turns "no row in account_totals" into a zero rather than a
// NULL that would poison every subtraction below.
const ATTENDANCE_DAYS = Prisma.sql`COALESCE(MAX(at.attendance_days), 0)`;
const UPDATE_DAYS = Prisma.sql`COALESCE(MAX(at.update_days), 0)`;
const COMPLETE_DAYS = Prisma.sql`COALESCE(MAX(at.complete_days), 0)`;
const ACTIVE_DAYS = Prisma.sql`COALESCE(MAX(at.active_days), 0)`;

/**
 * The rollup, derived from the complete-day count alone.
 *
 * `daysInRange` is bound as a parameter and is guaranteed non-zero by the
 * service, so `ALL_COMPLETE` can never be reached by vacuous truth.
 */
const rangeStatusExpression = (daysInRange: number): Prisma.Sql => Prisma.sql`
  CASE
    WHEN ${COMPLETE_DAYS} = ${daysInRange} THEN 'ALL_COMPLETE'
    WHEN ${COMPLETE_DAYS} = 0              THEN 'NONE'
    ELSE 'PARTIAL'
  END
`;

/**
 * The per-account SELECT list for range mode, shared by the page query and the
 * single-account read so the detail view can never disagree with the list.
 *
 * The three derived counts are subtractions against the bound `daysInRange`,
 * not additional scans.
 */
const accountRangeSelect = (daysInRange: number): Prisma.Sql => Prisma.sql`
  dm.discord_user_id AS "discordUserId",
  (ARRAY_AGG(dm.id ORDER BY dm.guild_id))[1]               AS "memberId",
  ARRAY_AGG(dm.id ORDER BY dm.guild_id)                    AS "memberIds",
  ARRAY_AGG(dm.guild_id ORDER BY dm.guild_id)              AS "guildIds",
  -- Outside the grouping on purpose, so it ignores any server filter and keeps
  -- reporting the true number of servers holding this account.
  (
    SELECT COUNT(*)::int FROM discord_members o
     WHERE o.discord_user_id = dm.discord_user_id
       AND o.is_in_guild = TRUE
  )                                                        AS "serverCount",
  (ARRAY_AGG(dm.discord_username ORDER BY dm.guild_id))[1] AS "discordUsername",
  (ARRAY_AGG(dm.display_name ORDER BY dm.guild_id))[1]     AS "displayName",
  BOOL_OR(dm.is_in_guild)          AS "isInGuild",
  MAX(rc.name)                     AS "name",
  MAX(rc.email)                    AS "email",
  MAX(rc.phone)                    AS "phone",
  MAX(rc.submitted_at)             AS "submittedAt",
  ${daysInRange}::int              AS "daysInRange",
  ${ATTENDANCE_DAYS}               AS "attendanceDays",
  ${UPDATE_DAYS}                   AS "updateDays",
  ${COMPLETE_DAYS}                 AS "completeDays",
  (${daysInRange} - ${COMPLETE_DAYS}) AS "incompleteDays",
  (${daysInRange} - ${ACTIVE_DAYS})   AS "missedBothDays",
  (${daysInRange} - ${UPDATE_DAYS})   AS "missedUpdateDays",
  ${rangeStatusExpression(daysInRange)} AS "rangeStatus"
`;

/**
 * One page of per-account status for a range, plus the total number of
 * accounts matching the filters.
 *
 * Two queries regardless of how many days the range spans and how many members
 * exist — never one per day, never one per member, and never one row per
 * member per day materialised in the database.
 */
const getDailyStatusRangePage = async ({
  days,
  guildId,
  rangeStatus,
  minMissedBothDays,
  search,
  page = 1,
  limit = 50,
  includeDeparted = false,
  sortBy = 'username',
  sortDir = 'asc',
}: DailyStatusRangeQuery): Promise<{
  rows: DailyStatusRangeRow[];
  total: number;
}> => {
  const daysInRange = days.length;
  const ctes = rangeCtes(days);
  const source = rangeSource({ includeDeparted, guildId });
  const having = rangeSearchHaving(search);

  // Both filters read computed columns, so they have to sit outside the SELECT
  // that defines them — hence the wrapping subquery, as in date mode.
  const outerFilters: Prisma.Sql[] = [];

  if (rangeStatus) {
    outerFilters.push(Prisma.sql`ranked."rangeStatus" = ${rangeStatus}`);
  }

  if (minMissedBothDays !== undefined) {
    outerFilters.push(
      Prisma.sql`ranked."missedBothDays" >= ${minMissedBothDays}`,
    );
  }

  const where = outerFilters.length
    ? Prisma.sql`WHERE ${Prisma.join(outerFilters, ' AND ')}`
    : Prisma.empty;

  const orderBy = Prisma.sql`ORDER BY ${
    RANGE_SORT_COLUMNS[sortBy] ?? RANGE_SORT_COLUMNS.username
  } ${SORT_DIRECTIONS[sortDir] ?? SORT_DIRECTIONS.asc} NULLS LAST`;

  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 500);
  const safePage = Math.max(Math.trunc(page) || 1, 1);
  const offset = (safePage - 1) * safeLimit;

  const [rows, totalResult] = await Promise.all([
    prisma.$queryRaw<DailyStatusRangeRow[]>`
      ${ctes}
      SELECT * FROM (
        SELECT ${accountRangeSelect(daysInRange)}
        ${source}
        GROUP BY dm.discord_user_id
        ${having}
      ) ranked
      ${where}
      ${orderBy}
      LIMIT ${safeLimit} OFFSET ${offset}
    `,
    prisma.$queryRaw<{ total: bigint }[]>`
      ${ctes}
      SELECT COUNT(*)::bigint AS total FROM (
        SELECT
          ${rangeStatusExpression(daysInRange)} AS "rangeStatus",
          (${daysInRange} - ${ACTIVE_DAYS})     AS "missedBothDays"
        ${source}
        GROUP BY dm.discord_user_id
        ${having}
      ) ranked
      ${where}
    `,
  ]);

  return { rows, total: Number(totalResult[0]?.total ?? 0) };
};

/**
 * The range overview figures, over the whole range rather than a page.
 *
 * The three rollup buckets sum to `totalMembers` by construction: every account
 * matched by the source falls into exactly one branch. The person-day totals do
 * not — they are a different unit and scale with the span.
 */
const getDailyStatusRangeCounts = async (
  days: string[],
  {
    includeDeparted = false,
    guildId,
  }: Pick<DailyStatusRangeQuery, 'includeDeparted' | 'guildId'> = {},
): Promise<DailyStatusRangeCounts> => {
  const daysInRange = days.length;
  const ctes = rangeCtes(days);
  const source = rangeSource({ includeDeparted, guildId });

  // The per-account roll-up both queries below aggregate over. Selected once
  // so the combined figures and the breakdown can never describe different
  // people.
  const groupedSelect = Prisma.sql`
    SELECT
      ${rangeStatusExpression(daysInRange)} AS "rangeStatus",
      ${ATTENDANCE_DAYS}                    AS "attendanceDays",
      ${UPDATE_DAYS}                        AS "updateDays",
      ${COMPLETE_DAYS}                      AS "completeDays",
      (${daysInRange} - ${ACTIVE_DAYS})     AS "missedBothDays"
    ${source}
    GROUP BY dm.discord_user_id
  `;

  const figuresSelect = Prisma.sql`
    COUNT(*)::bigint AS "totalMembers",
    COUNT(*) FILTER (WHERE grouped."rangeStatus" = 'ALL_COMPLETE')::bigint AS "allCompleteMembers",
    COUNT(*) FILTER (WHERE grouped."rangeStatus" = 'PARTIAL')::bigint      AS "partialMembers",
    COUNT(*) FILTER (WHERE grouped."rangeStatus" = 'NONE')::bigint         AS "noneMembers",
    COALESCE(SUM(grouped."attendanceDays"), 0)::bigint AS "attendanceDays",
    COALESCE(SUM(grouped."updateDays"), 0)::bigint     AS "updateDays",
    COALESCE(SUM(grouped."completeDays"), 0)::bigint   AS "completeDays",
    COALESCE(SUM(grouped."missedBothDays"), 0)::bigint AS "missedBothDays"
  `;

  type RawFigures = {
    totalMembers: bigint;
    allCompleteMembers: bigint;
    partialMembers: bigint;
    noneMembers: bigint;
    attendanceDays: bigint;
    updateDays: bigint;
    completeDays: bigint;
    missedBothDays: bigint;
  };

  const [result] = await prisma.$queryRaw<RawFigures[]>`
    ${ctes}
    SELECT ${figuresSelect}
    FROM (${groupedSelect}) grouped
  `;

  // The same figures per server. Ungrouped by account on purpose: this answers
  // "of the people in THIS server, how many are done" — a denominator each
  // server's admin can act on. The status being credited is still
  // account-level, so someone who posted in the other server counts here too.
  const perServer = await prisma.$queryRaw<
    (RawFigures & { guildId: string })[]
  >`
    ${ctes}
    SELECT
      grouped."guildId",
      ${figuresSelect}
    FROM (
      SELECT
        dm.guild_id AS "guildId",
        ${rangeStatusExpression(daysInRange)} AS "rangeStatus",
        ${ATTENDANCE_DAYS}                    AS "attendanceDays",
        ${UPDATE_DAYS}                        AS "updateDays",
        ${COMPLETE_DAYS}                      AS "completeDays",
        (${daysInRange} - ${ACTIVE_DAYS})     AS "missedBothDays"
      ${source}
      GROUP BY dm.guild_id, dm.discord_user_id
    ) grouped
    GROUP BY grouped."guildId"
    ORDER BY grouped."guildId" ASC
  `;

  const toFigures = (row?: RawFigures): DailyStatusRangeFigures => ({
    totalMembers: Number(row?.totalMembers ?? 0),
    allCompleteMembers: Number(row?.allCompleteMembers ?? 0),
    partialMembers: Number(row?.partialMembers ?? 0),
    noneMembers: Number(row?.noneMembers ?? 0),
    attendanceDays: Number(row?.attendanceDays ?? 0),
    updateDays: Number(row?.updateDays ?? 0),
    completeDays: Number(row?.completeDays ?? 0),
    missedBothDays: Number(row?.missedBothDays ?? 0),
  });

  return {
    daysInRange,
    ...toFigures(result),
    byServer: perServer.map((row) => ({
      guildId: row.guildId,
      ...toFigures(row),
    })),
  };
};

/** One counted day of an account's range, as the detail view shows it. */
export type DailyStatusRangeDay = {
  date: string;
  hasAttendance: boolean;
  hasDailyUpdate: boolean;
  status: DailyStatus;
};

/**
 * One account's range counts plus the per-day facts behind them.
 *
 * Takes any one of the account's member records and reports the whole account,
 * so a link built from server A's row reflects updates posted in server B.
 * No `is_in_guild` filter, for the same reason as the single-date detail read:
 * the page is reachable for someone who has since left, and their history is
 * still theirs.
 *
 * The per-day array is built from the SAME counted-day list the counts were
 * computed from, so the two always reconcile — a day the admin excluded is
 * absent from both.
 */
const getDailyStatusRangeForMember = async (
  memberId: string,
  days: string[],
): Promise<{
  row: DailyStatusRangeRow;
  days: DailyStatusRangeDay[];
} | null> => {
  const daysInRange = days.length;
  const ctes = rangeCtes(days);

  const rows = await prisma.$queryRaw<DailyStatusRangeRow[]>`
    ${ctes}
    SELECT ${accountRangeSelect(daysInRange)}
    FROM discord_members dm
    LEFT JOIN account_totals at ON at.discord_user_id = dm.discord_user_id
    LEFT JOIN range_contact  rc ON rc.discord_user_id = dm.discord_user_id
    WHERE dm.discord_user_id = (
      SELECT target.discord_user_id FROM discord_members target
       WHERE target.id = ${memberId}
    )
    GROUP BY dm.discord_user_id
    LIMIT 1
  `;

  const row = rows[0];

  if (!row) return null;

  const facts = await prisma.$queryRaw<
    { day: string; hasAttendance: boolean; hasUpdate: boolean }[]
  >`
    ${ctes}
    SELECT
      df.day                AS "day",
      df.has_attendance     AS "hasAttendance",
      df.has_update         AS "hasUpdate"
    FROM day_facts df
    WHERE df.discord_user_id = ${row.discordUserId}
  `;

  const byDay = new Map(facts.map((fact) => [fact.day, fact]));

  return {
    row,
    // Driven by the counted-day list, not by the rows returned: a day with no
    // activity has no `day_facts` row and must still appear as a missed day.
    days: days.map((date) => {
      const fact = byDay.get(date);
      const hasAttendance = fact?.hasAttendance ?? false;
      const hasDailyUpdate = fact?.hasUpdate ?? false;

      return {
        date,
        hasAttendance,
        hasDailyUpdate,
        status: statusOf(hasAttendance, hasDailyUpdate),
      };
    }),
  };
};

/**
 * The four-bucket verdict for one day, in TypeScript.
 *
 * Mirrors `statusExpression` exactly. It exists because the per-day breakdown
 * assembles days that have no database row at all, which SQL cannot produce a
 * verdict for.
 */
const statusOf = (
  hasAttendance: boolean,
  hasDailyUpdate: boolean,
): DailyStatus => {
  if (hasAttendance && hasDailyUpdate) return DAILY_STATUS.COMPLETE;
  if (hasAttendance) return DAILY_STATUS.MISSING_UPDATE;
  if (hasDailyUpdate) return DAILY_STATUS.MISSING_ATTENDANCE;

  return DAILY_STATUS.MISSING_BOTH;
};

/** What counts as a day an account failed, for reminder targeting. */
export const REMINDER_CRITERION = {
  /** No daily update recorded that day, whatever attendance says. */
  MISSING_UPDATE: 'MISSING_UPDATE',
  /** Neither an attendance submission nor a daily update that day. */
  MISSING_BOTH: 'MISSING_BOTH',
} as const;

export type ReminderCriterionValue =
  (typeof REMINDER_CRITERION)[keyof typeof REMINDER_CRITERION];

export type ReminderTargetQuery = {
  /** The counted days, already resolved from `from`/`to`/`daysOfWeek`. */
  days: string[];
  criterion: ReminderCriterionValue;
  /** Target only accounts failing on at least this many counted days. */
  minMissedDays: number;
  guildId?: string;
};

/**
 * Member records to remind — the DM target list.
 *
 * Built from the SAME `day_facts` CTE the dashboard's range aggregation is
 * built from. That is the whole point and not an implementation convenience:
 * dashboard and DM must agree on who is behind, so there is exactly one
 * definition of it and both read that one. A convenience query assembled in the
 * reminder service would be drift.
 *
 * ── The threshold is evaluated per ACCOUNT ────────────────────────────────
 * `failing_accounts` groups on `discord_user_id` with no `guild_id` anywhere,
 * so an account that did the work in server A is not targeted on behalf of
 * server B. Same rule the dashboard applies, same two tables, same way.
 *
 * ── But a row is still returned per MEMBER RECORD ─────────────────────────
 * That contract is unchanged from the single-date query it replaces. It is
 * what gives each server its own auditable recipient row and what lets the
 * closed-DM fallback post in the server the person is actually in. They receive
 * ONE DM regardless: every row carries `discordUserId` and the queue groups on
 * it, one job per account.
 *
 * `is_in_guild` and the optional `guildId` filter apply to the member-record
 * side only — a departed member cannot be reminded in the server they left,
 * but their membership elsewhere is targeted normally.
 */
const listReminderTargets = async ({
  days,
  criterion,
  minMissedDays,
  guildId,
}: ReminderTargetQuery): Promise<ReminderTarget[]> => {
  const ctes = rangeCtes(days);
  const daysInRange = days.length;

  const serverFilter = guildId
    ? Prisma.sql`AND dm.guild_id = ${guildId}`
    : Prisma.empty;

  // How many counted days the account failed, by criterion. Both are
  // subtractions against the bound day count rather than another scan:
  // an account with no `account_totals` row failed every counted day, which is
  // exactly what COALESCE(…, 0) produces here.
  const failedDays =
    criterion === REMINDER_CRITERION.MISSING_BOTH
      ? Prisma.sql`${daysInRange} - COALESCE(at.active_days, 0)`
      : Prisma.sql`${daysInRange} - COALESCE(at.update_days, 0)`;

  return prisma.$queryRaw<ReminderTarget[]>`
    ${ctes},
    failing_accounts AS (
      SELECT
        dm.discord_user_id,
        MAX(${failedDays}) AS missed_days
      FROM discord_members dm
      LEFT JOIN account_totals at ON at.discord_user_id = dm.discord_user_id
      GROUP BY dm.discord_user_id
      HAVING MAX(${failedDays}) >= ${minMissedDays}
    )
    SELECT
      dm.id               AS "memberId",
      dm.guild_id         AS "guildId",
      dm.discord_user_id  AS "discordUserId",
      dm.discord_username AS "discordUsername",
      dm.display_name     AS "displayName",
      fa.missed_days::int  AS "missedDays"
    FROM discord_members dm
    JOIN failing_accounts fa ON fa.discord_user_id = dm.discord_user_id
    WHERE dm.is_in_guild = TRUE
      ${serverFilter}
    ORDER BY dm.guild_id ASC, dm.discord_username ASC
  `;
};

/**
 * Re-exported for `rosterStatus.repository.ts` so the roster engagement report
 * can build on the same definitions of "submitted attendance" and "posted a
 * daily update" this dashboard uses. See the file header.
 */
export { accountAttendanceSource, accountUpdateSource, rangeCtes };

export const dailyStatusRepository = {
  getDailyStatusPage,
  getDailyStatusCounts,
  getDailyStatusForMember,
  listMembersMissingUpdate,
  getDailyStatusRangePage,
  getDailyStatusRangeCounts,
  getDailyStatusRangeForMember,
  listReminderTargets,
};
