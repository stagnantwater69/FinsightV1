-- One-time codes that carry a confirmed session from the web app into the
-- installed mobile app. See the model comment in schema.prisma for why the
-- code is stored only as a hash and the refresh token only as ciphertext.

-- CreateTable
CREATE TABLE "AuthHandoff" (
    "AuthHandoff_ID" SERIAL NOT NULL,
    "AuthHandoff_CodeHash" VARCHAR(64) NOT NULL,
    "AuthHandoff_User_ID" INTEGER NOT NULL,
    "AuthHandoff_RefreshTokenCipher" VARCHAR(4000) NOT NULL,
    "AuthHandoff_ExpiresAt" TIMESTAMP(3) NOT NULL,
    "AuthHandoff_ConsumedAt" TIMESTAMP(3),
    "AuthHandoff_CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthHandoff_pkey" PRIMARY KEY ("AuthHandoff_ID")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuthHandoff_AuthHandoff_CodeHash_key" ON "AuthHandoff"("AuthHandoff_CodeHash");

-- CreateIndex
CREATE INDEX "AuthHandoff_Expiry_idx" ON "AuthHandoff"("AuthHandoff_ExpiresAt");

-- AddForeignKey
ALTER TABLE "AuthHandoff" ADD CONSTRAINT "AuthHandoff_AuthHandoff_User_ID_fkey" FOREIGN KEY ("AuthHandoff_User_ID") REFERENCES "User"("User_ID") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same deny-all-to-the-Data-API posture as every other application table —
-- see 20260806153854_secure_application_tables_from_data_api. This one holds
-- sealed session material, so it matters more here than anywhere else.
ALTER TABLE public."AuthHandoff" ENABLE ROW LEVEL SECURITY;
