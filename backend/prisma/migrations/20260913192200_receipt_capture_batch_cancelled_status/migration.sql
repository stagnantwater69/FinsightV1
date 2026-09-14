ALTER TYPE "ReceiptCaptureBatchStatus" ADD VALUE 'CANCELLED';

ALTER TABLE "ReceiptCaptureBatch"
DROP CONSTRAINT "ReceiptCaptureBatch_finished_check",
ADD CONSTRAINT "ReceiptCaptureBatch_finished_check" CHECK (
    (
        "ReceiptCaptureBatch_Status"::text IN ('COMPLETE', 'CANCELLED')
        AND "ReceiptCaptureBatch_FinishedAt" IS NOT NULL
    )
    OR (
        "ReceiptCaptureBatch_Status"::text NOT IN ('COMPLETE', 'CANCELLED')
        AND "ReceiptCaptureBatch_FinishedAt" IS NULL
    )
);
