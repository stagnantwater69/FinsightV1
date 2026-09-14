CREATE TYPE "ReceiptCaptureBatchStatus" AS ENUM (
    'COLLECTING',
    'PROCESSING',
    'READY_FOR_REVIEW',
    'PARTIAL_FAILURE',
    'FAILED',
    'COMPLETE'
);

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

ALTER TABLE "ReceiptScan"
    ADD COLUMN "ReceiptCaptureBatch_ID" INTEGER,
    ADD COLUMN "ReceiptScan_ReceiptOrdinal" INTEGER,
    ADD COLUMN "ReceiptScan_ScanRevision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "ReceiptScan"
    ADD CONSTRAINT "ReceiptScan_scan_revision_check" CHECK (
        "ReceiptScan_ScanRevision" >= 0
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

CREATE INDEX "ReceiptCaptureBatch_profile_created_idx"
    ON "ReceiptCaptureBatch"(
        "BusinessProfile_ID",
        "ReceiptCaptureBatch_CreatedAt",
        "ReceiptCaptureBatch_ID"
    );

CREATE UNIQUE INDEX "ReceiptCaptureBatch_profile_client_key"
    ON "ReceiptCaptureBatch"("BusinessProfile_ID", "ReceiptCaptureBatch_ClientBatchKey");

CREATE UNIQUE INDEX "ReceiptCaptureBatch_ID_BusinessProfile_ID_key"
    ON "ReceiptCaptureBatch"("ReceiptCaptureBatch_ID", "BusinessProfile_ID");

CREATE UNIQUE INDEX "ReceiptScan_batch_ordinal_key"
    ON "ReceiptScan"("ReceiptCaptureBatch_ID", "ReceiptScan_ReceiptOrdinal");

ALTER TABLE "ReceiptCaptureBatch"
    ADD CONSTRAINT "ReceiptCaptureBatch_BusinessProfile_ID_fkey"
    FOREIGN KEY ("BusinessProfile_ID")
    REFERENCES "BusinessProfile"("BusinessProfile_ID")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReceiptScan"
    ADD CONSTRAINT "ReceiptScan_ReceiptCaptureBatch_ID_BusinessProfile_ID_fkey"
    FOREIGN KEY ("ReceiptCaptureBatch_ID", "BusinessProfile_ID")
    REFERENCES "ReceiptCaptureBatch"("ReceiptCaptureBatch_ID", "BusinessProfile_ID")
    ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "ReceiptCaptureBatch" ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE "ReceiptCaptureBatch" FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SEQUENCE "ReceiptCaptureBatch_ReceiptCaptureBatch_ID_seq" FROM PUBLIC;

DO $$
DECLARE
    api_role TEXT;
BEGIN
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']
    LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON TABLE "ReceiptCaptureBatch" FROM %I',
                api_role
            );
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON SEQUENCE "ReceiptCaptureBatch_ReceiptCaptureBatch_ID_seq" FROM %I',
                api_role
            );
        END IF;
    END LOOP;
END
$$;
