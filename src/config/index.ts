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
