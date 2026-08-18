import type { TGuildConfig } from '@/config/discord';
import { getGuildRuntimeStates } from '@/lib/discord/client';

/**
 * Running one action across every configured server.
 *
 * Every fanned-out feature — opening and locking the daily-update channel,
 * posting the announcement, the reminder fallback — goes through here rather
 * than writing its own loop, because the same three rules have to hold every
 * time and they are easy to get subtly wrong:
 *
 *  1. **Sequential, never `Promise.all`.** Fan-out multiplies Discord API
 *     calls; issuing them concurrently multiplies the instantaneous burst
 *     against a shared rate-limit budget that member sync, ingestion, and
 *     reminder delivery all draw on. Two servers, one request each, in order,
 *     is well inside any budget — and it keeps the log readable.
 *  2. **Every server runs.** One server's rejection is caught and recorded, and
 *     the next server still runs. A loop that short-circuits on the first throw
 *     recreates exactly the cross-server coupling this whole change exists to
 *     remove: a missing permission in one server would stop the other's channel
 *     from ever opening.
 *  3. **It never throws.** Callers get an array of outcomes. A cron callback
 *     logs it; a service turns a fully-failed array into an `AppError`.
 */

export type TGuildOutcome<T> =
  | { guildId: string; label: string; ok: true; value: T }
  | { guildId: string; label: string; ok: false; error: string };

export type TFanOutSummary = {
  total: number;
  succeeded: number;
  failed: number;
};

export type TFanOutEnvelope<T> = {
  servers: TGuildOutcome<T>[];
  summary: TFanOutSummary;
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The human name for a server: the configured label, else the live Discord
 * name, else the ID. Never stored — a label is configuration, and persisting it
 * would create a second copy that goes stale when `.env` changes.
 */
export const guildLabel = (config: TGuildConfig): string => {
  if (config.label) return config.label;

  const state = getGuildRuntimeStates().find(
    (candidate) => candidate.config.guildId === config.guildId,
  );

  return state?.name ?? config.guildId;
};

/**
 * Runs `fn` against each server in turn, collecting one outcome per server.
 *
 * Never rejects, whatever `fn` does.
 */
export const forEachGuild = async <T>(
  guilds: TGuildConfig[],
  fn: (guild: TGuildConfig) => Promise<T>,
): Promise<TGuildOutcome<T>[]> => {
  const outcomes: TGuildOutcome<T>[] = [];

  for (const guild of guilds) {
    const label = guildLabel(guild);

    try {
      const value = await fn(guild);
      outcomes.push({ guildId: guild.guildId, label, ok: true, value });
    } catch (error) {
      outcomes.push({
        guildId: guild.guildId,
        label,
        ok: false,
        error: describeError(error),
      });
    }
  }

  return outcomes;
};

/** Wraps outcomes in the `{ servers, summary }` shape every endpoint returns. */
export const toEnvelope = <T>(
  outcomes: TGuildOutcome<T>[],
): TFanOutEnvelope<T> => ({
  servers: outcomes,
  summary: {
    total: outcomes.length,
    succeeded: outcomes.filter((outcome) => outcome.ok).length,
    failed: outcomes.filter((outcome) => !outcome.ok).length,
  },
});

/** True when at least one server succeeded — the partial-success condition. */
export const anySucceeded = <T>(outcomes: TGuildOutcome<T>[]): boolean =>
  outcomes.some((outcome) => outcome.ok);

/** Joins every failure into one message, for the all-failed error case. */
export const describeFailures = <T>(outcomes: TGuildOutcome<T>[]): string =>
  outcomes
    .filter(
      (outcome): outcome is Extract<typeof outcome, { ok: false }> =>
        !outcome.ok,
    )
    .map((outcome) => `${outcome.label} (${outcome.guildId}): ${outcome.error}`)
    .join('; ');
