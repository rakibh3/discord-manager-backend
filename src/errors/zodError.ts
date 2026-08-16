import { ZodError, type ZodIssue } from 'zod';

import { TErrorMessage, TErrorResponse } from '@/interface/error';

export const handleZodValidationError = (error: ZodError): TErrorResponse => {
  const statusCode = 400;

  const capitalizeFirstLetter = (str: string) => {
    return str.replace(/\b\w/g, (char) => char.toUpperCase());
  };

  const errorMessages: TErrorMessage = error.issues.map((issue: ZodIssue) => {
    // Array indices are skipped so the *field* is named rather than the
    // position: a failure on `daysOfWeek[1]` has the path `['daysOfWeek', 1]`,
    // and reporting the trailing `1` would both lose the field name and crash
    // `capitalizeFirstLetter`, which takes a string. Flat object paths are
    // unaffected — their last segment is already the field name.
    const named = issue.path.filter(
      (segment): segment is string => typeof segment === 'string',
    );
    const path = named.at(-1) ?? '';

    return {
      path: capitalizeFirstLetter(path),
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
