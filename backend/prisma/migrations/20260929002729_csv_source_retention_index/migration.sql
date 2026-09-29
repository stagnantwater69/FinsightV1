-- CreateIndex
CREATE INDEX "CSVImportBatch_retention_idx" ON "CSVImportBatch"("ImportBatch_ProcessingStatus", "ImportBatch_CompletedAt");
