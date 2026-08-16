import { z } from 'zod';

const loginValidationSchema = z.object({
  email: z.email({ error: 'Please provide a valid email address' }),
  password: z
    .string({ error: 'Password is required' })
    .min(1, { error: 'Password cannot be empty' }),
});

export const authValidation = {
  loginValidationSchema,
};
