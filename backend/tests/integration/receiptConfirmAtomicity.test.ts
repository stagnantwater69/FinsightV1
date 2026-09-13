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

describe("two confirms of the same receipt at once", () => {
  it("books the receipt once and answers the loser 409 instead of writing a second set of records", async () => {
    const scan = await makeReadScan();

    // Holds the FIRST confirm inside its transaction, after it has claimed the
    // scan and before it has committed — the exact window the second request
    // used to walk straight through.
    let releaseWinner: (() => void) | null = null;
    const winnerHeld = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    createHook.before = async (call) => {
      if (call === 1) await winnerHeld;
    };

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

    const winner = confirm();
    await sleep(200); // the winner reaches the hook, holding its claim
    const loser = confirm();
    await sleep(200); // the loser reaches the claim and waits on the row
    releaseWinner!();

    const [first, second] = await Promise.all([winner, loser]);

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already being confirmed/i);

    // The point of the whole exercise: ONE set of books.
    const records = await prisma.expenseRecord.findMany({ where: { receiptScanId: scan.id } });
    expect(records).toHaveLength(1);
    expect(Number(records[0]!.amount)).toBe(1220);
    expect(await prisma.receiptScan.findUniqueOrThrow({ where: { id: scan.id } })).toMatchObject({
      confirmationStatus: "Confirmed",
    });
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

    let releaseWinner: (() => void) | null = null;
    const winnerHeld = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    createHook.before = async (call) => {
      if (call === 1) await winnerHeld;
    };

    const winner = confirm(scan.id, body).then((r) => r);
    await sleep(200);
    const loser = confirm(scan.id, body).then((r) => r);
    await sleep(200);
    releaseWinner!();
    const [first, second] = await Promise.all([winner, loser]);

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
