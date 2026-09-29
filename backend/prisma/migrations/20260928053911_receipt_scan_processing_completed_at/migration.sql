-- Existing scans stay NULL because their actual terminal transition time is unknown.
ALTER TABLE "ReceiptScan" ADD COLUMN     "ReceiptScan_ProcessingCompletedAt" TIMESTAMP(3);
