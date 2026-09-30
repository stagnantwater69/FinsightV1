import { Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Confirming a receipt is the moment a photograph becomes money in the books,
 * and it used to be neither atomic nor exclusive.
 *
 * Two defects lived in the same function and produced the same symptom — a
 * receipt booked twice — from opposite directions:
 *
 *   - a second confirm arriving before the first had finished passed the
 *     read-only "already confirmed?" guard and wrote a whole second set of
 *     expense records, with neither copy flagged as a duplicate because the
 *     duplicate detector raced too;
 *   - a failure part-way through the record loop committed the records it had
 *     already written and left the scan Pending, so the owner's retry booked
 *     those first splits a second time.
 *
 * Both are financial data corruption with no trace in the data, which is why
 * they are pinned here rather than left to the general receipt suites.
 *
 * THE SEAM. `createExpenseRecordWithin` is wrapped so a test can hold one
 * confirm INSIDE its transaction, or make one fail there. That is the only
 * way to make the race deterministic: without it the two requests interleave
 * differently on every run, and the test would pass on a broken build most of
 * the time.
 */
const { createHook } = vi.hoisted(() => ({
  createHook: { calls: 0, before: null as null | ((call: number) => Promise<void>) },
}));

vi.mock("../../src/services/expenseRecord.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/expenseRecord.service")>();
  return {
    ...actual,
    createExpenseRecordWithin: async (...args: Parameters<typeof actual.createExpenseRecordWithin>) => {
      createHook.calls += 1;
      if (createHook.before) await createHook.before(createHook.calls);
      return actual.createExpenseRecordWithin(...args);
    },
  };
});

// Auth validates against a live Supabase project, so token resolution is the
// one thing mocked here; requireAuth's own logic still runs against the real
// user row created below.
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
import { prisma } from "../../src/config/prisma";
import { bulkResolveExpenseDuplicates, deleteExpenseRecord } from "../../src/services/expenseRecord.service";
import { requestReceiptScanDeletion } from "../../src/services/receiptPurge.service";
import { confirmReceipt } from "../../src/services/receiptScan.service";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const AUTH = ["Authorization", "Bearer valid-token"] as const;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({}, ["Inventory", "Utilities"]);
  authUserId.value = ctx.user.authId;
  createHook.calls = 0;
  createHook.before = null;
});

afterAll(disconnectDb);

/**
 * A scan in exactly the state the confirm screen is shown for: read, not yet
 * confirmed. Written with Prisma rather than through the upload so the test
 * sets up the state it needs without depending on the OCR pipeline.
 */
async function makeReadScan(
  items: { name: string; amount: number }[] = [],
  businessProfileId: number = ctx.profile.id,
) {
  return prisma.receiptScan.create({
    data: {
      businessProfileId,
      imageFile: `${businessProfileId}/receipt.jpg`,
      confirmationStatus: "Pending",
      processingStatus: "Complete",
      items: {
        create: items.map((item, index) => ({ lineNumber: index + 1, name: item.name, amount: item.amount })),
      },
    },
    include: { items: { orderBy: { lineNumber: "asc" } } },
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForBlockedQuery(
  fragment: string,
  timeoutMs = 3_000,
): Promise<{ pid: number; blockingPids: number[] }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ pid: number; blockingPids: number[] }>>`
      SELECT pid, pg_blocking_pids(pid) AS "blockingPids"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query LIKE ${`%${fragment}%`}
    `;
    const blocked = rows.find((row) => row.blockingPids.length > 0);
    if (blocked) return blocked;
    await sleep(10);
  }
  throw new Error(`no PostgreSQL lock wait observed for ${fragment}`);
}

async function within<T>(promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`operation exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function holdConfirmationAtFirstRecord() {
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  createHook.before = async (call) => {
    if (call !== 1) return;
    entered!();
    await held;
  };
  return { reached, release: () => release!() };
}

type PausedTransactionQuery = {
  acquired: Promise<number>;
  resume(): void;
  restore(): void;
};

function rawQueryText(value: unknown): string {
  if (Array.isArray(value)) return value.join("");
  if (value && typeof value === "object" && "strings" in value) {
    const strings = (value as { strings?: unknown }).strings;
    if (Array.isArray(strings)) return strings.join("");
  }
  return "";
}

function pauseAfterTransactionQuery(
  property: "$executeRaw" | "$queryRaw",
  fragment: string,
): PausedTransactionQuery {
  let acquired!: (pid: number) => void;
  let resume!: () => void;
  const acquiredPromise = new Promise<number>((resolve) => { acquired = resolve; });
  const resumePromise = new Promise<void>((resolve) => { resume = resolve; });
  const originalTransaction = prisma.$transaction.bind(prisma);
  let paused = false;
  const spy = vi.spyOn(prisma, "$transaction").mockImplementation((async (...args: unknown[]) => {
    const operation = args[0];
    if (typeof operation !== "function") {
      return (originalTransaction as (...transactionArgs: unknown[]) => Promise<unknown>)(...args);
    }
    return (originalTransaction as (...transactionArgs: unknown[]) => Promise<unknown>)(
      async (tx: Prisma.TransactionClient) => {
        const proxied = new Proxy(tx, {
          get(target, key) {
            const value = Reflect.get(target, key, target);
            if (key !== property || typeof value !== "function") {
              return typeof value === "function" ? value.bind(target) : value;
            }
            return async (...queryArgs: unknown[]) => {
              const result = await (value as (...rawArgs: unknown[]) => Promise<unknown>).apply(target, queryArgs);
              if (!paused && rawQueryText(queryArgs[0]).includes(fragment)) {
                paused = true;
                const pids = await target.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                acquired(pids[0]?.pid ?? -1);
                await resumePromise;
              }
              return result;
            };
          },
        });
        return (operation as (client: Prisma.TransactionClient) => Promise<unknown>)(proxied);
      },
      args[1],
    );
  }) as typeof prisma.$transaction);
  return { acquired: acquiredPromise, resume, restore: () => spy.mockRestore() };
}

function confirmPendingScan(scanId: number) {
  return confirmReceipt(ctx.user.id, scanId, {
    date: "2026-07-20",
    description: "Fresh confirmed purchase",
    amount: 620,
    splits: [{ categoryId: ctx.categories.Inventory!, amount: 620 }],
  });
}

describe("two confirms of the same receipt at once", () => {
  it("books the receipt once and answers the loser 409 instead of writing a second set of records", async () => {
    const scan = await makeReadScan();
    const barrier = holdConfirmationAtFirstRecord();
    const pending: Promise<unknown>[] = [];

    const confirm = () =>
      request(app)
        .post(`/api/v1/records/receipts/${scan.id}/confirm`)
        .set(...AUTH)
        .send({
          date: "2026-07-20",
          description: "Purchase from ABC Store",
          amount: 1220,
          splits: [{ categoryId: ctx.categories.Inventory, amount: 1220 }],
        })
        // supertest only dispatches once the request is awaited, and this test
        // needs both in flight at the same time.
        .then((response) => response);

    try {
      const winner = confirm();
      pending.push(winner);
      await within(barrier.reached);
      const loser = confirm();
      pending.push(loser);
      await waitForBlockedQuery("pg_advisory_xact_lock");
      barrier.release();

      const [first, second] = await within(Promise.all([winner, loser]));
      expect(first.status).toBe(201);
      expect(second.status).toBe(409);
      expect(second.body.error).toMatch(/already being confirmed/i);

      const records = await prisma.expenseRecord.findMany({ where: { receiptScanId: scan.id } });
      expect(records).toHaveLength(1);
      expect(Number(records[0]!.amount)).toBe(1220);
      expect(await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } })).toMatchObject({
        confirmationStatus: "Confirmed",
      });
    } finally {
      barrier.release();
      await Promise.allSettled(pending);
    }
  });

  it("still answers a plainly repeated confirm with the 400 that names it", async () => {
    const scan = await makeReadScan();
    const body = {
      date: "2026-07-20",
      description: "Purchase from ABC Store",
      amount: 500,
      splits: [{ categoryId: ctx.categories.Inventory, amount: 500 }],
    };

    const first = await request(app).post(`/api/v1/records/receipts/${scan.id}/confirm`).set(...AUTH).send(body);
    expect(first.status).toBe(201);

    const second = await request(app).post(`/api/v1/records/receipts/${scan.id}/confirm`).set(...AUTH).send(body);
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/already been confirmed/i);
    expect(await prisma.expenseRecord.count()).toBe(1);
  });
});

describe("a confirm that fails part-way through", () => {
  it("leaves no expense records behind and the scan still Pending, so the retry cannot double-book", async () => {
    const scan = await makeReadScan([
      { name: "Rice 25kg", amount: 1000 },
      { name: "Electricity", amount: 220 },
    ]);
    const [rice, electricity] = scan.items;

    // Two categories means two splits; the second one fails, after the first
    // has already been written.
    createHook.before = async (call) => {
      if (call === 2) throw new Error("simulated failure writing the second split");
    };

    const response = await request(app)
      .post(`/api/v1/records/receipts/${scan.id}/confirm`)
      .set(...AUTH)
      .send({
        date: "2026-07-20",
        description: "Purchase from ABC Store",
        amount: 1220,
        itemAssignments: [
          { itemId: rice!.id, categoryId: ctx.categories.Inventory },
          { itemId: electricity!.id, categoryId: ctx.categories.Utilities },
        ],
      });

    expect(response.status).toBe(500);
    expect(createHook.calls).toBe(2); // the failure really was mid-loop

    // Nothing partial survives: no orphan record, no half-linked item, and a
    // scan the owner can confirm again exactly once.
    expect(await prisma.expenseRecord.count()).toBe(0);
    expect(await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } })).toMatchObject({
      confirmationStatus: "Pending",
    });
    const items = await prisma.receiptScanItem.findMany({ where: { receiptScanId: scan.id } });
    expect(items.map((item) => item.expenseRecordId)).toEqual([null, null]);

    // And the retry books the receipt ONCE, not twice.
    createHook.before = null;
    const retry = await request(app)
      .post(`/api/v1/records/receipts/${scan.id}/confirm`)
      .set(...AUTH)
      .send({
        date: "2026-07-20",
        description: "Purchase from ABC Store",
        amount: 1220,
        itemAssignments: [
          { itemId: rice!.id, categoryId: ctx.categories.Inventory },
          { itemId: electricity!.id, categoryId: ctx.categories.Utilities },
        ],
      });
    expect(retry.status).toBe(201);
    const records = await prisma.expenseRecord.findMany({ where: { receiptScanId: scan.id } });
    expect(records).toHaveLength(2);
    expect(records.reduce((sum, record) => sum + Number(record.amount), 0)).toBe(1220);
  });
});

describe("confirmation racing expense deletion", () => {
  async function legacyReceiptExpense(scanId: number, flagged = false) {
    const duplicateRoot = flagged
      ? await prisma.expenseRecord.create({
          data: {
            businessProfileId: ctx.profile.id,
            categoryId: ctx.categories.Inventory!,
            date: new Date("2026-07-19T00:00:00.000Z"),
            description: "Legacy duplicate",
            amount: 500,
            source: "MANUAL_ENTRY",
            reviewStatus: "Reviewed",
          },
        })
      : null;
    return prisma.expenseRecord.create({
      data: {
        businessProfileId: ctx.profile.id,
        categoryId: ctx.categories.Inventory!,
        receiptScanId: scanId,
        duplicateOfRecordId: duplicateRoot?.id,
        date: new Date("2026-07-19T00:00:00.000Z"),
        description: flagged ? "Legacy duplicate" : "Legacy partial confirmation",
        amount: 500,
        source: "RECEIPT_SCAN",
        reviewStatus: flagged ? "Needs Review" : "Reviewed",
        duplicateStatus: flagged ? "Flagged" : "Not a Duplicate",
      },
    });
  }

  async function expectConfirmedReplacement(scanId: number, deletedId: number) {
    expect(await prisma.expenseRecord.findUnique({ where: { id: deletedId } })).toBeNull();
    expect(await prisma.expenseRecord.findMany({ where: { receiptScanId: scanId } })).toHaveLength(1);
    expect(await prisma.receiptScan.findUniqueOrThrow({ where: { id: scanId } })).toMatchObject({
      confirmationStatus: "Confirmed",
    });
    expect(await prisma.receiptPurgeJob.count({ where: { receiptScanId: scanId } })).toBe(0);
  }

  it("finishes a single-record delete without deadlock or orphaning the newly confirmed record", async () => {
    const scan = await makeReadScan();
    const legacy = await legacyReceiptExpense(scan.id);
    const barrier = holdConfirmationAtFirstRecord();
    let confirming: ReturnType<typeof confirmPendingScan> | undefined;
    let deleting: ReturnType<typeof deleteExpenseRecord> | undefined;

    try {
      confirming = confirmPendingScan(scan.id);
      await within(barrier.reached);
      deleting = deleteExpenseRecord(ctx.user.id, legacy.id);
      await waitForBlockedQuery("pg_advisory_xact_lock");
      barrier.release();
      const [confirmed] = await within(Promise.all([confirming, deleting]));

      expect(confirmed).toHaveLength(1);
      await expectConfirmedReplacement(scan.id, legacy.id);
    } finally {
      barrier.release();
      await Promise.allSettled([confirming, deleting].filter(Boolean) as Promise<unknown>[]);
    }
  });

  it("finishes a bulk discard without deadlock or queuing cleanup for the newly confirmed record", async () => {
    const scan = await makeReadScan();
    const legacy = await legacyReceiptExpense(scan.id, true);
    const barrier = holdConfirmationAtFirstRecord();
    let confirming: ReturnType<typeof confirmPendingScan> | undefined;
    let deleting: ReturnType<typeof bulkResolveExpenseDuplicates> | undefined;

    try {
      confirming = confirmPendingScan(scan.id);
      await within(barrier.reached);
      deleting = bulkResolveExpenseDuplicates(ctx.user.id, ctx.profile.id, [legacy.id], "discard");
      await waitForBlockedQuery("pg_advisory_xact_lock");
      barrier.release();
      const [confirmed, deletedCount] = await within(Promise.all([confirming, deleting]));

      expect(confirmed).toHaveLength(1);
      expect(deletedCount).toBe(1);
      await expectConfirmedReplacement(scan.id, legacy.id);
    } finally {
      barrier.release();
      await Promise.allSettled([confirming, deleting].filter(Boolean) as Promise<unknown>[]);
    }
  });

  it("lets a single-record delete finish before a waiting confirmation", async () => {
    const scan = await makeReadScan();
    const legacy = await legacyReceiptExpense(scan.id);
    let pause: PausedTransactionQuery | undefined;
    let confirming: ReturnType<typeof confirmPendingScan> | undefined;
    let deleting: ReturnType<typeof deleteExpenseRecord> | undefined;

    try {
      pause = pauseAfterTransactionQuery("$executeRaw", "pg_advisory_xact_lock");
      deleting = deleteExpenseRecord(ctx.user.id, legacy.id);
      const deletionPid = await within(pause.acquired);
      confirming = confirmPendingScan(scan.id);
      const wait = await waitForBlockedQuery("pg_advisory_xact_lock");
      expect(wait.blockingPids).toContain(deletionPid);

      pause.resume();
      const [, confirmed] = await within(Promise.all([deleting, confirming]));
      expect(confirmed).toHaveLength(1);
      await expectConfirmedReplacement(scan.id, legacy.id);
    } finally {
      pause?.resume();
      await Promise.allSettled([confirming, deleting].filter(Boolean) as Promise<unknown>[]);
      pause?.restore();
    }
  });

  it("lets a bulk discard finish before a waiting confirmation", async () => {
    const scan = await makeReadScan();
    const legacy = await legacyReceiptExpense(scan.id, true);
    let pause: PausedTransactionQuery | undefined;
    let confirming: ReturnType<typeof confirmPendingScan> | undefined;
    let deleting: ReturnType<typeof bulkResolveExpenseDuplicates> | undefined;

    try {
      pause = pauseAfterTransactionQuery("$executeRaw", "pg_advisory_xact_lock");
      deleting = bulkResolveExpenseDuplicates(ctx.user.id, ctx.profile.id, [legacy.id], "discard");
      const deletionPid = await within(pause.acquired);
      confirming = confirmPendingScan(scan.id);
      const wait = await waitForBlockedQuery("pg_advisory_xact_lock");
      expect(wait.blockingPids).toContain(deletionPid);

      pause.resume();
      const [deletedCount, confirmed] = await within(Promise.all([deleting, confirming]));
      expect(deletedCount).toBe(1);
      expect(confirmed).toHaveLength(1);
      await expectConfirmedReplacement(scan.id, legacy.id);
    } finally {
      pause?.resume();
      await Promise.allSettled([confirming, deleting].filter(Boolean) as Promise<unknown>[]);
      pause?.restore();
    }
  });

  it("lets direct scan deletion win when confirmation is waiting on its receipt lock", async () => {
    const scan = await makeReadScan();
    let pause: PausedTransactionQuery | undefined;
    let confirming: ReturnType<typeof confirmPendingScan> | undefined;
    let deleting: ReturnType<typeof requestReceiptScanDeletion> | undefined;

    try {
      pause = pauseAfterTransactionQuery("$queryRaw", 'profile."User_ID"');
      deleting = requestReceiptScanDeletion(ctx.user.id, scan.id, "confirmation-race-delete-first");
      const deletionPid = await within(pause.acquired);
      confirming = confirmPendingScan(scan.id);
      const wait = await waitForBlockedQuery('UPDATE "public"."ReceiptScan"');
      expect(wait.blockingPids).toContain(deletionPid);

      pause.resume();
      const [deletionResult, confirmationResult] = await within(Promise.allSettled([deleting, confirming]));
      expect(deletionResult).toMatchObject({ status: "fulfilled", value: { mode: "DELETE_SCAN", status: "PENDING" } });
      expect(confirmationResult).toMatchObject({ status: "rejected", reason: { status: 409 } });
      expect(await prisma.expenseRecord.count({ where: { receiptScanId: scan.id } })).toBe(0);
      expect(await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } })).toMatchObject({
        confirmationStatus: "Deletion Pending",
        evidenceDeletionRequestedAt: expect.any(Date),
      });
      expect(await prisma.receiptPurgeJob.count({ where: { receiptScanId: scan.id } })).toBe(1);
    } finally {
      pause?.resume();
      await Promise.allSettled([confirming, deleting].filter(Boolean) as Promise<unknown>[]);
      pause?.restore();
    }
  });

  it("lets confirmation win while direct scan deletion waits on its receipt lock", async () => {
    const scan = await makeReadScan();
    const barrier = holdConfirmationAtFirstRecord();
    let confirming: ReturnType<typeof confirmPendingScan> | undefined;
    let deleting: ReturnType<typeof requestReceiptScanDeletion> | undefined;

    try {
      confirming = confirmPendingScan(scan.id);
      await within(barrier.reached);
      deleting = requestReceiptScanDeletion(ctx.user.id, scan.id, "confirmation-race-confirm-first");
      await waitForBlockedQuery("FOR UPDATE OF scan");

      barrier.release();
      const [confirmationResult, deletionResult] = await within(Promise.allSettled([confirming, deleting]));
      expect(confirmationResult).toMatchObject({ status: "fulfilled" });
      expect(deletionResult).toMatchObject({ status: "rejected", reason: { status: 409 } });
      expect(await prisma.expenseRecord.count({ where: { receiptScanId: scan.id } })).toBe(1);
      expect(await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } })).toMatchObject({
        confirmationStatus: "Confirmed",
        evidenceDeletionRequestedAt: null,
      });
      expect(await prisma.receiptPurgeJob.count({ where: { receiptScanId: scan.id } })).toBe(0);
    } finally {
      barrier.release();
      await Promise.allSettled([confirming, deleting].filter(Boolean) as Promise<unknown>[]);
    }
  });
});

describe("owner-added lines on a rejected or failed confirm", () => {
  /*
   * QA-FIN-01. The rows for lines the owner typed in were written BEFORE the
   * confirmation transaction, so every rejection after that point — a total
   * that did not reconcile, an unassigned item, a failed record write — left
   * them on the scan. The retry then wrote a second copy and was refused on
   * the first, which had no assignment: the owner could not get out without
   * refreshing and deleting lines they never saw arrive. Real PostgreSQL,
   * because the defect is about what survives a rolled-back request.
   */
  const softdrinks = () => ({ name: "Softdrinks", amount: 50, categoryId: ctx.categories.Inventory! });

  function confirm(scanId: number, body: Record<string, unknown>) {
    return request(app).post(`/api/v1/records/receipts/${scanId}/confirm`).set(...AUTH).send({
      date: "2026-07-20",
      description: "Purchase from ABC Store",
      ...body,
    });
  }

  it("leaves the original items untouched when the total does not reconcile, and the retry succeeds exactly once", async () => {
    const scan = await makeReadScan([{ name: "Rice 25kg", amount: 1000 }]);
    const rice = scan.items[0]!;
    const assignments = [{ itemId: rice.id, categoryId: ctx.categories.Inventory }];

    // Items come to 1050; the owner typed 1200 and chose no way to close the gap.
    const rejected = await confirm(scan.id, { amount: 1200, itemAssignments: assignments, additionalItems: [softdrinks()] });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatch(/choose how to account for the difference/i);

    // Pre-fix this was 2 rows: the Softdrinks line survived the refusal.
    expect(await prisma.receiptScanItem.count({ where: { receiptScanId: scan.id } })).toBe(1);
    expect(await prisma.receiptScanItem.count({ where: { receiptScanId: scan.id, addedByOwner: true } })).toBe(0);
    expect(await prisma.expenseRecord.count()).toBe(0);
    expect(await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } })).toMatchObject({
      confirmationStatus: "Pending",
    });

    // Same payload, corrected total. Pre-fix this was refused with "Every item
    // on the receipt needs a category" because of the orphan, and wrote a
    // third row while doing so.
    const retry = await confirm(scan.id, { amount: 1050, itemAssignments: assignments, additionalItems: [softdrinks()] });
    expect(retry.status).toBe(201);

    const items = await prisma.receiptScanItem.findMany({ where: { receiptScanId: scan.id }, orderBy: { lineNumber: "asc" } });
    expect(items).toHaveLength(2);
    expect(items.filter((i) => i.addedByOwner)).toMatchObject([{ name: "Softdrinks", lineNumber: 2 }]);
    const records = await prisma.expenseRecord.findMany({ where: { receiptScanId: scan.id } });
    expect(records).toHaveLength(1);
    expect(Number(records[0]!.amount)).toBe(1050);
    for (const item of items) expect(item.expenseRecordId).toBe(records[0]!.id);

    // The hand-added line still reaches the extraction-feedback ledger once,
    // now that it rides out of the transaction rather than being known before it.
    const misses = await prisma.receiptFieldCorrection.findMany({ where: { field: "itemPresence" } });
    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatchObject({ finalValue: "Softdrinks" });

    // And a plain repeat is the ordinary "already confirmed" refusal, writing nothing.
    const again = await confirm(scan.id, { amount: 1050, itemAssignments: assignments, additionalItems: [softdrinks()] });
    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/already been confirmed/i);
    expect(await prisma.receiptScanItem.count({ where: { receiptScanId: scan.id } })).toBe(2);
  });

  it("rolls the owner-added line back with everything else when a record write fails", async () => {
    const scan = await makeReadScan([
      { name: "Rice 25kg", amount: 1000 },
      { name: "Electricity", amount: 220 },
    ]);
    const [rice, electricity] = scan.items;
    const body = {
      amount: 1270,
      itemAssignments: [
        { itemId: rice!.id, categoryId: ctx.categories.Inventory },
        { itemId: electricity!.id, categoryId: ctx.categories.Utilities },
      ],
      additionalItems: [softdrinks()],
    };

    createHook.before = async (call) => {
      if (call === 2) throw new Error("simulated failure writing the second split");
    };
    const failed = await confirm(scan.id, body);
    expect(failed.status).toBe(500);
    expect(createHook.calls).toBe(2);

    expect(await prisma.expenseRecord.count()).toBe(0);
    expect(await prisma.receiptScanItem.count({ where: { receiptScanId: scan.id, addedByOwner: true } })).toBe(0);
    const items = await prisma.receiptScanItem.findMany({ where: { receiptScanId: scan.id } });
    expect(items.map((item) => item.expenseRecordId)).toEqual([null, null]);
    expect(await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } })).toMatchObject({
      confirmationStatus: "Pending",
    });

    createHook.before = null;
    const retry = await confirm(scan.id, body);
    expect(retry.status).toBe(201);
    expect(await prisma.receiptScanItem.count({ where: { receiptScanId: scan.id, addedByOwner: true } })).toBe(1);
    const records = await prisma.expenseRecord.findMany({ where: { receiptScanId: scan.id } });
    expect(records.reduce((sum, record) => sum + Number(record.amount), 0)).toBe(1270);
  });

  it("writes the owner-added line once when two confirms race", async () => {
    const scan = await makeReadScan([{ name: "Rice 25kg", amount: 1000 }]);
    const rice = scan.items[0]!;
    const body = {
      amount: 1050,
      itemAssignments: [{ itemId: rice.id, categoryId: ctx.categories.Inventory }],
      additionalItems: [softdrinks()],
    };

    const barrier = holdConfirmationAtFirstRecord();
    const pending: Promise<unknown>[] = [];

    try {
      const winner = confirm(scan.id, body).then((response) => response);
      pending.push(winner);
      await within(barrier.reached);
      const loser = confirm(scan.id, body).then((response) => response);
      pending.push(loser);
      await waitForBlockedQuery("pg_advisory_xact_lock");
      barrier.release();
      const [first, second] = await within(Promise.all([winner, loser]));

      expect(first.status).toBe(201);
      expect(second.status).toBe(409);
      expect(await prisma.expenseRecord.findMany({ where: { receiptScanId: scan.id } })).toHaveLength(1);
      const items = await prisma.receiptScanItem.findMany({ where: { receiptScanId: scan.id } });
      expect(items).toHaveLength(2);
      expect(items.filter((i) => i.addedByOwner)).toHaveLength(1);
      expect(items.every((i) => i.expenseRecordId !== null)).toBe(true);
      expect(await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } })).toMatchObject({
        confirmationStatus: "Confirmed",
      });
    } finally {
      barrier.release();
      await Promise.allSettled(pending);
    }
  });
});

describe("the item -> record link written on confirm", () => {
  /*
   * SEC-007. The link update was the one receipt-item write in the file not
   * scoped to the scan being confirmed — `where: { id: { in: itemIds } }`
   * alone. The confirm SCHEMA does not expose itemIds today, so this is not
   * reachable over HTTP; the service is called directly because the defence is
   * the scoping itself, not the schema that currently happens to hide it.
   */
  it("never touches an item belonging to another owner's receipt", async () => {
    const mine = await makeReadScan([{ name: "Rice 25kg", amount: 600 }]);

    const other = await makeOwnerWithProfile({}, ["Inventory"]);
    const theirs = await prisma.receiptScan.create({
      data: {
        businessProfileId: other.profile.id,
        imageFile: `${other.profile.id}/receipt.jpg`,
        confirmationStatus: "Pending",
        processingStatus: "Complete",
        items: { create: [{ lineNumber: 1, name: "Their groceries", amount: 900 }] },
      },
      include: { items: true },
    });

    await confirmReceipt(ctx.user.id, mine.id, {
      date: "2026-07-20",
      description: "Purchase from ABC Store",
      amount: 600,
      splits: [
        {
          categoryId: ctx.categories.Inventory,
          amount: 600,
          itemIds: [mine.items[0]!.id, theirs.items[0]!.id],
        },
      ],
    });

    const theirItem = await prisma.receiptScanItem.findUniqueOrThrow({ where: { id: theirs.items[0]!.id } });
    expect(theirItem.expenseRecordId).toBeNull();
    expect(theirItem.categoryId).toBeNull();

    // The owner's own item is still linked — the scoping fixed the leak
    // without breaking the feature.
    const myItem = await prisma.receiptScanItem.findUniqueOrThrow({ where: { id: mine.items[0]!.id } });
    expect(myItem.expenseRecordId).not.toBeNull();
  });
});
