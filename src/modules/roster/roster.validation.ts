import { z } from 'zod';

import { rosterEmailSchema } from '@/utils/rosterEmail';

/**
 * Field rules for the roster admin surface.
 *
 * One thing is deliberately absent here: the header-alias list and the
 * file-format instruction. `handleZodValidationError` title-cases every word of
 * every validation message, so a list of literal tokens the administrator must
 * type into their spreadsheet would come back as `Email Address`, `E-Mail` —
 * mangling the exact strings the message exists to name. Those two messages are
 * raised as `AppError` from the service instead. See `roster.service.ts`.
 */

const pageShape = {
  page: z.coerce
    .number({ error: 'page must be a number' })
    .int({ error: 'page must be a whole number' })
    .min(1, { error: 'page starts at 1' })
    .default(1),
  limit: z.coerce
    .number({ error: 'limit must be a number' })
    .int({ error: 'limit must be a whole number' })
    .min(1, { error: 'limit must be at least 1' })
    .max(200, { error: 'limit may not exceed 200' })
    .default(50),
};

const nameField = z
  .string({ error: 'Full name is required' })
  .trim()
  .min(1, { error: 'Full name cannot be empty' })
  .max(150, { error: 'Full name must be at most 150 characters' });

/**
 * The roster's phone rule is deliberately looser than the attendance form's.
 *
 * The form enforces the Bangladeshi mobile pattern because it is the number a
 * student is declaring about themselves right now. The roster's phone column is
 * reference data an administrator exported from somewhere else, nothing is
 * gated on it, and rejecting a row over a landline or an international number
 * would skip a person who is genuinely enrolled — the one outcome this feature
 * must not produce.
 */
const phoneField = z
  .string()
  .trim()
  .max(40, { error: 'Phone number must be at most 40 characters' });

/** `GET /api/roster?search=&status=&page=&limit=` */
const listRosterQuerySchema = z.object({
  search: z.string().trim().max(150).optional(),
  status: z
    .enum(['active', 'inactive', 'all'], {
      error: 'status must be one of: active, inactive, all',
    })
    .default('active'),
  ...pageShape,
});

/** `GET /api/roster/imports?page=&limit=` */
const listImportsQuerySchema = z.object({ ...pageShape });

/**
 * `PATCH /api/roster/:id`
 *
 * Every field optional, but at least one required — an empty patch is a client
 * bug, and answering 200 to it reports a save that changed nothing.
 */
const updateEntryValidationSchema = z
  .object({
    name: nameField.optional(),
    email: rosterEmailSchema.optional(),
    // Explicit `null` clears the number; omitting the key leaves it alone.
    phone: phoneField.nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    error: 'Provide at least one field to update',
  });

/**
 * `PATCH /api/roster/settings`
 *
 * Only the flag. Whether enabling it is ALLOWED is a business rule, not a field
 * rule — it depends on how many people are on the roster — so the refusal lives
 * in the service.
 */
const updateSettingsValidationSchema = z.object({
  enforceEmail: z.boolean({
    error: 'enforceEmail must be true or false',
  }),
});

export const rosterValidation = {
  listRosterQuerySchema,
  listImportsQuerySchema,
  updateEntryValidationSchema,
  updateSettingsValidationSchema,
};
