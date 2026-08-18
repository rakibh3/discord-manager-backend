-- Bring `rendered_message` in line with every other column in this table.
-- The field was declared without an `@map`, so Prisma named the column after
-- the field itself — the one camelCase column among snake_case siblings.
-- A rename, not a drop-and-add: the stored message is the audit record of what
-- students actually read, and it must survive the correction.
ALTER TABLE "announcement_logs" RENAME COLUMN "renderedMessage" TO "rendered_message";
