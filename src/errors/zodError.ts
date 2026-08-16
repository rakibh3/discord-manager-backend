import { ZodError, type ZodIssue } from 'zod';

import { TErrorMessage, TErrorResponse } from '@/interface/error';

export const handleZodValidationError = (error: ZodError): TErrorResponse => {
  const statusCode = 400;

  const capitalizeFirstLetter = (str: string) => {
    return str.replace(/\b\w/g, (char) => char.toUpperCase());
  };

  const errorMessages: TErrorMessage = error.issues.map((issue: ZodIssue) => {
    const path = issue.path.length > 0 ? issue.path[issue.path.length - 1] : '';
    return {
      path: capitalizeFirstLetter(path as string),
      message: capitalizeFirstLetter(issue.message),
    };
  });

  const errorMessage = errorMessages
    .map((error) => `${error.path} ${error.message}`)
    .join(', ');

  return {
    statusCode,
    errorMessage,
    errorDetails: {
      issues: errorMessages,
    },
  };
};
