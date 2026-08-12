-- CreateTable
CREATE TABLE "ReceiptScanItem" (
    "ReceiptScanItem_ID" SERIAL NOT NULL,
    "ReceiptScan_ID" INTEGER NOT NULL,
    "Category_ID" INTEGER,
    "ExpenseRecord_ID" INTEGER,
    "ReceiptScanItem_LineNumber" INTEGER NOT NULL,
    "ReceiptScanItem_Name" VARCHAR(255) NOT NULL,
    "ReceiptScanItem_Quantity" DECIMAL(10,2),
    "ReceiptScanItem_UnitPrice" DECIMAL(12,2),
    "ReceiptScanItem_Amount" DECIMAL(12,2) NOT NULL,
    "ReceiptScanItem_CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceiptScanItem_pkey" PRIMARY KEY ("ReceiptScanItem_ID")
);

-- CreateIndex
CREATE INDEX "ReceiptScanItem_ReceiptScan_ID_idx" ON "ReceiptScanItem"("ReceiptScan_ID");
CREATE INDEX "ReceiptScanItem_ExpenseRecord_ID_idx" ON "ReceiptScanItem"("ExpenseRecord_ID");
CREATE INDEX "ReceiptScanItem_Category_ID_idx" ON "ReceiptScanItem"("Category_ID");

-- AddForeignKey
ALTER TABLE "ReceiptScanItem" ADD CONSTRAINT "ReceiptScanItem_ReceiptScan_ID_fkey" FOREIGN KEY ("ReceiptScan_ID") REFERENCES "ReceiptScan"("ReceiptScan_ID") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReceiptScanItem" ADD CONSTRAINT "ReceiptScanItem_Category_ID_fkey" FOREIGN KEY ("Category_ID") REFERENCES "ExpenseCategory"("Category_ID") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReceiptScanItem" ADD CONSTRAINT "ReceiptScanItem_ExpenseRecord_ID_fkey" FOREIGN KEY ("ExpenseRecord_ID") REFERENCES "ExpenseRecord"("ExpenseRecord_ID") ON DELETE SET NULL ON UPDATE CASCADE;
