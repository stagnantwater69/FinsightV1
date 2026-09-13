-- AlterTable
ALTER TABLE "ReceiptScan"
    ADD COLUMN "ReceiptScan_SourceImageHash" CHAR(64);

ALTER TABLE "ReceiptScan"
    ADD CONSTRAINT "ReceiptScan_source_image_hash_check" CHECK (
        "ReceiptScan_SourceImageHash" IS NULL
        OR "ReceiptScan_SourceImageHash" ~ '^[0-9a-f]{64}$'
    );

-- CreateIndex
CREATE INDEX "ReceiptScan_profile_source_image_hash_idx"
    ON "ReceiptScan"("BusinessProfile_ID", "ReceiptScan_SourceImageHash");
