import { z } from 'zod';

const createUserValidationSchema = z.object({
  name: z
    .string({ error: 'Name is required' })
    .min(2, { error: 'Name must be at least 2 characters' })
    .max(100, { error: 'Name must not exceed 100 characters' }),
  email: z.email({ error: 'Please provide a valid email address' }),
  password: z
    .string({ error: 'Password is required' })
    .min(6, { error: 'Password must be at least 6 characters' }),
  profilePhoto: z
    .url({ error: 'Profile photo must be a valid URL' })
    .optional(),
});

const updateUserProfileValidationSchema = z.object({
  name: z
    .string()
    .min(2, { error: 'Name must be at least 2 characters' })
    .max(100, { error: 'Name must not exceed 100 characters' })
    .optional(),
  email: z.email({ error: 'Please provide a valid email address' }).optional(),
  profilePhoto: z
    .url({ error: 'Profile photo must be a valid URL' })
    .optional(),
  bio: z
    .string()
    .max(500, { error: 'Bio must not exceed 500 characters' })
    .optional(),
});

export const userValidation = {
  createUserValidationSchema,
  updateUserProfileValidationSchema,
};
