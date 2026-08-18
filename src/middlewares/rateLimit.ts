import { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import httpStatus from 'http-status';

import { sendResponse } from '@/utils/sendResponse';

/**
 * Request budgets for the endpoints that are reachable without an admin token.
 *
 * Every other route in this application sits behind `auth(UserRole.ADMIN)`.
 * The attendance endpoints cannot: students have no login account by design, so
 * there is nothing to authenticate. The guild-membership check is what stands in
 * for authorization, and these budgets are what stand between a public `POST`
 * that writes rows and anyone who finds the URL.
 *
 * The counting store is the library default, which is **process-local**. Running
 * more than one process multiplies the effective budget by the process count.
 * That is acceptable for now and deliberately recorded rather than hidden. Phase
 * 6 introduces Redis for BullMQ; swapping in `rate-limit-redis` means adding a
 * `store` option here and touching nothing else — no route, controller, or
 * service refers to the store.
 *
 * Client IP resolution depends on `app.set('trust proxy', <hops>)` in `app.ts`.
 * The library's `trustProxy` validation is left enabled on purpose: if that
 * setting is ever changed to `true`, `ERR_ERL_PERMISSIVE_TRUST_PROXY` fires and
 * says so, rather than every budget silently becoming forgeable.
 */

/** Shared shape: standard `RateLimit-*` headers, no legacy `X-RateLimit-*`. */
const publicLimiterDefaults = {
  standardHeaders: true,
  legacyHeaders: false,
} as const;

/**
 * Emits the refusal through `sendResponse`, so a throttled caller gets the same
 * envelope as every other endpoint rather than the library's bare text body.
 * A form parsing `data.verified` should not have to special-case a 429.
 *
 * Returning here also means the request never reaches the router: no member
 * lookup, no attendance write, no contact-detail update.
 */
const throttled =
  (message: string): RequestHandler =>
  (_req, res) => {
    sendResponse(res, {
      success: false,
      statusCode: httpStatus.TOO_MANY_REQUESTS,
      message,
      data: null,
    });
  };

/**
 * Verification fires on a 500 ms debounce as a student types their handle, so
 * one honest form session produces on the order of a dozen calls — and a student
 * who mistypes, backspaces, and retries produces more. 60 per minute leaves
 * generous room for that while still stopping an enumeration sweep of the member
 * directory within a second or two.
 *
 * Deliberately far looser than the submit budget: throttling this endpoint
 * breaks the form's live badge for a student who is doing nothing wrong.
 */
export const verifyUserRateLimiter = rateLimit({
  ...publicLimiterDefaults,
  windowMs: 60 * 1000,
  limit: 60,
  handler: throttled(
    'Too many verification attempts. Please wait a minute and try again.',
  ),
});

/**
 * A legitimate student submits once per day. The only reasons to send more are a
 * failed network request or a correction after a validation error, so 5 per
 * 15 minutes covers every honest case with room to spare and stops a scripted
 * flood after a handful of attempts.
 *
 * Materially tighter than verification because this is the endpoint that writes.
 */
export const submitAttendanceRateLimiter = rateLimit({
  ...publicLimiterDefaults,
  windowMs: 15 * 60 * 1000,
  limit: 5,
  handler: throttled(
    'Too many attendance submissions from this device. Please wait a few minutes and try again.',
  ),
});

/**
 * Sized to one call per page load: 60 per minute leaves generous room for
 * reloads and for several students behind one NAT while still bounding an
 * abusive client.
 *
 * Stays on the process-local in-memory store for the reason documented above:
 * a Redis outage on the students' submission path is not an acceptable failure
 * mode, and swapping the public limiters onto Redis needs its own decision.
 */
export const attendanceWindowRateLimiter = rateLimit({
  ...publicLimiterDefaults,
  windowMs: 60 * 1000,
  limit: 60,
  handler: throttled(
    'Too many window check requests. Please wait a minute and try again.',
  ),
});
