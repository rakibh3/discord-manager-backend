-- Step 1 of 2: widen a reminder broadcast from a single date to a period.
--
-- Purely ADDITIVE. `reminder_date` is still present and still authoritative
-- after this migration, so a deployment can sit here indefinitely and rolling
-- the application back needs nothing but the old code. Step 2 enforces and
-- drops, and is the irreversible half.

-- Which rule decided that an account owed a reminder. The default reproduces
-- exactly what a broadcast meant before ranges existed.
CREATE TYPE "ReminderCriterion" AS ENUM ('MISSING_UPDATE', 'MISSING_BOTH');

ALTER TABLE "reminder_logs"
  ADD COLUMN "reminder_start_date" TEXT,
  ADD COLUMN "reminder_end_date"   TEXT,
  ADD COLUMN "criterion"       "ReminderCriterion" NOT NULL DEFAULT 'MISSING_UPDATE',
  ADD COLUMN "min_missed_days" INTEGER NOT NULL DEFAULT 1,
  -- Empty means every day in the period counted, which is what every existing
  -- single-date run did.
  ADD COLUMN "days_of_week"    INTEGER[] NOT NULL DEFAULT '{}';

-- Backfill: every existing broadcast covered exactly one day, so that day is
-- both ends of its period.
UPDATE "reminder_logs"
   SET "reminder_start_date" = "reminder_date",
       "reminder_end_date"   = "reminder_date"
 WHERE "reminder_start_date" IS NULL;

-- The overlap guard's lookup: unfinished runs covering a proposed period.
CREATE INDEX "reminder_logs_reminder_start_date_reminder_end_date_idx"
  ON "reminder_logs" ("reminder_start_date", "reminder_end_date");
