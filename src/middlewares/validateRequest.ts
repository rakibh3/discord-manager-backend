import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

import { catchAsync } from '@/utils/catchAsync';

export const validateRequest = (schema: z.ZodObject) => {
  return catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    await schema.parseAsync(req.body);
    next();
  });
};

/**
 * The query-string counterpart of `validateRequest`, for endpoints whose input
 * arrives in the URL rather than the body — `GET /api/attendance/verify-user`
 * is the first of them.
 *
 * Deliberately does NOT assign the parsed result back onto the request. Under
 * Express 5 `req.query` is a getter, so an assignment would throw; and the
 * parsed value would be discarded anyway, since handlers read `req.query`
 * directly. This middleware exists to reject a malformed request before it
 * reaches a controller, not to transform one. Any normalization the handler
 * needs is the service's job.
 *
 * A failure raises `ZodError`, which `globalErrorHandler` already shapes into
 * the standard field-level validation response.
 */
export const validateQuery = (schema: z.ZodObject) => {
  return catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    await schema.parseAsync(req.query);
    next();
  });
};
