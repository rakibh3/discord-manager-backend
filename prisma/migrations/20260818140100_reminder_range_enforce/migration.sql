-- Step 2 of 2: make the period authoritative and remove the single date.
--
-- Run only after verifying on a copy of production data that no row is left
-- without a period and that every backfilled row has start = end.
--
-- This half is the irreversible one: rolling back past it means re-adding
-- `reminder_date` and backfilling it from `reminder_end_date`, which is
-- lossless for every row the old code could have written and lossy only for
-- genuinely multi-day runs, which the old code could not represent at all.

-- Belt and braces: refuse to enforce NOT NULL if anything was missed. A failed
-- migration is recoverable; a period column silently holding the wrong day is
-- not.
DO $$
DECLARE
  unbackfilled INTEGER;
BEGIN
  SELECT COUNT(*) INTO unbackfilled
    FROM "reminder_logs"
   WHERE "reminder_start_date" IS NULL OR "reminder_end_date" IS NULL;

  IF unbackfilled > 0 THEN
    RAISE EXCEPTION
      'reminder_logs has % row(s) with no period; re-run the backfill from migration 20260818140000 before enforcing',
      unbackfilled;
  END IF;
END $$;

ALTER TABLE "reminder_logs"
  ALTER COLUMN "reminder_start_date" SET NOT NULL,
  ALTER COLUMN "reminder_end_date"   SET NOT NULL;

DROP INDEX IF EXISTS "reminder_logs_reminder_date_idx";

ALTER TABLE "reminder_logs" DROP COLUMN "reminder_date";
