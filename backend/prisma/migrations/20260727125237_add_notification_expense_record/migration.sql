-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "ExpenseRecord_ID" INTEGER;

-- CreateIndex
CREATE INDEX "Notification_ExpenseRecord_ID_idx" ON "Notification"("ExpenseRecord_ID");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_ExpenseRecord_ID_fkey" FOREIGN KEY ("ExpenseRecord_ID") REFERENCES "ExpenseRecord"("ExpenseRecord_ID") ON DELETE SET NULL ON UPDATE CASCADE;
