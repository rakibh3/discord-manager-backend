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

/** `GET /api/attendance/verify-user?username=…` */
const verifyUserQuerySchema = z.object({
  username: discordUsernameField('Discord username'),
});

/**
 * `POST /api/attendance/submit`
 *
 * Exactly the four fields from PID §3.1. Zod strips anything else by default,
 * so extra keys are ignored rather than written.
 */
const submitAttendanceValidationSchema = z.object({
  name: z
    .string({ error: 'Full name is required' })
    .trim()
    .min(3, { error: 'Full name must be at least 3 characters' })
    .max(100, { error: 'Full name must be at most 100 characters' })
    // English-only by product decision. The message names the script, because
    // "only letters" reads as nonsense to a student who just typed their own
    // name in their own alphabet.
    .regex(/^[A-Za-z\s]+$/, {
      error: 'Full name must use English letters and spaces only',
    }),

  // `01XXXXXXXXX`, `+8801XXXXXXXXX`, or `8801XXXXXXXXX`. The `1[3-9]` covers
  // every operator prefix currently issued in Bangladesh (013-019).
  phone: z
    .string({ error: 'Phone number is required' })
    .trim()
    .regex(/^(?:\+?880|0)1[3-9]\d{8}$/, {
      error:
        'Enter a valid Bangladeshi mobile number, for example 01711000000 or +8801711000000',
    }),

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
});

export const attendanceValidation = {
  verifyUserQuerySchema,
  submitAttendanceValidationSchema,
};
