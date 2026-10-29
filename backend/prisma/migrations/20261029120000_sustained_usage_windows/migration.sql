-- CreateTable
CREATE TABLE "SustainedUsageWindow" (
    "SustainedUsageWindow_Key" VARCHAR(255) NOT NULL,
    "SustainedUsageWindow_WindowExpiresAt" TIMESTAMP(3) NOT NULL,
    "SustainedUsageWindow_Count" INTEGER NOT NULL,
    "SustainedUsageWindow_RecordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SustainedUsageWindow_pkey" PRIMARY KEY ("SustainedUsageWindow_Key","SustainedUsageWindow_WindowExpiresAt")
);

-- CreateIndex
CREATE INDEX "SustainedUsageWindow_SustainedUsageWindow_WindowExpiresAt_idx" ON "SustainedUsageWindow"("SustainedUsageWindow_WindowExpiresAt");

-- Application tables are accessible through Express/Prisma only; no client-role policies or grants.
ALTER TABLE public."SustainedUsageWindow" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public."SustainedUsageWindow" FROM PUBLIC;

DO $$
DECLARE
    api_role TEXT;
BEGIN
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']
    LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON TABLE public."SustainedUsageWindow" FROM %I',
                api_role
            );
        END IF;
    END LOOP;
END
$$;
