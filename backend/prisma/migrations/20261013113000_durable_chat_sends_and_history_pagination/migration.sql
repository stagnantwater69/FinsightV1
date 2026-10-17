CREATE TYPE "ChatSendRequestStatus" AS ENUM ('PROCESSING', 'COMPLETE', 'FAILED');

CREATE TABLE "ChatSendRequest" (
    "ChatSendRequest_KeyHash" CHAR(64) NOT NULL,
    "ChatSendRequest_InputHash" CHAR(64) NOT NULL,
    "BusinessProfile_ID" INTEGER NOT NULL,
    "User_ID" INTEGER NOT NULL,
    "ChatSendRequest_Status" "ChatSendRequestStatus" NOT NULL DEFAULT 'PROCESSING',
    "ChatSendRequest_Response" JSONB,
    "Conversation_ID" INTEGER,
    "Conversation_BusinessProfile_ID" INTEGER,
    "ChatSendRequest_ErrorStatus" INTEGER,
    "ChatSendRequest_ErrorCode" VARCHAR(80),
    "ChatSendRequest_ErrorMessage" VARCHAR(255),
    "ChatSendRequest_CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ChatSendRequest_CompletedAt" TIMESTAMP(3),

    CONSTRAINT "ChatSendRequest_pkey" PRIMARY KEY ("ChatSendRequest_KeyHash")
);

CREATE UNIQUE INDEX "Conversation_ID_BusinessProfile_ID_key" ON "Conversation"("Conversation_ID", "BusinessProfile_ID");
CREATE INDEX "ChatSendRequest_profile_owner_idx" ON "ChatSendRequest"("BusinessProfile_ID", "User_ID");
CREATE INDEX "ChatSendRequest_user_idx" ON "ChatSendRequest"("User_ID");
CREATE INDEX "ChatSendRequest_conversation_idx" ON "ChatSendRequest"("Conversation_ID", "Conversation_BusinessProfile_ID");

ALTER TABLE "Conversation" DROP CONSTRAINT "Conversation_BusinessProfile_ID_fkey";
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_profile_owner_fkey" FOREIGN KEY ("BusinessProfile_ID", "User_ID") REFERENCES "BusinessProfile"("BusinessProfile_ID", "User_ID") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatSendRequest" ADD CONSTRAINT "ChatSendRequest_user_fkey" FOREIGN KEY ("User_ID") REFERENCES "User"("User_ID") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatSendRequest" ADD CONSTRAINT "ChatSendRequest_profile_owner_fkey" FOREIGN KEY ("BusinessProfile_ID", "User_ID") REFERENCES "BusinessProfile"("BusinessProfile_ID", "User_ID") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatSendRequest" ADD CONSTRAINT "ChatSendRequest_conversation_fkey" FOREIGN KEY ("Conversation_ID", "Conversation_BusinessProfile_ID") REFERENCES "Conversation"("Conversation_ID", "BusinessProfile_ID") ON DELETE SET NULL ON UPDATE CASCADE;

-- SetNull keeps a deleted thread's request; populated link pairs must belong to its business.
ALTER TABLE "ChatSendRequest"
    ADD CONSTRAINT "ChatSendRequest_conversation_scope_check" CHECK (
        ("Conversation_ID" IS NULL AND "Conversation_BusinessProfile_ID" IS NULL)
        OR (
            "Conversation_ID" IS NOT NULL
            AND "Conversation_BusinessProfile_ID" IS NOT NULL
            AND "Conversation_BusinessProfile_ID" = "BusinessProfile_ID"
        )
    ),
    ADD CONSTRAINT "ChatSendRequest_state_check" CHECK (
        (
            "ChatSendRequest_Status" = 'PROCESSING'
            AND "ChatSendRequest_Response" IS NULL
            AND "ChatSendRequest_CompletedAt" IS NULL
            AND "ChatSendRequest_ErrorStatus" IS NULL
            AND "ChatSendRequest_ErrorCode" IS NULL
            AND "ChatSendRequest_ErrorMessage" IS NULL
        )
        OR (
            "ChatSendRequest_Status" = 'COMPLETE'
            AND "ChatSendRequest_Response" IS NOT NULL
            AND jsonb_typeof("ChatSendRequest_Response") = 'object'
            AND "ChatSendRequest_CompletedAt" IS NOT NULL
            AND "ChatSendRequest_ErrorStatus" IS NULL
            AND "ChatSendRequest_ErrorCode" IS NULL
            AND "ChatSendRequest_ErrorMessage" IS NULL
        )
        OR (
            "ChatSendRequest_Status" = 'FAILED'
            AND "ChatSendRequest_Response" IS NULL
            AND "ChatSendRequest_CompletedAt" IS NOT NULL
            AND "ChatSendRequest_ErrorStatus" IS NOT NULL
            AND "ChatSendRequest_ErrorStatus" BETWEEN 400 AND 599
            AND "ChatSendRequest_ErrorMessage" IS NOT NULL
        )
    );

-- The ID tail preserves pagination order when messages or activity timestamps are equal.
CREATE INDEX "Conversation_owner_profile_activity_idx" ON "Conversation"("User_ID", "BusinessProfile_ID", "Conversation_LastMessageAt", "Conversation_ID");
DROP INDEX "Conversation_User_ID_BusinessProfile_ID_Conversation_LastMe_idx";
CREATE INDEX "ChatMessage_conversation_created_id_idx" ON "ChatMessage"("Conversation_ID", "Message_Timestamp", "Message_ID");
DROP INDEX "ChatMessage_Conversation_ID_Message_Timestamp_idx";
CREATE INDEX "CSVImportBatch_profile_uploaded_id_idx" ON "CSVImportBatch"("BusinessProfile_ID", "ImportBatch_UploadDate", "ImportBatch_ID");
DROP INDEX "CSVImportBatch_BusinessProfile_ID_idx";

-- Application data stays behind Express/Prisma; no client-role policies are added.
ALTER TABLE public."ChatSendRequest" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public."ChatSendRequest" FROM PUBLIC;

DO $$
DECLARE
    api_role TEXT;
BEGIN
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']
    LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON TABLE public."ChatSendRequest" FROM %I',
                api_role
            );
        END IF;
    END LOOP;
END
$$;
