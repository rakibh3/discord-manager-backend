-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'LATE', 'EXCUSED');

-- CreateEnum
CREATE TYPE "ReminderStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ReminderDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'DM_CLOSED', 'FAILED');

-- CreateTable
CREATE TABLE "attendances" (
    "id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "attendance_date" TEXT NOT NULL,
    "status" "AttendanceStatus" NOT NULL DEFAULT 'PRESENT',
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_updates" (
    "id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "discord_message_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "message_date" TEXT NOT NULL,
    "message_created_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_updates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminder_logs" (
    "id" TEXT NOT NULL,
    "reminder_date" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "target_count" INTEGER NOT NULL,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "status" "ReminderStatus" NOT NULL DEFAULT 'PENDING',
    "created_by_id" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reminder_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminder_recipients" (
    "id" TEXT NOT NULL,
    "reminder_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "status" "ReminderDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "error_message" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reminder_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attendances_attendance_date_idx" ON "attendances"("attendance_date");

-- CreateIndex
CREATE UNIQUE INDEX "attendances_member_id_attendance_date_key" ON "attendances"("member_id", "attendance_date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_updates_discord_message_id_key" ON "daily_updates"("discord_message_id");

-- CreateIndex
CREATE INDEX "daily_updates_message_date_idx" ON "daily_updates"("message_date");

-- CreateIndex
CREATE INDEX "daily_updates_member_id_message_date_idx" ON "daily_updates"("member_id", "message_date");

-- CreateIndex
CREATE INDEX "reminder_logs_reminder_date_idx" ON "reminder_logs"("reminder_date");

-- CreateIndex
CREATE INDEX "reminder_recipients_reminder_id_status_idx" ON "reminder_recipients"("reminder_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "reminder_recipients_reminder_id_member_id_key" ON "reminder_recipients"("reminder_id", "member_id");

-- AddForeignKey
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "discord_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_updates" ADD CONSTRAINT "daily_updates_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "discord_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_logs" ADD CONSTRAINT "reminder_logs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_recipients" ADD CONSTRAINT "reminder_recipients_reminder_id_fkey" FOREIGN KEY ("reminder_id") REFERENCES "reminder_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_recipients" ADD CONSTRAINT "reminder_recipients_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "discord_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
