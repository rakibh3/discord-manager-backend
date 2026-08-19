-- Roster ↔ Discord pairing: record the Discord account an enrolled person
-- submitted attendance from.
--
-- Two nullable columns on `roster_entries`:
--   discord_user_id  - a Discord ACCOUNT snowflake (never a discord_members.id);
--                     unique per the database, so two entries cannot record
--                     the same account and one person cannot be counted twice
--                     in the engagement report.
--   linked_at        - the instant the pairing was recorded. Kept separate
--                     from `updated_at`, which an import rewrites on every
--                     row it touches.
--
-- A supporting index on `(is_active, discord_user_id)` serves the paired /
-- unpaired split used by the engagement counts and listing filter.
--
-- Purely additive: no data step, no rewriting of existing rows. Existing
-- entries start with both columns NULL and learn their pairing as students
-- submit attendance.

-- AlterTable
ALTER TABLE "roster_entries"
    ADD COLUMN "discord_user_id" TEXT,
    ADD COLUMN "linked_at"      TIMESTAMP(3);

-- CreateIndex: the unique constraint that enforces "at most one enrolled
-- person per Discord account". NULLs are exempt, so any number of entries
-- can be unlinked at the same time.
CREATE UNIQUE INDEX "roster_entries_discord_user_id_key"
    ON "roster_entries"("discord_user_id");

-- CreateIndex: paired/unpaired split for the listing filter and the counts
-- query. A predicate on `is_active` keeps the partial-count and the outreach
-- list served by the same index that already backs the active filter.
CREATE INDEX "roster_entries_is_active_discord_user_id_idx"
    ON "roster_entries"("is_active", "discord_user_id");