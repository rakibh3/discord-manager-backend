-- Multi-server support, step 2 of 2: enforce the server scope.
--
-- Run only after step 1's backfill is confirmed to have left no NULL. This
-- migration is the breaking half: it drops the GLOBAL uniqueness of a Discord
-- account and handle and replaces it with uniqueness WITHIN a server.
--
-- Dropping the global uniques is not a loosening by accident. A Discord handle
-- identifies one account globally, so two rows holding the same handle are that
-- one person present in two servers — the correct state, and impossible to
-- represent while the old constraint stood. Handle collisions that actually
-- matter (a member renaming onto a handle a stale row still holds) happen
-- within a server, and the composite unique still catches those.

-- AlterTable: the backfill in step 1 guarantees these are populated.
ALTER TABLE "discord_members" ALTER COLUMN "guild_id" SET NOT NULL;
ALTER TABLE "announcement_logs" ALTER COLUMN "guild_id" SET NOT NULL;

-- DropIndex: global uniqueness, replaced by the per-server pairs below.
DROP INDEX "discord_members_discord_user_id_key";
DROP INDEX "discord_members_discord_username_key";

-- CreateIndex
CREATE UNIQUE INDEX "discord_members_guild_id_discord_user_id_key"
    ON "discord_members"("guild_id", "discord_user_id");
CREATE UNIQUE INDEX "discord_members_guild_id_discord_username_key"
    ON "discord_members"("guild_id", "discord_username");

-- DropIndex: the once-per-day announcement claim becomes per server, so a
-- failure in one server cannot consume another server's day.
DROP INDEX "announcement_logs_key_announcement_date_attempt_key";
DROP INDEX "announcement_logs_key_announcement_date_idx";

-- CreateIndex
CREATE UNIQUE INDEX "announcement_logs_guild_id_key_announcement_date_attempt_key"
    ON "announcement_logs"("guild_id", "key", "announcement_date", "attempt");
CREATE INDEX "announcement_logs_guild_id_key_announcement_date_idx"
    ON "announcement_logs"("guild_id", "key", "announcement_date");
