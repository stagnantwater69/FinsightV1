import type { ChatMessage, Conversation } from "@prisma/client";
import { prisma } from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import { requireOwnedBusinessProfile } from "../lib/ownership";
import { buildModuleContext, type InteractionModule } from "./aiContext.service";
import { askFinSight, HISTORY_TURNS_FOR_CONTEXT, truncateAnswer, type ConversationTurn } from "./ai.service";
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
}

export interface ChatSendResult {
  conversation: ConversationSummaryDTO;
  userMessage: ChatMessageDTO;
  assistantMessage: ChatMessageDTO;
  provider: "gemini" | "openrouter" | "unavailable";
  detectedAmount: number | null;
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
  };
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
  await requireOwnedBusinessProfile(userId, businessProfileId);

  const conversations = await prisma.conversation.findMany({
    where: { userId, businessProfileId },
    orderBy: { lastMessageAt: "desc" },
    take: limit,
  });
  return conversations.map(toConversationDTO);
}

/**
 * One conversation with its full message list, oldest first.
 *
 * The `userId` in the WHERE clause is the isolation boundary: a conversation
 * belonging to someone else does not match, so it 404s indistinguishably from
 * one that never existed.
 */
export async function getConversation(userId: number, id: number) {
  const conversation = await prisma.conversation.findFirst({
    where: { id, userId },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!conversation) {
    throw new ApiError(404, "Conversation not found");
  }
  return {
    ...toConversationDTO(conversation),
    businessProfileId: conversation.businessProfileId,
    messages: conversation.messages.map(toMessageDTO),
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
) {
  const profile = await requireOwnedBusinessProfile(userId, businessProfileId);

  if (contextOverride) {
    const { answer, provider } = await askFinSight({ context: contextOverride, question, priorTurns });
    return { answer, provider, detectedAmount: null as number | null };
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
  );
  const { answer, provider } = await askFinSight({ context: built.context, question, priorTurns });
  return { answer, provider, detectedAmount: built.scenario?.amount ?? null };
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
): Promise<ChatSendResult> {
  const { answer, provider, detectedAmount } = await askInConversation(
    userId,
    businessProfileId,
    originModule,
    question,
    [],
    context,
    reductionOpportunity,
  );

  const storedTitle = title?.trim() ? title.trim().slice(0, TITLE_MAX_LENGTH) : deriveTitle(question);
  const storedAnswer = truncateAnswer(answer, MESSAGE_MAX_LENGTH);

  const created = await prisma.$transaction(async (tx) => {
    const conversation = await tx.conversation.create({
      data: { userId, businessProfileId, title: storedTitle, originModule },
    });
    const userMessage = await tx.chatMessage.create({
      data: { conversationId: conversation.id, role: "user", content: question },
    });
    const assistantMessage = await tx.chatMessage.create({
      data: { conversationId: conversation.id, role: "assistant", content: storedAnswer },
    });
    return { conversation, userMessage, assistantMessage };
  });

  return {
    conversation: toConversationDTO(created.conversation),
    userMessage: toMessageDTO(created.userMessage),
    assistantMessage: toMessageDTO(created.assistantMessage),
    provider,
    detectedAmount,
  };
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
): Promise<ChatSendResult> {
  const conversation = await requireOwnedConversation(userId, conversationId);

  // Newest first, then reversed: the tail of a long thread is what gets
  // replayed, not its opening.
  const recent = await prisma.chatMessage.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "desc" },
    take: HISTORY_TURNS_FOR_CONTEXT * 2,
  });
  const priorTurns = toPriorTurns(recent.reverse());

  const { answer, provider, detectedAmount } = await askInConversation(
    userId,
    conversation.businessProfileId,
    conversation.originModule as InteractionModule,
    question,
    priorTurns,
    context,
    reductionOpportunity,
  );

  const storedAnswer = truncateAnswer(answer, MESSAGE_MAX_LENGTH);

  const written = await prisma.$transaction(async (tx) => {
    const userMessage = await tx.chatMessage.create({
      data: { conversationId: conversation.id, role: "user", content: question },
    });
    const assistantMessage = await tx.chatMessage.create({
      data: { conversationId: conversation.id, role: "assistant", content: storedAnswer },
    });
    // lastMessageAt is what orders the sidebar, so it advances with the write
    // rather than being derived at read time from a join.
    const updated = await tx.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: assistantMessage.createdAt },
    });
    return { updated, userMessage, assistantMessage };
  });

  return {
    conversation: toConversationDTO(written.updated),
    userMessage: toMessageDTO(written.userMessage),
    assistantMessage: toMessageDTO(written.assistantMessage),
    provider,
    detectedAmount,
  };
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

/** One statement — ChatMessage cascades off the conversation row. */
export async function deleteConversation(userId: number, id: number): Promise<void> {
  const conversation = await requireOwnedConversation(userId, id);
  await prisma.conversation.delete({ where: { id: conversation.id } });
}
