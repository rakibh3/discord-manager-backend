import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

import { catchAsync } from '@/utils/catchAsync';

export const validateRequest = (schema: z.ZodObject) => {
  return catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    await schema.parseAsync(req.body);
    next();
  });
};
