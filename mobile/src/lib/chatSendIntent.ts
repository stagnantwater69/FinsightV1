import { newIdempotencyKey } from "./csvImport";
import type { ChatFocus, InteractionModule, ReductionOpportunity } from "./types";

export interface ChatSendBody {
  businessProfileId: number;
  idempotencyKey: string;
  question: string;
  originModule?: InteractionModule;
  reductionOpportunity?: ReductionOpportunity;
  focus?: ChatFocus;
}

export interface PendingChatSend {
  version: 1;
  ownerId: string | null;
  conversationId: number | null;
  body: ChatSendBody;
}

export interface ChatSendPersistence {
  read(ownerId: string, businessProfileId: number): Promise<PendingChatSend | null>;
  store(intent: PendingChatSend): Promise<void>;
  remove(intent: PendingChatSend): Promise<void>;
}

export const CHAT_SEND_MAX_BYTES = 32_768;

export function utf8Bytes(value: string): number {
  return encodeURIComponent(value).replace(/%[A-F\d]{2}/gi, "x").length;
}

function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

export function parsePendingChatSend(value: unknown, ownerId: string | null, businessProfileId: number): PendingChatSend {
  const intent = value as Partial<PendingChatSend> | null;
  const body = intent?.body;
  const validId = (id: unknown) => typeof id === "number" && Number.isSafeInteger(id) && id > 0;
  const focus = body?.focus;
  const validFocus = !focus || (focus.kind === "finding" ? validId(focus.findingId)
    : focus.kind === "record" && (focus.recordType === "expense" || focus.recordType === "sales") && validId(focus.recordId));
  const modules: InteractionModule[] = ["Dashboard", "Expense Insights", "Spending Impact", "Recovery Target", "Records Review"];
  if (!intent || intent.version !== 1 || intent.ownerId !== ownerId || !body || body.businessProfileId !== businessProfileId
    || !validId(businessProfileId) || (intent.conversationId !== null && !validId(intent.conversationId))
    || typeof body.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(body.idempotencyKey)
    || typeof body.question !== "string" || !body.question.trim() || body.question.length > 1000
    || (intent.conversationId === null && body.originModule === undefined)
    || (body.originModule !== undefined && !modules.includes(body.originModule)) || !validFocus
    || (body.reductionOpportunity !== undefined && (!body.reductionOpportunity || typeof body.reductionOpportunity !== "object" || Array.isArray(body.reductionOpportunity)))
    || Object.keys(body).some((key) => !["businessProfileId", "idempotencyKey", "question", "originModule", "reductionOpportunity", "focus"].includes(key))
    || utf8Bytes(JSON.stringify(intent)) > CHAT_SEND_MAX_BYTES) {
    throw new Error("Saved question details could not be verified for this account and business. Nothing was sent.");
  }
  return frozen(JSON.parse(JSON.stringify(intent)) as PendingChatSend);
}

export function createPendingChatSend(ownerId: string | null, conversationId: number | null, body: Omit<ChatSendBody, "idempotencyKey">): PendingChatSend {
  return parsePendingChatSend({ version: 1, ownerId, conversationId, body: { ...body, idempotencyKey: newIdempotencyKey() } }, ownerId, body.businessProfileId);
}
