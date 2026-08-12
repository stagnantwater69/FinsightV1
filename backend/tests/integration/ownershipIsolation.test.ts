import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/services/storage.service", () => ({
  uploadReceiptImage: vi.fn(async () => "mock/receipt.jpg"),
  uploadCsvFile: vi.fn(async () => "mock/import.csv"),
}));

import { prisma } from "../../src/config/prisma";
import * as businessProfiles from "../../src/services/businessProfile.service";
import * as categories from "../../src/services/expenseCategory.service";
import * as expenses from "../../src/services/expenseRecord.service";
import * as sales from "../../src/services/salesRecord.service";
import * as notifications from "../../src/services/notification.service";
import * as insights from "../../src/services/insights.service";
import { getDashboardSummary } from "../../src/services/dashboard.service";
import { getHistory } from "../../src/services/ai.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

// Multi-tenant isolation, asserted explicitly rather than assumed.
//
// FinSight is single-role: there is no admin, so a user's own ownership scope is
// the ONLY access control in the system. Every one of these is a
// confidentiality assertion, not a nicety.
//
// The expected failure is consistently 404, never 403: a 403 would confirm to an
// attacker that the id they guessed exists and belongs to somebody. "Not found"
// leaks nothing.

let alice: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
let bob: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
let aliceExpenseId: number;
let aliceSalesId: number;

beforeEach(async () => {
  await resetDb();
  alice = await makeOwnerWithProfile({ name: "Alice's Store" });
  bob = await makeOwnerWithProfile({ name: "Bob's Store" });

  aliceExpenseId = (
    await expenses.createExpenseRecord(alice.user.id, {
      businessProfileId: alice.profile.id,
      categoryId: alice.categories.Inventory!,
      date: utcDayString(0),
      description: "Alice private purchase",
      amount: 5000,
    })
  ).id;

  aliceSalesId = (
    await sales.createSalesRecord(alice.user.id, {
      businessProfileId: alice.profile.id,
      date: utcDayString(0),
      description: "Alice private sales",
      amount: 9000,
    })
  ).id;
});

afterAll(disconnectDb);

const notFound = { status: 404 };

describe("business profiles", () => {
  it("does not list another owner's profile", async () => {
    const list = await businessProfiles.listBusinessProfiles(bob.user.id);
    expect(list.map((p) => p.id)).toEqual([bob.profile.id]);
    expect(list.map((p) => p.name)).not.toContain("Alice's Store");
  });

  it("cannot read another owner's profile", async () => {
    await expect(businessProfiles.getBusinessProfile(bob.user.id, alice.profile.id)).rejects.toMatchObject(notFound);
  });

  it("cannot update another owner's profile", async () => {
    await expect(
      businessProfiles.updateBusinessProfile(bob.user.id, alice.profile.id, { name: "Hijacked" })
    ).rejects.toMatchObject(notFound);

    const untouched = await prisma.businessProfile.findUniqueOrThrow({ where: { id: alice.profile.id } });
    expect(untouched.name).toBe("Alice's Store");
  });

  // NOTE: there is deliberately no delete path for business profiles — no
  // route, controller or service exists. So there is nothing to isolate here.
  // Recorded as a coverage gap rather than tested: see the Phase 6 report.
});

describe("expense categories", () => {
  it("does not list another owner's categories", async () => {
    await expect(categories.listCategories(bob.user.id, alice.profile.id)).rejects.toMatchObject(notFound);
  });

  it("cannot create a category inside another owner's profile", async () => {
    await expect(
      categories.createCategory(bob.user.id, { businessProfileId: alice.profile.id, name: "Injected" })
    ).rejects.toMatchObject(notFound);
    expect(await prisma.expenseCategory.count({ where: { businessProfileId: alice.profile.id, name: "Injected" } })).toBe(0);
  });
});

describe("expense records", () => {
  it("cannot read another owner's expense record", async () => {
    await expect(expenses.getExpenseRecord(bob.user.id, aliceExpenseId)).rejects.toMatchObject(notFound);
  });

  it("cannot edit another owner's expense record", async () => {
    await expect(
      expenses.updateExpenseRecord(bob.user.id, aliceExpenseId, { amount: 1, description: "Tampered" })
    ).rejects.toMatchObject(notFound);

    const untouched = await prisma.expenseRecord.findUniqueOrThrow({ where: { id: aliceExpenseId } });
    expect(untouched.description).toBe("Alice private purchase");
    expect(Number(untouched.amount)).toBe(5000);
  });

  it("cannot delete another owner's expense record", async () => {
    await expect(expenses.deleteExpenseRecord(bob.user.id, aliceExpenseId)).rejects.toMatchObject(notFound);
    expect(await prisma.expenseRecord.count({ where: { id: aliceExpenseId } })).toBe(1);
  });

  it("cannot search another owner's records", async () => {
    await expect(
      expenses.searchExpenseRecords(bob.user.id, { businessProfileId: alice.profile.id })
    ).rejects.toMatchObject(notFound);
  });

  it("search on one's own profile never returns another owner's records", async () => {
    await expenses.createExpenseRecord(bob.user.id, {
      businessProfileId: bob.profile.id,
      categoryId: bob.categories.Inventory!,
      date: utcDayString(0),
      description: "Bob own purchase",
      amount: 100,
    });

    const results = await expenses.searchExpenseRecords(bob.user.id, { businessProfileId: bob.profile.id });
    expect(results.map((r) => r.description)).toEqual(["Bob own purchase"]);
    expect(results.every((r) => r.businessProfileId === bob.profile.id)).toBe(true);
  });

  it("cannot list another owner's flagged records", async () => {
    await expect(expenses.listFlaggedExpenseRecords(bob.user.id, alice.profile.id)).rejects.toMatchObject(notFound);
  });
});

describe("sales reference records", () => {
  it("cannot read another owner's sales record", async () => {
    await expect(sales.getSalesRecord(bob.user.id, aliceSalesId)).rejects.toMatchObject(notFound);
  });

  it("cannot edit another owner's sales record", async () => {
    await expect(
      sales.updateSalesRecord(bob.user.id, aliceSalesId, { amount: 1 })
    ).rejects.toMatchObject(notFound);
    const untouched = await prisma.salesReferenceRecord.findUniqueOrThrow({ where: { id: aliceSalesId } });
    expect(Number(untouched.amount)).toBe(9000);
  });

  it("cannot delete another owner's sales record", async () => {
    await expect(sales.deleteSalesRecord(bob.user.id, aliceSalesId)).rejects.toMatchObject(notFound);
    expect(await prisma.salesReferenceRecord.count({ where: { id: aliceSalesId } })).toBe(1);
  });
});

describe("dashboard and insights", () => {
  it("cannot read another owner's dashboard", async () => {
    await expect(getDashboardSummary(bob.user.id, alice.profile.id, 30)).rejects.toMatchObject(notFound);
  });

  it("cannot read another owner's expense behaviour", async () => {
    await expect(insights.getExpenseBehavior(bob.user.id, alice.profile.id, 30)).rejects.toMatchObject(notFound);
  });

  it("cannot read another owner's recovery insight", async () => {
    await expect(insights.getRecoveryInsight(bob.user.id, alice.profile.id, 14)).rejects.toMatchObject(notFound);
  });

  it("cannot run a spending-impact simulation against another owner's funds", async () => {
    await expect(insights.simulateSpendingImpact(bob.user.id, alice.profile.id, 1000)).rejects.toMatchObject(notFound);
  });

  it("a dashboard shows only its own profile's figures", async () => {
    // Alice has 5,000 of expenses and 9,000 of sales; Bob has nothing. If any
    // cross-tenant leak existed, Bob's totals would be non-zero.
    const bobDash = await getDashboardSummary(bob.user.id, bob.profile.id, 30);
    expect(bobDash.overview.totalExpenses).toBe(0);
    expect(bobDash.overview.totalSalesReference).toBe(0);

    const aliceDash = await getDashboardSummary(alice.user.id, alice.profile.id, 30);
    expect(aliceDash.overview.totalExpenses).toBe(5000);
    expect(aliceDash.overview.totalSalesReference).toBe(9000);
  });
});

describe("notifications", () => {
  it("cannot list another owner's notifications", async () => {
    await expenses.createExpenseRecord(alice.user.id, {
      businessProfileId: alice.profile.id,
      categoryId: alice.categories.Inventory!,
      date: utcDayString(0),
      description: "Triggers an alert",
      amount: 999999,
    });
    // Alice genuinely has notifications...
    expect((await notifications.listNotifications(alice.user.id, alice.profile.id)).length).toBeGreaterThan(0);
    // ...and Bob is refused, rather than being handed a quiet empty list.
    await expect(notifications.listNotifications(bob.user.id, alice.profile.id)).rejects.toMatchObject(notFound);
  });

  it("returns 404 for a nonexistent profile too, so the error is not an existence oracle", async () => {
    await expect(notifications.listNotifications(bob.user.id, alice.profile.id)).rejects.toMatchObject(notFound);
    await expect(notifications.listNotifications(bob.user.id, 999999)).rejects.toMatchObject(notFound);
  });

  it("still lists a user's own notifications across all their profiles when no profile is named", async () => {
    // The profile filter is optional; omitting it must not require ownership of
    // anything, and must still only ever return the caller's own rows.
    await expenses.createExpenseRecord(alice.user.id, {
      businessProfileId: alice.profile.id,
      categoryId: alice.categories.Inventory!,
      date: utcDayString(0),
      description: "Triggers an alert",
      amount: 999999,
    });
    const aliceAll = await notifications.listNotifications(alice.user.id);
    expect(aliceAll.length).toBeGreaterThan(0);
    expect(await notifications.listNotifications(bob.user.id)).toEqual([]);
  });

  it("cannot mark another owner's notification as read", async () => {
    await expenses.createExpenseRecord(alice.user.id, {
      businessProfileId: alice.profile.id,
      categoryId: alice.categories.Inventory!,
      date: utcDayString(0),
      description: "Triggers an alert",
      amount: 999999,
    });
    const aliceNote = await prisma.notification.findFirstOrThrow({ where: { userId: alice.user.id } });
    await expect(notifications.markNotificationRead(bob.user.id, aliceNote.id)).rejects.toMatchObject(notFound);

    const untouched = await prisma.notification.findUniqueOrThrow({ where: { id: aliceNote.id } });
    expect(untouched.readStatus).toBe(false);
  });

  it("does not leak one business profile's alerts into another's", async () => {
    // This is why Notification carries a businessProfileId: without it, an
    // owner's two shops would share one alert feed.
    const aliceSecond = await prisma.businessProfile.create({
      data: {
        userId: alice.user.id,
        name: "Alice's Second Shop",
        type: "Sari-Sari Store",
        availableFunds: 1000,
        expectedMonthlyExpenses: 1000,
        operatingDays: 20,
        largeExpenseThresholdPercent: 20,
      },
    });

    // Trigger a large-expense alert on the FIRST shop only.
    await expenses.createExpenseRecord(alice.user.id, {
      businessProfileId: alice.profile.id,
      categoryId: alice.categories.Inventory!,
      date: utcDayString(0),
      description: "Big one",
      amount: 999999,
    });

    const first = await notifications.listNotifications(alice.user.id, alice.profile.id);
    const second = await notifications.listNotifications(alice.user.id, aliceSecond.id);
    expect(first.length).toBeGreaterThan(0);
    expect(second).toHaveLength(0);
  });
});

describe("AI interactions", () => {
  it("cannot read another owner's AI conversation history", async () => {
    await prisma.aIInteraction.create({
      data: {
        userId: alice.user.id,
        businessProfileId: alice.profile.id,
        module: "Dashboard",
        question: "Alice's private question about her finances",
        aiResponse: "Alice's private answer containing her real figures",
      },
    });

    await expect(getHistory(bob.user.id, alice.profile.id, "Dashboard")).rejects.toMatchObject(notFound);
  });

  it("history on one's own profile never includes another owner's turns", async () => {
    await prisma.aIInteraction.create({
      data: {
        userId: alice.user.id,
        businessProfileId: alice.profile.id,
        module: "Dashboard",
        question: "Alice question",
        aiResponse: "Alice answer",
      },
    });
    await prisma.aIInteraction.create({
      data: {
        userId: bob.user.id,
        businessProfileId: bob.profile.id,
        module: "Dashboard",
        question: "Bob question",
        aiResponse: "Bob answer",
      },
    });

    const bobHistory = await getHistory(bob.user.id, bob.profile.id, "Dashboard");
    expect(bobHistory.map((h) => h.question)).toEqual(["Bob question"]);
  });
});

describe("non-existent ids behave identically to other owners' ids", () => {
  // If a missing id and a forbidden id produced different errors, the
  // difference itself would be an existence oracle.
  it("returns 404 for both a foreign profile and a nonexistent one", async () => {
    await expect(businessProfiles.getBusinessProfile(bob.user.id, alice.profile.id)).rejects.toMatchObject(notFound);
    await expect(businessProfiles.getBusinessProfile(bob.user.id, 999999)).rejects.toMatchObject(notFound);
  });

  it("returns 404 for both a foreign record and a nonexistent one", async () => {
    await expect(expenses.getExpenseRecord(bob.user.id, aliceExpenseId)).rejects.toMatchObject(notFound);
    await expect(expenses.getExpenseRecord(bob.user.id, 999999)).rejects.toMatchObject(notFound);
  });
});
