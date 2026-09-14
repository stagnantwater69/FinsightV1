-- CreateEnum
CREATE TYPE "ReceiptCaptureBatchStatus" AS ENUM (
    'COLLECTING',
    'PROCESSING',
    'READY_FOR_REVIEW',
    'PARTIAL_FAILURE',
    'FAILED',
    'COMPLETE'
);

-- CreateEnum
CREATE TYPE "ReceiptPurgeMode" AS ENUM (
    'DELETE_SCAN',
    'DETACH_EVIDENCE'
);

-- CreateEnum
CREATE TYPE "ReceiptDuplicateScoreBand" AS ENUM (
    'EXACT',
    'LIKELY'
);

-- CreateEnum
CREATE TYPE "ReceiptDuplicateReviewStatus" AS ENUM (
    'PENDING',
    'SAVED_ANYWAY',
    'SUPERSEDED'
);

-- CreateTable
CREATE TABLE "ReceiptCaptureBatch" (
    "ReceiptCaptureBatch_ID" SERIAL NOT NULL,
    "BusinessProfile_ID" INTEGER NOT NULL,
    "ReceiptCaptureBatch_ClientBatchKey" VARCHAR(100) NOT NULL,
    "ReceiptCaptureBatch_ExpectedReceiptCount" INTEGER NOT NULL,
    "ReceiptCaptureBatch_Status" "ReceiptCaptureBatchStatus" NOT NULL DEFAULT 'COLLECTING',
    "ReceiptCaptureBatch_CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ReceiptCaptureBatch_FinishedAt" TIMESTAMP(3),

    CONSTRAINT "ReceiptCaptureBatch_pkey" PRIMARY KEY ("ReceiptCaptureBatch_ID"),
    CONSTRAINT "ReceiptCaptureBatch_client_key_check" CHECK (
        char_length("ReceiptCaptureBatch_ClientBatchKey") BETWEEN 8 AND 100
    ),
    CONSTRAINT "ReceiptCaptureBatch_expected_count_check" CHECK (
        "ReceiptCaptureBatch_ExpectedReceiptCount" BETWEEN 2 AND 8
    ),
    CONSTRAINT "ReceiptCaptureBatch_finished_check" CHECK (
        (
            "ReceiptCaptureBatch_Status" = 'COMPLETE'
            AND "ReceiptCaptureBatch_FinishedAt" IS NOT NULL
        )
        OR (
            "ReceiptCaptureBatch_Status" <> 'COMPLETE'
            AND "ReceiptCaptureBatch_FinishedAt" IS NULL
        )
    ),
    CONSTRAINT "ReceiptCaptureBatch_timestamps_check" CHECK (
        "ReceiptCaptureBatch_FinishedAt" IS NULL
        OR "ReceiptCaptureBatch_FinishedAt" >= "ReceiptCaptureBatch_CreatedAt"
    )
);

-- CreateTable
CREATE TABLE "ReceiptDuplicateCandidate" (
    "ReceiptDuplicateCandidate_ID" SERIAL NOT NULL,
    "BusinessProfile_ID" INTEGER NOT NULL,
    "ReceiptDuplicateCandidate_SourceReceiptScan_ID" INTEGER NOT NULL,
    "ReceiptDuplicateCandidate_CandidateReceiptScan_ID" INTEGER,
    "ReceiptDuplicateCandidate_CandidateExpenseRecord_ID" INTEGER,
    "ReceiptDuplicateCandidate_DetectorVersion" VARCHAR(64) NOT NULL,
    "ReceiptDuplicateCandidate_SourceFingerprint" CHAR(64) NOT NULL,
    "ReceiptDuplicateCandidate_ReasonCodes" JSONB NOT NULL,
    "ReceiptDuplicateCandidate_ScoreBand" "ReceiptDuplicateScoreBand" NOT NULL,
    "ReceiptDuplicateCandidate_ReviewStatus" "ReceiptDuplicateReviewStatus" NOT NULL DEFAULT 'PENDING',
    "ReceiptDuplicateCandidate_DecisionSetHash" CHAR(64),
    "ReceiptDuplicateCandidate_DecidedByUser_ID" INTEGER,
    "ReceiptDuplicateCandidate_CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ReceiptDuplicateCandidate_DecidedAt" TIMESTAMP(3),

    CONSTRAINT "ReceiptDuplicateCandidate_pkey" PRIMARY KEY ("ReceiptDuplicateCandidate_ID"),
    CONSTRAINT "ReceiptDuplicateCandidate_target_check" CHECK (
        (
            "ReceiptDuplicateCandidate_CandidateReceiptScan_ID" IS NOT NULL
            AND "ReceiptDuplicateCandidate_CandidateExpenseRecord_ID" IS NULL
            AND "ReceiptDuplicateCandidate_CandidateReceiptScan_ID" <> "ReceiptDuplicateCandidate_SourceReceiptScan_ID"
        )
        OR (
            "ReceiptDuplicateCandidate_CandidateReceiptScan_ID" IS NULL
            AND "ReceiptDuplicateCandidate_CandidateExpenseRecord_ID" IS NOT NULL
        )
    ),
    CONSTRAINT "ReceiptDuplicateCandidate_detector_version_check" CHECK (
        btrim("ReceiptDuplicateCandidate_DetectorVersion") <> ''
    ),
    CONSTRAINT "ReceiptDuplicateCandidate_source_fingerprint_check" CHECK (
        "ReceiptDuplicateCandidate_SourceFingerprint" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "ReceiptDuplicateCandidate_decision_set_hash_check" CHECK (
        "ReceiptDuplicateCandidate_DecisionSetHash" IS NULL
        OR "ReceiptDuplicateCandidate_DecisionSetHash" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "ReceiptDuplicateCandidate_reason_codes_check" CHECK (
        jsonb_typeof("ReceiptDuplicateCandidate_ReasonCodes") = 'array'
        AND jsonb_array_length("ReceiptDuplicateCandidate_ReasonCodes") > 0
    ),
    CONSTRAINT "ReceiptDuplicateCandidate_decision_lifecycle_check" CHECK (
        (
            "ReceiptDuplicateCandidate_ReviewStatus" = 'SAVED_ANYWAY'
            AND "ReceiptDuplicateCandidate_DecisionSetHash" IS NOT NULL
            AND "ReceiptDuplicateCandidate_DecidedByUser_ID" IS NOT NULL
            AND "ReceiptDuplicateCandidate_DecidedAt" IS NOT NULL
        )
        OR (
            "ReceiptDuplicateCandidate_ReviewStatus" IN ('PENDING', 'SUPERSEDED')
            AND "ReceiptDuplicateCandidate_DecisionSetHash" IS NULL
            AND "ReceiptDuplicateCandidate_DecidedByUser_ID" IS NULL
            AND "ReceiptDuplicateCandidate_DecidedAt" IS NULL
        )
    ),
    CONSTRAINT "ReceiptDuplicateCandidate_decision_timestamp_check" CHECK (
        "ReceiptDuplicateCandidate_DecidedAt" IS NULL
        OR "ReceiptDuplicateCandidate_DecidedAt" >= "ReceiptDuplicateCandidate_CreatedAt"
    )
);

-- AlterTable
ALTER TABLE "ReceiptScan"
    ADD COLUMN "ReceiptCaptureBatch_ID" INTEGER,
    ADD COLUMN "ReceiptScan_EvidenceDeletedAt" TIMESTAMP(3),
    ADD COLUMN "ReceiptScan_EvidenceDeletionRequestedAt" TIMESTAMP(3),
    ADD COLUMN "ReceiptScan_ReceiptOrdinal" INTEGER,
    ADD COLUMN "ReceiptScan_ScanRevision" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "ReceiptScan_SemanticFingerprint" CHAR(64),
    ALTER COLUMN "ReceiptScan_ImageFile" DROP NOT NULL;

ALTER TABLE "ReceiptScan"
    ADD CONSTRAINT "ReceiptScan_scan_revision_check" CHECK (
        "ReceiptScan_ScanRevision" >= 0
    ),
    ADD CONSTRAINT "ReceiptScan_semantic_fingerprint_check" CHECK (
        "ReceiptScan_SemanticFingerprint" IS NULL
        OR "ReceiptScan_SemanticFingerprint" ~ '^[0-9a-f]{64}$'
    ),
    ADD CONSTRAINT "ReceiptScan_evidence_deletion_timestamps_check" CHECK (
        "ReceiptScan_EvidenceDeletedAt" IS NULL
        OR (
            "ReceiptScan_EvidenceDeletionRequestedAt" IS NOT NULL
            AND "ReceiptScan_EvidenceDeletedAt" >= "ReceiptScan_EvidenceDeletionRequestedAt"
        )
    ),
    ADD CONSTRAINT "ReceiptScan_batch_link_check" CHECK (
        (
            "ReceiptCaptureBatch_ID" IS NULL
            AND "ReceiptScan_ReceiptOrdinal" IS NULL
        )
        OR (
            "ReceiptCaptureBatch_ID" IS NOT NULL
            AND "ReceiptScan_ReceiptOrdinal" IS NOT NULL
            AND "BusinessProfile_ID" IS NOT NULL
            AND "ReceiptScan_ReceiptOrdinal" BETWEEN 1 AND 8
        )
    );

-- AlterTable
ALTER TABLE "ReceiptPurgeJob"
    ADD COLUMN "ReceiptPurgeJob_Mode" "ReceiptPurgeMode" NOT NULL DEFAULT 'DELETE_SCAN';

ALTER TABLE "ReceiptPurgeJob"
    ALTER COLUMN "ReceiptPurgeJob_Mode" DROP DEFAULT,
    ADD CONSTRAINT "ReceiptPurgeJob_active_target_check" CHECK (
        "ReceiptPurgeJob_Status" NOT IN ('PENDING', 'PROCESSING', 'RETRY')
        OR (
            "ReceiptScan_ID" IS NOT NULL
            AND "ReceiptScan_BusinessProfile_ID" IS NOT NULL
        )
    );

-- DropIndex
DROP INDEX "ReceiptScan_BusinessProfile_ID_idx";

-- CreateIndex
CREATE INDEX "ReceiptScan_history_status_created_idx"
    ON "ReceiptScan"(
        "BusinessProfile_ID",
        "ReceiptScan_ConfirmationStatus",
        "ReceiptScan_ProcessingStatus",
        "ReceiptScan_CreatedAt" DESC,
        "ReceiptScan_ID" DESC
    );

-- CreateIndex
CREATE INDEX "ReceiptScan_history_created_idx"
    ON "ReceiptScan"(
        "BusinessProfile_ID",
        "ReceiptScan_CreatedAt" DESC,
        "ReceiptScan_ID" DESC
    );

-- CreateIndex
CREATE INDEX "ReceiptScan_profile_semantic_fingerprint_idx"
    ON "ReceiptScan"("BusinessProfile_ID", "ReceiptScan_SemanticFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseRecord_ID_BusinessProfile_ID_key"
    ON "ExpenseRecord"("ExpenseRecord_ID", "BusinessProfile_ID");

-- CreateIndex
CREATE INDEX "ReceiptDuplicateCandidate_source_review_idx"
    ON "ReceiptDuplicateCandidate"(
        "BusinessProfile_ID",
        "ReceiptDuplicateCandidate_SourceReceiptScan_ID",
        "ReceiptDuplicateCandidate_ReviewStatus",
        "ReceiptDuplicateCandidate_ID"
    );

-- CreateIndex
CREATE INDEX "ReceiptDuplicateCandidate_scan_target_idx"
    ON "ReceiptDuplicateCandidate"(
        "ReceiptDuplicateCandidate_CandidateReceiptScan_ID",
        "BusinessProfile_ID"
    );

-- CreateIndex
CREATE INDEX "ReceiptDuplicateCandidate_expense_target_idx"
    ON "ReceiptDuplicateCandidate"(
        "ReceiptDuplicateCandidate_CandidateExpenseRecord_ID",
        "BusinessProfile_ID"
    );

-- CreateIndex
CREATE INDEX "ReceiptDuplicateCandidate_decision_owner_idx"
    ON "ReceiptDuplicateCandidate"(
        "BusinessProfile_ID",
        "ReceiptDuplicateCandidate_DecidedByUser_ID"
    );

-- Migration-only partial uniqueness keeps one durable detector result for
-- each concrete candidate without preventing distinct scan and expense targets.
CREATE UNIQUE INDEX "ReceiptDuplicateCandidate_source_scan_target_key"
    ON "ReceiptDuplicateCandidate"(
        "ReceiptDuplicateCandidate_SourceReceiptScan_ID",
        "ReceiptDuplicateCandidate_CandidateReceiptScan_ID",
        "ReceiptDuplicateCandidate_DetectorVersion"
    )
    WHERE "ReceiptDuplicateCandidate_CandidateReceiptScan_ID" IS NOT NULL;

CREATE UNIQUE INDEX "ReceiptDuplicateCandidate_source_expense_target_key"
    ON "ReceiptDuplicateCandidate"(
        "ReceiptDuplicateCandidate_SourceReceiptScan_ID",
        "ReceiptDuplicateCandidate_CandidateExpenseRecord_ID",
        "ReceiptDuplicateCandidate_DetectorVersion"
    )
    WHERE "ReceiptDuplicateCandidate_CandidateExpenseRecord_ID" IS NOT NULL;

-- DropIndex
DROP INDEX "ReceiptPurgeJob_profile_receipt_key";

-- CreateIndex
CREATE INDEX "ReceiptPurgeJob_profile_receipt_idx"
    ON "ReceiptPurgeJob"("BusinessProfile_ID", "ReceiptScan_ID");

CREATE UNIQUE INDEX "ReceiptPurgeJob_active_profile_receipt_key"
    ON "ReceiptPurgeJob"("BusinessProfile_ID", "ReceiptScan_ID")
    WHERE "ReceiptPurgeJob_Status" IN ('PENDING', 'PROCESSING', 'RETRY');

-- CreateIndex
CREATE INDEX "ReceiptCaptureBatch_profile_created_idx"
    ON "ReceiptCaptureBatch"("BusinessProfile_ID", "ReceiptCaptureBatch_CreatedAt", "ReceiptCaptureBatch_ID");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptCaptureBatch_profile_client_key"
    ON "ReceiptCaptureBatch"("BusinessProfile_ID", "ReceiptCaptureBatch_ClientBatchKey");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptCaptureBatch_ID_BusinessProfile_ID_key"
    ON "ReceiptCaptureBatch"("ReceiptCaptureBatch_ID", "BusinessProfile_ID");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptScan_batch_ordinal_key"
    ON "ReceiptScan"("ReceiptCaptureBatch_ID", "ReceiptScan_ReceiptOrdinal");

-- AddForeignKey
ALTER TABLE "ReceiptCaptureBatch"
    ADD CONSTRAINT "ReceiptCaptureBatch_BusinessProfile_ID_fkey"
    FOREIGN KEY ("BusinessProfile_ID")
    REFERENCES "BusinessProfile"("BusinessProfile_ID")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptScan"
    ADD CONSTRAINT "ReceiptScan_ReceiptCaptureBatch_ID_BusinessProfile_ID_fkey"
    FOREIGN KEY ("ReceiptCaptureBatch_ID", "BusinessProfile_ID")
    REFERENCES "ReceiptCaptureBatch"("ReceiptCaptureBatch_ID", "BusinessProfile_ID")
    ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptDuplicateCandidate"
    ADD CONSTRAINT "ReceiptDuplicateCandidate_profile_fkey"
    FOREIGN KEY ("BusinessProfile_ID")
    REFERENCES "BusinessProfile"("BusinessProfile_ID")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptDuplicateCandidate"
    ADD CONSTRAINT "ReceiptDuplicateCandidate_decision_owner_fkey"
    FOREIGN KEY ("BusinessProfile_ID", "ReceiptDuplicateCandidate_DecidedByUser_ID")
    REFERENCES "BusinessProfile"("BusinessProfile_ID", "User_ID")
    ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptDuplicateCandidate"
    ADD CONSTRAINT "ReceiptDuplicateCandidate_source_scan_fkey"
    FOREIGN KEY ("ReceiptDuplicateCandidate_SourceReceiptScan_ID", "BusinessProfile_ID")
    REFERENCES "ReceiptScan"("ReceiptScan_ID", "BusinessProfile_ID")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptDuplicateCandidate"
    ADD CONSTRAINT "ReceiptDuplicateCandidate_scan_target_fkey"
    FOREIGN KEY ("ReceiptDuplicateCandidate_CandidateReceiptScan_ID", "BusinessProfile_ID")
    REFERENCES "ReceiptScan"("ReceiptScan_ID", "BusinessProfile_ID")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptDuplicateCandidate"
    ADD CONSTRAINT "ReceiptDuplicateCandidate_expense_target_fkey"
    FOREIGN KEY ("ReceiptDuplicateCandidate_CandidateExpenseRecord_ID", "BusinessProfile_ID")
    REFERENCES "ExpenseRecord"("ExpenseRecord_ID", "BusinessProfile_ID")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReceiptCaptureBatch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReceiptDuplicateCandidate" ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE "ReceiptCaptureBatch", "ReceiptDuplicateCandidate" FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SEQUENCE "ReceiptCaptureBatch_ReceiptCaptureBatch_ID_seq" FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SEQUENCE "ReceiptDuplicateCandidate_ReceiptDuplicateCandidate_ID_seq" FROM PUBLIC;

DO $$
DECLARE
    api_role TEXT;
BEGIN
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']
    LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON TABLE "ReceiptCaptureBatch", "ReceiptDuplicateCandidate" FROM %I',
                api_role
            );
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON SEQUENCE "ReceiptCaptureBatch_ReceiptCaptureBatch_ID_seq", "ReceiptDuplicateCandidate_ReceiptDuplicateCandidate_ID_seq" FROM %I',
                api_role
            );
        END IF;
    END LOOP;
END
$$;
