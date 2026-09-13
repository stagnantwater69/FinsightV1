-- AlterTable
ALTER TABLE "ReceiptScan" ADD COLUMN     "ReceiptScan_UploadHash" VARCHAR(64),
ADD COLUMN     "ReceiptScan_UploadKey" VARCHAR(100);

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptScan_ReceiptScan_UploadKey_key" ON "ReceiptScan"("ReceiptScan_UploadKey");
