-- CreateTable
CREATE TABLE "roster_entries" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roster_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roster_imports" (
    "id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "imported_by_id" TEXT,
    "total_rows" INTEGER NOT NULL,
    "created_count" INTEGER NOT NULL,
    "updated_count" INTEGER NOT NULL,
    "skipped_count" INTEGER NOT NULL,
    "duplicate_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roster_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roster_settings" (
    "key" TEXT NOT NULL,
    "enforce_email" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roster_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "roster_entries_email_key" ON "roster_entries"("email");

-- CreateIndex
CREATE INDEX "roster_entries_is_active_idx" ON "roster_entries"("is_active");

-- CreateIndex
CREATE INDEX "roster_imports_created_at_idx" ON "roster_imports"("created_at");

-- AddForeignKey
ALTER TABLE "roster_imports" ADD CONSTRAINT "roster_imports_imported_by_id_fkey" FOREIGN KEY ("imported_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_settings" ADD CONSTRAINT "roster_settings_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
