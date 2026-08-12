-- Reading a receipt used to run inline in the HTTP request. It now runs in the
-- background and the client polls, so a scan needs a state of its own that says
-- how far the READ has got — distinct from ReceiptScan_ConfirmationStatus,
-- which is about the owner's decision afterwards. See schema header note 15.
--
-- Additive and defaulted, so this is safe on a database with existing rows.
-- Every scan that already exists was read synchronously and therefore finished
-- before its request returned: backfilling those to 'Complete' is a statement
-- of fact, not an assumption. New rows default to 'Processing' because that is
-- what they genuinely are the moment they are inserted.

ALTER TABLE "ReceiptScan"
  ADD COLUMN "ReceiptScan_ProcessingStatus" VARCHAR(50) NOT NULL DEFAULT 'Processing',
  ADD COLUMN "ReceiptScan_ProcessingError" VARCHAR(500);

UPDATE "ReceiptScan" SET "ReceiptScan_ProcessingStatus" = 'Complete';

-- Per-page photograph quality, which used to ride on the upload response and
-- was never stored. That worked only while the response WAS the finished scan;
-- now that the read completes in the background, anything not written down is
-- lost before the polling client can show it. Nullable throughout: scans read
-- before this column existed genuinely have no measurement, and NULL says that
-- honestly rather than implying a reading of zero.
ALTER TABLE "ReceiptScanPage"
  ADD COLUMN "ReceiptScanPage_Sharpness" DOUBLE PRECISION,
  ADD COLUMN "ReceiptScanPage_Brightness" DOUBLE PRECISION,
  ADD COLUMN "ReceiptScanPage_TooBlurredToTrust" BOOLEAN;
