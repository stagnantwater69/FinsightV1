import { createHash } from "node:crypto";
import { ChatSendRequestStatus, Prisma, type ChatSendRequest } from "@prisma/client";
import { prisma } from "../config/prisma";
import { logger } from "../config/logger";
import { ApiError } from "../middleware/error.middleware";
import { manualRecordIdempotencyKeySchema } from "./manualRecordCreate";

export const chatSendIdempotencyKeySchema = manualRecordIdempotencyKeySchema;

export interface ChatSendIdentity {
  keyHash: string;
  inputHash: string;
  userId: number;
  businessProfileId: number;
}

export interface ChatSendError {
  status: number;
  code: string;
  message: string;
}

function canonicalInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalInput);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonicalInput(entry)]));
  }
  return value;
}

export function chatSendKeyHash(userId: number, businessProfileId: number, key: string): string {
  const parsed = chatSendIdempotencyKeySchema.parse(key);
  return createHash("sha256").update(JSON.stringify(["chat-send-key-v1", userId, businessProfileId, parsed])).digest("hex");
}

export function chatSendIdentity(
  userId: number,
  businessProfileId: number,
  key: string,
  input: readonly unknown[],
): ChatSendIdentity {
  return {
    userId,
    businessProfileId,
    keyHash: chatSendKeyHash(userId, businessProfileId, key),
    inputHash: createHash("sha256").update(JSON.stringify(canonicalInput(["chat-send-input-v1", input]))).digest("hex"),
  };
}

export function storedChatSendError(request: ChatSendRequest): ChatSendError {
  return {
    status: request.errorStatus ?? 500,
    code: request.errorCode ?? "CHAT_SEND_FAILED",
    message: request.errorMessage ?? "This message could not be saved. Start a new message when you are ready.",
  };
}

export function deletedChatSend(): never {
  throw new ApiError(409, "The conversation from this send was deleted. Start a new conversation when you are ready.", {
    code: "CHAT_SEND_CONVERSATION_DELETED",
  });
}

export function checkChatSendReplay(request: ChatSendRequest, identity: ChatSendIdentity): void {
  if (
    request.userId !== identity.userId
    || request.businessProfileId !== identity.businessProfileId
    || request.inputHash !== identity.inputHash
  ) {
    throw new ApiError(409, "This message key was already used with different details. Check the original message before sending again.", {
      code: "CHAT_SEND_KEY_CONFLICT",
    });
  }
  if (request.status === ChatSendRequestStatus.COMPLETE) {
    if (request.conversationId === null) deletedChatSend();
    return;
  }
  if (request.status === ChatSendRequestStatus.FAILED) {
    const error = storedChatSendError(request);
    throw new ApiError(error.status, error.message, { code: error.code });
  }
  throw new ApiError(409, "This message has not finished or its outcome could not be confirmed. Check its status before sending another message.", {
    code: "CHAT_SEND_IN_PROGRESS",
  });
}

export async function findChatSendRequest(identity: ChatSendIdentity): Promise<ChatSendRequest | null> {
  return prisma.chatSendRequest.findFirst({
    where: { keyHash: identity.keyHash, userId: identity.userId, businessProfileId: identity.businessProfileId },
  });
}

export async function claimChatSendRequest(identity: ChatSendIdentity, conversationId?: number): Promise<ChatSendRequest | null> {
  try {
    await prisma.chatSendRequest.create({
      data: {
        ...identity,
        ...(conversationId !== undefined ? { conversationId, conversationBusinessProfileId: identity.businessProfileId } : {}),
      },
    });
    return null;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await findChatSendRequest(identity);
      if (existing) return existing;
    }
    throw error;
  }
}

export async function completeChatSendRequest(
  db: Prisma.TransactionClient,
  identity: ChatSendIdentity,
  conversationId: number,
  response: Prisma.InputJsonValue,
): Promise<void> {
  const completed = await db.chatSendRequest.updateMany({
    where: { ...identity, status: ChatSendRequestStatus.PROCESSING },
    data: {
      status: ChatSendRequestStatus.COMPLETE,
      conversationId,
      conversationBusinessProfileId: identity.businessProfileId,
      response,
      completedAt: new Date(),
    },
  });
  if (completed.count !== 1) {
    throw new ApiError(409, "This message request changed before it could be saved. Check its status.", {
      code: "CHAT_SEND_REQUEST_CHANGED",
    });
  }
}

// Unknown write outcomes retain the claim: replaying the provider could bill or save the send twice.
export async function resolveChatSendFailure(identity: ChatSendIdentity, failure: unknown): Promise<ChatSendRequest> {
  let request: ChatSendRequest | null = null;
  try {
    request = await findChatSendRequest(identity);
    if (request?.status === ChatSendRequestStatus.COMPLETE) return request;
    if (failure instanceof ApiError) {
      await prisma.chatSendRequest.updateMany({
        where: { ...identity, status: ChatSendRequestStatus.PROCESSING },
        data: {
          status: ChatSendRequestStatus.FAILED,
          errorStatus: failure.status,
          errorCode: failure.code ?? "CHAT_SEND_FAILED",
          errorMessage: failure.message.slice(0, 255),
          completedAt: new Date(),
        },
      });
      request = await findChatSendRequest(identity);
      if (request?.status === ChatSendRequestStatus.COMPLETE) return request;
      if (request?.status === ChatSendRequestStatus.FAILED) {
        const stored = storedChatSendError(request);
        throw new ApiError(stored.status, stored.message, { code: stored.code });
      }
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
  }
  logger.error({
    userId: identity.userId,
    businessProfileId: identity.businessProfileId,
    code: "CHAT_SEND_OUTCOME_UNKNOWN",
    failureKind: failure instanceof Error ? failure.name : "unknown",
  }, "Could not confirm a chat send outcome");
  throw new ApiError(503, "We couldn't confirm whether this message was saved. Check its status before sending another message.", {
    code: "CHAT_SEND_OUTCOME_UNKNOWN",
  });
}
