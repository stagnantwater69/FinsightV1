-- MAX_IMPORT_ROWS rose from 30,000 to 100,000. Staged files are stored in
-- chunks of at most 1,000 rows (STAGE_CHUNK_ROWS), so the chunk-index bound
-- moves from 30 to 100 with it. It stays a database-side guard: a staged file
-- larger than the application allows still cannot be written.
ALTER TABLE "CSVImportStageChunk"
  DROP CONSTRAINT "CSVImportStageChunk_index_check";

ALTER TABLE "CSVImportStageChunk"
  ADD CONSTRAINT "CSVImportStageChunk_index_check"
    CHECK ("CSVImportStageChunk_Index" >= 0 AND "CSVImportStageChunk_Index" < 100);
