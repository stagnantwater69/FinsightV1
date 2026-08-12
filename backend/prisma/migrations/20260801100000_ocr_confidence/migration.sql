-- How sure the OCR engine was, recorded so the confirm screen can say which
-- figure it doubts rather than asking the owner to check everything equally.
--
-- Additive and nullable, so this is safe on a database with existing rows:
-- nothing is rewritten and no existing query changes meaning. Existing scans
-- correctly get NULL — the confidence was never captured for them, and NULL
-- means "not measured", which is a different thing from a low score.

ALTER TABLE "ReceiptScan" ADD COLUMN "ReceiptScan_OcrConfidence" INTEGER;
ALTER TABLE "ReceiptScanItem" ADD COLUMN "ReceiptScanItem_AmountConfidence" INTEGER;
