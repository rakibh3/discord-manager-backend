import { Prisma } from '@generated/prisma/client';

import { prisma } from '@/lib/prisma';

/**
 * The read side of the attendance domain: each member's status for one Dhaka
 * day, the dashboard's summary counts, and the reminder target list.
 *
 * These are raw SQL because the shape — a LEFT JOIN against two date-filtered
 * subqueries producing a computed status column — is not expressible in
 * Prisma's fluent API. The alternative would be three queries plus an
 * in-memory join over ~5,000 rows in Node on every dashboard load.
 *
 * ── Columns these queries depend on ───────────────────────────────────────
 * A rename in `prisma/schema/*.prisma` will NOT break `$queryRaw` at compile
 * time, so every column named below must be checked by hand after a schema
 * change:
 *   discord_members: id, discord_user_id, discord_username, display_name,
 *                    is_in_guild
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
 */

/** The four buckets a member falls into on a given day. */
export const DAILY_STATUS = {
  COMPLETE: 'COMPLETE',
  MISSING_UPDATE: 'MISSING_UPDATE',
  MISSING_ATTENDANCE: 'MISSING_ATTENDANCE',
  MISSING_BOTH: 'MISSING_BOTH',
} as const;

export type DailyStatus = (typeof DAILY_STATUS)[keyof typeof DAILY_STATUS];

/**
 * Row shape returned by the aggregation. Declared by hand because `$queryRaw`
 * gives no inference — it must be kept in step with the SELECT list below.
 */
export type DailyStatusRow = {
  memberId: string;
  discordUserId: string;
  discordUsername: string;
  displayName: string | null;
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

export type DailyStatusCounts = {
  totalMembers: number;
  attendanceSubmitted: number;
  dailyUpdateSubmitted: number;
  bothCompleted: number;
  missingUpdateOnly: number;
  missingAttendanceOnly: number;
  missingBoth: number;
};

export type DailyStatusQuery = {
  /** `YYYY-MM-DD`, Asia/Dhaka. */
  date: string;
  status?: DailyStatus;
  search?: string;
  page?: number;
  limit?: number;
  /** Include members who have since left the guild. Off by default. */
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
 * Shared FROM/JOIN/WHERE core, so the page query and the counts query can
 * never disagree about which members and records they consider.
 *
 * The daily-update side joins a DISTINCT subquery rather than the table: a
 * member who posted five messages must produce one row, not five.
 */
const statusSource = (
  date: string,
  {
    includeDeparted = false,
    search,
  }: Pick<DailyStatusQuery, 'includeDeparted' | 'search'>,
) => {
  const guildFilter = includeDeparted
    ? Prisma.empty
    : Prisma.sql`AND dm.is_in_guild = TRUE`;

  // ILIKE gives the case-insensitive match the spec requires. The term is
  // bound as a parameter, so a `%` or `_` typed by a user is a literal
  // wildcard within their own search, never SQL.
  const searchFilter = search?.trim()
    ? Prisma.sql`AND (
        dm.display_name ILIKE ${`%${search.trim()}%`}
        OR dm.discord_username ILIKE ${`%${search.trim()}%`}
        OR a.name ILIKE ${`%${search.trim()}%`}
        OR a.phone ILIKE ${`%${search.trim()}%`}
        OR a.email ILIKE ${`%${search.trim()}%`}
      )`
    : Prisma.empty;

  return Prisma.sql`
    FROM discord_members dm
    LEFT JOIN attendances a
      ON dm.id = a.member_id AND a.attendance_date = ${date}
    LEFT JOIN (
      SELECT DISTINCT member_id FROM daily_updates WHERE message_date = ${date}
    ) du ON dm.id = du.member_id
    WHERE TRUE ${guildFilter} ${searchFilter}
  `;
};

/** The computed status column, shared by the page and count queries. */
const statusExpression = Prisma.sql`
  CASE
    WHEN a.id IS NOT NULL AND du.member_id IS NOT NULL THEN 'COMPLETE'
    WHEN a.id IS NOT NULL AND du.member_id IS NULL     THEN 'MISSING_UPDATE'
    WHEN a.id IS NULL     AND du.member_id IS NOT NULL THEN 'MISSING_ATTENDANCE'
    ELSE 'MISSING_BOTH'
  END
`;

/**
 * One page of per-member status for a date, plus the total number of members
 * matching the filters so the caller can derive the page count.
 *
 * Two queries regardless of member count — never one per member.
 */
const getDailyStatusPage = async ({
  date,
  status,
  search,
  page = 1,
  limit = 50,
  includeDeparted = false,
  sortBy = 'username',
  sortDir = 'asc',
}: DailyStatusQuery): Promise<{ rows: DailyStatusRow[]; total: number }> => {
  const source = statusSource(date, { includeDeparted, search });

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
        SELECT
          dm.id               AS "memberId",
          dm.discord_user_id  AS "discordUserId",
          dm.discord_username AS "discordUsername",
          dm.display_name     AS "displayName",
          dm.is_in_guild      AS "isInGuild",
          a.name              AS "name",
          a.email             AS "email",
          a.phone             AS "phone",
          a.submitted_at      AS "submittedAt",
          (a.id IS NOT NULL)        AS "hasAttendance",
          (du.member_id IS NOT NULL) AS "hasDailyUpdate",
          ${statusExpression} AS "status"
        ${source}
      ) ranked
      ${statusFilter}
      ${orderBy}
      LIMIT ${safeLimit} OFFSET ${offset}
    `,
    prisma.$queryRaw<{ total: bigint }[]>`
      SELECT COUNT(*)::bigint AS total FROM (
        SELECT ${statusExpression} AS status ${source}
      ) ranked
      ${statusFilter}
    `,
  ]);

  // Postgres COUNT is bigint; the pg driver hands it back as bigint, which
  // does not survive JSON serialization.
  return { rows, total: Number(totalResult[0]?.total ?? 0) };
};

/**
 * The seven dashboard overview figures for a date, in one query over the whole
 * date — not counted from a page, which would describe only that page.
 *
 * The four status buckets sum to `totalMembers` by construction: every member
 * matched by the source falls into exactly one CASE branch.
 */
const getDailyStatusCounts = async (
  date: string,
  { includeDeparted = false }: Pick<DailyStatusQuery, 'includeDeparted'> = {},
): Promise<DailyStatusCounts> => {
  const source = statusSource(date, { includeDeparted });

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
      COUNT(*) FILTER (WHERE a.id IS NOT NULL)::bigint AS "attendanceSubmitted",
      COUNT(*) FILTER (WHERE du.member_id IS NOT NULL)::bigint AS "dailyUpdateSubmitted",
      COUNT(*) FILTER (WHERE a.id IS NOT NULL AND du.member_id IS NOT NULL)::bigint AS "bothCompleted",
      COUNT(*) FILTER (WHERE a.id IS NOT NULL AND du.member_id IS NULL)::bigint AS "missingUpdateOnly",
      COUNT(*) FILTER (WHERE a.id IS NULL AND du.member_id IS NOT NULL)::bigint AS "missingAttendanceOnly",
      COUNT(*) FILTER (WHERE a.id IS NULL AND du.member_id IS NULL)::bigint AS "missingBoth"
    ${source}
  `;

  return {
    totalMembers: Number(result?.totalMembers ?? 0),
    attendanceSubmitted: Number(result?.attendanceSubmitted ?? 0),
    dailyUpdateSubmitted: Number(result?.dailyUpdateSubmitted ?? 0),
    bothCompleted: Number(result?.bothCompleted ?? 0),
    missingUpdateOnly: Number(result?.missingUpdateOnly ?? 0),
    missingAttendanceOnly: Number(result?.missingAttendanceOnly ?? 0),
    missingBoth: Number(result?.missingBoth ?? 0),
  };
};

export type ReminderTarget = {
  memberId: string;
  discordUserId: string;
  discordUsername: string;
  displayName: string | null;
};

/**
 * Members with no daily update on a date — Phase 6's DM target list.
 *
 * Always restricted to members currently in the guild: a departed member
 * cannot be reminded, and Golden Rule 1 makes `discord_user_id` the identity
 * used to DM them.
 */
const listMembersMissingUpdate = async (
  date: string,
): Promise<ReminderTarget[]> =>
  prisma.$queryRaw<ReminderTarget[]>`
    SELECT
      dm.id               AS "memberId",
      dm.discord_user_id  AS "discordUserId",
      dm.discord_username AS "discordUsername",
      dm.display_name     AS "displayName"
    FROM discord_members dm
    WHERE dm.is_in_guild = TRUE
      AND NOT EXISTS (
        SELECT 1 FROM daily_updates du
        WHERE du.member_id = dm.id AND du.message_date = ${date}
      )
    ORDER BY dm.discord_username ASC
  `;

export const dailyStatusRepository = {
  getDailyStatusPage,
  getDailyStatusCounts,
  listMembersMissingUpdate,
};
