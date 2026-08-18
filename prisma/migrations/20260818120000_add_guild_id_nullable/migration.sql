-- Multi-server support, step 1 of 2: add the server column and backfill it.
--
-- Split from the constraint change on purpose. This migration is additive and
-- leaves the running single-server code working untouched, so it can be
-- deployed and verified on its own before anything becomes NOT NULL.
--
-- The backfill value is the guild this deployment has been syncing all along,
-- taken from the deployed DISCORD_GUILD_ID. A migration cannot read `.env`, so
-- it is written literally here. Getting it wrong orphans the entire directory
-- from the running bot: the attendance form would refuse every student and the
-- next sync would create ~5,000 duplicate rows.

-- AlterTable
ALTER TABLE "discord_members" ADD COLUMN "guild_id" TEXT;
ALTER TABLE "announcement_logs" ADD COLUMN "guild_id" TEXT;

-- Backfill: every existing row belongs to the one server configured until now.
UPDATE "discord_members"
   SET "guild_id" = '1466393031874707570'
 WHERE "guild_id" IS NULL;

UPDATE "announcement_logs"
   SET "guild_id" = '1466393031874707570'
 WHERE "guild_id" IS NULL;

-- CreateIndex
-- "Who is currently in this server" — the shape every guild-scoped read uses.
CREATE INDEX "discord_members_guild_id_is_in_guild_idx"
    ON "discord_members"("guild_id", "is_in_guild");

-- Cross-server overlap: how many servers currently hold this Discord account.
CREATE INDEX "discord_members_discord_user_id_idx"
    ON "discord_members"("discord_user_id");
