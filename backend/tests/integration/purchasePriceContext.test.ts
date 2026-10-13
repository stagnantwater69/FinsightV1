import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as expenses from "../../src/services/expenseRecord.service";
import { buildPurchasePriceContext } from "../../src/services/insights.service";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDayString } from "../setup/testDb";

/**
 * The "is this normal for you?" half of Spending Impact, against real rows.
 *
 * The unit suite pins the matching RULES; this pins the QUERY, which is where
 * the failure actually happened. An owner pricing a house was shown a snack
 * receipt at PHP 5,313 as the last time they bought something like it: the
 * search is a SQL `contains`, one receipt line read "Piattos Roadhouse BBQ",
 * and "Roadhouse" contains "house". Nothing between the query and the screen
 * looked at whether that was a whole word.
 *
 * This is the half of the card labelled as counted from the owner's records
 * rather than written by AI, so a wrong number here spends the trust that
 * label was built to earn.
 */

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({ availableFunds: 50000 }, ["Inventory", "Equipment"]);
});

afterAll(disconnectDb);

async function addExpense(category: string, description: string, amount: number, dayOffset = -10) {
  return expenses.createExpenseRecord(ctx.user.id, {
    businessProfileId: ctx.profile.id,
    categoryId: ctx.categories[category]!,
    date: utcDayString(dayOffset),
    description,
    amount,
  });
}

const priceFor = (description: string, amount: number | null = null) =>
  buildPurchasePriceContext(ctx.user.id, ctx.profile.id, description, amount, null);

describe("what counts as a purchase like this one", () => {
  it("does not offer a snack receipt as the last time they bought a house", async () => {
    await addExpense(
      "Inventory",
      "Piattos Roadhouse BBQ (40g) - Bag, Mr. Chips Nacho Cheese (24g) - Bag, Presto Creams Peanut Butter (30g) - Pack of 10",
      5313,
    );

    const price = await priceFor("house", 38000);

    expect(price.similar).toEqual([]);
  });

  it("still finds the real thing when the owner has bought one before", async () => {
    await addExpense("Equipment", "Display fridge for the drinks", 11000);
    await addExpense("Inventory", "Display rack for the counter", 1800);

    const price = await priceFor("display fridge", 12500);

    expect(price.similar.map((r) => r.description)).toEqual(["Display fridge for the drinks"]);
    expect(price.similar[0]!.amount).toBe(11000);
  });

  it("matches a plural against the singular the owner typed", async () => {
    await addExpense("Equipment", "Plastic chairs x6", 2400);

    const price = await priceFor("chair", 500);

    expect(price.similar).toHaveLength(1);
  });

  /*
   * A confirmed scan writes every line of a receipt into one record, so its
   * amount is the whole shop. Even a genuine word match must not be quoted as
   * the price of one item.
   */
  it("leaves out a basket total even when the word match is real", async () => {
    await addExpense(
      "Inventory",
      "Rice 25kg, cooking oil 2L, soy sauce 1L, vinegar 1L, sugar 5kg",
      4200,
    );

    const price = await priceFor("rice", 1500);

    expect(price.similar).toEqual([]);
  });

  /*
   * The prefilter takes 30 and the card shows 3. Without the wider take, three
   * substring false positives would crowd out the genuine match behind them.
   */
  it("finds a real match hidden behind a run of substring false positives", async () => {
    for (let i = 0; i < 12; i += 1) {
      await addExpense("Inventory", `Roadhouse snack pack batch ${i}`, 300, -(i + 2));
    }
    await addExpense("Equipment", "House deposit", 38000, -20);

    const price = await priceFor("house", 38000);

    expect(price.similar.map((r) => r.description)).toEqual(["House deposit"]);
  });
});
