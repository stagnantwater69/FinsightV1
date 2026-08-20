-- CSV import state machine (docs/ML-OCR-CSV-UI-PROGRAM.md ADR-3).
--
-- Three parts, all reversible-by-revert:
--  1. CSVImportBatch grows a machine-progress state machine, idempotency key,
--     file provenance, persisted counts, and durable-worker columns.
--  2. fileReference becomes nullable: the batch row is now created BEFORE the
--     storage upload, so a failed upload can never orphan an untracked object.
--  3. ExpenseCategory gains the missing per-business name uniqueness, after
--     merging any pre-existing exact duplicates (the concurrency race this
--     constraint closes could already have produced them).

CREATE TYPE "CsvImportProcessingStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETE', 'FAILED');

ALTER TABLE "CSVImportBatch"
  ALTER COLUMN "ImportBatch_FileReference" DROP NOT NULL,
  ADD COLUMN "ImportBatch_ProcessingStatus" "CsvImportProcessingStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "ImportBatch_IdempotencyKey" VARCHAR(100),
  ADD COLUMN "ImportBatch_FileHash" VARCHAR(64),
  ADD COLUMN "ImportBatch_FileSizeBytes" INTEGER,
  ADD COLUMN "ImportBatch_TotalRows" INTEGER,
  ADD COLUMN "ImportBatch_ProcessedRows" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "ImportBatch_ImportedRows" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "ImportBatch_SkippedRows" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "ImportBatch_FlaggedRows" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "ImportBatch_FailureStage" VARCHAR(50),
  ADD COLUMN "ImportBatch_LastError" VARCHAR(1000),
  ADD COLUMN "ImportBatch_AttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "ImportBatch_NextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "ImportBatch_HeartbeatAt" TIMESTAMP(3),
  ADD COLUMN "ImportBatch_WorkerID" VARCHAR(100),
  ADD COLUMN "ImportBatch_StartedAt" TIMESTAMP(3),
  ADD COLUMN "ImportBatch_CompletedAt" TIMESTAMP(3),
  ADD COLUMN "ImportBatch_MappingMeta" JSONB,
  ADD COLUMN "ImportBatch_ResultSummary" JSONB;

-- Every batch that exists today finished under the old synchronous flow.
UPDATE "CSVImportBatch" SET "ImportBatch_ProcessingStatus" = 'COMPLETE';

CREATE UNIQUE INDEX "CSVImportBatch_ImportBatch_IdempotencyKey_key"
  ON "CSVImportBatch"("ImportBatch_IdempotencyKey");
CREATE INDEX "CSVImportBatch_ImportBatch_ProcessingStatus_ImportBatch_Nex_idx"
  ON "CSVImportBatch"("ImportBatch_ProcessingStatus", "ImportBatch_NextAttemptAt", "ImportBatch_HeartbeatAt");

-- ---- ExpenseCategory uniqueness ------------------------------------------
-- Merge exact duplicates (same business, same exact name) into the oldest id.
-- Financial records and owner-authored schedules are repointed; derived rows
-- (statistics, inferred patterns) are deleted — the daily refresh rebuilds
-- them, and repointing could collide with their own unique keys.
WITH ranked AS (
  SELECT "Category_ID" AS id,
         MIN("Category_ID") OVER (PARTITION BY "BusinessProfile_ID", "Category_Name") AS keep
  FROM "ExpenseCategory"
),
dupes AS (SELECT id, keep FROM ranked WHERE id <> keep)
UPDATE "ExpenseRecord" e SET "Category_ID" = d.keep FROM dupes d WHERE e."Category_ID" = d.id;

WITH ranked AS (
  SELECT "Category_ID" AS id,
         MIN("Category_ID") OVER (PARTITION BY "BusinessProfile_ID", "Category_Name") AS keep
  FROM "ExpenseCategory"
),
dupes AS (SELECT id, keep FROM ranked WHERE id <> keep)
UPDATE "RecurringSchedule" r SET "Category_ID" = d.keep FROM dupes d WHERE r."Category_ID" = d.id;

WITH ranked AS (
  SELECT "Category_ID" AS id,
         MIN("Category_ID") OVER (PARTITION BY "BusinessProfile_ID", "Category_Name") AS keep
  FROM "ExpenseCategory"
),
dupes AS (SELECT id, keep FROM ranked WHERE id <> keep)
UPDATE "ReceiptScanItem" i SET "Category_ID" = d.keep FROM dupes d WHERE i."Category_ID" = d.id;

WITH ranked AS (
  SELECT "Category_ID" AS id,
         MIN("Category_ID") OVER (PARTITION BY "BusinessProfile_ID", "Category_Name") AS keep
  FROM "ExpenseCategory"
)
DELETE FROM "CategoryStatistics" s USING ranked r WHERE s."Category_ID" = r.id AND r.id <> r.keep;

WITH ranked AS (
  SELECT "Category_ID" AS id,
         MIN("Category_ID") OVER (PARTITION BY "BusinessProfile_ID", "Category_Name") AS keep
  FROM "ExpenseCategory"
)
DELETE FROM "RecurringPattern" p USING ranked r WHERE p."Category_ID" = r.id AND r.id <> r.keep;

WITH ranked AS (
  SELECT "Category_ID" AS id,
         MIN("Category_ID") OVER (PARTITION BY "BusinessProfile_ID", "Category_Name") AS keep
  FROM "ExpenseCategory"
)
DELETE FROM "ExpenseCategory" c USING ranked r WHERE c."Category_ID" = r.id AND r.id <> r.keep;

CREATE UNIQUE INDEX "ExpenseCategory_BusinessProfile_ID_Category_Name_key"
  ON "ExpenseCategory"("BusinessProfile_ID", "Category_Name");
