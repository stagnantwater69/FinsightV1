import { describe, expect, it } from "vitest";
import { amountFilter, searchTerms } from "../../src/services/aiContext.service";

describe("amountFilter reads an amount bound out of an Ask FinSight question", () => {
  it.each([
    ["which expenses were over 5,000 last week?", { recordType: "expense", comparison: "gt", amount: 5000 }],
    ["show sales below ₱2k this month", { recordType: "sales", comparison: "lt", amount: 2000 }],
    ["expenses of at least PHP 1,250.50", { recordType: "expense", comparison: "gte", amount: 1250.5 }],
    ["gastos na lagpas sa 3000", { recordType: "expense", comparison: "gt", amount: 3000 }],
    ["benta na mababa sa 500", { recordType: "sales", comparison: "lt", amount: 500 }],
  ])("%s", (question, expected) => {
    expect(amountFilter(question)).toEqual(expected);
  });

  it.each([
    "how am I doing?",
    "what happened over the last month?",
    "did I buy rice more than 3 times?",
    "is rent over 20% of my expenses?",
    "anything under 5 days old?",
  ])("finds no amount bound in %s", (question) => {
    expect(amountFilter(question)).toBeNull();
  });

  it("does not search records for the comparison words themselves", () => {
    expect(searchTerms("expenses above 5,000 for rice")).toEqual(["rice"]);
    expect(searchTerms("gastos na lagpas sa 3000")).toEqual([]);
  });
});
