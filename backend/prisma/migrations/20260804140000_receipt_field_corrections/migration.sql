-- What FinSight read, against what the owner confirmed.
--
-- The confirm screen is the only place this app gets a human answer to "was
-- that extraction right", and until now the answer was discarded the moment it
-- was given: the owner's edits went to ExpenseRecord and the reading stayed on
-- ReceiptScan, with nothing recording that the two disagreed. This table is
-- that record.
--
-- A row is written for every reviewed field, not only for edited ones. Edits
-- alone are a numerator with no denominator — and the low-confidence-but-
-- correct case, which says the THRESHOLD is wrong rather than the extraction,
-- leaves no trace at all when nothing was edited.
--
-- Additive: no existing table is rewritten, no existing query changes meaning.
-- There is deliberately NO backfill. The reading and the owner's final values
-- both still exist for past scans, so a backfill looks possible, but it would
-- be wrong: ReceiptScanItem.Category_ID is OVERWRITTEN with the owner's choice
-- at confirmation, so for every scan already confirmed the categoriser's
-- original pick is gone. Reconstructing rows from what survives would silently
-- record "the AI agreed with the owner" for every historical item, which is
-- the one answer we know we cannot verify. Measurement starts from today.

CREATE TABLE "ReceiptFieldCorrection" (
    "ReceiptFieldCorrection_ID" SERIAL NOT NULL,
    "ReceiptScan_ID" INTEGER NOT NULL,
    "ReceiptFieldCorrection_LineNumber" INTEGER,
    "ReceiptFieldCorrection_Field" VARCHAR(30) NOT NULL,
    "ReceiptFieldCorrection_Source" VARCHAR(20) NOT NULL,
    "ReceiptFieldCorrection_OriginalValue" VARCHAR(255),
    "ReceiptFieldCorrection_FinalValue" VARCHAR(255),
    "ReceiptFieldCorrection_ItemName" VARCHAR(255),
    "ReceiptFieldCorrection_Confidence" INTEGER,
    "ReceiptFieldCorrection_WasEdited" BOOLEAN NOT NULL,
    "ReceiptFieldCorrection_CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceiptFieldCorrection_pkey" PRIMARY KEY ("ReceiptFieldCorrection_ID")
);

CREATE INDEX "ReceiptFieldCorrection_ReceiptScan_ID_idx" ON "ReceiptFieldCorrection"("ReceiptScan_ID");

-- The two axes every report groups by: which field, and over what period.
CREATE INDEX "ReceiptFieldCorrection_ReceiptFieldCorrection_Field_idx" ON "ReceiptFieldCorrection"("ReceiptFieldCorrection_Field");
CREATE INDEX "ReceiptFieldCorrection_ReceiptFieldCorrection_CreatedAt_idx" ON "ReceiptFieldCorrection"("ReceiptFieldCorrection_CreatedAt");

-- This table contains owner-confirmed transaction details and lives in the
-- public schema. It is consumed only by the server through Prisma, not by the
-- Supabase Data API, so expose no rows to API roles even if project-level Data
-- API settings grant access to newly created public tables.
ALTER TABLE "ReceiptFieldCorrection" ENABLE ROW LEVEL SECURITY;

-- Cascade, so deleting a receipt also deletes what we recorded about it.
-- Keeping these as orphaned rows would preserve the accuracy figures at the
-- cost of an owner's deletion not actually deleting — not a trade this app
-- makes for a percentage point.
ALTER TABLE "ReceiptFieldCorrection" ADD CONSTRAINT "ReceiptFieldCorrection_ReceiptScan_ID_fkey" FOREIGN KEY ("ReceiptScan_ID") REFERENCES "ReceiptScan"("ReceiptScan_ID") ON DELETE CASCADE ON UPDATE CASCADE;

-- Per-field confidence for the two receipt-level fields that have one.
-- ReceiptScan_OcrConfidence is the whole-scan figure and cannot answer "is
-- confidence well calibrated for VENDOR" — one number per scan says nothing
-- about which field on it was doubtful. Both values were already computed by
-- confidenceForValue during the scan; they were simply never persisted.
ALTER TABLE "ReceiptScan" ADD COLUMN "ReceiptScan_VendorConfidence" INTEGER;
ALTER TABLE "ReceiptScan" ADD COLUMN "ReceiptScan_AmountConfidence" INTEGER;
