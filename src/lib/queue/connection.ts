// Imported rather than taken from the global scope: the project's eslint config
// declares no timer globals, and an explicit import is the ESM-native form.
import { clearTimeout, setTimeout } from 'node:timers';

import Redis from 'ioredis';

import config from '@/config';
import { createLogger } from '@/utils/logger';

const logger = createLogger('Redis');

/**
 * The shared Redis connection, used by the reminder queue and its worker.
 *
 * ── Why nothing here throws ───────────────────────────────────────────────
 * Redis backs ONE feature: reminder DM broadcasts. The HTTP API, the Discord
 * gateway client, `#daily-update` ingestion, and the channel scheduler have no
 * dependency on it whatsoever. An unhandled connection error would take all
 * four down for a feature none of them use — and three of those four are on the
 * path ~5,000 students depend on to submit attendance.
 *
 * So: the connection is created lazily, every error is logged and swallowed,
 * `isRedisAvailable()` reports the truth, and the reminder service turns an
 * unavailable connection into a 503 naming Redis. Nothing else notices.
 *
 * ── maxRetriesPerRequest: null ────────────────────────────────────────────
 * Required by BullMQ for worker connections. ioredis otherwise gives up on a
 * command after a few attempts and throws; a worker blocked on a long-poll for
 * jobs would then die on any brief Redis blip instead of reconnecting. `null`
 * means retry indefinitely, which is what a long-lived worker wants.
 */

let connection: Redis | null = null;

/** Last connection error, for the admin status read. */
let lastError: string | null = null;
let ready = false;
let lastErrorLoggedAt = 0;

/** At most one connection-failure line per 30s while Redis is down. */
const ERROR_LOG_INTERVAL_MS = 30_000;

/**
 * A usable reason string for a connection failure.
 *
 * ioredis reports a refused connection as an `AggregateError` whose own
 * `message` is an empty string — one sub-error per address family it tried.
 * Reporting that verbatim puts an empty reason on `GET /api/reminders/status`
 * and inside the 503 an admin gets, which tells them nothing at the exact
 * moment they need to know whether Redis is down or misconfigured.
 */
const describeConnectionError = (error: Error): string => {
  if (error.message) return error.message;

  const causes = (error as AggregateError).errors;

  if (Array.isArray(causes) && causes.length > 0) {
    const first = causes[0];

    return first instanceof Error ? first.message : String(first);
  }

  return error.name || 'Redis connection failed';
};

const createConnection = (): Redis => {
  const client = new Redis(config.redis_url, {
    maxRetriesPerRequest: null,
    // Fail the first connect quickly rather than hanging a request that is
    // only trying to find out whether Redis is there.
    connectTimeout: 5000,
    retryStrategy: (times) => Math.min(times * 500, 10_000),
  });

  client.on('ready', () => {
    ready = true;
    lastError = null;
    lastErrorLoggedAt = 0;
    logger.info('Connected to Redis.');
  });

  client.on('end', () => {
    ready = false;
  });

  // Terminal for this module: logged, never rethrown. Without this listener
  // ioredis emits an unhandled 'error' event and takes the process with it.
  //
  // The log is throttled because the retry strategy never gives up: with Redis
  // genuinely absent this fires every few seconds forever, and an unthrottled
  // line would bury the bot, ingestion, and scheduler logs that matter under a
  // failure that is already reported on the status endpoint. The state is
  // always current; only the logging is rate limited.
  client.on('error', (error: Error) => {
    ready = false;
    lastError = describeConnectionError(error);

    const now = Date.now();

    if (now - lastErrorLoggedAt > ERROR_LOG_INTERVAL_MS) {
      lastErrorLoggedAt = now;
      logger.error(
        `Redis connection error (${config.redis_url}): ${lastError}. Reminder broadcasts are refused until it returns; nothing else is affected.`,
      );
    }
  });

  return client;
};

/**
 * The shared client, created on first use.
 *
 * Callers must still check `isRedisAvailable()` before relying on it — an
 * ioredis instance exists whether or not Redis is actually reachable.
 */
export const getRedisConnection = (): Redis => {
  connection ??= createConnection();

  return connection;
};

/** Whether the connection is currently usable. */
export const isRedisAvailable = (): boolean => ready;

/** The last connection error, or null when healthy. */
export const getRedisError = (): string | null => (ready ? null : lastError);

/**
 * Opens the connection and waits briefly for it to become usable.
 *
 * Returns whether Redis is reachable rather than throwing, so startup can log
 * the outcome and carry on. Called once at boot so the queue does not first
 * discover Redis is down in the middle of an admin's broadcast.
 */
export const connectRedis = async (timeoutMs = 5000): Promise<boolean> => {
  const client = getRedisConnection();

  if (client.status === 'ready') return true;

  return new Promise<boolean>((resolve) => {
    const settle = (result: boolean) => {
      clearTimeout(timer);
      client.off('ready', onReady);
      client.off('error', onError);
      resolve(result);
    };

    const onReady = () => settle(true);
    const onError = () => settle(false);

    const timer = setTimeout(() => settle(false), timeoutMs);

    client.once('ready', onReady);
    client.once('error', onError);
  });
};

/** Closes the connection during shutdown. Safe when it was never opened. */
export const closeRedis = async (): Promise<void> => {
  if (!connection) return;

  try {
    await connection.quit();
    logger.info('Redis connection closed.');
  } catch (error) {
    // Already closing, or the socket is gone. Nothing to do at shutdown.
    logger.warn(
      'Redis connection did not close cleanly:',
      error instanceof Error ? error.message : error,
    );
  } finally {
    connection = null;
    ready = false;
  }
};
