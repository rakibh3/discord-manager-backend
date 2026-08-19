/**
 * The mismatch-report status enum, exported as a runtime constant.
 *
 * The Prisma schema names these values `OPEN`, `REASSIGNED`, `DISMISSED` —
 * upper-case, the project convention for enum values. The public surface
 * here uses lower-case to match the existing `RosterStatus` / `DailyStatus`
 * constants exposed by `rosterStatus.repository.ts`, so a single
 * vocabulary crosses the HTTP boundary and the API and the dashboard never
 * disagree on the spelling of "reassigned".
 *
 * Mapping at the repository edge: lower-case in, Prisma enum value out.
 * Done with a closed map, not a free `toLowerCase()`, so a typo refuses
 * to compile rather than silently writing `undefined` to the database.
 */
export const MISMATCH_REPORT_STATUS = {
  OPEN: 'open',
  REASSIGNED: 'reassigned',
  DISMISSED: 'dismissed',
} as const;

export type MismatchReportStatus =
  (typeof MISMATCH_REPORT_STATUS)[keyof typeof MISMATCH_REPORT_STATUS];

/**
 * Map the public lower-case status onto the Prisma upper-case enum value.
 *
 * Used at the repository edge (input from the controller, value to the
 * schema). A `never` exhaustiveness check on the default branch makes the
 * function refuse to compile if a new status is added without a mapping.
 */
export const toPrismaMismatchReportStatus = (
  status: MismatchReportStatus,
): 'OPEN' | 'REASSIGNED' | 'DISMISSED' => {
  switch (status) {
    case MISMATCH_REPORT_STATUS.OPEN:
      return 'OPEN';
    case MISMATCH_REPORT_STATUS.REASSIGNED:
      return 'REASSIGNED';
    case MISMATCH_REPORT_STATUS.DISMISSED:
      return 'DISMISSED';
    default: {
      const _exhaustive: never = status;

      return _exhaustive;
    }
  }
};

/**
 * Map the Prisma upper-case enum value back to the public lower-case form.
 *
 * The other direction of the same edge. Used when reading the database back
 * out into the API view-model.
 */
export const fromPrismaMismatchReportStatus = (
  status: 'OPEN' | 'REASSIGNED' | 'DISMISSED',
): MismatchReportStatus => {
  switch (status) {
    case 'OPEN':
      return MISMATCH_REPORT_STATUS.OPEN;
    case 'REASSIGNED':
      return MISMATCH_REPORT_STATUS.REASSIGNED;
    case 'DISMISSED':
      return MISMATCH_REPORT_STATUS.DISMISSED;
    default: {
      const _exhaustive: never = status;

      return _exhaustive;
    }
  }
};

/**
 * The five outcomes the public attendance submission can return.
 *
 * Used as the `outcome` discriminator on the submit response so the form
 * can tell a "not enrolled" refusal from a "handle doesn't match the
 * recorded pairing" refusal — they call for opposite actions from the
 * student (correct the email, vs. correct the handle or check the new
 * "I cannot enter my real Discord username" box).
 *
 * These are the values exposed to the public form and to the dashboard;
 * the existing service-level outcomes stay as their existing strings, and
 * the new one joins the discriminated union at the bottom.
 */
export const SUBMISSION_OUTCOME = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  ADDRESS_NOT_ON_ROSTER: 'ADDRESS_NOT_ON_ROSTER',
  HANDLE_IN_NO_GUILD: 'HANDLE_IN_NO_GUILD',
  HANDLE_DOES_NOT_MATCH_PAIRING: 'HANDLE_DOES_NOT_MATCH_PAIRING',
  DUPLICATE_FOR_TODAY: 'DUPLICATE_FOR_TODAY',
  ACCEPTED: 'ACCEPTED',
} as const;

export type TSubmissionOutcome =
  (typeof SUBMISSION_OUTCOME)[keyof typeof SUBMISSION_OUTCOME];

/**
 * The message a refused submission gets when the submitted handle does not
 * match the Discord account already recorded against the submitted address.
 *
 * Says ONLY what is wrong. No paired-account identifier, no roster name, no
 * count of mismatch reports — none of those can be inferred from the input
 * alone, and the form has nothing to do with any of them. The student
 * either types the right handle or checks the "I cannot enter my real
 * Discord username" box, and the form's own state carries the rest.
 */
export const HANDLE_DOES_NOT_MATCH_PAIRING_MESSAGE =
  'This Discord username does not match the one already on file for your email address. Please enter the correct Discord username, or check the box below to record attendance with your current username and notify an administrator.';

/**
 * The five outcomes the admin-side report action endpoint can return.
 *
 * Distinct from `SUBMISSION_OUTCOME`: this is the discriminated union for
 * the `POST /api/roster/discord-mismatch-reports/:id/action` endpoint,
 * which operates on reports rather than submissions. The HTTP layer maps
 * each branch to a status code.
 */
export const REPORT_ACTION_OUTCOME = {
  SUCCESS: 'success',
  REPORT_NOT_FOUND: 'REPORT_NOT_FOUND',
  REPORT_NOT_OPEN: 'REPORT_NOT_OPEN',
  REPORT_PAIRING_CONFLICT: 'REPORT_PAIRING_CONFLICT',
  REPORT_NON_MEMBER_ACCOUNT: 'REPORT_NON_MEMBER_ACCOUNT',
  REPORT_UNKNOWN_ACTION: 'REPORT_UNKNOWN_ACTION',
} as const;

export type TReportActionOutcome =
  (typeof REPORT_ACTION_OUTCOME)[keyof typeof REPORT_ACTION_OUTCOME];

/**
 * The two final actions an administrator can take on a report.
 *
 * `reassign` rewrites the pairing on the referenced roster entry to the
 * submitted account; `dismiss` leaves the pairing unchanged. Anything else
 * is `REPORT_UNKNOWN_ACTION` and refused with 400.
 */
export const REPORT_ACTION = {
  REASSIGN: 'reassign',
  DISMISS: 'dismiss',
} as const;

export type TReportAction =
  (typeof REPORT_ACTION)[keyof typeof REPORT_ACTION];

/**
 * The reason string stored on the report.
 *
 * A short, fixed token — the dashboard surfaces it as-is, and a free-text
 * field here would let any report carry arbitrary content, including
 * content that names the student or the paired account.
 */
export const MISMATCH_REPORT_REASON = {
  HANDLE_MISMATCH_PAIRING: 'HANDLE_MISMATCH_PAIRING',
} as const;

export type TMismatchReportReason =
  (typeof MISMATCH_REPORT_REASON)[keyof typeof MISMATCH_REPORT_REASON];