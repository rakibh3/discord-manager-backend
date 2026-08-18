import status from 'http-status';

import AppError from '@/errors/AppError';
import {
  anySucceeded,
  describeFailures,
  toEnvelope,
  type TFanOutEnvelope,
  type TGuildOutcome,
} from '@/lib/discord/fanout';

/**
 * Turns fan-out outcomes into what a service should return, or throws.
 *
 * The rule this exists to apply consistently: **an action that succeeded in at
 * least one server is a SUCCESS carrying per-server failures, not a request
 * error.** The channel really did open in the server that worked, and answering
 * 500 would tell the administrator that nothing happened — so they would retry,
 * and the announcement path would then refuse the server that already posted.
 * Only a total failure is an error.
 *
 * Lives in `utils` rather than in `lib/discord/fanout.ts` because it raises
 * `AppError`, and nothing under `src/lib/discord/` may: those modules run in
 * cron callbacks and queue jobs that have no request to fail. Services do.
 */
export const requireAnyGuildSucceeded = <T>(
  outcomes: TGuildOutcome<T>[],
  context: string,
): TFanOutEnvelope<T> => {
  if (outcomes.length === 0) {
    throw new AppError(
      status.SERVICE_UNAVAILABLE,
      `${context}: no configured Discord server could be acted on. ` +
        'Check GET /api/discord/sync/status — the bot may not be connected, or every server may have failed channel verification.',
    );
  }

  if (!anySucceeded(outcomes)) {
    throw new AppError(
      status.BAD_GATEWAY,
      `${context} failed in every configured server. ${describeFailures(outcomes)}`,
    );
  }

  return toEnvelope(outcomes);
};
