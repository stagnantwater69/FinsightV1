-- One receipt may now produce several expense records (one per category the
-- receipt covers), so the 1:1 constraint becomes a plain index.

-- DropIndex
DROP INDEX "ExpenseRecord_ReceiptScan_ID_key";

-- CreateIndex
CREATE INDEX "ExpenseRecord_ReceiptScan_ID_idx" ON "ExpenseRecord"("ReceiptScan_ID");
