-- CSV imports no longer have a row limit; the 5 MB file size is the limit.
-- Staged files are stored in chunks of at most 1,000 rows, and a row takes at
-- least one byte, so a 5 MB file (5,242,880 bytes) can never need more than
-- 5,243 chunks. The guard now follows the file-size cap instead of a row cap.
ALTER TABLE "CSVImportStageChunk"
  DROP CONSTRAINT "CSVImportStageChunk_index_check";

ALTER TABLE "CSVImportStageChunk"
  ADD CONSTRAINT "CSVImportStageChunk_index_check"
    CHECK ("CSVImportStageChunk_Index" >= 0 AND "CSVImportStageChunk_Index" < 5243);
