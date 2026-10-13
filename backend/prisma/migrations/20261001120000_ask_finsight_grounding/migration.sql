-- Ask FinSight grounding: the flag/record a conversation is about, the
-- server-resolved links and actions under each reply, and owner feedback.
-- Additive and nullable: existing rows are untouched and need no backfill.
ALTER TABLE "Conversation" ADD COLUMN "Conversation_Focus" JSONB;

ALTER TABLE "ChatMessage" ADD COLUMN "Message_Metadata" JSONB;
ALTER TABLE "ChatMessage" ADD COLUMN "Message_Feedback" VARCHAR(10);
ALTER TABLE "ChatMessage" ADD COLUMN "Message_FeedbackAt" TIMESTAMP(3);

ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_Message_Feedback_check"
  CHECK ("Message_Feedback" IS NULL OR "Message_Feedback" IN ('up', 'down'));
