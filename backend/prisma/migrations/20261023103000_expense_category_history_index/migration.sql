-- CreateIndex
CREATE INDEX "ExpenseRecord_profile_category_date_id_idx" ON "ExpenseRecord"("BusinessProfile_ID", "Category_ID", "ExpenseRecord_Date", "ExpenseRecord_ID");
