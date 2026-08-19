import dotenv from 'dotenv';
import path from 'path';
import { env } from 'process';

// Load environment variables
dotenv.config({ path: path.join(process.cwd(), '.env'), quiet: true });

export type { TDiscordConfig } from '@/config/discord';
export { isDiscordConfigured, loadDiscordConfig } from '@/config/discord';

/**
 * The CORS origin allowlist.
 *
 * Two distinct front-ends call this API from a browser: the admin dashboard at
 * `APP_URL` and the public attendance form at `ATTENDANCE_FORM_URL`. They are
 * separate deployments on separate hosts, so a single-origin CORS config would
 * block the form's `fetch` outright.
 *
 * Stays an explicit list. `'*'` and `origin: true` are not options while
 * `credentials: true` is set — browsers reject the wildcard with credentials,
 * and reflecting any origin would defeat the point of the allowlist.
 */
const parseOrigins = (...values: (string | undefined)[]): string[] =>
  values
    .flatMap((value) => value?.split(',') ?? [])
    .map((origin) => origin.trim())
    .filter(Boolean);

/**
 * Whether this process runs the channel scheduler's timed jobs.
 *
 * `node-cron` tasks are per-process, so with N replicas every job fires N
 * times: N permission edits (idempotent, harmless) and N announcement embeds
 * in a channel ~5,000 students read (visible, not harmless). Exactly one
 * instance should have this on.
 *
 * Defaults to true when unset, which is correct for the current single-instance
 * deployment and means nothing breaks by omission. Only an explicit `false`
 * (or `0`) switches the jobs off; the manual open/lock endpoints and the status
 * read stay available on every process either way, because they act through the
 * shared Discord client rather than through cron.
 */
const parseSchedulerEnabled = (value: string | undefined): boolean => {
  const normalized = value?.trim().toLowerCase();

  if (!normalized) return true;

  return normalized !== 'false' && normalized !== '0';
};

/**
 * Whether THIS process consumes reminder DM jobs.
 *
 * Parsed exactly like `SCHEDULER_ENABLED`, but it exists for a different
 * reason, and the difference is worth keeping straight. The scheduler flag is
 * a correctness requirement: `node-cron` is process-local, so N replicas post N
 * announcement embeds. The queue's rate limiter counts in Redis and is shared
 * by every worker on the queue, so N workers still deliver within one DM
 * budget. This flag is therefore operational — draining a node, or moving the
 * worker to a dedicated process later — not load-bearing for safety.
 *
 * Unset means true. Only an explicit `false` (or `0`) disables it, and it gates
 * only job *consumption*: the admin endpoints that start, read, and cancel
 * broadcasts keep working on every process.
 */
const parseWorkerEnabled = (value: string | undefined): boolean => {
  const normalized = value?.trim().toLowerCase();

  if (!normalized) return true;

  return normalized !== 'false' && normalized !== '0';
};

/**
 * DMs per second the reminder worker is allowed to send.
 *
 * Clamped rather than trusted. Golden Rule 4 exists because bursting DMs gets
 * the bot rate limited and eventually banned — and because the bot is one
 * process, that ban also takes down member sync and with it the attendance
 * form's membership check. A typo here (`200` for `2`) would be that outage, so
 * the range is enforced in code and a nonsense value falls back to the default
 * instead of being honoured.
 */
const REMINDER_DM_RATE_DEFAULT = 2;
const REMINDER_DM_RATE_MIN = 1;
const REMINDER_DM_RATE_MAX = 5;

const parseReminderDmRate = (value: string | undefined): number => {
  if (!value?.trim()) return REMINDER_DM_RATE_DEFAULT;

  const rate = Number(value.trim());

  if (!Number.isFinite(rate)) return REMINDER_DM_RATE_DEFAULT;

  const truncated = Math.trunc(rate);

  if (truncated < REMINDER_DM_RATE_MIN || truncated > REMINDER_DM_RATE_MAX) {
    return REMINDER_DM_RATE_DEFAULT;
  }

  return truncated;
};

/**
 * Bounds on a roster spreadsheet upload.
 *
 * Both are blast-radius controls rather than performance limits, in the same
 * spirit as the 92-day cap on a reminder range. The file the admin uploads
 * decides who may submit attendance, and a wrong file — the whole export
 * instead of this term's cohort, a 40 MB workbook with images in it — should be
 * a refusal an admin reads, not something the process discovers by exhausting
 * memory while ~5,000 students are on the form.
 *
 * The size limit is handed to multer, which enforces it while the upload is
 * still streaming, so an oversized file never reaches the parser. The row limit
 * is checked after parsing and before any write.
 *
 * A missing, non-numeric, or non-positive value falls back to the default
 * rather than being honoured, so a typo cannot remove the bound entirely.
 */
const ROSTER_MAX_FILE_BYTES_DEFAULT = 5 * 1024 * 1024;
const ROSTER_MAX_ROWS_DEFAULT = 20_000;

const parsePositiveInt = (
  value: string | undefined,
  fallback: number,
): number => {
  if (!value?.trim()) return fallback;

  const parsed = Number(value.trim());

  if (!Number.isFinite(parsed)) return fallback;

  const truncated = Math.trunc(parsed);

  return truncated > 0 ? truncated : fallback;
};

/**
 * How many reverse proxies sit in front of the API.
 *
 * Handed to `app.set('trust proxy', …)` as an integer hop count, never as
 * `true`. With `true`, Express takes the leftmost `X-Forwarded-For` entry as
 * the client IP — and that entry is supplied by the caller, so every per-IP
 * rate limit could be bypassed by forging the header. `express-rate-limit`
 * raises `ERR_ERL_PERMISSIVE_TRUST_PROXY` for exactly this reason.
 *
 * Anything non-numeric (including the literal `true`) is ignored, leaving
 * Express on the direct connection address.
 */
const parseTrustProxyHops = (value: string | undefined): number | undefined => {
  if (!value?.trim()) return undefined;

  const hops = Number(value.trim());

  return Number.isInteger(hops) && hops >= 0 ? hops : undefined;
};

// Export config from environment
export default {
  port: env.PORT,
  database_url: env.DATABASE_URL,
  bcrypt_salt_rounds: env.BCRYPT_SALT_ROUNDS,
  jwt_access_secret: env.JWT_ACCESS_SECRET,
  jwt_refresh_secret: env.JWT_REFRESH_SECRET,
  jwt_access_expires_in: env.JWT_ACCESS_EXPIRES_IN,
  jwt_refresh_expires_in: env.JWT_REFRESH_EXPIRES_IN,
  app_url: env.APP_URL,
  attendance_form_url: env.ATTENDANCE_FORM_URL,
  allowed_origins: parseOrigins(env.APP_URL, env.ATTENDANCE_FORM_URL),
  trust_proxy_hops: parseTrustProxyHops(env.TRUST_PROXY_HOPS),
  scheduler_enabled: parseSchedulerEnabled(env.SCHEDULER_ENABLED),
  redis_url: env.REDIS_URL?.trim() || 'redis://localhost:6379',
  reminder_worker_enabled: parseWorkerEnabled(env.REMINDER_WORKER_ENABLED),
  reminder_dm_per_second: parseReminderDmRate(env.REMINDER_DM_PER_SECOND),
  roster: {
    maxFileBytes: parsePositiveInt(
      env.ROSTER_IMPORT_MAX_FILE_BYTES,
      ROSTER_MAX_FILE_BYTES_DEFAULT,
    ),
    maxRows: parsePositiveInt(
      env.ROSTER_IMPORT_MAX_ROWS,
      ROSTER_MAX_ROWS_DEFAULT,
    ),
  },
  env: env.NODE_ENV,
  admin: {
    emails: env.ADMIN_EMAILS
      ? env.ADMIN_EMAILS.split(',')
          .map((e) => e.trim())
          .filter(Boolean)
      : env.ADMIN_EMAIL
        ? [env.ADMIN_EMAIL.trim()].filter(Boolean)
        : [],
    name: env.ADMIN_NAME,
    password: env.ADMIN_PASSWORD,
  },
};
