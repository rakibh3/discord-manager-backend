import type { DiscordPairingMismatchReport } from '@generated/prisma/client';
import { Prisma } from '@generated/prisma/client';

import {
  fromPrismaMismatchReportStatus,
  MISMATCH_REPORT_STATUS,
  type MismatchReportStatus,
  type TMismatchReportReason,
  toPrismaMismatchReportStatus,
} from '@/interface/discordPairingMismatchReport';
import { prisma } from '@/lib/prisma';

/**
 * Data access for `discord_pairing_mismatch_reports`.
 *
 * Repositories own Prisma and nothing else: no `AppError`, no HTTP status
 * codes, no `req`. This file returns data, `null`, or a plain result
 * object; deciding that a miss is a 404 belongs to the calling service.
 *
 * The repository is the only place that knows about the partial unique
 * index on `(roster_entry_id, submission_dhaka_date)` filtered by
 * `status = 'OPEN'`. `createIfAbsent` swallows a P2002 on that index as a
 * no-op so two simultaneous flag-set submissions on the same day do not
 * both create a row — the index is the database-level guarantee, and the
 * repository is the only place that owns the translation.
 *
 * Likewise `reassign` is the only place that knows the conditional write
 * must succeed only while the entry still holds the originally paired
 * account. The service delegates; the repository runs the scoped update.
 * That contract is what lets a stale dashboard refuse a reassignment
 * instead of overwriting a freshly-changed pairing.
 *
 * The paired / submitting account identifiers on a report are Discord
 * ACCOUNT snowflakes, not `discord_members` row ids — same convention as
 * `RosterEntry.discordUserId`. The dashboard wants the normalized handle
 * to render, so the repository does the per-account lookup here rather
 * than hydrating a Prisma relation (which would require a FK, which
 * would force `paired_account_id` to be unique per server — not the
 * shape an account snowflake has).
 */

/**
 * Whether a P2002 is the partial unique index on
 * `(roster_entry_id, submission_dhaka_date)` filtered by `status = 'OPEN'`
 * firing, as opposed to some other unique constraint on the same write.
 *
 * Matches on the serialized `meta` rather than reading `meta.target`,
 * because **`target` is `undefined` under the `@prisma/adapter-pg` driver
 * adapter this project uses** — same constraint as `attendance.service.ts`
 * and `roster.service.ts`. The constraint arrives nested at
 * `meta.driverAdapterError.cause.constraint.fields` instead.
 *
 * `submission_dhaka_date` and `roster_entry_id` appear in no other
 * constraint on this table, so a match cannot be a false positive.
 */
const isOpenReportConflictError = (
  error: Prisma.PrismaClientKnownRequestError,
): boolean =>
  error.code === 'P2002' &&
  JSON.stringify(error.meta ?? {}).includes('submission_dhaka_date');

/**
 * The columns the listing and the count lookups need joined from the
 * `roster_entries` table.
 *
 * The relation is a Prisma relation because `roster_entry_id` IS a
 * foreign key to `roster_entries.id`. The paired / submitting accounts
 * are NOT relations in the schema, so they are joined separately by
 * `hydrateDiscordHandles`.
 */
const ROSTER_ENTRY_INCLUDE = {
  rosterEntry: {
    select: { id: true, name: true, email: true },
  },
} as const;

type TRosterEntryJoins = Prisma.DiscordPairingMismatchReportGetPayload<{
  include: typeof ROSTER_ENTRY_INCLUDE;
}>;

/**
 * A row with the entry's data and the paired / submitting account
 * handles hydrated — the view-model the service consumes.
 */
export type TReportRowWithJoins = TRosterEntryJoins & {
  pairedAccountHandle: {
    discordUsername: string | null;
    displayName: string | null;
  } | null;
  submittingAccountHandle: {
    discordUsername: string | null;
    displayName: string | null;
  } | null;
};

/**
 * Look up the account handles for a list of Discord account snowflakes.
 *
 * One indexed batched read against `discord_members` for each account
 * — picking the lowest-numbered server deterministically, the same way
 * `rosterStatus.repository.ts` resolves the joined profile. Returns a
 * map keyed by `discord_user_id`.
 */
const lookupAccountHandles = async (
  accountIds: string[],
): Promise<Map<string, { discordUsername: string | null; displayName: string | null }>> => {
  const map = new Map<string, { discordUsername: string | null; displayName: string | null }>();

  if (accountIds.length === 0) return map;

  const rows = await prisma.discordMember.findMany({
    where: {
      discordUserId: { in: accountIds },
      isInGuild: true,
    },
    select: {
      discordUserId: true,
      discordUsername: true,
      displayName: true,
      guildId: true,
    },
    orderBy: { guildId: 'asc' },
  });

  for (const row of rows) {
    if (!map.has(row.discordUserId)) {
      map.set(row.discordUserId, {
        discordUsername: row.discordUsername,
        displayName: row.displayName,
      });
    }
  }

  return map;
};

/**
 * Hydrate the paired and submitting account handles onto a set of
 * report rows. The roster-entry join is already in the row; this only
 * adds the discriminator-free account handles.
 */
const hydrateDiscordHandles = async (
  rows: TRosterEntryJoins[],
): Promise<TReportRowWithJoins[]> => {
  const accountIds = new Set<string>();

  for (const row of rows) {
    accountIds.add(row.pairedAccountId);
    accountIds.add(row.submittingAccountId);
  }

  const handles = await lookupAccountHandles([...accountIds]);

  return rows.map((row) => ({
    ...row,
    pairedAccountHandle: handles.get(row.pairedAccountId) ?? null,
    submittingAccountHandle: handles.get(row.submittingAccountId) ?? null,
  }));
};

/**
 * Inserts a new open report. Swallows the partial-unique-index conflict
 * as a no-op so two simultaneous flag-set submissions on the same day do
 * not both create a row.
 *
 * The caller is the public submission path, after the attendance row has
 * already committed. The repository is the only place that knows about
 * the partial unique index, so it is the only place that can decide
 * what to do with the conflict. A return of `null` is the signal that
 * the report was already on file, not a failure.
 */
const createIfAbsent = async (input: {
  rosterEntryId: string;
  pairedAccountId: string;
  submittingAccountId: string;
  submittedHandle: string;
  reason: TMismatchReportReason;
  submissionDhakaDate: string;
}): Promise<DiscordPairingMismatchReport | null> => {
  try {
    return await prisma.discordPairingMismatchReport.create({
      data: {
        rosterEntryId: input.rosterEntryId,
        pairedAccountId: input.pairedAccountId,
        submittingAccountId: input.submittingAccountId,
        submittedHandle: input.submittedHandle,
        reason: input.reason,
        submissionDhakaDate: input.submissionDhakaDate,
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      isOpenReportConflictError(error)
    ) {
      // The partial unique index fired: an open report for this entry
      // on this date already exists. That is the desired behaviour — two
      // simultaneous flag-set submissions should not both create a row.
      return null;
    }

    throw error;
  }
};

/**
 * The full report row, joined to the roster entry and the paired /
 * submitting accounts. Returns `null` when the id is unknown.
 *
 * Carries every column the dashboard renders so the controller does not
 * have to do a follow-up lookup. The relation shapes are explicit rather
 * than `include: true` so a future column addition does not silently
 * leak into the API response.
 */
const findById = async (
  id: string,
): Promise<TReportRowWithJoins | null> => {
  const row = await prisma.discordPairingMismatchReport.findUnique({
    where: { id },
    include: ROSTER_ENTRY_INCLUDE,
  });

  if (!row) return null;

  const hydrated = await hydrateDiscordHandles([row]);

  return hydrated[0] ?? null;
};

/**
 * The list of reports matching the given filters, plus the total count.
 *
 * The search term is matched against the entry's name OR email — the
 * vocabulary an administrator is typing into the search box. The date
 * range is over `reported_at`, the instant the report was created, NOT
 * the submission's Dhaka date — the dashboard surfaces the report's
 * existence, not the date it was filed.
 *
 * The default ordering is `reported_at DESC` so the dashboard's first
 * page is the most recent activity. A status filter narrows to that
 * one status; omitting it returns every open report.
 */
export type TListFilters = {
  status?: MismatchReportStatus;
  search?: string;
  dateFrom?: Date;
  dateTo?: Date;
  limit: number;
  offset: number;
};

const list = async (
  filters: TListFilters,
): Promise<{ rows: TReportRowWithJoins[]; total: number }> => {
  const where: Prisma.DiscordPairingMismatchReportWhereInput = {};

  if (filters.status) {
    where.status = toPrismaMismatchReportStatus(filters.status);
  }

  if (filters.search?.trim()) {
    const search = filters.search.trim();

    where.rosterEntry = {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ],
    };
  }

  if (filters.dateFrom || filters.dateTo) {
    where.reportedAt = {};
    if (filters.dateFrom) where.reportedAt.gte = filters.dateFrom;
    if (filters.dateTo) where.reportedAt.lte = filters.dateTo;
  }

  const [rawRows, total] = await Promise.all([
    prisma.discordPairingMismatchReport.findMany({
      where,
      orderBy: [{ reportedAt: 'desc' }, { id: 'desc' }],
      skip: filters.offset,
      take: filters.limit,
      include: ROSTER_ENTRY_INCLUDE,
    }),
    prisma.discordPairingMismatchReport.count({ where }),
  ]);

  const rows = await hydrateDiscordHandles(rawRows);

  return { rows, total };
};

/**
 * The open-report count per roster entry, for the page of entries the
 * engagement listing is rendering.
 *
 * One indexed query — a `where: { status: 'OPEN', rosterEntryId: { in } }`
 * — rather than one count per entry. The result is a `Map<entryId, count>`
 * keyed by the entry identifier; an entry absent from the map has zero
 * open reports, which is the default the engagement listing applies.
 *
 * The query is a `groupBy` on `rosterEntryId` so the count is correct
 * without forcing a fetch of every report row. Served by the partial
 * unique index on `(roster_entry_id, submission_dhaka_date)` filtered by
 * `status = 'OPEN'`.
 */
const countOpenByEntryIds = async (
  entryIds: string[],
): Promise<Map<string, number>> => {
  const map = new Map<string, number>();

  if (entryIds.length === 0) return map;

  const grouped = await prisma.discordPairingMismatchReport.groupBy({
    by: ['rosterEntryId'],
    where: {
      rosterEntryId: { in: entryIds },
      status: 'OPEN',
    },
    _count: { _all: true },
  });

  for (const row of grouped) {
    map.set(row.rosterEntryId, row._count._all);
  }

  return map;
};

/**
 * The discriminated union the repository returns from `reassign`.
 *
 * `success` — the roster entry still held the original paired account,
 * the pairing was rewritten to the submitted account, and the report
 * is now `REASSIGNED`.
 *
 * `pairing_changed_under_us` — the report was open, but the entry no
 * longer holds the original paired account. Nothing was written. The
 * report remains `OPEN` so the next administrator to look at the
 * dashboard can see what happened.
 */
export type TReassignResult =
  | { kind: 'success'; report: TReportRowWithJoins }
  | { kind: 'pairing_changed_under_us' }
  | { kind: 'not_found' }
  | { kind: 'not_open'; currentStatus: MismatchReportStatus };

/**
 * The reassignment — a single conditional write that rewrites the entry
 * pairing AND closes the report in one transaction, succeeds only while
 * the entry still holds the originally paired account.
 *
 * The scope is the load-bearing safety property. A read-then-write
 * check would race with another administrator's reassignment and could
 * overwrite a pairing that was already changed. The conditional write
 * is the same shape `linkEntryToAccount` uses for the first-write rule
 * on the public path: a scoped `updateMany` whose `WHERE` IS the
 * precondition, so two simultaneous reassignments cannot both succeed.
 *
 * After the conditional pairing rewrite succeeds, the report's status
 * is set to `REASSIGNED` and the reviewing admin is recorded. The two
 * writes are wrapped in a transaction so a partial commit is
 * impossible — either the pairing is rewritten AND the report is
 * closed, or neither is touched.
 *
 * Returns the four-state discriminated union. The service maps it to
 * HTTP statuses.
 */
const reassign = async (input: {
  reportId: string;
  reviewingAdminId: string;
  reviewedAt: Date;
}): Promise<TReassignResult> => {
  const result = await prisma.$transaction(async (tx) => {
    const report = await tx.discordPairingMismatchReport.findUnique({
      where: { id: input.reportId },
      include: ROSTER_ENTRY_INCLUDE,
    });

    if (!report) {
      return { kind: 'not_found' } as const;
    }

    if (report.status !== 'OPEN') {
      return {
        kind: 'not_open',
        currentStatus: fromPrismaMismatchReportStatus(report.status),
      } as const;
    }

    // The conditional write: rewrite the entry's pairing ONLY while it
    // still holds the originally paired account. The `WHERE` is the
    // precondition — a different account scoping the entry means the
    // update matches zero rows and the reassignment is refused as a
    // conflict.
    const updateResult = await tx.rosterEntry.updateMany({
      where: {
        id: report.rosterEntryId,
        discordUserId: report.pairedAccountId,
      },
      data: {
        discordUserId: report.submittingAccountId,
        linkedAt: input.reviewedAt,
      },
    });

    if (updateResult.count === 0) {
      // The entry no longer holds the originally paired account. The
      // report stays open — the next administrator to look at the
      // dashboard sees the actual pairing and can decide what to do.
      return { kind: 'pairing_changed_under_us' } as const;
    }

    const closed = await tx.discordPairingMismatchReport.update({
      where: { id: input.reportId },
      data: {
        status: 'REASSIGNED',
        reviewedByAdminId: input.reviewingAdminId,
        reviewedAt: input.reviewedAt,
      },
      include: ROSTER_ENTRY_INCLUDE,
    });

    return { kind: 'success', baseReport: closed } as const;
  });

  if (result.kind !== 'success') {
    return result;
  }

  const hydrated = await hydrateDiscordHandles([result.baseReport]);

  return { kind: 'success', report: hydrated[0]! };
};

/**
 * The dismissal — closes the report, leaves the pairing untouched.
 *
 * The pairing cannot be changed by `dismiss`, so the conditional write
 * is conditional on the report's status, not on the entry's pairing.
 * If the report is already closed, the action is refused with the
 * current status, same as `reassign`. If the report is open, the
 * status is set to `DISMISSED` and the reviewing admin is recorded.
 *
 * The pairing is intentionally not touched: a dismissed report is the
 * administrator's decision that the recorded pairing is correct, and
 * the pairing must outlive the report.
 */
const dismiss = async (input: {
  reportId: string;
  reviewingAdminId: string;
  reviewedAt: Date;
}): Promise<TReassignResult> => {
  const result = await prisma.$transaction(async (tx) => {
    const report = await tx.discordPairingMismatchReport.findUnique({
      where: { id: input.reportId },
      include: ROSTER_ENTRY_INCLUDE,
    });

    if (!report) {
      return { kind: 'not_found' } as const;
    }

    if (report.status !== 'OPEN') {
      return {
        kind: 'not_open',
        currentStatus: fromPrismaMismatchReportStatus(report.status),
      } as const;
    }

    const closed = await tx.discordPairingMismatchReport.update({
      where: { id: input.reportId },
      data: {
        status: 'DISMISSED',
        reviewedByAdminId: input.reviewingAdminId,
        reviewedAt: input.reviewedAt,
      },
      include: ROSTER_ENTRY_INCLUDE,
    });

    return { kind: 'success', baseReport: closed } as const;
  });

  if (result.kind !== 'success') {
    return result;
  }

  const hydrated = await hydrateDiscordHandles([result.baseReport]);

  return { kind: 'success', report: hydrated[0]! };
};

/**
 * The three fields the dashboard wants to render paired against the entry.
 *
 * `pairedAccountId` and `submittingAccountId` are the snowflakes the
 * repository already knows about; the engagement listing reads
 * `countOpenByEntryIds` and gets the count, not the snowflakes, so the
 * accounts themselves are not exposed to the public path.
 */
export type TOpenReportCount = {
  entryId: string;
  count: number;
};

export const discordPairingMismatchReportRepository = {
  createIfAbsent,
  findById,
  list,
  countOpenByEntryIds,
  reassign,
  dismiss,
};

// Re-export the status enum so callers don't need to depend on the
// interface module just to read the constants.
export { MISMATCH_REPORT_STATUS };