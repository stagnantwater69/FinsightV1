-- The enum values are committed in the immediately preceding migration.
-- Keeping their first use in a separate transaction works on every supported
-- PostgreSQL release and avoids "unsafe use of new value" failures.

ALTER TABLE "CSVImportBatch"
  ADD COLUMN "ImportBatch_ConfirmInputHash" CHAR(64),
  ADD COLUMN "ImportBatch_ConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "ImportBatch_StageExpiresAt" TIMESTAMP(3),
  ADD COLUMN "ImportBatch_StageID" UUID,
  ADD COLUMN "ImportBatch_StagedAt" TIMESTAMP(3);

CREATE TABLE "CSVImportStageChunk" (
  "ImportBatch_ID" INTEGER NOT NULL,
  "CSVImportStageChunk_Index" INTEGER NOT NULL,
  "CSVImportStageChunk_RowCount" INTEGER NOT NULL,
  "CSVImportStageChunk_Payload" BYTEA NOT NULL,
  "CSVImportStageChunk_PayloadHash" CHAR(64) NOT NULL,
  "CSVImportStageChunk_CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CSVImportStageChunk_pkey"
    PRIMARY KEY ("ImportBatch_ID", "CSVImportStageChunk_Index"),
  CONSTRAINT "CSVImportStageChunk_index_check"
    CHECK ("CSVImportStageChunk_Index" >= 0 AND "CSVImportStageChunk_Index" < 30),
  CONSTRAINT "CSVImportStageChunk_row_count_check"
    CHECK ("CSVImportStageChunk_RowCount" >= 1 AND "CSVImportStageChunk_RowCount" <= 1000),
  CONSTRAINT "CSVImportStageChunk_payload_check"
    CHECK (octet_length("CSVImportStageChunk_Payload") > 0),
  CONSTRAINT "CSVImportStageChunk_payload_hash_check"
    CHECK ("CSVImportStageChunk_PayloadHash"::text ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "CSVImportBatch_ImportBatch_StageID_key"
  ON "CSVImportBatch"("ImportBatch_StageID");

-- Expiry passes read only the short-lived states, ordered oldest first. A
-- partial index keeps finished import history out of this maintenance index.
CREATE INDEX "CSVImportBatch_staged_expiry_idx"
  ON "CSVImportBatch"("ImportBatch_StageExpiresAt", "ImportBatch_ID")
  WHERE "ImportBatch_ProcessingStatus" IN ('STAGING', 'STAGED')
    AND "ImportBatch_StageExpiresAt" IS NOT NULL;

ALTER TABLE "CSVImportBatch"
  ADD CONSTRAINT "CSVImportBatch_stage_identity_check" CHECK (
    "ImportBatch_ProcessingStatus" NOT IN ('STAGING', 'STAGED')
    OR (
      "ImportBatch_StageID" IS NOT NULL
      AND "ImportBatch_StageExpiresAt" IS NOT NULL
      AND "ImportBatch_FileReference" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "CSVImportBatch_stage_ready_check" CHECK (
    (
      "ImportBatch_ProcessingStatus" = 'STAGING'
      AND "ImportBatch_StagedAt" IS NULL
    )
    OR (
      "ImportBatch_ProcessingStatus" = 'STAGED'
      AND "ImportBatch_StagedAt" IS NOT NULL
    )
    OR "ImportBatch_ProcessingStatus" NOT IN ('STAGING', 'STAGED')
  ),
  ADD CONSTRAINT "CSVImportBatch_confirm_input_hash_check" CHECK (
    "ImportBatch_ConfirmInputHash" IS NULL
    OR "ImportBatch_ConfirmInputHash"::text ~ '^[0-9a-f]{64}$'
  );

ALTER TABLE "CSVImportStageChunk"
  ADD CONSTRAINT "CSVImportStageChunk_ImportBatch_ID_fkey"
  FOREIGN KEY ("ImportBatch_ID")
  REFERENCES "CSVImportBatch"("ImportBatch_ID")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

-- Application data is reachable only through Express/Prisma. Browser and
-- mobile Supabase roles receive no direct access to staged financial rows.
ALTER TABLE "CSVImportStageChunk" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "CSVImportStageChunk" FROM PUBLIC;

DO $$
DECLARE
  api_role TEXT;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE "CSVImportStageChunk" FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END
$$;
