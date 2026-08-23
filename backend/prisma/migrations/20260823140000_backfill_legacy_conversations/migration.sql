-- Backfill the old per-module Ask FinSight log into real conversations.
--
-- WHY THIS EXISTS. Before conversations, "history" was an implicit query: the
-- last N AIInteraction rows for (user, business profile, module). Those rows
-- were never deleted, but the drawer now reads Conversation/ChatMessage, so
-- from the owner's side their entire question history silently vanished. The
-- original plan was to leave the old rows alone; seeing an empty Chat History
-- after months of use is what changed it.
--
-- WHAT IT PRODUCES. One conversation per (user, business profile, module) that
-- actually has interactions, holding that module's whole log oldest-first.
--
-- WHY ONE PER MODULE RATHER THAN ONE PER TOPIC. The old data has no thread
-- boundaries — nothing recorded where one line of enquiry ended and the next
-- began — so any finer split would be invented. A module bucket is the only
-- grouping the source data actually supports.
--
-- WHY THE TITLE IS A LABEL, NOT THE FIRST QUESTION. Deriving it the way a new
-- conversation does would put one question's words on a thread that may cover
-- six unrelated ones asked across three weeks, which reads as a conversation
-- about something it is not. "Earlier Dashboard questions" is honest about
-- being an archive.
--
-- NOT DESTRUCTIVE. The AIInteraction rows are left exactly as they are. Mobile
-- still reads them through /ai/ask and /ai/history, which are unchanged, so an
-- owner's history is now reachable from both clients rather than moved from one
-- to the other.

-- One conversation per module that has history.
--
-- Timestamps come from the source rows (MIN/MAX) rather than now(), so a thread
-- last touched in June lands under "Older" instead of pretending to be today's.
-- The NOT EXISTS guard makes this safe to re-run against a database where it has
-- already been applied by hand.
INSERT INTO "Conversation" (
  "User_ID",
  "BusinessProfile_ID",
  "Conversation_Title",
  "Conversation_OriginModule",
  "Conversation_DateCreated",
  "Conversation_LastMessageAt"
)
SELECT
  i."User_ID",
  i."BusinessProfile_ID",
  -- Module is VARCHAR(50), so this is at most 68 characters against a 120 cap.
  'Earlier ' || i."Interaction_Module" || ' questions',
  i."Interaction_Module",
  MIN(i."Interaction_Timestamp"),
  MAX(i."Interaction_Timestamp")
FROM "AIInteraction" i
WHERE NOT EXISTS (
  SELECT 1 FROM "Conversation" c
  WHERE c."User_ID" = i."User_ID"
    AND c."BusinessProfile_ID" = i."BusinessProfile_ID"
    AND c."Conversation_Title" = 'Earlier ' || i."Interaction_Module" || ' questions'
)
GROUP BY i."User_ID", i."BusinessProfile_ID", i."Interaction_Module";

-- Both halves of every exchange, as the two messages they always were.
--
-- The assistant reply is stamped one millisecond after its question so that
-- ordering by timestamp cannot interleave a reply ahead of what it answered —
-- the source schema stored a single timestamp for the pair, which is ambiguous
-- the moment they become separate rows.
--
-- LEFT(...) guards the 2000-character column: Interaction_Question is capped at
-- 500 and Interaction_AIResponse at 1000, so neither can actually overflow, but
-- a widened source column should not turn this into a failed deploy.
--
-- The join carries the title predicate so this can only ever attach to the
-- archive conversation created above, never to a real one the owner has since
-- started from the same module.
INSERT INTO "ChatMessage" (
  "Conversation_ID",
  "Message_Role",
  "Message_Content",
  "Message_Timestamp"
)
SELECT
  c."Conversation_ID",
  'user',
  LEFT(i."Interaction_Question", 2000),
  i."Interaction_Timestamp"
FROM "AIInteraction" i
JOIN "Conversation" c
  ON  c."User_ID" = i."User_ID"
  AND c."BusinessProfile_ID" = i."BusinessProfile_ID"
  AND c."Conversation_OriginModule" = i."Interaction_Module"
  AND c."Conversation_Title" = 'Earlier ' || i."Interaction_Module" || ' questions'
WHERE NOT EXISTS (
  SELECT 1 FROM "ChatMessage" m WHERE m."Conversation_ID" = c."Conversation_ID"
)

UNION ALL

SELECT
  c."Conversation_ID",
  'assistant',
  LEFT(i."Interaction_AIResponse", 2000),
  i."Interaction_Timestamp" + INTERVAL '1 millisecond'
FROM "AIInteraction" i
JOIN "Conversation" c
  ON  c."User_ID" = i."User_ID"
  AND c."BusinessProfile_ID" = i."BusinessProfile_ID"
  AND c."Conversation_OriginModule" = i."Interaction_Module"
  AND c."Conversation_Title" = 'Earlier ' || i."Interaction_Module" || ' questions'
WHERE NOT EXISTS (
  SELECT 1 FROM "ChatMessage" m WHERE m."Conversation_ID" = c."Conversation_ID"
);
