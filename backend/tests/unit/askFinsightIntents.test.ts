import { describe, expect, it } from "vitest";
import { recordedTransaction, recoveryWhatIf, reductionWhatIf, COMPLETENESS_CUE, RECURRING_CUE } from "../../src/lib/chatIntents";
import { extractComparedMonths } from "../../src/lib/questionPeriod";

/**
 * Each reader decides whether Ask FinSight runs a calculation or offers a
 * button. A false positive is the expensive mistake, so the "no" cases matter
 * as much as the "yes" ones.
 */

describe("recordedTransaction", () => {
  it.each([
    ["I paid 500 for rice today", { recordType: "expense", amount: 500, description: "rice" }],
    ["bought 1,250 worth of LPG yesterday", { recordType: "expense", amount: 1250 }],
    ["sold 3,000 today", { recordType: "sales", amount: 3000, description: "Daily sales" }],
    ["nabenta ko 2,500 kanina", { recordType: "sales", amount: 2500 }],
  ])("reads %j as something already recorded-worthy", (message, expected) => {
    expect(recordedTransaction(message)).toMatchObject(expected);
  });

  it.each([
    "how much did I spend on rice?",
    "did I pay 500 for rice?",
    "what if I buy a 12,000 fridge",
    "if I paid 500 more for rice",
    "I paid for rice today",
    "rice was expensive",
  ])("does not offer to record %j", (message) => {
    expect(recordedTransaction(message)).toBeNull();
  });
});

describe("recoveryWhatIf", () => {
  it("reads a daily sales lever and a monthly costs lever", () => {
    expect(recoveryWhatIf("what if I sell 3,000 a day?")).toEqual({ kind: "daily-sales", amount: 3000 });
    expect(recoveryWhatIf("what if my monthly costs were 80,000?")).toEqual({ kind: "monthly-costs", amount: 80000 });
  });

  it.each(["I sell 3,000 a day", "what if I buy a 3,000 mixer", "what if I sell more?"])("ignores %j", (message) => {
    expect(recoveryWhatIf(message)).toBeNull();
  });
});

describe("reductionWhatIf", () => {
  it("reads a percent or an amount cut", () => {
    expect(reductionWhatIf("what if I cut Supplies by 10%?")).toEqual({ kind: "percent", value: 10 });
    expect(reductionWhatIf("how much would I save if I reduce Utilities by 1,000?")).toEqual({ kind: "amount", value: 1000 });
  });

  it.each(["cut Supplies by 10%", "what if I cut Supplies by 150%?", "what if I spend 1,000 on Supplies?"])("ignores %j", (message) => {
    expect(reductionWhatIf(message)).toBeNull();
  });
});

describe("question cues", () => {
  it("spots completeness and repeating-payment questions", () => {
    expect(COMPLETENESS_CUE.test("is my data complete?")).toBe(true);
    expect(COMPLETENESS_CUE.test("may nakalimutan ba ako?")).toBe(true);
    expect(RECURRING_CUE.test("what are my regular bills?")).toBe(true);
    expect(RECURRING_CUE.test("how much did I sell?")).toBe(false);
  });
});

describe("extractComparedMonths", () => {
  const today = new Date(Date.UTC(2026, 10, 10));

  it("returns two named months oldest first", () => {
    const months = extractComparedMonths("compare October and September", today);
    expect(months?.map((month) => month.label)).toEqual(["September 2026", "October 2026"]);
  });

  it("pairs this month with last month, across a year boundary", () => {
    expect(extractComparedMonths("this month vs last month", today)?.map((m) => m.label)).toEqual(["October 2026", "November 2026"]);
    const january = new Date(Date.UTC(2027, 0, 5));
    expect(extractComparedMonths("this month vs last month", january)?.map((m) => m.label)).toEqual(["December 2026", "January 2027"]);
  });

  it("needs two different months", () => {
    expect(extractComparedMonths("how did October go?", today)).toBeNull();
    expect(extractComparedMonths("this month vs November", today)).toBeNull();
  });
});
