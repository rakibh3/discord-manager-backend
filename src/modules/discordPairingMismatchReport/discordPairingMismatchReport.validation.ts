import { z } from 'zod';

import { MISMATCH_REPORT_STATUS, REPORT_ACTION } from '@/interface/discordPairingMismatchReport';

/**
 * Field rules for the discord-pairing-mismatch-report admin surface.
 *
 * Same shape as the other admin validation modules: a query schema for
 * the listing and a body schema for the action. Both reject unknown
 * fields by Zod's default `strip` behaviour — extra keys are dropped
 * silently rather than written.
 */

/** `GET /api/roster/discord-mismatch-reports` */
const listReportsQuerySchema = z
  .object({
    /**
     * The status filter. Defaults to "open" so a dashboard without an
     * explicit status lands on the actionable queue. Rejected otherwise.
     */
    status: z
      .enum([
        MISMATCH_REPORT_STATUS.OPEN,
        MISMATCH_REPORT_STATUS.REASSIGNED,
        MISMATCH_REPORT_STATUS.DISMISSED,
      ])
      .default(MISMATCH_REPORT_STATUS.OPEN),

    /** Search term against the entry's name OR email. */
    search: z.string().trim().max(150).optional(),

    /** Inclusive lower bound of the report time range. */
    dateFrom: z.iso.datetime({ error: 'dateFrom must be an ISO 8601 datetime' }).optional(),

    /** Inclusive upper bound of the report time range. */
    dateTo: z.iso.datetime({ error: 'dateTo must be an ISO 8601 datetime' }).optional(),

    page: z.coerce
      .number({ error: 'page must be a number' })
      .int({ error: 'page must be a whole number' })
      .min(1, { error: 'page starts at 1' })
      .default(1),
    limit: z.coerce
      .number({ error: 'limit must be a number' })
      .int({ error: 'limit must be a whole number' })
      .min(1, { error: 'limit may not be less than 1' })
      .max(200, { error: 'limit may not exceed 200' })
      .default(50),

    // The dashboard must NOT accept a paired-account filter or a
    // submitting-account filter — that would let any caller enumerate
    // Discord accounts by combining filters. The schema rejects both
    // explicitly so a misconfigured dashboard surfaces a 400 immediately.
    pairedAccountId: z.unknown().optional(),
    submittingAccountId: z.unknown().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.pairedAccountId !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['pairedAccountId'],
        message:
          'The listing does not accept a paired-account filter — it would let callers enumerate Discord accounts',
      });
    }

    if (value.submittingAccountId !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['submittingAccountId'],
        message:
          'The listing does not accept a submitting-account filter — it would let callers enumerate Discord accounts',
      });
    }
  });

/**
 * `POST /api/roster/discord-mismatch-reports/:id/action`
 *
 * The only field is `action`. Anything else is a validation error so
 * the service receives a closed vocabulary.
 */
const actOnReportValidationSchema = z.object({
  action: z.enum([REPORT_ACTION.REASSIGN, REPORT_ACTION.DISMISS], {
    error: `action must be one of: ${REPORT_ACTION.REASSIGN}, ${REPORT_ACTION.DISMISS}`,
  }),
});

export const discordPairingMismatchReportValidation = {
  listReportsQuerySchema,
  actOnReportValidationSchema,
};