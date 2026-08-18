-- CreateEnum
CREATE TYPE "AnnouncementStatus" AS ENUM ('SENDING', 'POSTED', 'FAILED');

-- CreateEnum
CREATE TYPE "AnnouncementTrigger" AS ENUM ('SCHEDULED', 'MANUAL');

-- CreateTable
CREATE TABLE "announcement_templates" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "termination_days" INTEGER NOT NULL DEFAULT 3,
    "mention_everyone" BOOLEAN NOT NULL DEFAULT false,
    "mention_role_ids" TEXT[],
    "mention_usernames" TEXT[],
    "announce_time" TEXT NOT NULL DEFAULT '19:00',
    "days_of_week" INTEGER[] DEFAULT ARRAY[0, 1, 2, 3, 4, 5, 6]::INTEGER[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "announcement_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcement_logs" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "announcement_date" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" "AnnouncementStatus" NOT NULL,
    "trigger" "AnnouncementTrigger" NOT NULL,
    "renderedMessage" TEXT NOT NULL,
    "discord_message_id" TEXT,
    "mentioned_role_ids" TEXT[],
    "mentioned_user_ids" TEXT[],
    "unresolved_targets" TEXT[],
    "error" TEXT,
    "triggered_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "announcement_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "announcement_templates_key_key" ON "announcement_templates"("key");

-- CreateIndex
CREATE INDEX "announcement_logs_key_announcement_date_idx" ON "announcement_logs"("key", "announcement_date");

-- CreateIndex
CREATE UNIQUE INDEX "announcement_logs_key_announcement_date_attempt_key" ON "announcement_logs"("key", "announcement_date", "attempt");

-- AddForeignKey
ALTER TABLE "announcement_templates" ADD CONSTRAINT "announcement_templates_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_logs" ADD CONSTRAINT "announcement_logs_triggered_by_id_fkey" FOREIGN KEY ("triggered_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
