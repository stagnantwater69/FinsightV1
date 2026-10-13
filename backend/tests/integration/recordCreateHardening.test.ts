import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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

const { notificationEffect } = vi.hoisted(() => ({ notificationEffect: { fail: false, calls: 0 } }));
vi.mock("../../src/services/notification.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/notification.service")>();
  return {
    ...actual,
    createNotification: async (...args: Parameters<typeof actual.createNotification>) => {
      notificationEffect.calls += 1;
      if (notificationEffect.fail) throw new Error("simulated notification write failure");
      return actual.createNotification(...args);
    },
  };
});

import request from "supertest";
import { app } from "../../src/app";
import { logger } from "../../src/config/logger";
import { prisma } from "../../src/config/prisma";
import { lockExpenseDuplicateWriteGate, lockSalesDuplicateWriteGate } from "../../src/lib/recordLock";
import { resetRateLimits } from "../../src/middleware/rateLimit.middleware";
import { NOTIFICATION_TYPES } from "../../src/services/notification.service";
import { bulkCreateExpenseRecords } from "../../src/services/expenseRecord.service";
import { bulkCreateSalesRecords } from "../../src/services/salesRecord.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const AUTH = ["Authorization", "Bearer valid-token"] as const;
const EXPENSES = "/api/v1/records/expenses";
const SALES = "/api/v1/records/sales";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForAdvisoryWaiters(expected: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND wait_event = 'advisory'
    `;
    if ((row?.count ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${expected} record write gate waiter(s)`);
}

async function holdSalesWriteGate() {
  const entered = deferred();
  const release = deferred();
  const blocker = prisma.$transaction(async (tx) => {
    await lockSalesDuplicateWriteGate(tx, ctx.profile.id);
    entered.resolve();
    await release.promise;
  }, { timeout: 15_000 });
  await Promise.race([
    entered.promise,
    blocker.then(() => { throw new Error("Sales write gate blocker exited early"); }),
  ]);
  return {
    waitFor: waitForAdvisoryWaiters,
    release: async () => {
      release.resolve();
      await blocker;
    },
  };
}

async function holdExpenseWriteGate() {
  const entered = deferred();
  const release = deferred();
  const blocker = prisma.$transaction(async (tx) => {
    await lockExpenseDuplicateWriteGate(tx, ctx.profile.id);
    entered.resolve();
    await release.promise;
  }, { timeout: 15_000 });
  await Promise.race([
    entered.promise,
    blocker.then(() => { throw new Error("Expense write gate blocker exited early"); }),
  ]);
  return {
    waitFor: waitForAdvisoryWaiters,
    release: async () => {
      release.resolve();
      await blocker;
    },
  };
}

beforeEach(async () => {
  await resetDb();
  resetRateLimits();
  ctx = await makeOwnerWithProfile({}, ["Inventory"]);
  authUserId.value = ctx.user.authId;
  notificationEffect.fail = false;
  notificationEffect.calls = 0;
  vi.restoreAllMocks();
});
afterAll(disconnectDb);

/**
 * API-004 — the amount that was accepted and then stored as nothing.
 *
 * `amount: 0.001` used to answer 201 with a record whose stored amount was
 * 0.00: past `.positive()`, rounded away by the Decimal(12,2) column, and from
 * then on a real row in the owner's books worth zero pesos. These assert on
 * the STORED value, not just on the status, because the status was never the
 * part that was wrong.
 */
describe("money amount validation", () => {
  it("rejects a sub-centavo expense with a 400 instead of storing zero", async () => {
    const res = await request(app)
      .post(EXPENSES)
      .set(...AUTH)
      .send({
        businessProfileId: ctx.profile.id,
        categoryId: ctx.categories.Inventory,
        date: utcDayString(),
        description: "Sub-centavo",
        amount: 0.001,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
    expect(await prisma.expenseRecord.count()).toBe(0);
  });

  it("still accepts a normal two-decimal amount and stores it exactly", async () => {
    const res = await request(app)
      .post(EXPENSES)
      .set(...AUTH)
      .send({
        businessProfileId: ctx.profile.id,
        categoryId: ctx.categories.Inventory,
        date: utcDayString(),
        description: "Rice sack",
        amount: 1234.56,
      });

    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(1234.56);
    const stored = await prisma.expenseRecord.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(Number(stored.amount)).toBe(1234.56);
  });

  it("rejects a sub-centavo sales record too", async () => {
    const res = await request(app)
      .post(SALES)
      .set(...AUTH)
      .send({
        businessProfileId: ctx.profile.id,
        date: utcDayString(),
        description: "Sub-centavo sale",
        amount: 0.004,
      });

    expect(res.status).toBe(400);
    expect(await prisma.salesReferenceRecord.count()).toBe(0);
  });

  it("rejects a sub-centavo amount on update as well as on create", async () => {
    const created = await request(app)
      .post(EXPENSES)
      .set(...AUTH)
      .send({
        businessProfileId: ctx.profile.id,
        categoryId: ctx.categories.Inventory,
        date: utcDayString(),
        description: "Edited later",
        amount: 500,
      });
    expect(created.status).toBe(201);

    const res = await request(app)
      .patch(`${EXPENSES}/${created.body.id}`)
      .set(...AUTH)
      .send({ amount: 0.009 });

    expect(res.status).toBe(400);
    const stored = await prisma.expenseRecord.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(Number(stored.amount)).toBe(500);
  });

  it("rejects an amount wider than the column rather than answering 500", async () => {
    const res = await request(app)
      .post(EXPENSES)
      .set(...AUTH)
      .send({
        businessProfileId: ctx.profile.id,
        categoryId: ctx.categories.Inventory,
        date: utcDayString(),
        description: "Overflow",
        amount: 99_999_999_999.99,
      });

    expect(res.status).toBe(400);
    expect(await prisma.expenseRecord.count()).toBe(0);
  });
});

/**
 * API-008 / API-014 — the double-tap the duplicate detector could not see.
 *
 * Two identical creates issued together used to both read "no duplicate"
 * before either had written, so BOTH landed as "Not a Duplicate" and the owner
 * was never told they had recorded the same purchase twice. Neither record is
 * rejected — a genuine second identical purchase is legitimate — but exactly
 * one of them must come out flagged and pointing at the other.
 */
describe("concurrent create is not a read-then-write race", () => {
  const body = () => ({
    businessProfileId: ctx.profile.id,
    categoryId: ctx.categories.Inventory,
    date: utcDayString(),
    description: "Double-tapped delivery",
    amount: 350.5,
  });

  /*
   * SIX AT ONCE, not two. Two supertest requests fired together rarely
   * interleave inside the millisecond the duplicate check takes, so a
   * two-request version of this passed even with the serialisation removed —
   * it was testing nothing. Six reliably overlap, and the assertion is the one
   * that matters either way: however many identical records arrive together,
   * exactly ONE of them is the original and every other points at it.
   */
  it("flags every simultaneous identical expense but the first", async () => {
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => request(app).post(EXPENSES).set(...AUTH).send(body())),
    );
    expect(responses.map((r) => r.status)).toEqual(Array(6).fill(201));

    const records = await prisma.expenseRecord.findMany({ orderBy: { id: "asc" } });
    expect(records).toHaveLength(6);

    const originals = records.filter((r) => r.duplicateStatus === "Not a Duplicate");
    expect(originals).toHaveLength(1);
    for (const duplicate of records.filter((r) => r.duplicateStatus === "Flagged")) {
      expect(duplicate.duplicateOfRecordId).toBe(originals[0]!.id);
    }
  });

  it("flags every simultaneous identical sales record but the first", async () => {
    const salesBody = () => ({
      businessProfileId: ctx.profile.id,
      date: utcDayString(),
      description: "Double-tapped sale",
      amount: 120.25,
    });

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => request(app).post(SALES).set(...AUTH).send(salesBody())),
    );
    expect(responses.map((r) => r.status)).toEqual(Array(6).fill(201));

    const records = await prisma.salesReferenceRecord.findMany({ orderBy: { id: "asc" } });
    expect(records).toHaveLength(6);
    expect(records.filter((r) => r.duplicateStatus === "Not a Duplicate")).toHaveLength(1);
  });

  it("leaves nothing behind when the create fails inside its transaction", async () => {
    // A category from another business: the ownership check inside the
    // transaction rejects it, and no partial row may survive the rollback.
    const other = await makeOwnerWithProfile({ name: "Other Store" }, ["Utilities"]);
    const res = await request(app)
      .post(EXPENSES)
      .set(...AUTH)
      .send({
        businessProfileId: ctx.profile.id,
        categoryId: other.categories.Utilities,
        date: utcDayString(),
        description: "Someone else's category",
        amount: 10,
      });

    expect(res.status).toBe(400);
    expect(await prisma.expenseRecord.count()).toBe(0);
  });
});

describe("concurrent sales updates are serialized", () => {
  const createSale = (description: string, amount: number) =>
    request(app)
      .post(SALES)
      .set(...AUTH)
      .send({ businessProfileId: ctx.profile.id, date: utcDayString(), description, amount });

  it("preserves independent partial edits to the same record", async () => {
    const created = await createSale("Initial sale", 100);
    expect(created.status).toBe(201);

    const gate = await holdSalesWriteGate();
    const editDescription = Promise.resolve(
      request(app).patch(`${SALES}/${created.body.id}`).set(...AUTH).send({ description: "Edited sale" }),
    );
    await gate.waitFor(1);
    const editAmount = Promise.resolve(
      request(app).patch(`${SALES}/${created.body.id}`).set(...AUTH).send({ amount: 200 }),
    );
    await gate.waitFor(2);
    await gate.release();

    const responses = await Promise.all([editDescription, editAmount]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const stored = await prisma.salesReferenceRecord.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(stored.description).toBe("Edited sale");
    expect(Number(stored.amount)).toBe(200);
  });

  it("leaves one original when two records concurrently move to the same duplicate identity", async () => {
    const [first, second] = await Promise.all([
      createSale("First draft", 100),
      createSale("Second draft", 200),
    ]);
    expect([first.status, second.status]).toEqual([201, 201]);

    const target = { date: utcDayString(-1), description: "Same corrected sale", amount: 300 };
    const gate = await holdSalesWriteGate();
    const firstUpdate = Promise.resolve(request(app).patch(`${SALES}/${first.body.id}`).set(...AUTH).send(target));
    await gate.waitFor(1);
    const secondUpdate = Promise.resolve(request(app).patch(`${SALES}/${second.body.id}`).set(...AUTH).send(target));
    await gate.waitFor(2);
    await gate.release();

    const responses = await Promise.all([firstUpdate, secondUpdate]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);

    const records = await prisma.salesReferenceRecord.findMany({
      where: { id: { in: [first.body.id, second.body.id] } },
      orderBy: { id: "asc" },
    });
    const originals = records.filter((record) => record.duplicateStatus === "Not a Duplicate");
    const duplicates = records.filter((record) => record.duplicateStatus === "Flagged");
    expect(originals).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]!.duplicateOfRecordId).toBe(originals[0]!.id);
  });

  it("keeps the existing target canonical when an older record is edited into its identity", async () => {
    const older = await createSale("Older source identity", 110);
    const newer = await createSale("Newer target identity", 220);
    expect([older.status, newer.status]).toEqual([201, 201]);

    notificationEffect.calls = 0;
    const updated = await request(app)
      .patch(`${SALES}/${older.body.id}`)
      .set(...AUTH)
      .send({ date: utcDayString(), description: "Newer target identity", amount: 220 });

    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      id: older.body.id,
      duplicateStatus: "Flagged",
      duplicateOfRecordId: newer.body.id,
    });
    expect(await prisma.salesReferenceRecord.findUniqueOrThrow({ where: { id: newer.body.id } }))
      .toMatchObject({ duplicateStatus: "Not a Duplicate", duplicateOfRecordId: null });
    expect(notificationEffect.calls).toBe(1);
    expect(await prisma.notification.count({
      where: { businessProfileId: ctx.profile.id, type: NOTIFICATION_TYPES.POSSIBLE_DUPLICATE },
    })).toBe(1);
  });

  it("promotes the source follower when a concurrent create lands before its original moves", async () => {
    const original = await createSale("Source identity", 410);
    expect(original.status).toBe(201);

    const gate = await holdSalesWriteGate();
    const sourceCreate = Promise.resolve(createSale("Source identity", 410));
    await gate.waitFor(1);
    const moveOriginal = Promise.resolve(
      request(app)
        .patch(`${SALES}/${original.body.id}`)
        .set(...AUTH)
        .send({ description: "Target identity", amount: 820 }),
    );
    await gate.waitFor(2);
    await gate.release();

    const [created, moved] = await Promise.all([sourceCreate, moveOriginal]);
    expect([created.status, moved.status]).toEqual([201, 200]);

    const records = await prisma.salesReferenceRecord.findMany({
      where: { id: { in: [created.body.id, moved.body.id] } },
      orderBy: { id: "asc" },
    });
    expect(records).toHaveLength(2);
    expect(records.map((record) => ({
      description: record.description,
      duplicateStatus: record.duplicateStatus,
      duplicateOfRecordId: record.duplicateOfRecordId,
    }))).toEqual([
      { description: "Target identity", duplicateStatus: "Not a Duplicate", duplicateOfRecordId: null },
      { description: "Source identity", duplicateStatus: "Not a Duplicate", duplicateOfRecordId: null },
    ]);
  });

  it("keeps both identities canonical when two originals swap concurrently", async () => {
    const first = await createSale("Identity A", 510);
    const second = await createSale("Identity B", 920);
    expect([first.status, second.status]).toEqual([201, 201]);

    const gate = await holdSalesWriteGate();
    const firstUpdate = Promise.resolve(
      request(app).patch(`${SALES}/${first.body.id}`).set(...AUTH).send({ description: "Identity B", amount: 920 }),
    );
    await gate.waitFor(1);
    const secondUpdate = Promise.resolve(
      request(app).patch(`${SALES}/${second.body.id}`).set(...AUTH).send({ description: "Identity A", amount: 510 }),
    );
    await gate.waitFor(2);
    await gate.release();

    const responses = await Promise.all([firstUpdate, secondUpdate]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);

    const records = await prisma.salesReferenceRecord.findMany({
      where: { id: { in: [first.body.id, second.body.id] } },
      orderBy: { description: "asc" },
    });
    expect(records.map((record) => ({
      description: record.description,
      amount: Number(record.amount),
      duplicateStatus: record.duplicateStatus,
      duplicateOfRecordId: record.duplicateOfRecordId,
    }))).toEqual([
      { description: "Identity A", amount: 510, duplicateStatus: "Not a Duplicate", duplicateOfRecordId: null },
      { description: "Identity B", amount: 920, duplicateStatus: "Not a Duplicate", duplicateOfRecordId: null },
    ]);
  });

  it("holds the same gate while bulk sales rows are classified and inserted", async () => {
    const batch = await prisma.cSVImportBatch.create({
      data: {
        businessProfileId: ctx.profile.id,
        title: "Concurrent sales import",
        uploadDate: new Date(),
      },
    });
    const gate = await holdSalesWriteGate();
    const bulkCreate = bulkCreateSalesRecords(ctx.user.id, ctx.profile.id, batch.id, [{
      date: utcDayString(),
      description: "Imported sale",
      amount: 123,
    }]);
    await gate.waitFor(1);
    await gate.release();

    await expect(bulkCreate).resolves.toMatchObject([
      { description: "Imported sale", duplicateStatus: "Not a Duplicate" },
    ]);
  });

  it("points bulk and later manual followers at one canonical sales row", async () => {
    const batch = await prisma.cSVImportBatch.create({
      data: {
        businessProfileId: ctx.profile.id,
        title: "Canonical sales import",
        uploadDate: new Date(),
      },
    });
    const row = { date: utcDayString(), description: "Canonical imported sale", amount: 321 };

    const imported = await bulkCreateSalesRecords(ctx.user.id, ctx.profile.id, batch.id, [row, row, row]);
    expect(imported[1]).toMatchObject({ duplicateStatus: "Flagged", duplicateOfRecordId: imported[0]!.id });
    expect(imported[2]).toMatchObject({ duplicateStatus: "Flagged", duplicateOfRecordId: imported[0]!.id });
    const manual = await createSale(row.description, row.amount);
    expect(manual.status).toBe(201);

    const records = await prisma.salesReferenceRecord.findMany({
      where: {
        businessProfileId: ctx.profile.id,
        date: new Date(row.date),
        amount: row.amount,
        description: row.description,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const canonical = records.filter((record) =>
      record.duplicateStatus === "Not a Duplicate" && record.duplicateOfRecordId === null);
    expect(canonical).toHaveLength(1);
    expect(records).toHaveLength(4);
    expect(records.filter((record) => record.id !== canonical[0]!.id).every((record) =>
      record.duplicateStatus === "Flagged" && record.duplicateOfRecordId === canonical[0]!.id)).toBe(true);
  });
});

describe("direct bulk expense creation is serialized", () => {
  it("holds the expense gate inside a transaction for the exported default path", async () => {
    const batch = await prisma.cSVImportBatch.create({
      data: {
        businessProfileId: ctx.profile.id,
        title: "Direct expense import",
        uploadDate: new Date(),
      },
    });
    const gate = await holdExpenseWriteGate();
    const row = {
      categoryId: ctx.categories.Inventory!,
      date: utcDayString(),
      description: "Imported expense",
      amount: 456,
    };
    const bulkCreate = bulkCreateExpenseRecords(ctx.user.id, ctx.profile, batch.id, [row, row]);
    await gate.waitFor(1);
    await gate.release();

    const imported = await bulkCreate;
    expect(imported).toMatchObject([
      { description: "Imported expense", duplicateStatus: "Not a Duplicate" },
      { description: "Imported expense", duplicateStatus: "Flagged", duplicateOfRecordId: imported[0]!.id },
    ]);
    expect(await prisma.expenseRecord.findUniqueOrThrow({ where: { id: imported[1]!.id } }))
      .toMatchObject({ duplicateStatus: "Flagged", duplicateOfRecordId: imported[0]!.id });
  });

  it("returns every direct edge of a non-transitive within-batch expense chain", async () => {
    const batch = await prisma.cSVImportBatch.create({
      data: {
        businessProfileId: ctx.profile.id,
        title: "Expense bridge import",
        uploadDate: new Date(),
      },
    });
    const base = { categoryId: ctx.categories.Inventory!, date: utcDayString(), amount: 654 };
    const imported = await bulkCreateExpenseRecords(ctx.user.id, ctx.profile, batch.id, [
      { ...base, vendor: "Bulk bridge vendor 1", description: "Bulk bridge description 1" },
      { ...base, vendor: "Bulk bridge vendor 1", description: "Bulk bridge description 2" },
      { ...base, vendor: "Bulk bridge vendor 2", description: "Bulk bridge description 2" },
      { ...base, vendor: "Bulk bridge vendor 2", description: "Bulk bridge description 3" },
    ]);

    expect(imported.map((record) => ({
      duplicateStatus: record.duplicateStatus,
      duplicateOfRecordId: record.duplicateOfRecordId,
    }))).toEqual([
      { duplicateStatus: "Not a Duplicate", duplicateOfRecordId: null },
      { duplicateStatus: "Flagged", duplicateOfRecordId: imported[0]!.id },
      { duplicateStatus: "Flagged", duplicateOfRecordId: imported[1]!.id },
      { duplicateStatus: "Flagged", duplicateOfRecordId: imported[2]!.id },
    ]);
    const stored = await prisma.expenseRecord.findMany({
      where: { id: { in: imported.map((record) => record.id) } },
      orderBy: { id: "asc" },
    });
    expect(stored.map((record) => record.duplicateOfRecordId))
      .toEqual([null, stored[0]!.id, stored[1]!.id, stored[2]!.id]);
  });

  it("links an imported expense to the canonical target after an older row moves into its identity", async () => {
    const older = await request(app).post(EXPENSES).set(...AUTH).send({
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory,
      date: utcDayString(),
      description: "Older expense source",
      amount: 111,
    });
    const newer = await request(app).post(EXPENSES).set(...AUTH).send({
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory,
      date: utcDayString(),
      description: "Newer expense target",
      amount: 222,
    });
    expect([older.status, newer.status]).toEqual([201, 201]);

    const moved = await request(app)
      .patch(`${EXPENSES}/${older.body.id}`)
      .set(...AUTH)
      .send({ description: "Newer expense target", amount: 222 });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({
      duplicateStatus: "Flagged",
      duplicateOfRecordId: newer.body.id,
    });

    const batch = await prisma.cSVImportBatch.create({
      data: {
        businessProfileId: ctx.profile.id,
        title: "Canonical expense import",
        uploadDate: new Date(),
      },
    });
    const [imported] = await bulkCreateExpenseRecords(ctx.user.id, ctx.profile, batch.id, [{
      categoryId: ctx.categories.Inventory!,
      date: utcDayString(),
      description: "Newer expense target",
      amount: 222,
    }]);

    expect(imported).toMatchObject({
      duplicateStatus: "Flagged",
      duplicateOfRecordId: newer.body.id,
    });
  });
});

/**
 * The update's post-commit tail. An edit that crosses the large-expense
 * threshold commits the new amount and then raises a notification and requeues
 * the analysis job outside the transaction. The notification used to be
 * awaited bare: if it threw, the enqueue after it never ran and the owner got
 * a 500 for an edit that was already in the books, the same gap the create
 * path closed in round 4.
 */
describe("a post-commit effect of an update that fails", () => {
  const VENDOR = "Sari-sari Wholesale Depot";
  // Above the default large-expense threshold (125000 * 25% = 31250).
  const LARGE_AMOUNT = 40000;

  it("notification write: answers 200 with the edit committed, the analysis still queued, and an ids-only log entry", async () => {
    const created = await request(app)
      .post(EXPENSES)
      .set(...AUTH)
      .send({
        businessProfileId: ctx.profile.id,
        categoryId: ctx.categories.Inventory,
        date: utcDayString(),
        description: "Stock purchase",
        vendor: VENDOR,
        amount: 500,
      });
    expect(created.status).toBe(201);
    expect(created.body.largeExpenseFlag).toBe(false);
    // Drain the create's own job so the edit's requeue is observable.
    await prisma.analysisJob.deleteMany({ where: { expenseRecordId: created.body.id } });

    const logged = vi.spyOn(logger, "error");
    notificationEffect.calls = 0;
    notificationEffect.fail = true;

    const res = await request(app)
      .patch(`${EXPENSES}/${created.body.id}`)
      .set(...AUTH)
      .send({ amount: LARGE_AMOUNT });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: created.body.id, largeExpenseFlag: true, reviewStatus: "Needs Review" });
    expect(notificationEffect.calls).toBe(1);

    const stored = await prisma.expenseRecord.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(Number(stored.amount)).toBe(LARGE_AMOUNT);
    expect(stored.largeExpenseFlag).toBe(true);
    // The notification itself is lost, and the loss is the only thing that is.
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.analysisJob.findUnique({ where: { idempotencyKey: `transaction:${created.body.id}` } }))
      .toMatchObject({ status: "PENDING" });

    const entry = logged.mock.calls.find(([fields]) =>
      typeof fields === "object" && fields !== null
      && (fields as { code?: unknown }).code === "EXPENSE_RECORD_SIDE_EFFECT_FAILED");
    expect(entry, "a failed post-commit effect must be logged").toBeDefined();
    expect(entry![0]).toMatchObject({
      businessProfileId: ctx.profile.id,
      expenseRecordId: created.body.id,
      effect: "notification",
      failureKind: "notification-write-failed",
    });
    const serialised = JSON.stringify(entry, (_key, value) => (value instanceof Error ? value.message : value));
    expect(entry![0]).not.toHaveProperty("err");
    expect(serialised).not.toContain("simulated notification write failure");
    expect(serialised).not.toContain("stack");
    expect(serialised).not.toMatch(new RegExp(VENDOR));
    expect(serialised).not.toContain(String(LARGE_AMOUNT));
    expect(serialised).not.toContain("Stock purchase");
  });
});

describe("a sales notification failure after commit", () => {
  const sale = (description: string, amount: number) => ({
    businessProfileId: ctx.profile.id,
    date: utcDayString(),
    description,
    amount,
  });

  it("keeps a duplicate sales create successful and stored", async () => {
    const first = await request(app).post(SALES).set(...AUTH).send(sale("Counter sales", 750));
    expect(first.status).toBe(201);

    const logged = vi.spyOn(logger, "error");
    notificationEffect.fail = true;
    notificationEffect.calls = 0;
    const duplicate = await request(app).post(SALES).set(...AUTH).send(sale("Counter sales", 750));

    expect(duplicate.status).toBe(201);
    expect(duplicate.body).toMatchObject({ duplicateStatus: "Flagged", duplicateOfRecordId: first.body.id });
    expect(notificationEffect.calls).toBe(1);
    expect(await prisma.salesReferenceRecord.count({ where: { businessProfileId: ctx.profile.id } })).toBe(2);
    expect(await prisma.notification.count()).toBe(0);
    const entry = logged.mock.calls.find(([fields]) =>
      typeof fields === "object" && fields !== null
      && (fields as { code?: unknown }).code === "SALES_RECORD_SIDE_EFFECT_FAILED"
      && (fields as { salesRecordId?: unknown }).salesRecordId === duplicate.body.id);
    expect(entry, "a failed sales notification must be logged").toBeDefined();
    expect(entry![0]).toMatchObject({
      businessProfileId: ctx.profile.id,
      salesRecordId: duplicate.body.id,
      effect: "notification",
      failureKind: "notification-write-failed",
      code: "SALES_RECORD_SIDE_EFFECT_FAILED",
    });
    expect(entry![0]).not.toHaveProperty("err");
    const serialised = JSON.stringify(entry![0]);
    expect(serialised).not.toContain("simulated notification write failure");
    expect(serialised).not.toContain("Counter sales");
    expect(serialised).not.toContain("750");
    expect(serialised).not.toContain("stack");
  });

  it("keeps an update that becomes a duplicate successful and stored", async () => {
    const first = await request(app).post(SALES).set(...AUTH).send(sale("Morning sales", 500));
    const second = await request(app).post(SALES).set(...AUTH).send(sale("Afternoon sales", 900));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const logged = vi.spyOn(logger, "error");
    notificationEffect.fail = true;
    notificationEffect.calls = 0;
    const updated = await request(app)
      .patch(`${SALES}/${second.body.id}`)
      .set(...AUTH)
      .send({ date: utcDayString(), description: "Morning sales", amount: 500 });

    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      id: second.body.id,
      duplicateStatus: "Flagged",
      duplicateOfRecordId: first.body.id,
    });
    expect(notificationEffect.calls).toBe(1);
    expect(await prisma.salesReferenceRecord.findUniqueOrThrow({ where: { id: second.body.id } }))
      .toMatchObject({ duplicateStatus: "Flagged", duplicateOfRecordId: first.body.id });
    expect(await prisma.notification.count()).toBe(0);
    const entry = logged.mock.calls.find(([fields]) =>
      typeof fields === "object" && fields !== null
      && (fields as { code?: unknown }).code === "SALES_RECORD_SIDE_EFFECT_FAILED"
      && (fields as { salesRecordId?: unknown }).salesRecordId === second.body.id);
    expect(entry, "a failed sales notification must be logged").toBeDefined();
    expect(entry![0]).toMatchObject({
      businessProfileId: ctx.profile.id,
      salesRecordId: second.body.id,
      effect: "notification",
      failureKind: "notification-write-failed",
      code: "SALES_RECORD_SIDE_EFFECT_FAILED",
    });
    expect(entry![0]).not.toHaveProperty("err");
    const serialised = JSON.stringify(entry![0]);
    expect(serialised).not.toContain("simulated notification write failure");
    expect(serialised).not.toContain("Morning sales");
    expect(serialised).not.toContain("500");
    expect(serialised).not.toContain("stack");
  });
});
