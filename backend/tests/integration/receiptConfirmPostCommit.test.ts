import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P2-6. The confirmation transaction commits the expense records and flips the
 * scan to Confirmed, then runs a tail of effects outside it: the duplicate and
 * large-expense notifications, the analysis job, and the extraction-feedback
 * ledger. None of those is part of the books. If one of them threw, the owner
 * got a 500 for a receipt that was already booked, retried, and was told it
 * had "already been confirmed" with no way to tell which answer was true.
 *
 * Each effect is injected to fail on its own so a regression in any one of
 * them is named by the failing case rather than hidden behind the others.
 */
const { effects, hold } = vi.hoisted(() => ({
  effects: {
    notification: { fail: false, calls: 0 },
    analysis: { fail: false, calls: 0 },
    feedback: { fail: false, calls: 0 },
  },
  hold: { notification: null as null | Promise<void> },
}));

vi.mock("../../src/services/notification.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/notification.service")>();
  return {
    ...actual,
    createNotification: async (...args: Parameters<typeof actual.createNotification>) => {
      effects.notification.calls += 1;
      if (hold.notification) await hold.notification;
      if (effects.notification.fail) throw new Error("simulated notification write failure");
      return actual.createNotification(...args);
    },
  };
});

vi.mock("../../src/services/anomalyDetection/job.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/anomalyDetection/job.service")>();
  return {
    ...actual,
    enqueueExpenseAnalysis: async (...args: Parameters<typeof actual.enqueueExpenseAnalysis>) => {
      effects.analysis.calls += 1;
      if (effects.analysis.fail) throw new Error("simulated analysis queue failure");
      return actual.enqueueExpenseAnalysis(...args);
    },
  };
});

vi.mock("../../src/services/extractionFeedback.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/extractionFeedback.service")>();
  return {
    ...actual,
    recordConfirmationFeedback: async (...args: Parameters<typeof actual.recordConfirmationFeedback>) => {
      effects.feedback.calls += 1;
      if (effects.feedback.fail) throw new Error("simulated feedback ledger failure");
      return actual.recordConfirmationFeedback(...args);
    },
  };
});

const { authUserId } = vi.hoisted(() => ({ authUserId: { value: "" } }));
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

import request from "supertest";
import { app } from "../../src/app";
import { logger } from "../../src/config/logger";
import { prisma } from "../../src/config/prisma";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const AUTH = ["Authorization", "Bearer valid-token"] as const;
const VENDOR = "Sari-sari Wholesale Depot";
// Above the default large-expense threshold (125000 * 25% = 31250), so the
// large-expense notification fires on a manual single-split confirm.
const LARGE_AMOUNT = 40000;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({}, ["Inventory", "Utilities"]);
  authUserId.value = ctx.user.authId;
  for (const effect of Object.values(effects)) {
    effect.fail = false;
    effect.calls = 0;
  }
  hold.notification = null;
  vi.restoreAllMocks();
});

afterAll(disconnectDb);

async function makeReadScan(items: { name: string; amount: number }[] = []) {
  return prisma.receiptScan.create({
    data: {
      businessProfileId: ctx.profile.id,
      imageFile: `${ctx.profile.id}/receipt.jpg`,
      confirmationStatus: "Pending",
      processingStatus: "Complete",
      extractedVendor: VENDOR,
      extractedAmount: LARGE_AMOUNT,
      items: {
        create: items.map((item, index) => ({ lineNumber: index + 1, name: item.name, amount: item.amount })),
      },
    },
    include: { items: { orderBy: { lineNumber: "asc" } } },
  });
}

function confirm(scanId: number, body: Record<string, unknown>) {
  return request(app)
    .post(`/api/v1/records/receipts/${scanId}/confirm`)
    .set(...AUTH)
    .send({ date: "2026-07-20", description: "Stock purchase", vendor: VENDOR, ...body });
}

const manualBody = () => ({
  amount: LARGE_AMOUNT,
  splits: [{ categoryId: ctx.categories.Inventory, amount: LARGE_AMOUNT }],
});

/** Same day, total and merchant: what makes the POSSIBLE_DUPLICATE branch run. */
async function priorMatchingExpense(amount: number) {
  return prisma.expenseRecord.create({
    data: {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: new Date("2026-07-20T00:00:00.000Z"),
      description: "Earlier stock purchase",
      vendor: VENDOR,
      amount,
      source: "MANUAL_ENTRY",
    },
  });
}

/** The pre-save review answers 409 for the prior match; acknowledge it and save anyway. */
async function confirmAcknowledgingDuplicates(scanId: number, body: Record<string, unknown>) {
  const first = await confirm(scanId, body);
  if (first.status !== 409 || first.body.code !== "DUPLICATE_REVIEW_REQUIRED") return first;
  expect(first.body.candidates.length).toBeGreaterThan(0);
  return confirm(scanId, {
    ...body,
    duplicateDecision: { action: "SAVE_ANYWAY", candidateSetHash: first.body.candidateSetHash },
  });
}

async function expectBookedOnce(scanId: number, expectedRecords: number, expectedTotal: number) {
  const records = await prisma.expenseRecord.findMany({ where: { receiptScanId: scanId } });
  expect(records).toHaveLength(expectedRecords);
  expect(records.reduce((sum, r) => sum + Number(r.amount), 0)).toBe(expectedTotal);
  expect(await prisma.expenseRecord.count()).toBe(expectedRecords);
  expect(await prisma.receiptScan.findUniqueOrThrow({ where: { id: scanId } })).toMatchObject({
    confirmationStatus: "Confirmed",
  });
}

async function expectRetryRefusedWithoutWriting(scanId: number, body: Record<string, unknown>, expectedRecords: number) {
  const retry = await confirm(scanId, body);
  expect(retry.status).toBe(400);
  expect(retry.body.error).toMatch(/already been confirmed/i);
  expect(await prisma.expenseRecord.count()).toBe(expectedRecords);
}

describe("a noncritical post-commit effect that fails", () => {
  it("notification write: the committed records are returned, not a 500, and the retry writes nothing", async () => {
    const scan = await makeReadScan();
    const logged = vi.spyOn(logger, "error");
    effects.notification.fail = true;

    const response = await confirm(scan.id, manualBody());

    expect(response.status).toBe(201);
    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toMatchObject({ receiptScanId: scan.id, largeExpenseFlag: true });
    expect(effects.notification.calls).toBe(1);
    await expectBookedOnce(scan.id, 1, LARGE_AMOUNT);
    // The notification itself is lost, and the loss is the only thing that is.
    expect(await prisma.notification.count()).toBe(0);

    // Observable: logged with identifiers a support engineer can look up, and
    // nothing off the receipt.
    const entry = logged.mock.calls.find(([fields]) =>
      typeof fields === "object" && fields !== null && "receiptScanId" in fields);
    expect(entry, "a failed post-commit effect must be logged").toBeDefined();
    expect(entry![0]).toMatchObject({
      receiptScanId: scan.id,
      code: "RECEIPT_CONFIRM_POST_COMMIT_EFFECT_FAILED",
    });
    const serialised = JSON.stringify(entry, (_key, value) => (value instanceof Error ? value.message : value));
    expect(serialised).not.toMatch(new RegExp(VENDOR));
    expect(serialised).not.toContain(String(LARGE_AMOUNT));
    expect(serialised).not.toContain("Stock purchase");

    await expectRetryRefusedWithoutWriting(scan.id, manualBody(), 1);
  });

  it("possible-duplicate notification: the flagged record is still returned and the retry writes nothing", async () => {
    const prior = await priorMatchingExpense(LARGE_AMOUNT);
    const scan = await makeReadScan();
    effects.notification.fail = true;

    const response = await confirmAcknowledgingDuplicates(scan.id, manualBody());

    expect(response.status).toBe(201);
    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toMatchObject({
      receiptScanId: scan.id,
      duplicateStatus: "Flagged",
      duplicateOfRecordId: prior.id,
      largeExpenseFlag: true,
    });
    // The duplicate notification is first in the tail and throws, so the
    // large-expense one after it is never attempted; both are lost, nothing else is.
    expect(effects.notification.calls).toBe(1);
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.expenseRecord.count()).toBe(2);
    expect(await prisma.expenseRecord.findMany({ where: { receiptScanId: scan.id } })).toHaveLength(1);
    expect(await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } })).toMatchObject({
      confirmationStatus: "Confirmed",
    });

    const retry = await confirm(scan.id, manualBody());
    expect(retry.status).toBe(400);
    expect(retry.body.error).toMatch(/already been confirmed/i);
    expect(await prisma.expenseRecord.count()).toBe(2);
  });

  it("analysis queueing: the committed records are returned and the retry writes nothing", async () => {
    const scan = await makeReadScan();
    effects.analysis.fail = true;

    const response = await confirm(scan.id, manualBody());

    expect(response.status).toBe(201);
    expect(effects.analysis.calls).toBe(1);
    await expectBookedOnce(scan.id, 1, LARGE_AMOUNT);
    expect(await prisma.analysisJob.count()).toBe(0);
    // The notification before it in the same tail still landed.
    expect(await prisma.notification.count()).toBe(1);

    await expectRetryRefusedWithoutWriting(scan.id, manualBody(), 1);
  });

  it("confirmation feedback: the committed records are returned and the retry writes nothing", async () => {
    const scan = await makeReadScan([{ name: "Rice 25kg", amount: LARGE_AMOUNT }]);
    const body = {
      amount: LARGE_AMOUNT,
      itemAssignments: [{ itemId: scan.items[0]!.id, categoryId: ctx.categories.Inventory }],
    };
    effects.feedback.fail = true;

    const response = await confirm(scan.id, body);

    expect(response.status).toBe(201);
    expect(effects.feedback.calls).toBe(1);
    await expectBookedOnce(scan.id, 1, LARGE_AMOUNT);
    expect(await prisma.receiptFieldCorrection.count()).toBe(0);
    // Effects earlier in the tail were not skipped because a later one failed.
    expect(await prisma.notification.count()).toBe(1);
    expect(await prisma.analysisJob.count()).toBe(1);

    await expectRetryRefusedWithoutWriting(scan.id, body, 1);
  });

  it("all three at once, on a two-category itemised receipt: every record is still returned once", async () => {
    const scan = await makeReadScan([
      { name: "Rice 25kg", amount: 30000 },
      { name: "Electricity", amount: 10000 },
    ]);
    const [rice, electricity] = scan.items;
    // Matches the Inventory split (30050) on date, amount and merchant. Neither
    // split crosses the 31250 large-expense threshold, so this is the only
    // thing that makes the notification injection fire.
    const prior = await priorMatchingExpense(30050);
    const body = {
      amount: LARGE_AMOUNT + 50,
      itemAssignments: [
        { itemId: rice!.id, categoryId: ctx.categories.Inventory },
        { itemId: electricity!.id, categoryId: ctx.categories.Utilities },
      ],
      additionalItems: [{ name: "Bagged ice", amount: 50, categoryId: ctx.categories.Inventory }],
    };
    effects.notification.fail = true;
    effects.analysis.fail = true;
    effects.feedback.fail = true;

    const response = await confirmAcknowledgingDuplicates(scan.id, body);

    expect(response.status).toBe(201);
    expect(response.body).toHaveLength(2);
    const inventory = response.body.find((row: { categoryId: number }) => row.categoryId === ctx.categories.Inventory);
    const utilities = response.body.find((row: { categoryId: number }) => row.categoryId === ctx.categories.Utilities);
    expect(inventory).toMatchObject({ amount: 30050, duplicateStatus: "Flagged", duplicateOfRecordId: prior.id });
    expect(utilities).toMatchObject({ amount: 10000, duplicateStatus: "Not a Duplicate" });
    const booked = await prisma.expenseRecord.findMany({ where: { receiptScanId: scan.id } });
    expect(booked).toHaveLength(2);
    expect(booked.reduce((sum, r) => sum + Number(r.amount), 0)).toBe(LARGE_AMOUNT + 50);
    expect(await prisma.expenseRecord.count()).toBe(3);
    expect(await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } })).toMatchObject({
      confirmationStatus: "Confirmed",
    });
    // The first record's failed notification stops the rest of its own tail
    // (its analysis enqueue never runs) but not the second record's tail or
    // the feedback ledger. Pinned as shipped; changing it should be deliberate.
    expect(effects.notification.calls).toBe(1);
    expect(effects.analysis.calls).toBe(1);
    expect(effects.feedback.calls).toBe(1);
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.analysisJob.count()).toBe(0);
    const items = await prisma.receiptScanItem.findMany({ where: { receiptScanId: scan.id } });
    expect(items).toHaveLength(3);
    expect(items.every((item) => item.expenseRecordId !== null)).toBe(true);

    const retry = await confirm(scan.id, body);
    expect(retry.status).toBe(400);
    expect(retry.body.error).toMatch(/already been confirmed/i);
    expect(await prisma.expenseRecord.count()).toBe(3);
  });

  it("a retry that lands while the tail is still running finds the scan already confirmed", async () => {
    const scan = await makeReadScan();
    let release: (() => void) | null = null;
    hold.notification = new Promise<void>((resolve) => {
      release = resolve;
    });
    effects.notification.fail = true;

    const first = confirm(scan.id, manualBody()).then((r) => r);
    // Wait until the first request is parked inside the notification write,
    // which means its transaction has already committed.
    for (let i = 0; i < 50 && effects.notification.calls === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(effects.notification.calls).toBe(1);

    const second = await confirm(scan.id, manualBody());
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/already been confirmed/i);

    release!();
    const response = await first;
    expect(response.status).toBe(201);
    await expectBookedOnce(scan.id, 1, LARGE_AMOUNT);
  });
});

describe("with every post-commit effect healthy", () => {
  it("still lands the notification, the analysis job and the feedback rows exactly once", async () => {
    const scan = await makeReadScan([{ name: "Rice 25kg", amount: LARGE_AMOUNT }]);
    const response = await confirm(scan.id, {
      amount: LARGE_AMOUNT,
      itemAssignments: [{ itemId: scan.items[0]!.id, categoryId: ctx.categories.Inventory }],
    });
    expect(response.status).toBe(201);
    expect(await prisma.notification.count()).toBe(1);
    expect(await prisma.analysisJob.count()).toBe(1);
    expect(await prisma.receiptFieldCorrection.count({ where: { receiptScanId: scan.id } })).toBeGreaterThan(0);
  });

  it("sends both the possible-duplicate and the large-expense notification for one flagged record", async () => {
    const prior = await priorMatchingExpense(LARGE_AMOUNT);
    const scan = await makeReadScan();

    const response = await confirmAcknowledgingDuplicates(scan.id, manualBody());

    expect(response.status).toBe(201);
    expect(response.body[0]).toMatchObject({ duplicateStatus: "Flagged", duplicateOfRecordId: prior.id });
    const notifications = await prisma.notification.findMany({ orderBy: { id: "asc" } });
    expect(notifications.map((row) => row.type)).toEqual(["Possible Duplicate", "Large Expense Flag"]);
    expect(notifications.every((row) => row.expenseRecordId === response.body[0].id)).toBe(true);
  });
});
