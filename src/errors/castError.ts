import { Prisma } from '@generated/prisma/client';

import config from '@/config';
import { TErrorResponse } from '@/interface/error';

export const handleCastValidationError = (
  error: Prisma.PrismaClientKnownRequestError,
): TErrorResponse => {
  const statusCode = 400;
  const message = 'Invalid ID';

  const target = (error.meta?.target as string) || 'unknown field';
  const errorMessage = `Provided value for "${target}" is not a valid ID!`;

  return {
    statusCode,
    message,
    errorMessage,
    errorDetails: error,
    stack: config.env === 'development' ? error.stack : undefined,
  };
};
