import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/config/prisma";
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
  });
});
