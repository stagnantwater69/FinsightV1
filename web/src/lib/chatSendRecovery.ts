import { captureServerStateAccount } from "./serverStateCache";
import type { ChatFocus, InteractionModule, ReductionOpportunity } from "./types";

const PREFIX = "finsight.pendingChatSend.";
const MAX_RECOVERY_CHARACTERS = 32_768;
const MODULES: readonly InteractionModule[] = ["Dashboard", "Expense Insights", "Records Review", "Recovery Target", "Spending Impact"];
export interface PendingChatSend {
  ownerId: string | null;
  conversationId: number | null;
  body: {
    businessProfileId: number;
    idempotencyKey: string;
    question: string;
    originModule?: InteractionModule;
    reductionOpportunity?: ReductionOpportunity;
    focus?: ChatFocus;
  };
}

function storageKey(ownerId: string, businessProfileId: number) {
  return `${PREFIX}${ownerId}.${businessProfileId}`;
}

function validId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}

function validFocus(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const focus = value as Record<string, unknown>;
  return focus.kind === "finding" ? validId(focus.findingId)
    : focus.kind === "record" && (focus.recordType === "expense" || focus.recordType === "sales") && validId(focus.recordId);
}

export function readPendingChatSend(businessProfileId: number): PendingChatSend | null {
  const ownerId = captureServerStateAccount()?.userId;
  if (!ownerId) return null;
  try {
    const raw = sessionStorage.getItem(storageKey(ownerId, businessProfileId));
    if (!raw || raw.length > MAX_RECOVERY_CHARACTERS) return null;
    const value = JSON.parse(raw) as PendingChatSend;
    if (value.ownerId !== ownerId || value.body?.businessProfileId !== businessProfileId
      || typeof value.body.question !== "string" || !value.body.question.trim() || value.body.question.length > 1000
      || typeof value.body.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(value.body.idempotencyKey)
      || !validId(value.body.businessProfileId)
      || (value.conversationId !== null && !validId(value.conversationId))
      || (value.conversationId === null && !MODULES.includes(value.body.originModule as InteractionModule))
      || (value.body.originModule !== undefined && !MODULES.includes(value.body.originModule))
      || (value.body.focus !== undefined && !validFocus(value.body.focus))) return null;
    return value;
  } catch { return null; }
}

export function storePendingChatSend(request: PendingChatSend) {
  const { ownerId, conversationId, body } = request;
  const serialized = JSON.stringify({ ownerId, conversationId, body });
  if (serialized.length > MAX_RECOVERY_CHARACTERS) throw new Error("The question is too large to save for recovery.");
  if (ownerId === null) return;
  sessionStorage.setItem(storageKey(ownerId, body.businessProfileId), serialized);
}

export function removePendingChatSend(request: PendingChatSend) {
  if (request.ownerId === null) return;
  try {
    const key = storageKey(request.ownerId, request.body.businessProfileId);
    const stored = sessionStorage.getItem(key);
    if (stored && (JSON.parse(stored) as PendingChatSend).body.idempotencyKey === request.body.idempotencyKey) sessionStorage.removeItem(key);
  } catch { /* A completed request is also cleared from the in-memory recovery state. */ }
}

export function clearChatSendRecovery() {
  try {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(PREFIX)) sessionStorage.removeItem(key);
  } catch { /* Storage may be unavailable in this browser. */ }
}
