-- Keyword search on the records list is `description ILIKE '%term%'`, which a
-- b-tree cannot serve: at 500,000 records it scanned the business's whole
-- ledger (~266 ms, backend/tests/load/query-plans.ts). A pg_trgm GIN index can.
--
-- Where the extension goes: Supabase keeps extensions in its `extensions`
-- schema, so their functions are not exposed through the Data API's public
-- schema; plain Postgres (local, CI) has no such schema and uses the default.
-- The operator class is then named through whichever schema pg_trgm actually
-- lives in, so this does not depend on the migration session's search_path.
DO $$
DECLARE
  trgm_schema text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions') THEN
      CREATE EXTENSION pg_trgm WITH SCHEMA extensions;
    ELSE
      CREATE EXTENSION pg_trgm;
    END IF;
  END IF;

  SELECT n.nspname INTO trgm_schema
  FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'pg_trgm';

  EXECUTE format(
    'CREATE INDEX "ExpenseRecord_description_trgm_idx" ON "ExpenseRecord" USING GIN ("ExpenseRecord_Description" %I.gin_trgm_ops)',
    trgm_schema
  );
  EXECUTE format(
    'CREATE INDEX "SalesReferenceRecord_description_trgm_idx" ON "SalesReferenceRecord" USING GIN ("SalesReferenceRecord_Description" %I.gin_trgm_ops)',
    trgm_schema
  );
END $$;
