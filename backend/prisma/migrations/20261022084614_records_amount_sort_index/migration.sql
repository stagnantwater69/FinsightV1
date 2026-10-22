-- CreateIndex
CREATE INDEX "ExpenseRecord_profile_amount_id_idx" ON "ExpenseRecord"("BusinessProfile_ID", "ExpenseRecord_Amount", "ExpenseRecord_ID");

-- CreateIndex
CREATE INDEX "SalesReferenceRecord_profile_amount_id_idx" ON "SalesReferenceRecord"("BusinessProfile_ID", "SalesReferenceRecord_Amount", "SalesReferenceRecord_ID");

