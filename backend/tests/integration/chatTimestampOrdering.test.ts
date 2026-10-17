import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const ask = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/ai.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/ai.service")>();
  return { ...actual, askFinSight: ask };
});

import { prisma } from "../../src/config/prisma";
import { getHistory } from "../../src/services/ai.service";
import { appendMessage, getConversation, listConversations } from "../../src/services/conversation.service";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

const tiedAt = new Date("2026-10-01T00:00:00.000Z");
let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile();
  ask.mockReset();
  ask.mockResolvedValue({ answer: "Review your recorded expenses.", provider: "gemini" });
});
afterAll(disconnectDb);

async function thread() {
  return prisma.conversation.create({ data: {
    userId: ctx.user.id, businessProfileId: ctx.profile.id, title: "Tied message times", originModule: "Dashboard",
  } });
}

async function tiedMessages(conversationId: number) {
  const turns = Array.from({ length: 8 }, (_, index) => [
    { id: 101 + index * 2, conversationId, role: "user", content: `Question ${index}?`, createdAt: tiedAt },
    { id: 102 + index * 2, conversationId, role: "assistant", content: `Answer ${index}.`, createdAt: tiedAt },
  ]).flat();
  // Storage order deliberately differs from conversational ID order.
  await prisma.chatMessage.createMany({ data: [...turns.slice(8), ...turns.slice(0, 8)].reverse() });
  return turns;
}

describe("chat chronology with equal timestamps", () => {
  it("shows each question before its answer in detail regardless of insertion order", async () => {
    const conversation = await thread();
    const rows = await tiedMessages(conversation.id);
    const detail = await getConversation(ctx.user.id, conversation.id);
    expect(detail.messages.map((message) => message.id)).toEqual(rows.map((row) => row.id));
    expect(detail.messages.map((message) => message.content)).toEqual(rows.map((row) => row.content));
  });

  it("replays exactly the latest six complete turns in chronological order", async () => {
    const conversation = await thread();
    await tiedMessages(conversation.id);
    await appendMessage(ctx.user.id, conversation.id, "Which expense should I review?");
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]![0].priorTurns).toEqual(Array.from({ length: 6 }, (_, index) => ({
      question: `Question ${index + 2}?`, answer: `Answer ${index + 2}.`,
    })));
  });

  it("orders sidebar ties consistently by newest conversation ID", async () => {
    await prisma.conversation.createMany({ data: [30, 10, 20].map((id) => ({
      id, userId: ctx.user.id, businessProfileId: ctx.profile.id, title: `Thread ${id}`, originModule: "Dashboard", lastMessageAt: tiedAt,
    })) });
    expect((await listConversations(ctx.user.id, ctx.profile.id)).map((conversation) => conversation.id)).toEqual([30, 20, 10]);
  });

  it("orders legacy recent interactions by timestamp and ID before taking the newest window", async () => {
    await prisma.aIInteraction.createMany({ data: [7, 2, 8, 1, 6, 3, 5, 4].map((id) => ({
      id, userId: ctx.user.id, businessProfileId: ctx.profile.id, module: "Dashboard", question: `Legacy ${id}?`, aiResponse: `Answer ${id}.`, timestamp: tiedAt,
    })) });
    expect((await getHistory(ctx.user.id, ctx.profile.id, "Dashboard", 6)).map((interaction) => interaction.id))
      .toEqual([3, 4, 5, 6, 7, 8]);
  });
});
