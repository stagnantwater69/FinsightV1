-- CreateTable
CREATE TABLE "VeryfiUsage" (
    "VeryfiUsage_Month" VARCHAR(7) NOT NULL,
    "VeryfiUsage_Count" INTEGER NOT NULL DEFAULT 0,
    "VeryfiUsage_UpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VeryfiUsage_pkey" PRIMARY KEY ("VeryfiUsage_Month")
);

-- Same deny-all-to-the-Data-API posture as every other application table —
-- see 20260806153854_secure_application_tables_from_data_api. The revoked
-- default privileges from that migration already cover future tables, but
-- RLS is enabled explicitly here too, matching every table listed there.
ALTER TABLE public."VeryfiUsage" ENABLE ROW LEVEL SECURITY;
