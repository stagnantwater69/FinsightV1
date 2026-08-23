import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AI Chat conversations, end to end over HTTP.
 *
 * The P0 case here is ownership isolation on all six routes: another owner's
 * conversation id must come back as a 404 with no body, never a 403 — a 403
 * would confirm the row exists, which is exactly the probe the project's
 * first non-negotiable forbids.
 *
 * The model itself is mocked. Nothing in this suite should reach Gemini or
 * OpenRouter (there are no API keys in .env.test), and mocking it also lets
 * the tests assert on WHICH prior turns were replayed into the prompt.
 */

const { authUserId, askSpy } = vi.hoisted(() => ({
  authUserId: { value: "" },
  askSpy: vi.fn(),
}));

vi.mock("../../src/config/supabase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/supabase")>();
  return {
    ...actual,
    supabaseAdmin: {
      auth: {
        getUser: async (token: string) =>
          token === "valid-token"
            ? { data: { user: { id: authUserId.value } }, error: null }
            : { data: { user: null }, error: new Error("bad token") },
      },
    },
  };
});

vi.mock("../../src/services/ai.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/ai.service")>();
  return { ...actual, askFinSight: askSpy };
});

import request from "supertest";
import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { resetRateLimits } from "../../src/middleware/rateLimit.middleware";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

const AUTH = ["Authorization", "Bearer valid-token"] as const;
const BASE = "/api/v1/ai/conversations";

let alice: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
let mallory: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

/** Authenticates the next requests as this owner. */
function actAs(owner: Awaited<ReturnType<typeof makeOwnerWithProfile>>) {
  authUserId.value = owner.user.authId;
}

async function startConversation(question = "Why were my expenses higher this month?") {
  const response = await request(app)
    .post(BASE)
    .set(...AUTH)
    .send({ businessProfileId: alice.profile.id, originModule: "Dashboard", question });
  expect(response.status).toBe(201);
  return response.body;
}

beforeEach(async () => {
  await resetDb();
  // The send routes share /ask's burst limiter, and ids restart with the
  // database — without this, buckets from earlier tests would 429 later ones.
  resetRateLimits();
  askSpy.mockReset();
  askSpy.mockResolvedValue({ answer: "Your Inventory spending rose.", provider: "gemini" });
  alice = await makeOwnerWithProfile({ name: "Alice's Store" }, ["Inventory"]);
  mallory = await makeOwnerWithProfile({ name: "Mallory's Store" }, ["Inventory"]);
  actAs(alice);
});

afterAll(disconnectDb);

describe("creating and continuing a conversation", () => {
  it("creates the conversation and both messages in one exchange", async () => {
    const body = await startConversation("Why were my expenses higher this month?");

    expect(body.conversation.title).toBe("Why were my expenses higher this month?");
    expect(body.conversation.originModule).toBe("Dashboard");
    expect(body.userMessage).toMatchObject({ role: "user", content: "Why were my expenses higher this month?" });
    expect(body.assistantMessage).toMatchObject({ role: "assistant", content: "Your Inventory spending rose." });
    expect(body.provider).toBe("gemini");
    expect(body.detectedAmount).toBeNull();

    expect(await prisma.chatMessage.count({ where: { conversationId: body.conversation.id } })).toBe(2);
  });

  it("derives a title from the question when the client sends none", async () => {
    const question = `${"spending ".repeat(40)}question?`;
    const body = await startConversation(question);
    expect(body.conversation.title.length).toBeLessThanOrEqual(120);
    expect(body.conversation.title.endsWith("spending")).toBe(true);
  });

  it("returns the conversation with its messages oldest first", async () => {
    const created = await startConversation();
    await request(app)
      .post(`${BASE}/${created.conversation.id}/messages`)
      .set(...AUTH)
      .send({ question: "Which category moved the most?" })
      .expect(201);

    const detail = await request(app)
      .get(`${BASE}/${created.conversation.id}`)
      .set(...AUTH);

    expect(detail.status).toBe(200);
    expect(detail.body.messages).toHaveLength(4);
    expect(detail.body.messages.map((m: { role: string }) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(detail.body.messages[2].content).toBe("Which category moved the most?");
  });

  it("advances lastMessageAt when a message is appended", async () => {
    const created = await startConversation();
    const before = new Date(created.conversation.lastMessageAt).getTime();

    // A conversation created and continued in the same millisecond would make
    // the assertion vacuous.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const sent = await request(app)
      .post(`${BASE}/${created.conversation.id}/messages`)
      .set(...AUTH)
      .send({ question: "And what about utilities?" });

    expect(sent.status).toBe(201);
    expect(new Date(sent.body.conversation.lastMessageAt).getTime()).toBeGreaterThan(before);

    const list = await request(app)
      .get(BASE)
      .set(...AUTH)
      .query({ businessProfileId: alice.profile.id });
    expect(list.status).toBe(200);
    expect(list.body[0].id).toBe(created.conversation.id);
    // The list carries no messages — the sidebar only needs titles.
    expect(list.body[0].messages).toBeUndefined();
  });

  it("lists conversations newest activity first", async () => {
    const first = await startConversation("First thread");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await startConversation("Second thread");

    const list = await request(app)
      .get(BASE)
      .set(...AUTH)
      .query({ businessProfileId: alice.profile.id });

    expect(list.body.map((c: { id: number }) => c.id)).toEqual([second.conversation.id, first.conversation.id]);
  });

  it("threads THIS conversation's own turns, and not another thread's", async () => {
    const kept = await startConversation("Why were my expenses higher this month?");
    // A separate thread whose turns must never leak into the first one.
    await startConversation("Completely unrelated question about sales?");

    askSpy.mockClear();
    await request(app)
      .post(`${BASE}/${kept.conversation.id}/messages`)
      .set(...AUTH)
      .send({ question: "Which category moved the most?" })
      .expect(201);

    const input = askSpy.mock.calls[0][0];
    expect(input.priorTurns).toEqual([
      { question: "Why were my expenses higher this month?", answer: "Your Inventory spending rose." },
    ]);
    expect(JSON.stringify(input.priorTurns)).not.toContain("unrelated question about sales");
    // Context is rebuilt fresh from the owner's data, never replayed from the
    // earlier turn — the newest message is the only one carrying figures.
    expect(input.context).toContain("BUSINESS PROFILE");
  });

  it("replays at most the last six turns", async () => {
    const created = await startConversation("Turn 0?");
    for (let i = 1; i <= 8; i += 1) {
      await request(app)
        .post(`${BASE}/${created.conversation.id}/messages`)
        .set(...AUTH)
        .send({ question: `Turn ${i}?` })
        .expect(201);
    }

    const lastCall = askSpy.mock.calls[askSpy.mock.calls.length - 1][0];
    expect(lastCall.priorTurns).toHaveLength(6);
    expect(lastCall.priorTurns[5].question).toBe("Turn 7?");
  });
});

describe("rename and delete", () => {
  it("renames a conversation", async () => {
    const created = await startConversation();
    const renamed = await request(app)
      .patch(`${BASE}/${created.conversation.id}`)
      .set(...AUTH)
      .send({ title: "Utilities deep dive" });

    expect(renamed.status).toBe(200);
    expect(renamed.body.title).toBe("Utilities deep dive");
  });

  it("rejects an empty or whitespace-only title", async () => {
    const created = await startConversation();
    for (const title of ["", "   "]) {
      const response = await request(app)
        .patch(`${BASE}/${created.conversation.id}`)
        .set(...AUTH)
        .send({ title });
      expect(response.status).toBe(400);
    }

    const unchanged = await prisma.conversation.findUniqueOrThrow({ where: { id: created.conversation.id } });
    expect(unchanged.title).toBe(created.conversation.title);
  });

  it("rejects a title longer than the column allows", async () => {
    const created = await startConversation();
    const response = await request(app)
      .patch(`${BASE}/${created.conversation.id}`)
      .set(...AUTH)
      .send({ title: "x".repeat(121) });
    expect(response.status).toBe(400);
  });

  it("deletes the conversation and cascades to its messages", async () => {
    const created = await startConversation();
    await request(app)
      .post(`${BASE}/${created.conversation.id}/messages`)
      .set(...AUTH)
      .send({ question: "And utilities?" })
      .expect(201);

    const deleted = await request(app)
      .delete(`${BASE}/${created.conversation.id}`)
      .set(...AUTH);
    expect(deleted.status).toBe(204);

    expect(await prisma.conversation.count({ where: { id: created.conversation.id } })).toBe(0);
    expect(await prisma.chatMessage.count({ where: { conversationId: created.conversation.id } })).toBe(0);
  });
});

describe("ownership isolation", () => {
  /*
   * Every route, one case each. 404 rather than 403 throughout: the two are
   * indistinguishable to an attacker probing for ids, which is the point.
   */
  it("hides another owner's conversation from GET, PATCH, DELETE and send", async () => {
    const aliceThread = await startConversation("Alice's private question about her margins?");
    actAs(mallory);

    const read = await request(app)
      .get(`${BASE}/${aliceThread.conversation.id}`)
      .set(...AUTH);
    expect(read.status).toBe(404);
    expect(JSON.stringify(read.body)).not.toContain("Alice's private question");

    const renamed = await request(app)
      .patch(`${BASE}/${aliceThread.conversation.id}`)
      .set(...AUTH)
      .send({ title: "Mine now" });
    expect(renamed.status).toBe(404);

    const sent = await request(app)
      .post(`${BASE}/${aliceThread.conversation.id}/messages`)
      .set(...AUTH)
      .send({ question: "Tell me about this?" });
    expect(sent.status).toBe(404);

    const deleted = await request(app)
      .delete(`${BASE}/${aliceThread.conversation.id}`)
      .set(...AUTH);
    expect(deleted.status).toBe(404);

    // Nothing was read, renamed, appended to or destroyed.
    const untouched = await prisma.conversation.findUniqueOrThrow({
      where: { id: aliceThread.conversation.id },
    });
    expect(untouched.title).toBe(aliceThread.conversation.title);
    expect(await prisma.chatMessage.count({ where: { conversationId: untouched.id } })).toBe(2);
  });

  it("refuses to list or create against a business profile the caller does not own", async () => {
    await startConversation("Alice's thread");
    actAs(mallory);

    const list = await request(app)
      .get(BASE)
      .set(...AUTH)
      .query({ businessProfileId: alice.profile.id });
    expect(list.status).toBe(404);

    const created = await request(app)
      .post(BASE)
      .set(...AUTH)
      .send({ businessProfileId: alice.profile.id, originModule: "Dashboard", question: "Let me in?" });
    expect(created.status).toBe(404);

    expect(await prisma.conversation.count({ where: { businessProfileId: alice.profile.id } })).toBe(1);
  });

  it("keeps another owner's conversations out of a legitimate list", async () => {
    await startConversation("Alice's thread");
    actAs(mallory);

    const list = await request(app)
      .get(BASE)
      .set(...AUTH)
      .query({ businessProfileId: mallory.profile.id });

    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
  });

  it("requires authentication", async () => {
    const response = await request(app).get(BASE).query({ businessProfileId: alice.profile.id });
    expect(response.status).toBe(401);
  });
});
