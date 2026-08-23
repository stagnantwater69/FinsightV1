-- Named AI chat threads for the web AI Chat page.
--
-- Additive only. AIInteraction is untouched and no row is migrated into these
-- tables: mobile's Ask FinSight still reads the per-module log verbatim, and
-- the two have different semantics (an append-only log versus a conversation
-- entity with a title, a lifetime and an owner-visible delete). Conversation
-- history therefore starts empty for existing users, by design.

-- CreateTable
CREATE TABLE "Conversation" (
    "Conversation_ID" SERIAL NOT NULL,
    "User_ID" INTEGER NOT NULL,
    "BusinessProfile_ID" INTEGER NOT NULL,
    "Conversation_Title" VARCHAR(120) NOT NULL,
    "Conversation_OriginModule" VARCHAR(50) NOT NULL,
    "Conversation_DateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "Conversation_LastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("Conversation_ID")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "Message_ID" SERIAL NOT NULL,
    "Conversation_ID" INTEGER NOT NULL,
    "Message_Role" VARCHAR(10) NOT NULL,
    "Message_Content" VARCHAR(2000) NOT NULL,
    "Message_Timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("Message_ID")
);

-- CreateIndex
-- The sidebar's only query: this owner's threads for the active profile,
-- newest activity first.
CREATE INDEX "Conversation_User_ID_BusinessProfile_ID_Conversation_LastMe_idx" ON "Conversation"("User_ID", "BusinessProfile_ID", "Conversation_LastMessageAt");

-- CreateIndex
CREATE INDEX "ChatMessage_Conversation_ID_Message_Timestamp_idx" ON "ChatMessage"("Conversation_ID", "Message_Timestamp");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_User_ID_fkey" FOREIGN KEY ("User_ID") REFERENCES "User"("User_ID") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_BusinessProfile_ID_fkey" FOREIGN KEY ("BusinessProfile_ID") REFERENCES "BusinessProfile"("BusinessProfile_ID") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Cascade is what makes deleting a conversation a single statement.
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_Conversation_ID_fkey" FOREIGN KEY ("Conversation_ID") REFERENCES "Conversation"("Conversation_ID") ON DELETE CASCADE ON UPDATE CASCADE;

-- Deny-all posture for the new tables, matching every other application table
-- (see 20260806153854_secure_application_tables_from_data_api). All access goes
-- through the Express/Prisma connection; the Supabase Data API roles get
-- nothing. Guarded because those roles do not exist in the local test container.
ALTER TABLE public."Conversation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ChatMessage" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public."Conversation" FROM anon;
    REVOKE ALL ON TABLE public."ChatMessage" FROM anon;
    REVOKE ALL ON SEQUENCE public."Conversation_Conversation_ID_seq" FROM anon;
    REVOKE ALL ON SEQUENCE public."ChatMessage_Message_ID_seq" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public."Conversation" FROM authenticated;
    REVOKE ALL ON TABLE public."ChatMessage" FROM authenticated;
    REVOKE ALL ON SEQUENCE public."Conversation_Conversation_ID_seq" FROM authenticated;
    REVOKE ALL ON SEQUENCE public."ChatMessage_Message_ID_seq" FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON TABLE public."Conversation" TO service_role;
    GRANT ALL ON TABLE public."ChatMessage" TO service_role;
    GRANT USAGE, SELECT ON SEQUENCE public."Conversation_Conversation_ID_seq" TO service_role;
    GRANT USAGE, SELECT ON SEQUENCE public."ChatMessage_Message_ID_seq" TO service_role;
  END IF;
END $$;
