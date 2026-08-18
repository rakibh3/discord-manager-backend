/**
 * `<mm> <HH> * * <days>` — minute and hour from a stored `HH:mm`, weekdays
 * straight from a `daysOfWeek` array, which already uses cron's own 0-6
 * numbering.
 *
 * Never stored; always derived. An admin edits a time picker and a weekday
 * list, never a cron string — a mistyped `0 6 * * *` produces a job that fires
 * happily at the wrong hour with no error raised anywhere.
 *
 * Shared by every scheduled feature (the channel open/lock jobs and the
 * attendance announcement) so there is one derivation rather than two that
 * drift apart the first time one of them is fixed.
 */
export const buildCronExpression = (
  time: string,
  daysOfWeek: number[],
): string => {
  const [hour, minute] = time.split(':');

  return `${Number(minute)} ${Number(hour)} * * ${[...daysOfWeek].sort((a, b) => a - b).join(',')}`;
};
