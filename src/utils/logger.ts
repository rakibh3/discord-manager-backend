/* eslint-disable no-console */

/**
 * Minimal scoped logger. Keeps the `no-console` suppression in one place
 * and gives every bot/sync line a consistent, greppable prefix.
 */
const format = (scope: string, message: string) =>
  `[${new Date().toISOString()}] [${scope}] ${message}`;

export const createLogger = (scope: string) => ({
  info: (message: string, ...rest: unknown[]) =>
    console.log(format(scope, message), ...rest),
  warn: (message: string, ...rest: unknown[]) =>
    console.warn(format(scope, message), ...rest),
  error: (message: string, ...rest: unknown[]) =>
    console.error(format(scope, message), ...rest),
});

export type TLogger = ReturnType<typeof createLogger>;
