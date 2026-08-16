import { Prisma } from '@generated/prisma/client';

import config from '@/config';
import { TErrorResponse } from '@/interface/error';

export const handleDuplicateValidationError = (
  error: Prisma.PrismaClientKnownRequestError,
): TErrorResponse => {
  const statusCode = 409;
  const message = 'Duplicate Error';

  const target = error.meta?.target as string[] | undefined;
  const fields = target?.join(', ') || 'unknown field';

  const errorMessage = `${fields} already exists!`;

  return {
    statusCode,
    message,
    errorMessage,
    errorDetails: error,
    stack: config.env === 'development' ? error.stack : undefined,
  };
};
