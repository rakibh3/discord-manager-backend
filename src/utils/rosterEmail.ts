import { z } from 'zod';

/**
 * The canonical form of a roster email address.
 *
 * This module is the ONLY producer of that form, in the same spirit as
 * `dhakaDate.ts` for civil dates and `discordUsername.ts` for handles. Three
 * callers depend on it agreeing with itself: the spreadsheet import (which
 * writes the value the unique constraint indexes), the admin correction
 * endpoint, and the attendance submit gate (which looks the value up). A second
 * inline `.trim().toLowerCase()` anywhere else is how the constraint and the
 * lookup come to disagree — and under an enabled gate, a disagreement refuses a
 * student who really is enrolled.
 */

/**
 * Trim surrounding whitespace and lowercase. Nothing else.
 *
 * Deliberately does NOT strip dots, does NOT strip a `+` suffix, and applies no
 * provider-specific alias rule. Those rules hold for Gmail and not for most
 * other providers, so applying them universally would merge two people who hold
 * genuinely distinct addresses. With enforcement on, that merge refuses one of
 * the two — someone who is enrolled being told they are not, with nothing in
 * the system looking wrong.
 *
 * Lowercasing the local part is technically a narrowing too (RFC 5321 makes it
 * case-sensitive), but every provider in practice treats it case-insensitively,
 * and a student who typed `Rakib@…` on the form when the sheet said `rakib@…`
 * is the far more likely event than two people distinguished only by case.
 */
export const normalizeRosterEmail = (rawEmail: string): string =>
  rawEmail.trim().toLowerCase();

/**
 * The email field rule, shared by the import, the admin patch, and anywhere
 * else an address enters the system.
 *
 * Validation runs on the NORMALIZED value: what gets stored and compared is the
 * normalized form, so validating the raw input would accept a string whose
 * stored counterpart was never checked.
 */
export const rosterEmailSchema = z
  .string({ error: 'Email address is required' })
  .trim()
  .min(1, { error: 'Email address cannot be empty' })
  // 254 is the RFC 5321 maximum for a forward path; longer values are
  // truncation or paste accidents rather than addresses.
  .max(254, { error: 'Email address is too long' })
  .transform(normalizeRosterEmail)
  .refine((value) => z.email().safeParse(value).success, {
    error: 'Please provide a valid email address',
  });

/**
 * Whether a raw value is a usable roster address. Normalizes first, so callers
 * may pass a spreadsheet cell straight in.
 *
 * Used by the import, where a failure skips ONE row and is reported by row
 * number rather than raising — a single bad cell must not discard the workbook.
 */
export const isValidRosterEmail = (rawEmail: string): boolean =>
  rosterEmailSchema.safeParse(rawEmail).success;
