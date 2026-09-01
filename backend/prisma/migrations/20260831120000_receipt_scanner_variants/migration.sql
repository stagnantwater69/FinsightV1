ALTER TABLE "ReceiptScan"
  ADD COLUMN "ReceiptScan_ReceiptLikelihood" JSONB;

ALTER TABLE "ReceiptScanPage"
  ADD COLUMN "ReceiptScanPage_ProcessedImageFile" VARCHAR(255),
  ADD COLUMN "ReceiptScanPage_CaptureMetadata" JSONB,
  ADD COLUMN "ReceiptScanPage_OcrSource" VARCHAR(20) NOT NULL DEFAULT 'original',
  ADD COLUMN "ReceiptScanPage_OriginalRawText" TEXT,
  ADD COLUMN "ReceiptScanPage_OriginalOcrConfidence" INTEGER,
  ADD COLUMN "ReceiptScanPage_ProcessedRawText" TEXT,
  ADD COLUMN "ReceiptScanPage_ProcessedOcrConfidence" INTEGER;
