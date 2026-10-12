import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AnomalyFindingSeverity, AnomalyFindingStatus, AnomalyFindingType } from "@prisma/client";

/**
 * Ask FinSight grounding, over HTTP.
 *
 * The security cases (C5): a focus, a record link or a feedback write can only
 * ever touch the asking owner's own rows. Another owner's finding id 404s
 * before a conversation is created or a model is called; a record tag the
 * model invents — including one naming another owner's real record — never
 * becomes a link; and the period a question names changes which rows the
 * context reads.
 *
 * The model is mocked, so the tests can both script its answer and read the
 * CONTEXT it was given.
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

type Owner = Awaited<ReturnType<typeof makeOwnerWithProfile>>;
let alice: Owner;
let mallory: Owner;

function actAs(owner: Owner) {
  authUserId.value = owner.user.authId;
}

function addExpense(owner: Owner, description: string, amount: number, date: string) {
  return prisma.expenseRecord.create({
    data: {
      businessProfileId: owner.profile.id,
      categoryId: owner.categories.Inventory!,
      date: new Date(`${date}T00:00:00.000Z`),
      description,
      amount,
      source: "MANUAL_ENTRY",
    },
  });
}

function addFinding(owner: Owner, expenseRecordId: number, title: string, status: AnomalyFindingStatus = AnomalyFindingStatus.OPEN) {
  return prisma.anomalyFinding.create({
    data: {
      businessProfileId: owner.profile.id,
      expenseRecordId,
      fingerprint: `amount-outlier-v1:${title}`,
      type: AnomalyFindingType.AMOUNT_OUTLIER,
      method: "z-score-iqr",
      severity: AnomalyFindingSeverity.MEDIUM,
      title,
      reasons: ["Detected by iqr", "The category baseline average is 305.14"],
      metadata: { categoryMean: 305.14, historyCount: 7 },
      detectorVersion: "amount-outlier-v1",
      status,
    },
  });
}

/** The CONTEXT block of the most recent model call. */
function lastContext(): string {
  return askSpy.mock.calls.at(-1)![0].context as string;
}

beforeEach(async () => {
  await resetDb();
  resetRateLimits();
  askSpy.mockReset();
  askSpy.mockResolvedValue({ answer: "Here's what I see.", provider: "gemini" });
  alice = await makeOwnerWithProfile({ name: "Alice's Store" }, ["Inventory"]);
  mallory = await makeOwnerWithProfile({ name: "Mallory's Store" }, ["Inventory"]);
  actAs(alice);
});

afterAll(disconnectDb);

describe("Explain this flag — the focused finding", () => {
  it("puts the flag the owner opened first, in plain language, with its review actions", async () => {
    const meals = await addExpense(alice, "Team lunch", 900, "2026-09-20");
    const fries = await addExpense(alice, "Frozen fries x5", 550, "2026-09-21");
    const focused = await addFinding(alice, meals.id, "Unusual Business Meals expense");
    await addFinding(alice, fries.id, "Unusual Raw Materials expense");

    const response = await request(app)
      .post(BASE)
      .set(...AUTH)
      .send({
        businessProfileId: alice.profile.id,
        originModule: "Records Review",
        question: "Why was this flagged?",
        focus: { kind: "finding", findingId: focused.id },
      })
      .expect(201);

    const context = lastContext();
    const focusBlock = context.slice(context.indexOf("=== THE FLAG THE OWNER IS ASKING ABOUT ==="));
    expect(focusBlock).toContain("Unusual Business Meals expense");
    expect(focusBlock).toContain(`"Team lunch" PHP 900.00`);
    expect(context.indexOf("Team lunch")).toBeLessThan(context.indexOf("Frozen fries"));
    // Detector shorthand never reaches the model.
    expect(context).not.toMatch(/Detected by iqr|baseline average|z-score/i);
    expect(context).toContain("Well outside the usual range of amounts for this category");

    expect(response.body.assistantMessage.metadata.actions).toEqual([
      expect.objectContaining({ kind: "review-finding", findingId: focused.id, feedback: "CONFIRMED_UNUSUAL" }),
      expect.objectContaining({ kind: "review-finding", findingId: focused.id, feedback: "EXPECTED_TRANSACTION" }),
    ]);
  });

  it("404s another owner's finding before creating anything or calling the model", async () => {
    const theirs = await addExpense(mallory, "Mallory secret purchase", 5000, "2026-09-20");
    const finding = await addFinding(mallory, theirs.id, "MALLORY SECRET FLAG");

    const response = await request(app)
      .post(BASE)
      .set(...AUTH)
      .send({
        businessProfileId: alice.profile.id,
        originModule: "Records Review",
        question: "Why was this flagged?",
        focus: { kind: "finding", findingId: finding.id },
      });

    expect(response.status).toBe(404);
    expect(askSpy).not.toHaveBeenCalled();
    expect(await prisma.conversation.count()).toBe(0);
  });

  it("404s another owner's record as a focus on a follow-up too", async () => {
    const created = await request(app)
      .post(BASE)
      .set(...AUTH)
      .send({ businessProfileId: alice.profile.id, originModule: "Records Review", question: "What needs review?" })
      .expect(201);
    const theirs = await addExpense(mallory, "Mallory secret purchase", 5000, "2026-09-20");

    await request(app)
      .post(`${BASE}/${created.body.conversation.id}/messages`)
      .set(...AUTH)
      .send({ question: "And this one?", focus: { kind: "record", recordType: "expense", recordId: theirs.id } })
      .expect(404);
  });

  it("keeps the focus on later messages, and lets a resolved flag drop out instead of failing", async () => {
    const meals = await addExpense(alice, "Team lunch", 900, "2026-09-20");
    const focused = await addFinding(alice, meals.id, "Unusual Business Meals expense");
    const created = await request(app)
      .post(BASE)
      .set(...AUTH)
      .send({
        businessProfileId: alice.profile.id,
        originModule: "Records Review",
        question: "Why was this flagged?",
        focus: { kind: "finding", findingId: focused.id },
      })
      .expect(201);

    await request(app).post(`${BASE}/${created.body.conversation.id}/messages`).set(...AUTH).send({ question: "Is that normal?" }).expect(201);
    expect(lastContext()).toContain("=== THE FLAG THE OWNER IS ASKING ABOUT ===");

    await prisma.anomalyFinding.update({ where: { id: focused.id }, data: { status: AnomalyFindingStatus.RESOLVED } });
    const after = await request(app)
      .post(`${BASE}/${created.body.conversation.id}/messages`)
      .set(...AUTH)
      .send({ question: "Anything else?" })
      .expect(201);
    // Still described (it exists and is the owner's) but no longer actionable.
    expect(after.body.assistantMessage.metadata.actions).toEqual([]);
  });
});

describe("record links", () => {
  it("links only records the context carried, never another owner's or an invented one", async () => {
    const meals = await addExpense(alice, "Team lunch", 900, "2026-09-20");
    const focused = await addFinding(alice, meals.id, "Unusual Business Meals expense");
    const theirs = await addExpense(mallory, "Mallory secret purchase", 5000, "2026-09-20");

    askSpy.mockResolvedValue({
      answer:
        `**Team lunch** [ref:e${meals.id}] was above your usual PHP 305.14. ` +
        `Compare [ref:e${theirs.id}] and [ref:e999999]. [page:review-queue]\nFOLLOW-UPS: Is that normal for me? | What did I spend in January?`,
      provider: "gemini",
    });

    const response = await request(app)
      .post(BASE)
      .set(...AUTH)
      .send({
        businessProfileId: alice.profile.id,
        originModule: "Records Review",
        question: "Give me a link to it",
        focus: { kind: "finding", findingId: focused.id },
      })
      .expect(201);

    const message = response.body.assistantMessage;
    expect(message.metadata.references).toEqual([
      { kind: "record", recordType: "expense", id: meals.id, label: "Team lunch", amount: 900, date: "2026-09-20" },
    ]);
    expect(message.metadata.pages).toEqual([{ key: "review-queue", label: "Needs review" }]);
    expect(message.metadata.followUps).toEqual(["Is that normal for me?", "What did I spend in January?"]);
    expect(message.content).not.toMatch(/\[(ref|page):/);
    expect(JSON.stringify(message)).not.toContain("Mallory");

    // A reopened conversation shows the same buttons.
    const detail = await request(app).get(`${BASE}/${response.body.conversation.id}`).set(...AUTH).expect(200);
    expect(detail.body.messages[1].metadata.references).toHaveLength(1);
  });

  it("trims a figure the model invented after one retry", async () => {
    askSpy
      .mockResolvedValueOnce({ answer: "You're PHP 594.86 over. Worth checking.", provider: "gemini" })
      .mockResolvedValueOnce({ answer: "You're PHP 594.86 over. Worth checking.", provider: "gemini" });

    const response = await request(app)
      .post(BASE)
      .set(...AUTH)
      .send({ businessProfileId: alice.profile.id, originModule: "Dashboard", question: "How far over am I?" })
      .expect(201);

    expect(askSpy).toHaveBeenCalledTimes(2);
    expect(askSpy.mock.calls[1]![0].revisionNote).toContain("594.86");
    expect(response.body.assistantMessage.content).toBe("Worth checking.");
    expect(response.body.assistantMessage.metadata.amountCheck).toBe("trimmed");
  });
});

describe("periods and record search", () => {
  it("grounds a question naming a month in that month, with server-computed totals for the item asked about", async () => {
    await addExpense(alice, "Frozen fries x5", 550, "2022-01-10");
    await addExpense(alice, "Frozen fries x3", 330, "2022-01-20");
    await addExpense(alice, "Frozen fries x9", 990, "2022-02-03");
    await addExpense(mallory, "Frozen fries MALLORY", 777, "2022-01-11");

    const response = await request(app)
      .post(BASE)
      .set(...AUTH)
      .send({ businessProfileId: alice.profile.id, originModule: "Dashboard", question: "How much did I spend on fries in January 2022?" })
      .expect(201);

    const context = lastContext();
    expect(context).toContain("=== FINANCIAL SNAPSHOT (January 2022) ===");
    expect(context).toContain('=== EXPENSE RECORDS MATCHING THE QUESTION (January 2022) ===');
    expect(context).toContain('Matching "fries": 2 record(s) totalling PHP 880.00');
    expect(context).not.toContain("x9");
    expect(context).not.toContain("MALLORY");
    expect(response.body.assistantMessage.metadata.period).toBe("January 2022");
  });
});

describe("feedback on a reply", () => {
  it("records and clears the owner's rating, and 404s anyone else", async () => {
    const created = await request(app)
      .post(BASE)
      .set(...AUTH)
      .send({ businessProfileId: alice.profile.id, originModule: "Dashboard", question: "How am I doing?" })
      .expect(201);
    const conversationId = created.body.conversation.id;
    const answerId = created.body.assistantMessage.id;
    const questionId = created.body.userMessage.id;

    const up = await request(app)
      .put(`${BASE}/${conversationId}/messages/${answerId}/feedback`)
      .set(...AUTH)
      .send({ feedback: "up" })
      .expect(200);
    expect(up.body.feedback).toBe("up");

    await request(app).put(`${BASE}/${conversationId}/messages/${questionId}/feedback`).set(...AUTH).send({ feedback: "down" }).expect(404);
    await request(app).put(`${BASE}/${conversationId}/messages/${answerId}/feedback`).set(...AUTH).send({ feedback: "meh" }).expect(400);

    actAs(mallory);
    const probe = await request(app).put(`${BASE}/${conversationId}/messages/${answerId}/feedback`).set(...AUTH).send({ feedback: "down" });
    expect(probe.status).toBe(404);

    actAs(alice);
    const cleared = await request(app)
      .put(`${BASE}/${conversationId}/messages/${answerId}/feedback`)
      .set(...AUTH)
      .send({ feedback: null })
      .expect(200);
    expect(cleared.body.feedback).toBeNull();
    expect((await prisma.chatMessage.findUniqueOrThrow({ where: { id: answerId } })).feedback).toBeNull();
  });
});
