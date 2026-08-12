-- Keep application tables inaccessible through Supabase's public Data API.
-- The backend connects with the postgres role, which bypasses RLS, while
-- browser and mobile clients use Supabase only for Auth.

ALTER TABLE public."_prisma_migrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."BusinessProfile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ExpenseCategory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ExpenseRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."SalesReferenceRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ReceiptScan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."CSVImportBatch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."AIInteraction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ReceiptScanItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ReceiptScanPage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ReceiptFieldCorrection" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I',
        api_role
      );
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I',
        api_role
      );

      -- Supabase projects grant Data API access to new public objects by
      -- default. Remove those defaults for all future Prisma migrations too.
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM %I',
        api_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END
$$;
