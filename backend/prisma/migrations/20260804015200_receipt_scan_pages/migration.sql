-- A long receipt is now several pages of one scan rather than several
-- unrelated scans. ReceiptScan.imageFile stays the page-1 cover — every
-- existing caller (signed URLs, the origin panels, source cleanup) keeps
-- working unchanged — and this table holds every page, including the first.
--
-- Backfilled from ReceiptScan.imageFile as page 1 of every existing scan, so
-- the invariant "every scan has at least one ReceiptScanPage row" holds from
-- this migration onward with no special case for scans taken before it.
-- rawText and ocrConfidence are copied across too: they already describe the
-- one photograph an old scan has, so the per-page columns can carry the same
-- values rather than starting NULL for every historical row.

CREATE TABLE "ReceiptScanPage" (
    "ReceiptScanPage_ID" SERIAL NOT NULL,
    "ReceiptScan_ID" INTEGER NOT NULL,
    "ReceiptScanPage_Number" INTEGER NOT NULL,
    "ReceiptScanPage_ImageFile" VARCHAR(255) NOT NULL,
    "ReceiptScanPage_RawText" TEXT,
    "ReceiptScanPage_OcrConfidence" INTEGER,

    CONSTRAINT "ReceiptScanPage_pkey" PRIMARY KEY ("ReceiptScanPage_ID")
);

CREATE UNIQUE INDEX "ReceiptScanPage_ReceiptScan_ID_ReceiptScanPage_Number_key" ON "ReceiptScanPage"("ReceiptScan_ID", "ReceiptScanPage_Number");

CREATE INDEX "ReceiptScanPage_ReceiptScan_ID_idx" ON "ReceiptScanPage"("ReceiptScan_ID");

ALTER TABLE "ReceiptScanPage" ADD CONSTRAINT "ReceiptScanPage_ReceiptScan_ID_fkey" FOREIGN KEY ("ReceiptScan_ID") REFERENCES "ReceiptScan"("ReceiptScan_ID") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "ReceiptScanPage" ("ReceiptScan_ID", "ReceiptScanPage_Number", "ReceiptScanPage_ImageFile", "ReceiptScanPage_RawText", "ReceiptScanPage_OcrConfidence")
SELECT "ReceiptScan_ID", 1, "ReceiptScan_ImageFile", "ReceiptScan_RawText", "ReceiptScan_OcrConfidence"
FROM "ReceiptScan";
