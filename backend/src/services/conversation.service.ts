import { ChatSendRequestStatus, Prisma, type ChatMessage, type ChatSendRequest, type Conversation } from "@prisma/client";
import { prisma } from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import { requireOwnedBusinessProfile } from "../lib/ownership";
import { dateCursorScope, datePageSize, decodeDateCursor, finishDatePage, invalidDateCursor, type DatePageInput } from "../lib/datePagination";
import { chatSendIdentity, chatSendKeyHash, checkChatSendReplay, claimChatSendRequest, completeChatSendRequest, deletedChatSend, findChatSendRequest, resolveChatSendFailure, storedChatSendError, type ChatSendError, type ChatSendIdentity } from "../lib/chatSendRequest";
import { buildModuleContext, type ChatFocus, type InteractionModule } from "./aiContext.service";
import { askFinSight, HISTORY_TURNS_FOR_CONTEXT, truncateAnswer, type ConversationTurn } from "./ai.service";
import { groundAnswer, type AnswerMetadata } from "./aiAnswer.service";
import type { ReductionOpportunity } from "./reductionOpportunity.service";

/*
 * Named chat threads for the web AI Chat page.
 *
 * Deliberately a separate service from ai.service's askAndRecord rather than a
 * flag on it: that path is the per-module append-only log mobile still reads
 * byte-for-byte, and threading a "which conversation is this" parameter through
 * it would put the two lifetimes in one function. What IS shared is everything
 * that matters — the model call (askFinSight), the context builder
 * (buildModuleContext), the number of turns replayed and the truncation guard
 * are imported from ai.service, not re-implemented here.
 *
 * OWNERSHIP: every read and write below is scoped to the authenticated userId
 * AND validated against the business profile, exactly as ai.service.getHistory
 * does. Another owner's conversation id is a 404 — never a 403 with a body,
 * which would confirm the row exists.
 */

/** Matches Conversation_Title VARCHAR(120). */
export const TITLE_MAX_LENGTH = 120;

/**
 * Matches Message_Content VARCHAR(2000).
 *
 * Wider than AIInteraction's 1000 because one column now holds both halves of
 * an exchange. Questions are capped at 500 by the zod schema before they reach
 * here; answers come from a model that cannot be told "no", so they get the
 * same sentence-boundary truncation the module log applies.
 */
export const MESSAGE_MAX_LENGTH = 2000;

/** Default page size for the sidebar list. */
const DEFAULT_LIST_LIMIT = 50;

export interface ConversationSummaryDTO {
  id: number;
  title: string;
  originModule: string;
  createdAt: Date;
  lastMessageAt: Date;
}

export interface ChatMessageDTO {
  id: number;
  role: string;
  content: string;
  createdAt: Date;
  /** Assistant replies only; null on user messages and on replies stored before it existed. */
  metadata: AnswerMetadata | null;
  feedback: "up" | "down" | null;
}

export interface ChatSendResult {
  conversation: ConversationSummaryDTO;
  userMessage: ChatMessageDTO;
  assistantMessage: ChatMessageDTO;
  provider: "gemini" | "openrouter" | "unavailable";
  detectedAmount: number | null;
}

export interface ChatSendStatusDTO {
  status: "PROCESSING" | "COMPLETE" | "FAILED" | "DELETED";
  result: ChatSendResult | null;
  error: ChatSendError | null;
  createdAt: Date;
  completedAt: Date | null;
}

function restoredChatSendResult(request: ChatSendRequest): ChatSendResult {
  const stored = request.response as unknown as ChatSendResult;
  return {
    ...stored,
    conversation: {
      ...stored.conversation,
      createdAt: new Date(String(stored.conversation.createdAt)),
      lastMessageAt: new Date(String(stored.conversation.lastMessageAt)),
    },
    userMessage: { ...stored.userMessage, createdAt: new Date(String(stored.userMessage.createdAt)) },
    assistantMessage: { ...stored.assistantMessage, createdAt: new Date(String(stored.assistantMessage.createdAt)) },
  };
}

function replayChatSend(request: ChatSendRequest, identity: ChatSendIdentity): ChatSendResult {
  checkChatSendReplay(request, identity);
  return restoredChatSendResult(request);
}

async function runChatSendOutcome(identity: ChatSendIdentity | undefined, run: () => Promise<ChatSendResult>): Promise<ChatSendResult> {
  try {
    return await run();
  } catch (error) {
    if (!identity) throw error;
    return replayChatSend(await resolveChatSendFailure(identity, error), identity);
  }
}

export async function getChatSendStatus(userId: number, businessProfileId: number, key: string): Promise<ChatSendStatusDTO> {
  await requireOwnedBusinessProfile(userId, businessProfileId);
  const request = await prisma.chatSendRequest.findFirst({
    where: { keyHash: chatSendKeyHash(userId, businessProfileId, key), userId, businessProfileId },
  });
  if (!request) throw new ApiError(404, "Message request not found");
  const common = { createdAt: request.createdAt, completedAt: request.completedAt };
  if (request.status === ChatSendRequestStatus.COMPLETE) {
    if (request.conversationId === null) {
      return {
        ...common,
        status: "DELETED",
        result: null,
        error: { status: 409, code: "CHAT_SEND_CONVERSATION_DELETED", message: "The conversation from this send was deleted." },
      };
    }
    return { ...common, status: "COMPLETE", result: restoredChatSendResult(request), error: null };
  }
  if (request.status === ChatSendRequestStatus.FAILED) {
    return { ...common, status: "FAILED", result: null, error: storedChatSendError(request) };
  }
  return { ...common, status: "PROCESSING", result: null, error: null };
}

function toConversationDTO(conversation: Conversation): ConversationSummaryDTO {
  return {
    id: conversation.id,
    title: conversation.title,
    originModule: conversation.originModule,
    createdAt: conversation.createdAt,
    lastMessageAt: conversation.lastMessageAt,
  };
}

function toMessageDTO(message: ChatMessage): ChatMessageDTO {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    metadata: (message.metadata as AnswerMetadata | null) ?? null,
    feedback: message.feedback === "up" || message.feedback === "down" ? message.feedback : null,
  };
}

/** A stored focus, read back defensively — it is JSON, so its shape is re-checked. */
function storedFocus(value: Prisma.JsonValue | null): ChatFocus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const focus = value as Record<string, unknown>;
  if (focus.kind === "finding" && Number.isInteger(focus.findingId)) {
    return { kind: "finding", findingId: focus.findingId as number };
  }
  if (
    focus.kind === "record" &&
    (focus.recordType === "expense" || focus.recordType === "sales") &&
    Number.isInteger(focus.recordId)
  ) {
    return { kind: "record", recordType: focus.recordType, recordId: focus.recordId as number };
  }
  return null;
}

/**
 * The thread's name, taken from its first question.
 *
 * No extra model call: a title is navigation, not analysis, and paying a model
 * to name a chat would double the cost of starting one. Cut at a WORD boundary
 * so a long first question reads as a shortened sentence rather than as a
 * string that ran out of room mid-word.
 *
 * Exported for the unit tests and used as the fallback whenever the client
 * omits a title, so the stored title can never be empty regardless of client.
 */
export function deriveTitle(question: string): string {
  const cleaned = question.trim().replace(/\s+/g, " ");
  if (!cleaned) return "New conversation";
  if (cleaned.length <= TITLE_MAX_LENGTH) return cleaned;

  const clipped = cleaned.slice(0, TITLE_MAX_LENGTH);
  const lastSpace = clipped.lastIndexOf(" ");
  // Only honour the word boundary when it leaves a usable title. A single
  // 200-character "word" would otherwise collapse to almost nothing.
  const trimmed = lastSpace > TITLE_MAX_LENGTH * 0.5 ? clipped.slice(0, lastSpace) : clipped;
  return trimmed.trimEnd();
}

/**
 * The last few turns of THIS conversation, oldest first.
 *
 * Pairs each user message with the assistant reply that followed it. Only
 * questions and answers are replayed — never the CONTEXT blocks they were
 * originally answered against, for the reason spelled out on callGemini: those
 * numbers are stale, and the newest message is the only one carrying data.
 */
function toPriorTurns(messages: ChatMessage[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (let i = 0; i < messages.length - 1; i += 1) {
    const question = messages[i];
    const answer = messages[i + 1];
    if (question?.role === "user" && answer?.role === "assistant") {
      turns.push({ question: question.content, answer: answer.content });
      i += 1;
    }
  }
  return turns.slice(-HISTORY_TURNS_FOR_CONTEXT);
}

/** This owner's threads for one business profile, newest activity first. */
export async function listConversations(
  userId: number,
  businessProfileId: number,
  limit: number = DEFAULT_LIST_LIMIT,
): Promise<ConversationSummaryDTO[]> {
  return (await listConversationsPage(userId, businessProfileId, { pageSize: limit })).items;
}

export async function listConversationsPage(
  userId: number,
  businessProfileId: number,
  input: DatePageInput,
) {
  await requireOwnedBusinessProfile(userId, businessProfileId);
  const pageSize = datePageSize(input);
  const scope = dateCursorScope(["conversations", userId, businessProfileId]);
  const cursor = decodeDateCursor(input.cursor, scope);
  if (cursor && !await prisma.conversation.findFirst({ where: { id: cursor.id, userId, businessProfileId }, select: { id: true } })) {
    invalidDateCursor();
  }
  const conversations = await prisma.conversation.findMany({
    where: {
      userId,
      businessProfileId,
      ...(cursor ? { OR: [{ lastMessageAt: { lt: cursor.at } }, { lastMessageAt: cursor.at, id: { lt: cursor.id } }] } : {}),
    },
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    take: pageSize + 1,
  });
  const page = finishDatePage(conversations, pageSize, scope, (row) => row.lastMessageAt);
  return { ...page, items: page.items.map(toConversationDTO) };
}

/**
 * One conversation with a bounded message page, oldest first within the page.
 *
 * The `userId` in the WHERE clause is the isolation boundary: a conversation
 * belonging to someone else does not match, so it 404s indistinguishably from
 * one that never existed.
 */
export async function getConversation(userId: number, id: number, input: DatePageInput = { pageSize: 100 }) {
  const conversation = await requireOwnedConversation(userId, id);
  const pageSize = datePageSize(input);
  const scope = dateCursorScope(["conversation-messages", userId, conversation.businessProfileId, id]);
  const cursor = decodeDateCursor(input.cursor, scope);
  if (cursor && !await prisma.chatMessage.findFirst({ where: { id: cursor.id, conversationId: id }, select: { id: true } })) {
    invalidDateCursor();
  }
  const messages = await prisma.chatMessage.findMany({
    where: {
      conversationId: id,
      ...(cursor ? { OR: [{ createdAt: { lt: cursor.at } }, { createdAt: cursor.at, id: { lt: cursor.id } }] } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: pageSize + 1,
  });
  const page = finishDatePage(messages, pageSize, scope, (row) => row.createdAt);
  return {
    ...toConversationDTO(conversation),
    businessProfileId: conversation.businessProfileId,
    messages: page.items.reverse().map(toMessageDTO),
    nextCursor: page.nextCursor,
  };
}

/** Loads an owned conversation, or 404s. Never distinguishes "not yours". */
async function requireOwnedConversation(userId: number, id: number) {
  const conversation = await prisma.conversation.findFirst({ where: { id, userId } });
  if (!conversation) {
    throw new ApiError(404, "Conversation not found");
  }
  return conversation;
}

/**
 * Asks the model, with context rebuilt from data queried at this moment.
 *
 * Context is never cached and never replayed from an earlier turn — that is
 * the property that lets a follow-up see an expense the owner recorded twenty
 * seconds ago, and it is why the drawer's original comment block exists.
 */
async function askInConversation(
  userId: number,
  businessProfileId: number,
  originModule: InteractionModule,
  question: string,
  priorTurns: ConversationTurn[],
  contextOverride?: string,
  reductionOpportunity?: ReductionOpportunity,
  focus?: { value: ChatFocus; strict: boolean } | null,
) {
  const profile = await requireOwnedBusinessProfile(userId, businessProfileId);

  if (contextOverride) {
    // An override carries no tagged records, so it can link to nothing — but
    // its figures are still checked against the text the client sent.
    const { answer, provider, metadata } = await groundAnswer(askFinSight, {
      context: contextOverride,
      question,
      priorTurns,
      references: new Map(),
    });
    return { answer, provider, metadata, detectedAmount: null as number | null };
  }

  // reductionOpportunity only ever renders on the Expense Insights module —
  // enforced here (not just by the controller schema) so this function
  // can't be made to attach a selected-opportunity block to a conversation
  // that didn't originate there. See plan §11.1/§5.4: no new
  // InteractionModule, the block is additive to that one module's context.
  const built = await buildModuleContext(
    userId,
    profile,
    originModule,
    question,
    originModule === "Expense Insights" ? reductionOpportunity : undefined,
    { focus: focus?.value ?? null, strictFocus: focus?.strict ?? false },
  );
  const { answer, provider, metadata } = await groundAnswer(askFinSight, {
    context: built.context,
    question,
    priorTurns,
    references: built.references,
    actions: built.actions,
    period: built.period,
  });
  return { answer, provider, metadata, detectedAmount: built.scenario?.amount ?? null };
}

function metadataJson(metadata: AnswerMetadata): Prisma.InputJsonValue {
  return metadata as unknown as Prisma.InputJsonValue;
}

/**
 * Lazy creation: nothing is persisted until the owner actually sends
 * something, so an abandoned empty chat leaves no trace.
 *
 * The conversation and both messages are written in ONE transaction — a
 * conversation with no messages, or a question with no answer beside it, are
 * both states the page has no sensible way to render.
 */
export async function createConversationWithFirstMessage(
  userId: number,
  businessProfileId: number,
  originModule: InteractionModule,
  question: string,
  title?: string,
  context?: string,
  reductionOpportunity?: ReductionOpportunity,
  focus?: ChatFocus,
  idempotencyKey?: string,
): Promise<ChatSendResult> {
  const identity = idempotencyKey === undefined ? undefined : chatSendIdentity(userId, businessProfileId, idempotencyKey, [
    "create", businessProfileId, originModule, question, title ?? null, context ?? null, reductionOpportunity ?? null, focus ?? null,
  ]);
  if (identity) {
    await requireOwnedBusinessProfile(userId, businessProfileId);
    const previous = await findChatSendRequest(identity);
    if (previous) return replayChatSend(previous, identity);
    const concurrent = await claimChatSendRequest(identity);
    if (concurrent) return replayChatSend(concurrent, identity);
  }
  return runChatSendOutcome(identity, async () => {
    // Strict on creation: a focus that is not this owner's 404s before a
    // conversation row exists or a model is billed.
    const { answer, provider, metadata, detectedAmount } = await askInConversation(
      userId,
      businessProfileId,
      originModule,
      question,
      [],
      context,
      reductionOpportunity,
      focus ? { value: focus, strict: true } : null,
    );

    const storedTitle = title?.trim() ? title.trim().slice(0, TITLE_MAX_LENGTH) : deriveTitle(question);
    const storedAnswer = truncateAnswer(answer, MESSAGE_MAX_LENGTH);

    const created = await prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.create({
        data: {
          userId,
          businessProfileId,
          title: storedTitle,
          originModule,
          ...(focus ? { focus: focus as unknown as Prisma.InputJsonValue } : {}),
        },
      });
      const userMessage = await tx.chatMessage.create({
        data: { conversationId: conversation.id, role: "user", content: question },
      });
      const assistantMessage = await tx.chatMessage.create({
        data: { conversationId: conversation.id, role: "assistant", content: storedAnswer, metadata: metadataJson(metadata) },
      });
      const result: ChatSendResult = {
        conversation: toConversationDTO(conversation),
        userMessage: toMessageDTO(userMessage),
        assistantMessage: toMessageDTO(assistantMessage),
        provider,
        detectedAmount,
      };
      if (identity) {
        await completeChatSendRequest(tx, identity, conversation.id, JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue);
      }
      return result;
    });
    return created;
  });
}

/**
 * Continues an existing thread. Same response shape as creation, so the page
 * has one code path for "a message was sent".
 */
export async function appendMessage(
  userId: number,
  conversationId: number,
  question: string,
  context?: string,
  reductionOpportunity?: ReductionOpportunity,
  focus?: ChatFocus,
  idempotencyKey?: string,
  businessProfileId?: number,
): Promise<ChatSendResult> {
  let identity: ChatSendIdentity | undefined;
  if (idempotencyKey !== undefined && businessProfileId !== undefined) {
    await requireOwnedBusinessProfile(userId, businessProfileId);
    identity = chatSendIdentity(userId, businessProfileId, idempotencyKey, [
      "append", businessProfileId, conversationId, question, context ?? null, reductionOpportunity ?? null, focus ?? null,
    ]);
    const previous = await findChatSendRequest(identity);
    if (previous) return replayChatSend(previous, identity);
  }
  const conversation = await requireOwnedConversation(userId, conversationId);
  if (businessProfileId !== undefined && conversation.businessProfileId !== businessProfileId) {
    throw new ApiError(404, "Conversation not found");
  }
  if (idempotencyKey !== undefined) {
    identity ??= chatSendIdentity(userId, conversation.businessProfileId, idempotencyKey, [
      "append", conversation.businessProfileId, conversationId, question, context ?? null, reductionOpportunity ?? null, focus ?? null,
    ]);
    const concurrent = await claimChatSendRequest(identity, conversationId);
    if (concurrent) return replayChatSend(concurrent, identity);
  }
  return runChatSendOutcome(identity, async () => {
    // A new focus (the owner pressed "Explain this flag" on a different card
    // while this thread was open) replaces the stored one and is held to the
    // same strict check as creation; the stored one is re-validated leniently,
    // so a flag resolved mid-conversation just drops out of the context.
    const activeFocus = focus
      ? { value: focus, strict: true }
      : (() => {
          const stored = storedFocus(conversation.focus);
          return stored ? { value: stored, strict: false } : null;
        })();

    // Newest first, then reversed: the tail of a long thread is what gets
    // replayed, not its opening.
    const recent = await prisma.chatMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: HISTORY_TURNS_FOR_CONTEXT * 2,
    });
    const priorTurns = toPriorTurns(recent.reverse());

    const { answer, provider, metadata, detectedAmount } = await askInConversation(
      userId,
      conversation.businessProfileId,
      conversation.originModule as InteractionModule,
      question,
      priorTurns,
      context,
      reductionOpportunity,
      activeFocus,
    );

    const storedAnswer = truncateAnswer(answer, MESSAGE_MAX_LENGTH);

    const written = await prisma.$transaction(async (tx) => {
      const existing = await tx.$queryRaw<Array<{ id: number }>>`
        SELECT "Conversation_ID" AS id FROM "Conversation"
        WHERE "Conversation_ID" = ${conversation.id}
          AND "User_ID" = ${userId}
          AND "BusinessProfile_ID" = ${conversation.businessProfileId}
        FOR UPDATE
      `;
      if (existing.length !== 1) deletedChatSend();
      const userMessage = await tx.chatMessage.create({
        data: { conversationId: conversation.id, role: "user", content: question },
      });
      const assistantMessage = await tx.chatMessage.create({
        data: { conversationId: conversation.id, role: "assistant", content: storedAnswer, metadata: metadataJson(metadata) },
      });
      // lastMessageAt is what orders the sidebar, so it advances with the write
      // rather than being derived at read time from a join.
      const updated = await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageAt: assistantMessage.createdAt,
          ...(focus ? { focus: focus as unknown as Prisma.InputJsonValue } : {}),
        },
      });
      const result: ChatSendResult = {
        conversation: toConversationDTO(updated),
        userMessage: toMessageDTO(userMessage),
        assistantMessage: toMessageDTO(assistantMessage),
        provider,
        detectedAmount,
      };
      if (identity) {
        await completeChatSendRequest(tx, identity, conversation.id, JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue);
      }
      return result;
    });
    return written;
  });
}

export async function renameConversation(
  userId: number,
  id: number,
  title: string,
): Promise<ConversationSummaryDTO> {
  const conversation = await requireOwnedConversation(userId, id);
  const cleaned = title.trim();
  if (!cleaned) {
    throw new ApiError(400, "Title is required");
  }

  const updated = await prisma.conversation.update({
    where: { id: conversation.id },
    data: { title: cleaned.slice(0, TITLE_MAX_LENGTH) },
  });
  return toConversationDTO(updated);
}

/** Keep replay identities after deletion, without retaining the deleted message content. */
export async function deleteConversation(userId: number, id: number): Promise<void> {
  const conversation = await requireOwnedConversation(userId, id);
  await prisma.$transaction(async (tx) => {
    const existing = await tx.$queryRaw<Array<{ id: number }>>`
      SELECT "Conversation_ID" AS id FROM "Conversation"
      WHERE "Conversation_ID" = ${conversation.id}
        AND "User_ID" = ${userId}
        AND "BusinessProfile_ID" = ${conversation.businessProfileId}
      FOR UPDATE
    `;
    if (existing.length !== 1) throw new ApiError(404, "Conversation not found");
    await tx.chatSendRequest.updateMany({
      where: {
        userId,
        businessProfileId: conversation.businessProfileId,
        conversationId: conversation.id,
        status: ChatSendRequestStatus.COMPLETE,
      },
      data: { response: {} },
    });
    await tx.conversation.delete({ where: { id: conversation.id, userId, businessProfileId: conversation.businessProfileId } });
  });
}

/**
 * Thumbs up/down on one assistant reply, or null to take it back.
 *
 * Scoped through the conversation's owner: a message id from someone else's
 * thread 404s exactly like one that does not exist. User messages cannot be
 * rated — there is nothing of FinSight's in them to judge.
 */
export async function setMessageFeedback(
  userId: number,
  conversationId: number,
  messageId: number,
  feedback: "up" | "down" | null,
): Promise<ChatMessageDTO> {
  const conversation = await requireOwnedConversation(userId, conversationId);
  const message = await prisma.chatMessage.findFirst({
    where: { id: messageId, conversationId: conversation.id, role: "assistant" },
  });
  if (!message) {
    throw new ApiError(404, "Message not found");
  }
  const updated = await prisma.chatMessage.update({
    where: { id: message.id },
    data: { feedback, feedbackAt: feedback ? new Date() : null },
  });
  return toMessageDTO(updated);
}
