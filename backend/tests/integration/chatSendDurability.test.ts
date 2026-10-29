import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({ ask: vi.fn(), complete: null as null | (() => Promise<void>), authId: "" }));
vi.mock("../../src/config/supabase", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/config/supabase")>(),
  supabaseAdmin: { auth: { getUser: async () => ({ data: { user: { id: controls.authId } }, error: null }) } },
}));
vi.mock("../../src/services/ai.service", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/services/ai.service")>(), askFinSight: controls.ask,
}));
vi.mock("../../src/lib/chatSendRequest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/chatSendRequest")>();
  return { ...actual, completeChatSendRequest: async (...args: Parameters<typeof actual.completeChatSendRequest>) => {
    await controls.complete?.();
    return actual.completeChatSendRequest(...args);
  } };
});

import request from "supertest";
import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { ApiError } from "../../src/middleware/error.middleware";
import { appendMessage, createConversationWithFirstMessage, deleteConversation, getChatSendStatus } from "../../src/services/conversation.service";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

let owner: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const answer = { answer: "Review your recorded expenses.", provider: "gemini" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function create(key: string, question = "What should I review?") {
  return createConversationWithFirstMessage(owner.user.id, owner.profile.id, "Dashboard", question,
    undefined, undefined, undefined, key);
}
function append(id: number, key: string, question = "Which record next?") {
  return appendMessage(owner.user.id, id, question, undefined, undefined, key, owner.profile.id);
}
const status = (key: string) => getChatSendStatus(owner.user.id, owner.profile.id, key);
const errorCode = (code: string) => expect.objectContaining({ code });

beforeEach(async () => {
  vi.restoreAllMocks();
  controls.complete = null;
  controls.ask.mockReset().mockResolvedValue(answer);
  await resetDb();
  owner = await makeOwnerWithProfile();
  controls.authId = owner.user.authId;
});
afterAll(disconnectDb);

describe("durable chat sends", () => {
  it("returns the same HTTP result and owned status after a client loses its response", async () => {
    const key = randomUUID();
    const body = { businessProfileId: owner.profile.id, originModule: "Dashboard", question: "What should I review?", context: "Synthetic context", idempotencyKey: key };
    const first = await request(app).post("/api/v1/ai/conversations").set("Authorization", "Bearer synthetic-token").send(body);
    const replay = await request(app).post("/api/v1/ai/conversations").set("Authorization", "Bearer synthetic-token").send(body);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    const checked = await request(app).get(`/api/v1/ai/send-requests/${key}`).set("Authorization", "Bearer synthetic-token").query({ businessProfileId: owner.profile.id });
    expect(checked.status).toBe(200);
    expect(checked.body).toMatchObject({ status: "COMPLETE", result: first.body, error: null });
    const other = await makeOwnerWithProfile();
    controls.authId = other.user.authId;
    const foreign = await request(app).get(`/api/v1/ai/send-requests/${key}`).set("Authorization", "Bearer synthetic-token").query({ businessProfileId: owner.profile.id });
    expect(foreign.status).toBe(404);
    expect(foreign.body).not.toHaveProperty("result");
    expect(controls.ask).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid keyed append/status inputs before a provider dispatch", async () => {
    const saved = await create(randomUUID());
    const missingScope = await request(app).post(`/api/v1/ai/conversations/${saved.conversation.id}/messages`)
      .set("Authorization", "Bearer synthetic-token").send({ question: "Which next?", idempotencyKey: randomUUID() });
    expect(missingScope.status).toBe(400);
    const invalidKey = await request(app).get("/api/v1/ai/send-requests/short").set("Authorization", "Bearer synthetic-token").query({ businessProfileId: owner.profile.id });
    expect(invalidKey.status).toBe(400);
    expect(controls.ask).toHaveBeenCalledTimes(1);
  });

  it("claims concurrent identical sends before billing the provider a second time", async () => {
    const key = randomUUID();
    const gate = deferred<typeof answer>();
    controls.ask.mockImplementation(() => gate.promise);
    const first = create(key);
    let secondFinished = false;
    let second: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(controls.ask).toHaveBeenCalledTimes(1));
      second = create(key).then((value) => { secondFinished = true; return value; }, (error: unknown) => { secondFinished = true; return error; });
      await vi.waitFor(() => expect(secondFinished || controls.ask.mock.calls.length > 1).toBe(true));
      gate.resolve(answer);
      await first;
      expect(await second).toEqual(errorCode("CHAT_SEND_IN_PROGRESS"));
      expect(controls.ask).toHaveBeenCalledTimes(1);
      expect(await prisma.conversation.count()).toBe(1);
      expect(await prisma.chatMessage.count()).toBe(2);
    } finally {
      gate.resolve(answer);
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
  });

  it("replays the exact completed create DTO after a lost response", async () => {
    const key = randomUUID();
    const saved = await create(key);
    expect(await create(key)).toEqual(saved);
    expect(await status(key)).toMatchObject({ status: "COMPLETE", result: saved, error: null });
    expect(controls.ask).toHaveBeenCalledTimes(1);
    expect(await prisma.chatMessage.count()).toBe(2);
    expect(await prisma.chatSendRequest.count()).toBe(1);
  });

  it("replays an append without another question/answer pair or provider call", async () => {
    const first = await create(randomUUID());
    const key = randomUUID();
    const saved = await append(first.conversation.id, key);
    expect(await append(first.conversation.id, key)).toEqual(saved);
    expect(controls.ask).toHaveBeenCalledTimes(2);
    expect(await prisma.conversation.count()).toBe(1);
    expect(await prisma.chatMessage.count()).toBe(4);
  });

  it("rejects changed questions and create/append key reuse before another provider call", async () => {
    const key = randomUUID();
    const first = await create(key);
    await expect(create(key, "A different question?")).rejects.toEqual(errorCode("CHAT_SEND_KEY_CONFLICT"));
    await expect(append(first.conversation.id, key)).rejects.toEqual(errorCode("CHAT_SEND_KEY_CONFLICT"));
    expect(controls.ask).toHaveBeenCalledTimes(1);
  });

  it("keeps status and replay private to the owning account and business", async () => {
    const key = randomUUID();
    await create(key, "Private owner's question?");
    const other = await makeOwnerWithProfile();
    await expect(getChatSendStatus(other.user.id, other.profile.id, key)).rejects.toMatchObject({ status: 404 });
    await expect(getChatSendStatus(other.user.id, owner.profile.id, key)).rejects.toMatchObject({ status: 404 });
    await expect(getChatSendStatus(owner.user.id, other.profile.id, key)).rejects.toMatchObject({ status: 404 });
    expect(controls.ask).toHaveBeenCalledTimes(1);
  });

  it("retains an indeterminate claim indefinitely without retrying the provider", async () => {
    const key = randomUUID();
    controls.ask.mockRejectedValueOnce(new Error("Synthetic connection lost"));
    await expect(create(key)).rejects.toEqual(errorCode("CHAT_SEND_OUTCOME_UNKNOWN"));
    await prisma.chatSendRequest.updateMany({ data: { createdAt: new Date("1999-01-01T00:00:00Z") } });
    expect(await status(key)).toMatchObject({ status: "PROCESSING", result: null, error: null });
    await expect(create(key)).rejects.toEqual(errorCode("CHAT_SEND_IN_PROGRESS"));
    expect(controls.ask).toHaveBeenCalledTimes(1);
    expect(await prisma.chatMessage.count()).toBe(0);
  });

  it("replays a known failure while permitting a deliberate new logical key", async () => {
    const key = randomUUID();
    controls.ask.mockRejectedValueOnce(new ApiError(422, "Synthetic known invalid question", { code: "SYNTHETIC_INVALID_QUESTION" }));
    await expect(create(key)).rejects.toEqual(errorCode("SYNTHETIC_INVALID_QUESTION"));
    expect(await status(key)).toMatchObject({ status: "FAILED", result: null,
      error: { status: 422, code: "SYNTHETIC_INVALID_QUESTION", message: "Synthetic known invalid question" } });
    await expect(create(key)).rejects.toEqual(errorCode("SYNTHETIC_INVALID_QUESTION"));
    expect(controls.ask).toHaveBeenCalledTimes(1);
    await create(randomUUID());
    expect(controls.ask).toHaveBeenCalledTimes(2);
  });

  it("rolls back messages if the completion ledger cannot be saved", async () => {
    const key = randomUUID();
    controls.complete = async () => { throw new Error("Synthetic ledger write failure"); };
    await expect(create(key)).rejects.toEqual(errorCode("CHAT_SEND_OUTCOME_UNKNOWN"));
    expect(await prisma.conversation.count()).toBe(0);
    expect(await prisma.chatMessage.count()).toBe(0);
    expect(await status(key)).toMatchObject({ status: "PROCESSING", result: null });
    await expect(create(key)).rejects.toEqual(errorCode("CHAT_SEND_IN_PROGRESS"));
    expect(controls.ask).toHaveBeenCalledTimes(1);
  });

  it("preserves COMPLETE when the database commit succeeds but its acknowledgement is lost", async () => {
    const key = randomUUID();
    const transaction = prisma.$transaction.bind(prisma);
    vi.spyOn(prisma, "$transaction").mockImplementationOnce(async (...args) => {
      await Reflect.apply(transaction, prisma, args);
      throw new Error("Synthetic lost commit acknowledgement");
    });
    const saved = await create(key);
    expect(await status(key)).toMatchObject({ status: "COMPLETE", result: saved });
    expect(await create(key)).toEqual(saved);
    expect(controls.ask).toHaveBeenCalledTimes(1);
    expect(await prisma.chatMessage.count()).toBe(2);
    expect(await prisma.chatSendRequest.findFirst()).toMatchObject({ status: "COMPLETE", errorCode: null });
  });

  it("redacts completed replay content and retains a deletion tombstone", async () => {
    const key = randomUUID();
    const saved = await create(key);
    await deleteConversation(owner.user.id, saved.conversation.id);
    const ledger = await prisma.chatSendRequest.findFirst();
    expect(ledger).toMatchObject({ status: "COMPLETE", conversationId: null, conversationBusinessProfileId: null });
    expect(ledger?.response).toEqual({});
    expect(await status(key)).toMatchObject({ status: "DELETED", result: null });
    await expect(create(key)).rejects.toEqual(errorCode("CHAT_SEND_CONVERSATION_DELETED"));
    expect(await prisma.chatMessage.count()).toBe(0);
    expect(controls.ask).toHaveBeenCalledTimes(1);
  });

  it("does not resurrect a thread deleted while an append provider response is pending", async () => {
    const saved = await create(randomUUID());
    const key = randomUUID();
    const gate = deferred<typeof answer>();
    controls.ask.mockImplementationOnce(() => gate.promise);
    const pending = append(saved.conversation.id, key).catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(controls.ask).toHaveBeenCalledTimes(2));
      await deleteConversation(owner.user.id, saved.conversation.id);
      gate.resolve(answer);
      expect(await pending).toEqual(errorCode("CHAT_SEND_CONVERSATION_DELETED"));
      expect(await status(key)).toMatchObject({ status: "FAILED", result: null, error: { code: "CHAT_SEND_CONVERSATION_DELETED" } });
      expect(await prisma.conversation.count()).toBe(0);
      expect(await prisma.chatMessage.count()).toBe(0);
    } finally { gate.resolve(answer); await pending; }
  });

  it("redacts an append completed while deletion is waiting for its conversation lock", async () => {
    const saved = await createConversationWithFirstMessage(owner.user.id, owner.profile.id, "Dashboard", "Legacy question?");
    const key = randomUUID();
    const entered = deferred<void>();
    const release = deferred<void>();
    controls.complete = async () => { entered.resolve(); await release.promise; };
    const pending = append(saved.conversation.id, key);
    let deletion: Promise<void> | undefined;
    try {
      await entered.promise;
      deletion = deleteConversation(owner.user.id, saved.conversation.id);
      await vi.waitFor(async () => {
        const waiting = await prisma.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%Conversation%' AND pid <> pg_backend_pid()
        `;
        expect(Number(waiting[0]?.count)).toBeGreaterThan(0);
      });
      release.resolve();
      await Promise.all([pending, deletion]);
      const ledgers = await prisma.chatSendRequest.findMany();
      expect(ledgers).toHaveLength(1);
      for (const row of ledgers) {
        expect(row).toMatchObject({ status: "COMPLETE", conversationId: null, conversationBusinessProfileId: null });
        expect(row.response).toEqual({});
      }
      expect(await status(key)).toMatchObject({ status: "DELETED", result: null });
      expect(await prisma.chatMessage.count()).toBe(0);
    } finally { release.resolve(); await Promise.allSettled([pending, ...(deletion ? [deletion] : [])]); }
  });

  it("keeps the replay ledger behind deny-all RLS and zero client-role table privileges", async () => {
    const rows = await prisma.$queryRaw<Array<{ rls: boolean; policies: bigint; anon: boolean; authenticated: boolean }>>`
      SELECT c.relrowsecurity AS rls,
        (SELECT count(*) FROM pg_policy WHERE polrelid = c.oid) AS policies,
        has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS anon,
        has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS authenticated
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'ChatSendRequest'
    `;
    expect(rows).toEqual([{ rls: true, policies: 0n, anon: false, authenticated: false }]);
  });

  it("enforces the profile-owner and conversation-profile relationships in the ledger", async () => {
    const saved = await create(randomUUID());
    const other = await makeOwnerWithProfile();
    await expect(prisma.chatSendRequest.create({ data: { keyHash: "a".repeat(64), inputHash: "b".repeat(64), userId: other.user.id, businessProfileId: owner.profile.id } })).rejects.toMatchObject({ code: "P2003" });
    await expect(prisma.chatSendRequest.create({ data: { keyHash: "c".repeat(64), inputHash: "d".repeat(64), userId: other.user.id, businessProfileId: other.profile.id, conversationId: saved.conversation.id, conversationBusinessProfileId: other.profile.id } })).rejects.toMatchObject({ code: "P2003" });
    expect(await prisma.chatSendRequest.count()).toBe(1);
  });
});
