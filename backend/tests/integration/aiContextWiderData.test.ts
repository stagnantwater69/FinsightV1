import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Same seam recurringScheduleHttp.test.ts uses: the flag is frozen at module load.
const { recurringFlag } = vi.hoisted(() => ({ recurringFlag: { enabled: true } }));
vi.mock("../../src/services/anomalyDetection/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/anomalyDetection/config")>();
  return {
    ...actual,
    get RUNTIME_DETECTION_CONFIG() {
      return actual.detectionConfig({ featureFlags: { recurring: recurringFlag.enabled } });
    },
  };
});

import { prisma } from "../../src/config/prisma";
import * as expenses from "../../src/services/expenseRecord.service";
import * as sales from "../../src/services/salesRecord.service";
import { buildModuleContext } from "../../src/services/aiContext.service";
import { recordTag } from "../../src/services/aiAnswer.service";
import { businessDayString, disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

/**
 * The data Ask FinSight gained beyond the screen summaries: sales search, the
 * period's sales total and largest expenses, and upcoming repeating payments.
 * Each block is checked for its content and for staying inside one business.
 */

let alice: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
let mallory: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

async function seed(owner: typeof alice, tag: string, amount: number) {
  const sale = await sales.createSalesRecord(owner.user.id, {
    businessProfileId: owner.profile.id,
    date: utcDayString(-1),
    description: `${tag} catering order`,
    amount,
  });
  const expense = await expenses.createExpenseRecord(owner.user.id, {
    businessProfileId: owner.profile.id,
    categoryId: owner.categories.Utilities!,
    date: utcDayString(-2),
    description: `${tag} generator repair`,
    amount: amount * 2,
  });
  await prisma.recurringSchedule.create({
    data: {
      businessProfileId: owner.profile.id,
      categoryId: owner.categories.Utilities!,
      label: `${tag} electricity bill`,
      intervalDays: 30,
      expectedAmount: amount + 1,
      nextDueDate: new Date(businessDayString(owner.profile.timezone, 10)),
    },
  });
  const scan = await prisma.receiptScan.create({
    data: { businessProfileId: owner.profile.id, imageFile: `receipts/${tag}.jpg`, processingStatus: "Complete", confirmationStatus: "Confirmed" },
  });
  await prisma.receiptScanItem.create({
    data: { receiptScanId: scan.id, expenseRecordId: expense.id, lineNumber: 1, name: `${tag} spark plug`, amount: amount + 3 },
  });
  await prisma.notification.create({
    data: { userId: owner.user.id, businessProfileId: owner.profile.id, type: "LARGE_EXPENSE", message: `${tag} unread alert` },
  });
  return { sale, expense };
}

async function contextFor(
  owner: typeof alice,
  question: string,
  module: Parameters<typeof buildModuleContext>[2] = "Dashboard",
) {
  const profile = await prisma.businessProfile.findUniqueOrThrow({ where: { id: owner.profile.id } });
  return buildModuleContext(owner.user.id, profile, module, question);
}

beforeEach(async () => {
  await resetDb();
  recurringFlag.enabled = true;
  alice = await makeOwnerWithProfile({}, ["Utilities"]);
  mallory = await makeOwnerWithProfile({}, ["Utilities"]);
});
afterAll(disconnectDb);

describe("Ask FinSight wider data", () => {
  it("finds sales records named in the question and lets the answer link to them", async () => {
    const { sale } = await seed(alice, "ALICE", 4321);
    const { context, references } = await contextFor(alice, "how much did the catering bring in?");

    expect(context).toContain("=== SALES RECORDS MATCHING THE QUESTION");
    expect(context).toContain('Sales matching "catering": 1 record(s) totalling PHP 4,321.00');
    expect(references.get(recordTag("sales", sale.id))).toMatchObject({ recordType: "sales", id: sale.id, amount: 4321 });
  });

  it("states the period's sales total and its largest expenses", async () => {
    const { expense } = await seed(alice, "ALICE", 4321);
    const { context, references } = await contextFor(alice, "how am I doing?");

    expect(context).toContain("Sales recorded this period: PHP 4,321.00 across 1 sales record(s)");
    // Same figure the Dashboard block reports, so the two can never disagree.
    expect(context).toContain("Total sales recorded: PHP 4,321.00");
    expect(context).toContain("Largest expense records dated in this period");
    expect(context).toContain(`"ALICE generator repair" PHP 8,642.00`);
    expect(references.has(recordTag("expense", expense.id))).toBe(true);
  });

  it("lists upcoming repeating payments only while the recurring feature is on", async () => {
    await seed(alice, "ALICE", 4321);
    const on = await contextFor(alice, "what bills are coming up?");
    expect(on.context).toContain("=== UPCOMING REPEATING PAYMENTS");
    expect(on.context).toContain('"ALICE electricity bill" expected PHP 4,322.00');

    recurringFlag.enabled = false;
    const off = await contextFor(alice, "what bills are coming up?");
    expect(off.context).not.toContain("UPCOMING REPEATING PAYMENTS");
  });

  it("summarises what was added recently, and unread alerts on a narrow screen", async () => {
    await seed(alice, "ALICE", 4321);
    const { context } = await contextFor(alice, "what's happening in my business?", "Recovery Target");

    expect(context).toContain("=== RECENT ACTIVITY");
    expect(context).toContain("Expenses added: 1 record(s) totalling PHP 8,642.00");
    expect(context).toContain("Sales added: 1 record(s) totalling PHP 4,321.00");
    expect(context).toContain("Receipts scanned: 1.");
    expect(context).toContain("Unread alerts: 1");
    expect(context).toContain("[LARGE_EXPENSE] ALICE unread alert");
  });

  it("gives every category a figure, not just the top five", async () => {
    const names = ["Cat A", "Cat B", "Cat C", "Cat D", "Cat E", "Cat F", "Cat G"];
    for (const [index, name] of names.entries()) {
      const category = await prisma.expenseCategory.create({ data: { businessProfileId: alice.profile.id, name } });
      await expenses.createExpenseRecord(alice.user.id, {
        businessProfileId: alice.profile.id,
        categoryId: category.id,
        date: utcDayString(-1),
        description: `${name} purchase`,
        amount: 1000 - index * 100,
      });
    }
    const { context } = await contextFor(alice, "how am I doing?");

    expect(context).toContain("Other categories this period:");
    expect(context).toContain("- Cat F: PHP 500.00");
    expect(context).toContain("- Cat G: PHP 400.00");
  });

  it("names the best and lowest sales days", async () => {
    for (const [offset, amount] of [[-1, 900], [-2, 300], [-2, 200], [-3, 1500]] as const) {
      await sales.createSalesRecord(alice.user.id, {
        businessProfileId: alice.profile.id, date: utcDayString(offset), description: "Daily sales", amount,
      });
    }
    const { context } = await contextFor(alice, "how are sales?");

    expect(context).toContain(`Best sales day this period: ${utcDayString(-3)} with PHP 1,500.00`);
    expect(context).toContain(`Lowest sales day this period (among days with sales recorded): ${utcDayString(-2)} with PHP 500.00`);
  });

  it("finds items inside saved receipts and links the expense they belong to", async () => {
    const { expense } = await seed(alice, "ALICE", 4321);
    const { context, references } = await contextFor(alice, "how much on spark plugs?");

    expect(context).toContain('Receipt items matching "spark": 1 item line(s) totalling PHP 4,324.00');
    expect(context).toContain('Item "ALICE spark plug" PHP 4,324.00');
    expect(references.has(recordTag("expense", expense.id))).toBe(true);
  });

  it("answers an amount filter from the database", async () => {
    await seed(alice, "ALICE", 4321);
    const { context } = await contextFor(alice, "which expenses were over 5,000?");

    expect(context).toContain("Expense records over PHP 5,000.00: 1 record(s) totalling PHP 8,642.00");
    expect(context).toContain('"ALICE generator repair" PHP 8,642.00');
  });

  it("never shows another owner's records, receipts, alerts or schedules", async () => {
    await seed(alice, "ALICE", 4321);
    await seed(mallory, "MALLORY", 7777);
    const { context, references } = await contextFor(
      alice,
      "how much did the catering, spark plugs and generator cost over 100?",
      "Expense Insights",
    );

    expect(context).toContain("ALICE catering order");
    expect(context).toContain("ALICE spark plug");
    expect(context).toContain("Unread alerts: 1");
    expect(context).not.toContain("MALLORY");
    for (const figure of ["7,777", "7,778", "7,780", "15,554"]) expect(context).not.toContain(figure);
    expect([...references.values()].every((reference) => reference.label.startsWith("ALICE"))).toBe(true);
  });
});
