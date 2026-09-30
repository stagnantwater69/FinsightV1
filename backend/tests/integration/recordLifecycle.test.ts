import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/config/prisma";
import { lockExpenseDuplicateWriteGate, lockSalesDuplicateWriteGate } from "../../src/lib/recordLock";
import * as expenses from "../../src/services/expenseRecord.service";
import * as sales from "../../src/services/salesRecord.service";
import { NOTIFICATION_TYPES } from "../../src/services/notification.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

// Full record lifecycle against a real Postgres database: create -> flag ->
// resolve. These run the actual services (and therefore the actual Prisma
// queries, Decimal handling and notification writes), not mocks of them.

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  // EME 60,000 with a 25% threshold -> anything >= 15,000 is a large expense.
  ctx = await makeOwnerWithProfile({ expectedMonthlyExpenses: 60000, largeExpenseThresholdPercent: 25 });
});

afterAll(disconnectDb);

const TODAY = () => utcDayString(0);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

type RecordTable = "ExpenseRecord" | "SalesReferenceRecord";

async function waitForBlockedDeleteGates(table: RecordTable, expected: number): Promise<void> {
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
  throw new Error(`Expected ${expected} blocked ${table} delete gate waiter(s)`);
}

async function raceDeletesBehindWriteGate(
  table: RecordTable,
  businessProfileId: number,
  attempts: Array<() => Promise<void>>,
) {
  const entered = deferred();
  const release = deferred();
  const blocker = prisma.$transaction(async (tx) => {
    if (table === "ExpenseRecord") await lockExpenseDuplicateWriteGate(tx, businessProfileId);
    else await lockSalesDuplicateWriteGate(tx, businessProfileId);
    entered.resolve();
    await release.promise;
  }, { timeout: 15_000 });
  await Promise.race([
    entered.promise,
    blocker.then(() => { throw new Error("Delete row-lock blocker exited early"); }),
  ]);

  const pending = attempts.map((attempt) => attempt());
  let barrierError: unknown;
  try {
    await waitForBlockedDeleteGates(table, attempts.length);
  } catch (error) {
    barrierError = error;
  }
  release.resolve();
  await blocker;
  const outcomes = await Promise.allSettled(pending);
  if (barrierError) throw barrierError;
  return outcomes;
}

describe("create", () => {
  it("stores an ordinary expense as reviewed, unflagged, manual-entry", async () => {
    const r = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Supplier stocks",
      vendor: "ABC Supplier",
      amount: 5000,
    });

    expect(r.amount).toBe(5000);
    expect(r.source).toBe("MANUAL_ENTRY");
    expect(r.largeExpenseFlag).toBe(false);
    expect(r.reviewStatus).toBe("Reviewed");
    expect(r.duplicateStatus).toBe("Not a Duplicate");
    expect(r.duplicateOfRecordId).toBeNull();

    const cannotInventDuplicate = await expenses.updateExpenseRecord(ctx.user.id, r.id, {
      duplicateStatus: "Flagged",
    });
    expect(cannotInventDuplicate).toMatchObject({
      duplicateStatus: "Not a Duplicate",
      duplicateOfRecordId: null,
    });
  });

  it("stores the date at UTC midnight so day-scoped queries find it", async () => {
    const r = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Boundary check",
      amount: 100,
    });
    const stored = await prisma.expenseRecord.findUniqueOrThrow({ where: { id: r.id } });
    expect(stored.date.toISOString()).toBe(`${TODAY()}T00:00:00.000Z`);
  });

  it("rejects a category belonging to a different business profile", async () => {
    const other = await makeOwnerWithProfile({}, ["Rent"]);
    await expect(
      expenses.createExpenseRecord(ctx.user.id, {
        businessProfileId: ctx.profile.id,
        categoryId: other.categories.Rent!, // not ours
        date: TODAY(),
        description: "Cross-profile category",
        amount: 100,
      })
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("large-expense flagging (base: expected monthly expenses)", () => {
  it("flags at exactly the threshold and marks it for review", async () => {
    const r = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Exactly at threshold",
      amount: 15000, // 25% of 60,000
    });
    expect(r.largeExpenseFlag).toBe(true);
    expect(r.reviewStatus).toBe("Needs Review");
  });

  it("does not flag one peso below the threshold", async () => {
    const r = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Just under",
      amount: 14999,
    });
    expect(r.largeExpenseFlag).toBe(false);
    expect(r.reviewStatus).toBe("Reviewed");
  });

  it("raises a Large Expense Flag notification scoped to this business profile", async () => {
    await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Bulk delivery",
      amount: 20000,
    });

    const notes = await prisma.notification.findMany({ where: { businessProfileId: ctx.profile.id } });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.type).toBe(NOTIFICATION_TYPES.LARGE_EXPENSE_FLAG);
    expect(notes[0]!.businessProfileId).toBe(ctx.profile.id);
    expect(notes[0]!.userId).toBe(ctx.user.id);
  });

  it("honours a per-owner threshold rather than a global rule", async () => {
    const strict = await makeOwnerWithProfile({
      expectedMonthlyExpenses: 60000,
      largeExpenseThresholdPercent: 15, // -> 9,000
    });
    const r = await expenses.createExpenseRecord(strict.user.id, {
      businessProfileId: strict.profile.id,
      categoryId: strict.categories.Inventory!,
      date: TODAY(),
      description: "Same amount, stricter owner",
      amount: 12000,
    });
    expect(r.largeExpenseFlag).toBe(true); // large at 15%
    // ...but the same 12,000 is ordinary for the 25% owner.
    const relaxed = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Same amount, relaxed owner",
      amount: 12000,
    });
    expect(relaxed.largeExpenseFlag).toBe(false);
  });
});

describe("duplicate detection", () => {
  it("flags an exact repeat and links it to the original", async () => {
    const first = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Supplier stocks",
      amount: 5000,
    });
    const second = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Supplier stocks",
      amount: 5000,
    });

    expect(second.duplicateStatus).toBe("Flagged");
    expect(second.duplicateOfRecordId).toBe(first.id);
    // The original is untouched — only the later record carries the flag.
    const original = await expenses.getExpenseRecord(ctx.user.id, first.id);
    expect(original.duplicateStatus).toBe("Not a Duplicate");
  });

  it("matches case-insensitively on description", async () => {
    await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Supplier Stocks",
      amount: 5000,
    });
    const dup = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "supplier STOCKS",
      amount: 5000,
    });
    expect(dup.duplicateStatus).toBe("Flagged");
  });

  it("does not flag when the amount differs", async () => {
    await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Supplier stocks",
      amount: 5000,
    });
    const r = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Supplier stocks",
      amount: 5001,
    });
    expect(r.duplicateStatus).toBe("Not a Duplicate");
  });

  it("does not flag when the date differs", async () => {
    await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: utcDayString(-1),
      description: "Supplier stocks",
      amount: 5000,
    });
    const r = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Supplier stocks",
      amount: 5000,
    });
    expect(r.duplicateStatus).toBe("Not a Duplicate");
  });

  it("does not treat another owner's identical record as a duplicate", async () => {
    // Duplicate detection must be scoped per business profile, or two shops
    // recording the same routine purchase would flag each other.
    const other = await makeOwnerWithProfile();
    await expenses.createExpenseRecord(other.user.id, {
      businessProfileId: other.profile.id,
      categoryId: other.categories.Inventory!,
      date: TODAY(),
      description: "Supplier stocks",
      amount: 5000,
    });
    const mine = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Supplier stocks",
      amount: 5000,
    });
    expect(mine.duplicateStatus).toBe("Not a Duplicate");
  });

  it("raises a Possible Duplicate notification", async () => {
    for (let i = 0; i < 2; i++) {
      await expenses.createExpenseRecord(ctx.user.id, {
        businessProfileId: ctx.profile.id,
        categoryId: ctx.categories.Inventory!,
        date: TODAY(),
        description: "Supplier stocks",
        amount: 5000,
      });
    }
    const notes = await prisma.notification.findMany({ where: { businessProfileId: ctx.profile.id } });
    expect(notes.map((n) => n.type)).toContain(NOTIFICATION_TYPES.POSSIBLE_DUPLICATE);
  });

  it("keeps every edge of a non-transitive duplicate chain direct and repairs only a deleted middle edge", async () => {
    const create = (vendor: string, description: string) => expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description,
      vendor,
      amount: 575,
    });
    const root = await create("Bridge vendor 1", "Bridge description 1");
    const vendorFollower = await create("Bridge vendor 1", "Bridge description 2");
    const descriptionFollower = await create("Bridge vendor 2", "Bridge description 2");
    const tail = await create("Bridge vendor 2", "Bridge description 3");

    expect(vendorFollower).toMatchObject({ duplicateStatus: "Flagged", duplicateOfRecordId: root.id });
    expect(descriptionFollower).toMatchObject({
      duplicateStatus: "Flagged",
      duplicateOfRecordId: vendorFollower.id,
    });
    expect(tail).toMatchObject({ duplicateStatus: "Flagged", duplicateOfRecordId: descriptionFollower.id });

    await expenses.deleteExpenseRecord(ctx.user.id, descriptionFollower.id);

    expect(await prisma.expenseRecord.findUniqueOrThrow({ where: { id: vendorFollower.id } }))
      .toMatchObject({ duplicateStatus: "Flagged", duplicateOfRecordId: root.id });
    expect(await prisma.expenseRecord.findUniqueOrThrow({ where: { id: tail.id } }))
      .toMatchObject({ duplicateStatus: "Not a Duplicate", duplicateOfRecordId: null });
  });

  it("repairs only direct followers when a middle expense moves to another identity", async () => {
    const create = (vendor: string, description: string) => expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description,
      vendor,
      amount: 585,
    });
    const root = await create("Move vendor 1", "Move description 1");
    const moved = await create("Move vendor 1", "Move description 2");
    const directFollower = await create("Move vendor 2", "Move description 2");
    const tail = await create("Move vendor 2", "Move description 3");
    const independentRoot = await create("Move vendor 3", "Independent root description");
    const independentFollower = await create("Move vendor 3", "Move description 2");
    expect(moved.duplicateOfRecordId).toBe(root.id);
    expect(directFollower.duplicateOfRecordId).toBe(moved.id);
    expect(tail.duplicateOfRecordId).toBe(directFollower.id);
    expect(independentFollower.duplicateOfRecordId).toBe(independentRoot.id);

    await expenses.updateExpenseRecord(ctx.user.id, moved.id, {
      vendor: "Moved-away vendor",
      description: "Moved-away description",
    });

    expect(await prisma.expenseRecord.findUniqueOrThrow({ where: { id: directFollower.id } }))
      .toMatchObject({ duplicateStatus: "Not a Duplicate", duplicateOfRecordId: null });
    expect(await prisma.expenseRecord.findUniqueOrThrow({ where: { id: tail.id } }))
      .toMatchObject({ duplicateStatus: "Flagged", duplicateOfRecordId: directFollower.id });
    expect(await prisma.expenseRecord.findUniqueOrThrow({ where: { id: independentFollower.id } }))
      .toMatchObject({ duplicateStatus: "Flagged", duplicateOfRecordId: independentRoot.id });
  });

  it("never links equal splits from the same receipt to each other", async () => {
    const scan = await prisma.receiptScan.create({
      data: {
        businessProfileId: ctx.profile.id,
        imageFile: `${ctx.profile.id}/same-receipt.jpg`,
        confirmationStatus: "Confirmed",
      },
    });
    const createSplit = () => expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Equal receipt split",
      vendor: "Same receipt vendor",
      amount: 425,
      source: "RECEIPT_SCAN",
      receiptScanId: scan.id,
    });

    const [first, second] = [await createSplit(), await createSplit()];
    expect(first).toMatchObject({ duplicateStatus: "Not a Duplicate", duplicateOfRecordId: null });
    expect(second).toMatchObject({ duplicateStatus: "Not a Duplicate", duplicateOfRecordId: null });
  });
});

describe("resolve", () => {
  async function createDuplicatePair() {
    const first = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Supplier stocks",
      amount: 5000,
    });
    const second = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Supplier stocks",
      amount: 5000,
    });
    return { first, second };
  }

  it("clears a duplicate flag when the owner marks it as not a duplicate", async () => {
    const { second } = await createDuplicatePair();
    const resolved = await expenses.updateExpenseRecord(ctx.user.id, second.id, {
      duplicateStatus: "Not a Duplicate",
    });
    expect(resolved.duplicateStatus).toBe("Not a Duplicate");
    expect(resolved.duplicateOfRecordId).toBeNull();
  });

  it("promotes the source follower when its expense canonical is edited away", async () => {
    const { first, second } = await createDuplicatePair();

    const moved = await expenses.updateExpenseRecord(ctx.user.id, first.id, {
      description: "Corrected supplier stocks",
      amount: 5100,
    });

    expect(moved).toMatchObject({ duplicateStatus: "Not a Duplicate", duplicateOfRecordId: null });
    expect(await prisma.expenseRecord.findUniqueOrThrow({ where: { id: second.id } }))
      .toMatchObject({ duplicateStatus: "Not a Duplicate", duplicateOfRecordId: null });
  });

  it("keeps a follower link when the edited expense still matches it by vendor", async () => {
    const original = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Original description",
      vendor: "Stable vendor",
      amount: 5050,
    });
    const follower = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Different description",
      vendor: "Stable vendor",
      amount: 5050,
    });

    await expenses.updateExpenseRecord(ctx.user.id, original.id, { description: "Edited description" });

    expect(await prisma.expenseRecord.findUniqueOrThrow({ where: { id: follower.id } }))
      .toMatchObject({ duplicateStatus: "Flagged", duplicateOfRecordId: original.id });
  });

  it("clears a review flag when the owner marks it reviewed", async () => {
    const big = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Bulk delivery",
      amount: 20000,
    });
    expect(big.reviewStatus).toBe("Needs Review");
    const reviewed = await expenses.updateExpenseRecord(ctx.user.id, big.id, { reviewStatus: "Reviewed" });
    expect(reviewed.reviewStatus).toBe("Reviewed");
    // The large-expense flag itself is a fact about the amount, so it stays.
    expect(reviewed.largeExpenseFlag).toBe(true);
  });

  it("removes a resolved record from the flagged list", async () => {
    const { second } = await createDuplicatePair();
    expect(await expenses.listFlaggedExpenseRecords(ctx.user.id, ctx.profile.id)).toHaveLength(1);

    await expenses.updateExpenseRecord(ctx.user.id, second.id, { duplicateStatus: "Not a Duplicate" });
    expect(await expenses.listFlaggedExpenseRecords(ctx.user.id, ctx.profile.id)).toHaveLength(0);
  });

  it("re-evaluates flags when the amount is edited so a stale flag can't persist", async () => {
    const big = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Bulk delivery",
      amount: 20000,
    });
    expect(big.largeExpenseFlag).toBe(true);

    // Corrected down below the threshold — the flag must clear.
    const fixed = await expenses.updateExpenseRecord(ctx.user.id, big.id, { amount: 1000 });
    expect(fixed.largeExpenseFlag).toBe(false);
    expect(fixed.reviewStatus).toBe("Reviewed");
  });

  it("does not re-notify on an edit to an already-flagged record", async () => {
    const { second } = await createDuplicatePair();
    const before = await prisma.notification.count({ where: { businessProfileId: ctx.profile.id } });

    // Editing the vendor changes nothing about duplicate state.
    await expenses.updateExpenseRecord(ctx.user.id, second.id, { vendor: "New Vendor" });
    const after = await prisma.notification.count({ where: { businessProfileId: ctx.profile.id } });
    expect(after).toBe(before);
  });

  it("deletes a record", async () => {
    const r = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "To delete",
      amount: 100,
    });
    await expenses.deleteExpenseRecord(ctx.user.id, r.id);
    await expect(expenses.getExpenseRecord(ctx.user.id, r.id)).rejects.toMatchObject({ status: 404 });
  });

  it("promotes one expense follower and repairs every pointer when the canonical is deleted", async () => {
    const first = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Delete expense canonical",
      vendor: "Direct match supplier",
      amount: 640,
    });
    await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Delete expense canonical",
      vendor: "Direct match supplier",
      amount: 640,
    });
    await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Delete expense canonical",
      vendor: "Direct match supplier",
      amount: 640,
    });

    await expenses.deleteExpenseRecord(ctx.user.id, first.id);

    const survivors = await prisma.expenseRecord.findMany({
      where: { businessProfileId: ctx.profile.id, amount: 640 },
      orderBy: { id: "asc" },
    });
    const canonical = survivors.filter((record) =>
      record.duplicateStatus === "Not a Duplicate" && record.duplicateOfRecordId === null);
    expect(canonical).toHaveLength(1);
    expect(survivors.filter((record) => record.id !== canonical[0]!.id).every((record) =>
      record.duplicateStatus === "Flagged" && record.duplicateOfRecordId === canonical[0]!.id)).toBe(true);
  });

  it("does not reflag expense copies the owner kept when the old canonical is deleted", async () => {
    const created = [];
    for (let index = 0; index < 4; index++) {
      created.push(await expenses.createExpenseRecord(ctx.user.id, {
        businessProfileId: ctx.profile.id,
        categoryId: ctx.categories.Inventory!,
        date: TODAY(),
        description: "Kept expense duplicates",
        amount: 690,
      }));
    }
    await expenses.bulkResolveExpenseDuplicates(
      ctx.user.id,
      ctx.profile.id,
      [created[1]!.id, created[2]!.id],
      "keep",
    );

    await expenses.deleteExpenseRecord(ctx.user.id, created[0]!.id);

    const survivors = await prisma.expenseRecord.findMany({
      where: { id: { in: created.slice(1).map((record) => record.id) } },
      orderBy: { id: "asc" },
    });
    expect(survivors.slice(0, 2).every((record) =>
      record.duplicateStatus === "Not a Duplicate" && record.duplicateOfRecordId === null)).toBe(true);
    expect(survivors[2]).toMatchObject({
      duplicateStatus: "Flagged",
      duplicateOfRecordId: survivors[0]!.id,
    });
  });

  it("reuses and repairs a legacy kept root instead of promoting another expense follower", async () => {
    const original = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Legacy kept expense",
      amount: 705,
    });
    const follower = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Legacy kept expense",
      amount: 705,
    });
    const legacyKept = await prisma.expenseRecord.create({
      data: {
        businessProfileId: ctx.profile.id,
        categoryId: ctx.categories.Inventory!,
        date: new Date(TODAY()),
        description: "Legacy kept expense",
        amount: 705,
        source: "MANUAL_ENTRY",
        reviewStatus: "Reviewed",
        duplicateStatus: "Not a Duplicate",
        duplicateOfRecordId: original.id,
      },
    });

    await expenses.deleteExpenseRecord(ctx.user.id, original.id);

    expect(await prisma.expenseRecord.findUniqueOrThrow({ where: { id: legacyKept.id } }))
      .toMatchObject({ duplicateStatus: "Not a Duplicate", duplicateOfRecordId: null });
    expect(await prisma.expenseRecord.findUniqueOrThrow({ where: { id: follower.id } }))
      .toMatchObject({ duplicateStatus: "Flagged", duplicateOfRecordId: legacyKept.id });
  });

  it("promotes both sides of a non-transitive expense bridge when its canonical is deleted", async () => {
    const bridge = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Shared description",
      vendor: "Shared vendor",
      amount: 730,
    });
    const vendorMatch = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Vendor side only",
      vendor: "Shared vendor",
      amount: 730,
    });
    const descriptionMatch = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Shared description",
      vendor: "Description side only",
      amount: 730,
    });

    await expenses.deleteExpenseRecord(ctx.user.id, bridge.id);

    const survivors = await prisma.expenseRecord.findMany({
      where: { id: { in: [vendorMatch.id, descriptionMatch.id] } },
      orderBy: { id: "asc" },
    });
    expect(survivors.map((record) => ({
      duplicateStatus: record.duplicateStatus,
      duplicateOfRecordId: record.duplicateOfRecordId,
    }))).toEqual([
      { duplicateStatus: "Not a Duplicate", duplicateOfRecordId: null },
      { duplicateStatus: "Not a Duplicate", duplicateOfRecordId: null },
    ]);
  });

  it("lets exactly one concurrent expense delete win and gives the retry a stable 404", async () => {
    const record = await expenses.createExpenseRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      categoryId: ctx.categories.Inventory!,
      date: TODAY(),
      description: "Double-delete expense",
      amount: 100,
    });

    const outcomes = await raceDeletesBehindWriteGate("ExpenseRecord", ctx.profile.id, [
      () => expenses.deleteExpenseRecord(ctx.user.id, record.id),
      () => expenses.deleteExpenseRecord(ctx.user.id, record.id),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { status: 404 } });
    expect(await prisma.expenseRecord.count({ where: { id: record.id } })).toBe(0);
  });
});

describe("sales reference records", () => {
  it("creates a sales record and flags an exact duplicate", async () => {
    const first = await sales.createSalesRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      date: TODAY(),
      description: "Daily sales",
      amount: 9000,
    });
    expect(first.duplicateStatus).toBe("Not a Duplicate");
    expect(first.source).toBe("MANUAL_ENTRY");

    const second = await sales.createSalesRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      date: TODAY(),
      description: "Daily sales",
      amount: 9000,
    });
    expect(second.duplicateStatus).toBe("Flagged");
    expect(second.duplicateOfRecordId).toBe(first.id);

    const kept = await sales.updateSalesRecord(ctx.user.id, second.id, { duplicateStatus: "Not a Duplicate" });
    expect(kept).toMatchObject({ duplicateStatus: "Not a Duplicate", duplicateOfRecordId: null });
  });

  it("never applies the large-expense rule to sales", async () => {
    const r = await sales.createSalesRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      date: TODAY(),
      description: "Huge sales day",
      amount: 999999,
    });
    expect(r).not.toHaveProperty("largeExpenseFlag");
    expect(r.reviewStatus).toBe("Reviewed");

    const cannotInventDuplicate = await sales.updateSalesRecord(ctx.user.id, r.id, {
      duplicateStatus: "Flagged",
    });
    expect(cannotInventDuplicate).toMatchObject({
      duplicateStatus: "Not a Duplicate",
      duplicateOfRecordId: null,
    });
  });

  it("promotes one sales follower and repairs every pointer when the canonical is deleted", async () => {
    const first = await sales.createSalesRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      date: TODAY(),
      description: "Delete sales canonical",
      amount: 810,
    });
    await sales.createSalesRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      date: TODAY(),
      description: "Delete sales canonical",
      amount: 810,
    });
    await sales.createSalesRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      date: TODAY(),
      description: "Delete sales canonical",
      amount: 810,
    });

    await sales.deleteSalesRecord(ctx.user.id, first.id);

    const survivors = await prisma.salesReferenceRecord.findMany({
      where: { businessProfileId: ctx.profile.id, amount: 810 },
      orderBy: { id: "asc" },
    });
    const canonical = survivors.filter((record) =>
      record.duplicateStatus === "Not a Duplicate" && record.duplicateOfRecordId === null);
    expect(canonical).toHaveLength(1);
    expect(survivors.filter((record) => record.id !== canonical[0]!.id).every((record) =>
      record.duplicateStatus === "Flagged" && record.duplicateOfRecordId === canonical[0]!.id)).toBe(true);
  });

  it("does not reflag sales copies the owner kept when the old canonical is deleted", async () => {
    const created = [];
    for (let index = 0; index < 4; index++) {
      created.push(await sales.createSalesRecord(ctx.user.id, {
        businessProfileId: ctx.profile.id,
        date: TODAY(),
        description: "Kept sales duplicates",
        amount: 860,
      }));
    }
    await sales.bulkResolveSalesDuplicates(
      ctx.user.id,
      ctx.profile.id,
      [created[1]!.id, created[2]!.id],
      "keep",
    );

    await sales.deleteSalesRecord(ctx.user.id, created[0]!.id);

    const survivors = await prisma.salesReferenceRecord.findMany({
      where: { id: { in: created.slice(1).map((record) => record.id) } },
      orderBy: { id: "asc" },
    });
    expect(survivors.slice(0, 2).every((record) =>
      record.duplicateStatus === "Not a Duplicate" && record.duplicateOfRecordId === null)).toBe(true);
    expect(survivors[2]).toMatchObject({
      duplicateStatus: "Flagged",
      duplicateOfRecordId: survivors[0]!.id,
    });
  });

  it("bulk sales discard protects the canonical and repairs an intermediate follower", async () => {
    const original = await sales.createSalesRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      date: TODAY(),
      description: "Sales follower chain",
      amount: 910,
    });
    const intermediate = await sales.createSalesRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      date: TODAY(),
      description: "Sales follower chain",
      amount: 910,
    });
    const follower = await sales.createSalesRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      date: TODAY(),
      description: "Sales follower chain",
      amount: 910,
    });
    await prisma.salesReferenceRecord.update({
      where: { id: follower.id },
      data: { duplicateOfRecordId: intermediate.id },
    });

    expect(await sales.bulkResolveSalesDuplicates(
      ctx.user.id,
      ctx.profile.id,
      [original.id, intermediate.id],
      "discard",
    )).toBe(1);

    expect(await prisma.salesReferenceRecord.findUnique({ where: { id: original.id } })).not.toBeNull();
    expect(await prisma.salesReferenceRecord.findUniqueOrThrow({ where: { id: follower.id } }))
      .toMatchObject({ duplicateStatus: "Flagged", duplicateOfRecordId: original.id });
  });

  it("lets exactly one concurrent sales delete win and gives the retry a stable 404", async () => {
    const record = await sales.createSalesRecord(ctx.user.id, {
      businessProfileId: ctx.profile.id,
      date: TODAY(),
      description: "Double-delete sale",
      amount: 100,
    });

    const outcomes = await raceDeletesBehindWriteGate("SalesReferenceRecord", ctx.profile.id, [
      () => sales.deleteSalesRecord(ctx.user.id, record.id),
      () => sales.deleteSalesRecord(ctx.user.id, record.id),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { status: 404 } });
    expect(await prisma.salesReferenceRecord.count({ where: { id: record.id } })).toBe(0);
  });
});
