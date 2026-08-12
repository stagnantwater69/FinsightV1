-- Provenance for receipts a vision model interpreted.
--
-- Both columns are additive with a FALSE default, so this is safe to apply to
-- a database with existing rows: nothing is rewritten, and the default
-- backfills correctly because every scan and item that already exists was
-- produced by the deterministic OCR path.
--
-- These exist so the confirm screen can distinguish a value FinSight READ
-- from one it GUESSED from a photograph. Losing that distinction is the whole
-- risk of using a model for extraction, so it is stored rather than inferred.

-- The deterministic parse came back empty and the photo was interpreted by a
-- vision model instead.
ALTER TABLE "ReceiptScan" ADD COLUMN "ReceiptScan_VisionAssisted" BOOLEAN NOT NULL DEFAULT false;

-- This specific line came from that vision read, not from OCR text.
-- Parallel to ReceiptScanItem_AddedByOwner.
ALTER TABLE "ReceiptScanItem" ADD COLUMN "ReceiptScanItem_ExtractedByVision" BOOLEAN NOT NULL DEFAULT false;
