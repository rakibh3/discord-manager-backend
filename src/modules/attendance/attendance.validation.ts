import { z } from 'zod';

import { isValidDiscordUsername } from '@/utils/discordUsername';

/**
 * Field rules for the public attendance form.
 *
 * These run before any database work, so a malformed request never reaches the
 * member directory. A failure here is a 400 naming the offending field — a
 * different outcome from a well-formed handle that simply is not in the server,
 * which the service reports separately. The form needs to tell those apart to
 * say anything useful to the student.
 */

/**
 * The handle rule, shared by both endpoints.
 *
 * `isValidDiscordUsername` normalizes (trim, strip leading `@`, lowercase) and
 * then tests `DISCORD_USERNAME_REGEX` from `@/utils/discordUsername`. That regex
 * is imported, never restated here: a second copy is a second thing to tighten
 * by accident, and tightening it to forbid a leading or trailing `_` / `.`
 * locked out 5.3% of live members last time it was tried.
 */
const discordUsernameField = (fieldLabel: string) =>
  z
    .string({ error: `${fieldLabel} is required` })
    .trim()
    .min(1, { error: `${fieldLabel} cannot be empty` })
    .refine(isValidDiscordUsername, {
      error:
        'Enter a valid Discord username: 2-32 characters using only lowercase letters, numbers, underscore, or period. This is the name under the @ on your Discord profile, not your display name.',
    });

/** `GET /api/attendance/verify-user?username=…&email=…` */
const verifyUserQuerySchema = z.object({
  username: discordUsernameField('Discord username'),
  /**
   * Optional email. When supplied AND the email is enrolled and paired with
   * a Discord account, the already-submitted answer is restricted to rows
   * whose member belongs to that paired account. Mirrors the email rule on
   * the submit endpoint so a malformed value is caught here the same way
   * it would be caught there.
   */
  email: z
    .string()
    .trim()
    .pipe(z.email({ error: 'Please provide a valid email address' }))
    .optional(),
});

/**
 * `GET /api/attendance/verify-email?email=…`
 *
 * Same shape of input as the submit endpoint's `email` field, so a malformed
 * value fails here the same way it would fail at submit — handing the form the
 * same "please provide a valid email address" message it would have seen one
 * click later. Trimmed before the address check for the same reason as the
 * submit schema: a trailing space from a chat paste must not reject an
 * otherwise valid address before it ever reaches the roster lookup.
 */
const verifyEmailQuerySchema = z.object({
  email: z
    .string({ error: 'Email address is required' })
    .trim()
    .pipe(z.email({ error: 'Please provide a valid email address' })),
});

/**
 * `POST /api/attendance/submit`
 *
 * Exactly the two fields the form is allowed to carry — `email` and
 * `discordUsername` — plus one optional flag for "I cannot enter my real
 * Discord username". The student's `name` and `phone` are not collected by the
 * form; the backend sources them from the matched active roster entry when
 * roster enforcement is enabled, and writes empty strings when enforcement is
 * off (see `attendance.service.ts`).
 *
 * `.strict()` refuses any extra key as a 400 naming the field. The default
 * Zod behaviour strips unknown keys, which would silently accept a stale
 * form still posting `name` / `phone` — and silently dropping what the form
 * supplied is the failure mode this change exists to remove. A 400 surfaces
 * the staleness to whoever is operating the form.
 */
const submitAttendanceValidationSchema = z
  .object({
    // Trimmed BEFORE the address check. A student pasting their email out of a
    // chat message brings a trailing space with it, and `z.email()` on the raw
    // value rejects that as malformed — handing them "Please Provide A Valid
    // Email Address" for an address that is perfectly valid. The roster gate
    // normalizes (trim + lowercase) before comparing, so padding never reaches
    // the lookup either way; this only stops the form refusing it first.
    email: z
      .string({ error: 'Email address is required' })
      .trim()
      .pipe(z.email({ error: 'Please provide a valid email address' })),

    discordUsername: discordUsernameField('Discord username'),

    // Strict boolean: any other value (a string, a number, an `undefined`
    // that arrived as `"undefined"`) is a validation error naming the field.
    // Zod's default `OPTIONAL` would silently coerce a missing key but
    // reject a string, which is what we want: a missing key is `false`, a
    // present-but-malformed value is a 400.
    cannotEnterRealDiscordUsername: z
      .boolean({
        error: 'cannotEnterRealDiscordUsername must be true or false',
      })
      .optional(),
  })
  .strict();

export const attendanceValidation = {
  verifyUserQuerySchema,
  verifyEmailQuerySchema,
  submitAttendanceValidationSchema,
};
