-- Discord pairing mismatch reports.
--
-- One row per "this Discord username is not mine" flag-set submission per
-- roster entry per Asia/Dhaka date, while the report is still `open`. The
-- partial unique index below enforces "at most one OPEN report per entry per
-- day" at the database level so two simultaneous flag-set submissions on the
-- same day do not both create a row — the repository swallows the conflict
-- as a no-op.
--
-- Purely additive: no data step, no rewriting of existing rows.

-- CreateEnum
CREATE TYPE "DiscordPairingMismatchReportStatus" AS ENUM ('OPEN', 'REASSIGNED', 'DISMISSED');

-- CreateTable
CREATE TABLE "discord_pairing_mismatch_reports" (
    "id"                    TEXT                                  NOT NULL,
    "roster_entry_id"       TEXT                                  NOT NULL,
    "paired_account_id"     TEXT                                  NOT NULL,
    "submitting_account_id" TEXT                                  NOT NULL,
    "submitted_handle"      TEXT                                  NOT NULL,
    "reason"                TEXT                                  NOT NULL,
    "submission_dhaka_date" TEXT                                  NOT NULL,
    "reported_at"           TIMESTAMP(3)                          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status"                "DiscordPairingMismatchReportStatus"  NOT NULL DEFAULT 'OPEN',
    "reviewed_by_admin_id"  TEXT,
    "reviewed_at"           TIMESTAMP(3),
    "created_at"            TIMESTAMP(3)                          NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discord_pairing_mismatch_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: paired account — supports future per-account filtering and
-- the engagement listing's open-report count lookup (which joins through
-- roster entries, not accounts, so this is mostly for diagnostics).
CREATE INDEX "discord_pairing_mismatch_reports_paired_account_id_idx"
    ON "discord_pairing_mismatch_reports"("paired_account_id");

-- CreateIndex: submitting account — same shape as `paired_account_id`.
CREATE INDEX "discord_pairing_mismatch_reports_submitting_account_id_idx"
    ON "discord_pairing_mismatch_reports"("submitting_account_id");

-- CreateIndex: the dashboard listing sorts by status with newest first.
CREATE INDEX "discord_pairing_mismatch_reports_status_reported_at_idx"
    ON "discord_pairing_mismatch_reports"("status", "reported_at" DESC);

-- CreateIndex: audit-log query (which admin took which action).
CREATE INDEX "discord_pairing_mismatch_reports_reviewed_by_admin_id_idx"
    ON "discord_pairing_mismatch_reports"("reviewed_by_admin_id");

-- CreateIndex: PARTIAL UNIQUE — at most one OPEN report per entry per day.
-- This is a partial index because Prisma does not natively support partial
-- indexes; it is created in raw SQL inside the migration. A second flag-set
-- submission on the same day for the same roster entry raises a P2002 on
-- this index; the repository swallows that as a no-op.
CREATE UNIQUE INDEX "discord_pairing_mismatch_reports_open_per_entry_date_key"
    ON "discord_pairing_mismatch_reports"("roster_entry_id", "submission_dhaka_date")
    WHERE "status" = 'OPEN';

-- AddForeignKey: cascade on roster entry deletion — deactivating an entry
-- removes its reports, mirroring the `attendances` cascade.
ALTER TABLE "discord_pairing_mismatch_reports"
    ADD CONSTRAINT "discord_pairing_mismatch_reports_roster_entry_id_fkey"
    FOREIGN KEY ("roster_entry_id") REFERENCES "roster_entries"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: set-null on admin deletion — the report outlives the admin,
-- same as `roster_imports.imported_by_id` and `roster_settings.updated_by_id`.
ALTER TABLE "discord_pairing_mismatch_reports"
    ADD CONSTRAINT "discord_pairing_mismatch_reports_reviewed_by_admin_id_fkey"
    FOREIGN KEY ("reviewed_by_admin_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;