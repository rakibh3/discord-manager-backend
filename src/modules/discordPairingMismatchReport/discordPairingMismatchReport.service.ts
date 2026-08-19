import httpStatus from 'http-status';

import AppError from '@/errors/AppError';
import {
  MISMATCH_REPORT_REASON,
  MISMATCH_REPORT_STATUS,
  type MismatchReportStatus,
  REPORT_ACTION,
  type TReportAction,
} from '@/interface/discordPairingMismatchReport';
import { getConfiguredGuilds } from '@/lib/discord/client';
import { guildLabel } from '@/lib/discord/fanout';
import {
  discordPairingMismatchReportRepository,
  type TListFilters,
  type TReassignResult,
  type TReportRowWithJoins,
} from '@/repositories/discordPairingMismatchReport.repository';
import { memberRepository } from '@/repositories/member.repository';
import { rosterRepository } from '@/repositories/roster.repository';
import { createLogger } from '@/utils/logger';

/**
 * Business rules for the discord-pairing-mismatch reports.
 *
 * The service owns the rules that span the repository and the controller —
 * `AppError` lives here, the error mapping for the admin action endpoint
 * lives here, and the membership check at reassignment time lives here.
 *
 * `AppError` appears here and nowhere below it — the repository returns
 * data and a tagged union, deciding that `pairing_changed_under_us` is a
 * 409 belongs to this layer.
 */

const logger = createLogger('DiscordPairingMismatchReport');

/**
 * The view-model the listing endpoint hands to the controller.
 *
 * Same shape as `rosterStatusResult`: the joined columns are projected
 * out so the API surface never depends on Prisma's generated types.
 * The paired / submitting account identifiers are NOT exposed — only the
 * normalized handles, so the dashboard can display "this Discord
 * username was filed against this pairing" without leaking either
 * account snowflake to a wider surface than necessary.
 */
export type TMismatchReportListItem = {
  id: string;
  entryId: string;
  entryName: string;
  entryEmail: string;
  pairedDiscordUsername: string | null;
  pairedDisplayName: string | null;
  submittingDiscordUsername: string | null;
  submittingDisplayName: string | null;
  submittedHandle: string;
  reason: string;
  submissionDhakaDate: string;
  reportedAt: string;
  status: MismatchReportStatus;
};

const toListItem = (row: TReportRowWithJoins): TMismatchReportListItem => ({
  id: row.id,
  entryId: row.rosterEntryId,
  entryName: row.rosterEntry.name,
  entryEmail: row.rosterEntry.email,
  pairedDiscordUsername: row.pairedAccountHandle?.discordUsername ?? null,
  pairedDisplayName: row.pairedAccountHandle?.displayName ?? null,
  submittingDiscordUsername: row.submittingAccountHandle?.discordUsername ?? null,
  submittingDisplayName: row.submittingAccountHandle?.displayName ?? null,
  submittedHandle: row.submittedHandle,
  reason: row.reason,
  submissionDhakaDate: row.submissionDhakaDate,
  reportedAt: row.reportedAt.toISOString(),
  status:
    row.status === 'OPEN'
      ? MISMATCH_REPORT_STATUS.OPEN
      : row.status === 'REASSIGNED'
        ? MISMATCH_REPORT_STATUS.REASSIGNED
        : MISMATCH_REPORT_STATUS.DISMISSED,
});

/**
 * The view-model the action endpoint hands to the controller on success.
 *
 * Mirrors the listing shape with the reviewing admin and the action
 * time added — the dashboard wants both to render the audit trail inline.
 */
export type TMismatchReportActionResult = {
  id: string;
  status: MismatchReportStatus;
  reviewedByAdminId: string;
  reviewedAt: string;
  rosterEntryId: string;
};

/**
 * The view-model the listing endpoint returns.
 *
 * `items` is the page, `total` is the count of reports matching the same
 * filter — the controller derives the page count from `total / limit`.
 */
export type TMismatchReportListResult = {
  items: TMismatchReportListItem[];
  total: number;
};

/**
 * The page of mismatch reports for the admin dashboard, with the
 * pagination metadata the controller hands back to the client.
 */
const listReports = async (filters: TListFilters): Promise<TMismatchReportListResult> => {
  const { rows, total } =
    await discordPairingMismatchReportRepository.list(filters);

  return {
    items: rows.map(toListItem),
    total,
  };
};

/**
 * Whether a Discord account snowflake is currently a member of any
 * configured server.
 *
 * The membership check at reassignment time. A report opened yesterday
 * against an account that was in a guild then, but is not today, is
 * refused as a non-member. The administrator can dismiss it instead.
 *
 * Loops every configured guild rather than checking one — the bot runs
 * out of several identical servers, and the member may be in any one
 * of them. The account is the question, not the server.
 */
const isAccountStillInAnyGuild = async (
  discordUserId: string,
): Promise<boolean> => {
  const configured = getConfiguredGuilds();

  for (const guild of configured) {
    const member = await memberRepository.findMemberByDiscordUserId(
      guild.guildId,
      discordUserId,
    );

    if (member && member.isInGuild) {
      return true;
    }
  }

  return false;
};

/**
 * The exhaustive 400-message vocabulary the action endpoint can return.
 *
 * Each branch maps the discriminated union's `kind` to a 400 / 404 / 409 /
 * 422, the way the attendance service maps `DUPLICATE_FOR_TODAY` to 409.
 * Service-layer mapping rather than controller-layer: the controller
 * already wraps `actOnReport` and has the status code; the service
 * owns the rule.
 */
const mapReassignResultToAppError = (
  result: Exclude<TReassignResult, { kind: 'success' }>,
  action: TReportAction,
): AppError => {
  switch (result.kind) {
    case 'not_found':
      return new AppError(
        httpStatus.NOT_FOUND,
        'Mismatch report not found',
      );

    case 'not_open':
      return new AppError(
        httpStatus.CONFLICT,
        `This report is already ${result.currentStatus} and cannot be ${action === REPORT_ACTION.REASSIGN ? 'reassigned' : 'dismissed'} again`,
      );

    case 'pairing_changed_under_us':
      return new AppError(
        httpStatus.CONFLICT,
        'The pairing on this entry has changed since the report was filed; refresh and review the current pairing before reassigning',
      );

    default: {
      const _exhaustive: never = result;

      return new AppError(httpStatus.INTERNAL_SERVER_ERROR, String(_exhaustive));
    }
  }
};

/**
 * The action endpoint's two outcomes.
 *
 * On success, returns the closed report's view-model so the dashboard
 * can update the listing in place without a follow-up fetch.
 */
export type TActOnReportResult =
  | { kind: 'success'; result: TMismatchReportActionResult }
  | { kind: 'error'; error: AppError };

/**
 * Performs the membership check (for `reassign`) and delegates to the
 * repository, mapping the repository's discriminated union to the
 * outcomes the controller expects.
 *
 * For `reassign`, the membership check is a precondition: the
 * repository's conditional write will rewrite the pairing to the
 * submitted account, and a non-member account would leave the entry
 * paired to nothing. The check runs BEFORE the write, with the same
 * account the report carried.
 *
 * For `dismiss`, no membership check is needed — the pairing is left
 * untouched and the report is closed regardless of whether the
 * submitted account is still in a guild.
 */
const actOnReport = async (input: {
  reportId: string;
  action: TReportAction;
  reviewingAdminId: string;
}): Promise<TActOnReportResult> => {
  if (
    input.action !== REPORT_ACTION.REASSIGN &&
    input.action !== REPORT_ACTION.DISMISS
  ) {
    return {
      kind: 'error',
      error: new AppError(
        httpStatus.BAD_REQUEST,
        `Action must be one of: ${REPORT_ACTION.REASSIGN}, ${REPORT_ACTION.DISMISS}`,
      ),
    };
  }

  if (input.action === REPORT_ACTION.REASSIGN) {
    const report =
      await discordPairingMismatchReportRepository.findById(input.reportId);

    if (!report) {
      return {
        kind: 'error',
        error: new AppError(httpStatus.NOT_FOUND, 'Mismatch report not found'),
      };
    }

    const stillMember = await isAccountStillInAnyGuild(
      report.submittingAccountId,
    );

    if (!stillMember) {
      return {
        kind: 'error',
        error: new AppError(
          httpStatus.UNPROCESSABLE_ENTITY,
          `The submitted Discord account is not a current member of any configured server (${getConfiguredGuilds()
            .map((guild) => guildLabel(guild))
            .join(', ')}); reassign it only after the student has rejoined, or dismiss the report instead`,
        ),
      };
    }
  }

  const reviewedAt = new Date();
  const result =
    input.action === REPORT_ACTION.REASSIGN
      ? await discordPairingMismatchReportRepository.reassign({
          reportId: input.reportId,
          reviewingAdminId: input.reviewingAdminId,
          reviewedAt,
        })
      : await discordPairingMismatchReportRepository.dismiss({
          reportId: input.reportId,
          reviewingAdminId: input.reviewingAdminId,
          reviewedAt,
        });

  if (result.kind === 'success') {
    return {
      kind: 'success',
      result: {
        id: result.report.id,
        status:
          result.report.status === 'OPEN'
            ? MISMATCH_REPORT_STATUS.OPEN
            : result.report.status === 'REASSIGNED'
              ? MISMATCH_REPORT_STATUS.REASSIGNED
              : MISMATCH_REPORT_STATUS.DISMISSED,
        reviewedByAdminId: result.report.reviewedByAdminId ?? '',
        reviewedAt: (result.report.reviewedAt ?? reviewedAt).toISOString(),
        rosterEntryId: result.report.rosterEntryId,
      },
    };
  }

  return {
    kind: 'error',
    error: mapReassignResultToAppError(result, input.action),
  };
};

/**
 * The flag-set report writer invoked from the attendance submission
 * service after the attendance row has committed.
 *
 * Three conditions must hold for a report to be recorded, and the
 * caller checks all three before calling:
 *   1. The submitted address is held by an active roster entry.
 *   2. That entry is paired with a Discord account.
 *   3. The submitted handle, normalized, is not the paired account.
 *   4. The flag `cannotEnterRealDiscordUsername` was set to `true`.
 *
 * The function absorbs every error and never throws. The same pattern
 * `recordRosterPairing` uses for the existing first-write rule:
 * bookkeeping outside the attendance path can never make a student
 * retry. The student is not told the report was created — the public
 * response is byte-for-byte the shape it would have been without the
 * flag.
 */
const recordReportIfFlagged = async (input: {
  rosterEntryId: string;
  pairedDiscordUserId: string;
  submittingDiscordUserId: string;
  submittedHandle: string;
  submissionDhakaDate: string;
}): Promise<void> => {
  try {
    await discordPairingMismatchReportRepository.createIfAbsent({
      rosterEntryId: input.rosterEntryId,
      pairedAccountId: input.pairedDiscordUserId,
      submittingAccountId: input.submittingDiscordUserId,
      submittedHandle: input.submittedHandle,
      reason: MISMATCH_REPORT_REASON.HANDLE_MISMATCH_PAIRING,
      submissionDhakaDate: input.submissionDhakaDate,
    });
  } catch (error) {
    // The report write failed in some unexpected way. The attendance has
    // already committed and the response is going out as a success; the
    // most we can do is log it and move on. The student is not told.
    logger.error(
      `Discord pairing mismatch report write failed for entry ${input.rosterEntryId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

/**
 * Resolves the open-report count for a page of engagement listing rows.
 *
 * Thin wrapper around the repository so the engagement listing module
 * depends on this service and not on the repository directly. The
 * service is the layering boundary; an engagement listing consumer
 * should not have to know which file owns the table.
 */
const openReportCountsByEntryIds = async (
  entryIds: string[],
): Promise<Map<string, number>> =>
  discordPairingMismatchReportRepository.countOpenByEntryIds(entryIds);

/**
 * The re-export of `rosterRepository` here is unused, but is referenced
 * for completeness by readers who want to know where to start when
 * tracing a flag-set submission. The actual import is from the
 * `roster` module elsewhere.
 */
void rosterRepository;

export const discordPairingMismatchReportService = {
  listReports,
  actOnReport,
  recordReportIfFlagged,
  openReportCountsByEntryIds,
};