-- CreateTable
CREATE TABLE "discord_members" (
    "id" TEXT NOT NULL,
    "discord_user_id" TEXT NOT NULL,
    "discord_username" TEXT NOT NULL,
    "display_name" TEXT,
    "global_name" TEXT,
    "avatar_url" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "is_in_guild" BOOLEAN NOT NULL DEFAULT true,
    "joined_at" TIMESTAMP(3),
    "left_at" TIMESTAMP(3),
    "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discord_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "discord_members_discord_user_id_key" ON "discord_members"("discord_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "discord_members_discord_username_key" ON "discord_members"("discord_username");

-- CreateIndex
CREATE INDEX "discord_members_discord_username_idx" ON "discord_members"("discord_username");

-- CreateIndex
CREATE INDEX "discord_members_is_in_guild_idx" ON "discord_members"("is_in_guild");
