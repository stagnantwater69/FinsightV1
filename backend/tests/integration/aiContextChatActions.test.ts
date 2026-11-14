import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Same seam aiContextWiderData.test.ts uses: the flag is frozen at module load.
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
import { sendWeeklySummaries } from "../../src/services/weeklySummary.service";
import { NOTIFICATION_TYPES } from "../../src/services/notification.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

/**
 * The second round of Ask FinSight additions: month comparison, top vendors,
 * recovery and cost-cut what-ifs, the completeness check, buttons to watch a
 * repeating expense or record something the owner says they paid, and the
 * Monday summary alert. Each stays inside the asking owner's business.
 */

let alice: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
let mallory: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The 15th of the month `back` months before this one, and its name. */
function pastMonth(back: number) {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 15));
  return { name: MONTHS[date.getUTCMonth()]!, day: date.toISOString().slice(0, 10), label: `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}` };
}

async function expense(owner: typeof alice, amount: number, extra: { date?: string; vendor?: string; category?: string; description?: string } = {}) {
  return expenses.createExpenseRecord(owner.user.id, {
    businessProfileId: owner.profile.id,
    categoryId: owner.categories[extra.category ?? "Utilities"]!,
    date: extra.date ?? utcDayString(-1),
    description: extra.description ?? "Utility payment",
    vendor: extra.vendor,
    amount,
  });
}

async function sale(owner: typeof alice, amount: number, date = utcDayString(-1)) {
  return sales.createSalesRecord(owner.user.id, { businessProfileId: owner.profile.id, date, description: "Daily sales", amount });
}

async function candidate(owner: typeof alice, description: string) {
  return prisma.recurringPattern.create({
    data: {
      businessProfileId: owner.profile.id,
      categoryId: owner.categories.Utilities!,
      normalizedKey: description.toLowerCase(),
      description,
      intervalDays: 30,
      expectedAmount: 1200,
      amountTolerance: 0.1,
      confidence: 0.9,
      observationCount: 3,
      lastOccurrence: new Date(utcDayString(-20)),
      nextExpectedDate: new Date(utcDayString(10)),
    },
  });
}

async function contextFor(owner: typeof alice, question: string, module: Parameters<typeof buildModuleContext>[2] = "Dashboard") {
  const profile = await prisma.businessProfile.findUniqueOrThrow({ where: { id: owner.profile.id } });
  return buildModuleContext(owner.user.id, profile, module, question);
}

beforeEach(async () => {
  await resetDb();
  recurringFlag.enabled = true;
  alice = await makeOwnerWithProfile({}, ["Utilities", "Uncategorized"]);
  mallory = await makeOwnerWithProfile({}, ["Utilities", "Uncategorized"]);
});
afterAll(disconnectDb);

describe("Ask FinSight comparisons and lists", () => {
  it("compares two named months with the differences already worked out", async () => {
    const earlier = pastMonth(2);
    const later = pastMonth(1);
    await expense(alice, 1000, { date: earlier.day });
    await expense(alice, 1500, { date: later.day });
    await sale(alice, 2000, earlier.day);
    await sale(alice, 1000, later.day);
    await expense(mallory, 9999, { date: later.day });

    const { context } = await contextFor(alice, `compare ${later.name} and ${earlier.name}`);

    expect(context).toContain(`=== MONTH COMPARISON: ${earlier.label} and ${later.label} ===`);
    expect(context).toContain(`- Utilities change from ${earlier.label} to ${later.label}: up PHP 500.00`);
    expect(context).toContain(`- Total sales recorded change from ${earlier.label} to ${later.label}: down PHP 1,000.00`);
    expect(context).not.toContain("9,999");
  });

  it("names the vendors paid the most, from this business only", async () => {
    await expense(alice, 700, { vendor: "Petron" });
    await expense(alice, 300, { vendor: "Petron" });
    await expense(alice, 400, { vendor: "Meralco" });
    await expense(mallory, 5000, { vendor: "Mallory Supply" });

    const { context } = await contextFor(alice, "who do I pay the most?");

    expect(context).toContain("- Petron: PHP 1,000.00 across 2 record(s)");
    expect(context).toContain("- Meralco: PHP 400.00 across 1 record(s)");
    expect(context).not.toContain("Mallory Supply");
  });
});

describe("Ask FinSight what-ifs", () => {
  it("projects a daily sales pace over the open days Recovery Target counts", async () => {
    const { context, scenario } = await contextFor(alice, "what if I sell 3,000 a day?", "Recovery Target");

    expect(context).toContain("=== RECOVERY WHAT-IF: selling PHP 3,000.00 on each open day left this month ===");
    expect(context).toMatch(/Open days left this month, as Recovery Target counts them: \d+|There are no open days left this month/);
    // A sales pace is not a purchase: the spending what-if stays out.
    expect(scenario).toBeUndefined();
  });

  it("runs a monthly-costs what-if through the Recovery Target simulator", async () => {
    const { context } = await contextFor(alice, "what if my monthly costs were 80,000?", "Recovery Target");

    expect(context).toContain("=== RECOVERY WHAT-IF: if monthly costs were PHP 80,000.00 ===");
    expect(context).toContain("New daily goal in this what-if:");
  });

  it("works out a cost cut for a category the owner named, and asks when none is named", async () => {
    await expense(alice, 1000);
    const named = await contextFor(alice, "what if I cut Utilities by 10%?");
    expect(named.context).toContain("Amount this cut takes off: PHP 100.00");
    expect(named.context).toContain("Utilities spending in the period with this cut: PHP 900.00");

    const unnamed = await contextFor(alice, "what if I cut costs by 10%?");
    expect(unnamed.context).toContain("the question names none of their categories");
  });

  it("explains a cut it cannot calculate instead of failing the message", async () => {
    await expense(alice, 1000);
    const { context } = await contextFor(alice, "what if I cut Utilities by 5,000?");
    expect(context).toContain("FinSight could not calculate this cut for Utilities");
  });
});

describe("Ask FinSight completeness check", () => {
  it("counts uncategorised records and open days with no sales", async () => {
    await expense(alice, 250, { category: "Uncategorized" });
    await expense(mallory, 250, { category: "Uncategorized" });
    await expense(mallory, 250, { category: "Uncategorized" });

    const { context } = await contextFor(alice, "is my data complete?");

    expect(context).toContain("=== IS THE DATA COMPLETE? ===");
    expect(context).toContain("Expense records still without a category (Uncategorized): 1");
    expect(context).toMatch(/Open days in the last \d+ days with no sales recorded: |Every open day in the last \d+ days has sales recorded\./);
  });
});

describe("Ask FinSight buttons", () => {
  it("offers to watch this owner's noticed repeating expenses, only while the feature is on", async () => {
    const mine = await candidate(alice, "LPG refill");
    const theirs = await candidate(mallory, "Mallory water delivery");

    const on = await contextFor(alice, "what are my regular bills?");
    expect(on.context).toContain('- "LPG refill": usually PHP 1,200.00, about every 30 days');
    expect(on.context).not.toContain("Mallory");
    expect(on.actions).toContainEqual({ kind: "watch-recurring-pattern", patternId: mine.id, label: 'Watch "LPG refill" as a repeating payment' });
    expect(on.actions.some((action) => action.kind === "watch-recurring-pattern" && action.patternId === theirs.id)).toBe(false);

    recurringFlag.enabled = false;
    const off = await contextFor(alice, "what are my regular bills?");
    expect(off.actions.some((action) => action.kind === "watch-recurring-pattern")).toBe(false);
  });

  it("offers a filled-in Add expense form for something the owner says they paid", async () => {
    await expense(mallory, 500, { date: utcDayString(0) });
    const { context, actions } = await contextFor(alice, "I paid 500 for rice today");

    expect(context).toContain('The owner says they paid PHP 500.00 for "rice". This is NOT in their records yet.');
    expect(actions).toContainEqual({ kind: "prefill-record", recordType: "expense", amount: 500, description: "rice", label: "Add this expense" });
  });

  it("holds the button back when a record of that amount is already there this week", async () => {
    await expense(alice, 500, { date: utcDayString(-1), description: "Rice sack" });
    const { context, actions } = await contextFor(alice, "I paid 500 for rice today");

    expect(context).toContain('An expense record of the same amount is already in the records: "Rice sack" PHP 500.00');
    expect(actions.some((action) => action.kind === "prefill-record")).toBe(false);
  });

  it("offers Add sales for a sale, and nothing for a question about one", async () => {
    const said = await contextFor(alice, "sold 3,000 today");
    expect(said.actions).toContainEqual({ kind: "prefill-record", recordType: "sales", amount: 3000, description: "Daily sales", label: "Add this sale" });

    const asked = await contextFor(alice, "how much did I sell today?");
    expect(asked.actions.some((action) => action.kind === "prefill-record")).toBe(false);
  });
});

describe("weekly summary alert", () => {
  /** A Monday noon in Manila (the test profiles' timezone), a few weeks back so its week is all past. */
  function mondayNoonManila(): Date {
    const day = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000);
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
    return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 4));
  }
  const dayBefore = (monday: Date, days: number) => new Date(monday.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  it("sends one summary per business on a Monday, and only for a week with records", async () => {
    const monday = mondayNoonManila();
    await expense(alice, 1200, { date: dayBefore(monday, 3) });
    await sale(alice, 5000, dayBefore(monday, 2));
    await sale(alice, 999, dayBefore(monday, 8)); // the week before: not counted

    expect(await sendWeeklySummaries(monday)).toEqual({ sent: 1 });
    const sent = await prisma.notification.findMany({ where: { type: NOTIFICATION_TYPES.WEEKLY_SUMMARY } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ userId: alice.user.id, businessProfileId: alice.profile.id, readStatus: false });
    expect(sent[0]!.message).toContain(`Last week (${dayBefore(monday, 7)} to ${dayBefore(monday, 1)})`);
    expect(sent[0]!.message).toContain("PHP 5,000.00 in sales from 1 record(s), PHP 1,200.00 in expenses from 1 record(s)");

    // The hourly sweep runs again the same day: nothing new.
    expect(await sendWeeklySummaries(new Date(monday.getTime() + 60 * 60 * 1000))).toEqual({ sent: 0 });
  });

  it("sends one summary when two workers sweep at the same moment", async () => {
    const monday = mondayNoonManila();
    await expense(alice, 1200, { date: dayBefore(monday, 3) });

    const results = await Promise.all([sendWeeklySummaries(monday), sendWeeklySummaries(monday)]);
    expect(results.map((r) => r.sent).sort()).toEqual([0, 1]);
    expect(await prisma.notification.count({ where: { type: NOTIFICATION_TYPES.WEEKLY_SUMMARY } })).toBe(1);
  });

  it("sends nothing on other days", async () => {
    const monday = mondayNoonManila();
    await expense(alice, 1200, { date: dayBefore(monday, 3) });
    expect(await sendWeeklySummaries(new Date(monday.getTime() + 24 * 60 * 60 * 1000))).toEqual({ sent: 0 });
  });

  it("keeps the timezone in mind: Sunday evening UTC is already Monday in Manila", async () => {
    const monday = mondayNoonManila();
    await expense(alice, 1200, { date: dayBefore(monday, 3) });
    const sundayEveningUtc = new Date(monday.getTime() - 6 * 60 * 60 * 1000 + 30 * 60 * 1000); // 22:30 UTC Sunday = 06:30 Monday Manila
    expect(sundayEveningUtc.getUTCDay()).toBe(0);
    expect(await sendWeeklySummaries(sundayEveningUtc)).toEqual({ sent: 1 });
  });
});
