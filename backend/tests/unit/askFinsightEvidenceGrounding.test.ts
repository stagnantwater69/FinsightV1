import { describe, expect, it, vi } from "vitest";
import {
  AMOUNT_FALLBACK_ANSWER,
  groundAnswer,
  statedFigures,
  type RecordReference,
} from "../../src/services/aiAnswer.service";
import type { AskInput, AskResult } from "../../src/services/ai.service";

const context = "Rent: PHP 100.00 [ref:e1]\nSupplies: PHP 500.00 [ref:e2]";
const references = new Map<string, RecordReference>([
  ["[ref:e1]", { kind: "record", recordType: "expense", id: 1, label: "Rent", amount: 100, date: "2026-10-01" }],
  ["[ref:e2]", { kind: "record", recordType: "expense", id: 2, label: "Supplies", amount: 500, date: "2026-10-02" }],
]);

function scripted(...answers: string[]) {
  return vi.fn(async (_input: AskInput): Promise<AskResult> => ({
    answer: answers.shift()!, provider: "gemini",
  }));
}

describe("Ask FinSight evidence provenance", () => {
  it.each([
    ["If you need a recap your rent expense [ref:e1] was PHP 500.00.", "Was my rent expense PHP 500.00?"],
    ["Assuming you want a recap your electricity expense was PHP 900.00.", "Was electricity PHP 900.00?"],
  ])("keeps an unrelated unpunctuated introduction from certifying a fact: %s", async (bad, question) => {
    const ask = scripted(bad, bad);
    const result = await groundAnswer(ask, { context, question, references });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.answer).toBe(AMOUNT_FALLBACK_ANSWER);
    expect(result.metadata.amountCheck).toBe("trimmed");
  });

  it("does not extend a hypothetical amount over the following factual clause's comma", async () => {
    const bad = "If you spend PHP 500.00, your rent expense was PHP 900.00.";
    const ask = scripted(bad, bad);
    const result = await groundAnswer(ask, { context, question: "What if I spend PHP 500.00? Was rent PHP 900.00?", references });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.answer).toBe(AMOUNT_FALLBACK_ANSWER);
    expect(result.metadata.amountCheck).toBe("trimmed");
  });

  it("does not treat a record tag's colon as the end of a valid hypothetical clause", async () => {
    const answer = "If your rent [ref:e1] were PHP 500.00, review your available funds first.";
    const ask = scripted(answer, answer);
    const result = await groundAnswer(ask, { context, question: "What if rent were PHP 500.00?", references });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.answer).toBe("If your rent were PHP 500.00, review your available funds first.");
    expect(result.metadata.amountCheck).toBe("passed");
    expect(result.metadata.references).toEqual([references.get("[ref:e1]")]);
  });

  it("does not let an unrelated if introduction exempt a cited factual amount", async () => {
    const bad = "If you need a recap, your rent expense [ref:e1] was PHP 500.00.";
    const ask = scripted(bad, bad);
    const result = await groundAnswer(ask, { context, question: "Was my rent expense PHP 500.00?", references });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.answer).toBe(AMOUNT_FALLBACK_ANSWER);
    expect(result.metadata.references).toEqual([]);
    expect(result.metadata.amountCheck).toBe("trimmed");
  });

  it("does not treat assuming an owner's interest as an assumption about a recorded expense", async () => {
    const bad = "Assuming you want a recap, your electricity expense was PHP 900.00.";
    const ask = scripted(bad, bad);
    const result = await groundAnswer(ask, { context, question: "Was electricity PHP 900.00?", references });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.answer).toBe(AMOUNT_FALLBACK_ANSWER);
    expect(result.metadata.amountCheck).toBe("trimmed");
  });

  it("preserves a conditional monetary clause even when its amount occurs in another record", async () => {
    const answer = "If rent costs PHP 500.00 next month, review the available funds first.";
    const ask = scripted(answer);
    const result = await groundAnswer(ask, { context, question: "What if rent costs PHP 500.00 next month?", references });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.answer).toBe(answer);
    expect(result.metadata.amountCheck).toBe("passed");
  });

  it("revises a mislabeled known amount even when the answer omits a record tag", async () => {
    const ask = scripted("Rent cost PHP 500.00.", "Rent cost PHP 100.00.");
    const result = await groundAnswer(ask, { context, question: "How much was rent?", references });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.answer).toBe("Rent cost PHP 100.00.");
  });

  it("revises a known amount attributed to a different cited record", async () => {
    const ask = scripted(
      "Your rent expense [ref:e1] was PHP 500.00.",
      "Your rent expense [ref:e1] was PHP 100.00.",
    );
    const result = await groundAnswer(ask, { context, question: "How much was my rent?", references });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.answer).toBe("Your rent expense was PHP 100.00.");
    expect(result.metadata.amountCheck).toBe("revised");
    expect(result.metadata.references).toEqual([references.get("[ref:e1]")]);
  });

  it("does not confirm an unverified amount merely because it appears in the question", async () => {
    const ask = scripted(
      "Your electricity expense was PHP 900.00.",
      "Your records do not show an electricity expense.",
    );
    const result = await groundAnswer(ask, {
      context, question: "Was my electricity expense PHP 900.00?", references,
    });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.answer).toBe("Your records do not show an electricity expense.");
    expect(result.metadata.amountCheck).toBe("revised");
  });

  it("drops an unsupported confirmation that remains after revision", async () => {
    const ask = scripted("Your electricity expense was PHP 900.00.", "Your electricity expense was PHP 900.00.");
    const result = await groundAnswer(ask, {
      context, question: "Was my electricity expense PHP 900.00?", references,
    });
    expect(result.answer).toBe(AMOUNT_FALLBACK_ANSWER);
    expect(result.metadata.amountCheck).toBe("trimmed");
  });

  it("checks integer amounts followed by pesos", async () => {
    expect(statedFigures("Your rent expense was 987 pesos.")).toEqual([
      { raw: "987 pesos", value: 987, kind: "money" },
    ]);
    const ask = scripted("Your rent expense was 987 pesos.", "Your rent expense [ref:e1] was PHP 100.00.");
    const result = await groundAnswer(ask, { context, question: "How much was my rent?", references });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.answer).toBe("Your rent expense was PHP 100.00.");
  });

  it("preserves a clearly hypothetical amount supplied by the owner", async () => {
    const ask = scripted("If you spend PHP 11,000 on a fridge, consider the effect on your funds.");
    const result = await groundAnswer(ask, {
      context, question: "What if I spend PHP 11,000 on a fridge?", references,
    });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.answer).toContain("If you spend PHP 11,000");
    expect(result.metadata.amountCheck).toBe("passed");
  });

  it("preserves a hypothetical change to an existing record even when the amount matches another record", async () => {
    const answer = "If your rent were PHP 500.00, review how that change would affect your funds.";
    const ask = scripted(answer, answer);
    const result = await groundAnswer(ask, {
      context, question: "What if my rent were PHP 500.00?", references,
    });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.answer).toBe(answer);
    expect(result.metadata.amountCheck).toBe("passed");
  });

  it("does not turn a hypothetical question into a recorded purchase", async () => {
    const ask = scripted("Your fridge purchase was PHP 11,000.", "If you spend PHP 11,000 on a fridge, review your funds first.");
    const result = await groundAnswer(ask, {
      context, question: "What if I spend PHP 11,000 on a fridge?", references,
    });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.answer.startsWith("If you spend PHP 11,000")).toBe(true);
    expect(result.metadata.amountCheck).toBe("revised");
  });

  it("preserves a recorded negative balance", async () => {
    const ask = scripted("Your recorded funds are PHP -500.00.");
    const result = await groundAnswer(ask, {
      context: "Recorded funds: PHP -500.00", question: "What are my funds?", references: new Map(),
    });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.answer).toBe("Your recorded funds are PHP -500.00.");
    expect(result.metadata.amountCheck).toBe("passed");
  });

  it("preserves a cited record compared with a computed contextual metric", async () => {
    const ask = scripted("Your rent expense [ref:e1] was PHP 100.00, compared with your usual PHP 347.33.");
    const result = await groundAnswer(ask, {
      context: context + "\nUsual rent: PHP 347.33", question: "How does rent compare?", references,
    });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.answer).toContain("PHP 100.00, compared with your usual PHP 347.33");
    expect(result.metadata.amountCheck).toBe("passed");
  });

  it("preserves two correctly attributed records in one sentence", async () => {
    const ask = scripted("Rent [ref:e1] cost PHP 100.00 and Supplies [ref:e2] cost PHP 500.00.");
    const result = await groundAnswer(ask, { context, question: "What did those expenses cost?", references });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.answer).toBe("Rent cost PHP 100.00 and Supplies cost PHP 500.00.");
    expect(result.metadata.references.map((reference) => reference.id)).toEqual([1, 2]);
  });

  it("rejects a figure attributed to the wrong explicit financial fact", async () => {
    const ask = scripted("Recorded funds are PHP 500.00 [fact:f1].", "Recorded funds are PHP 100.00 [fact:f1].");
    const result = await groundAnswer(ask, {
      context: "Recorded funds: PHP 100.00 [fact:f1]\nMonthly expenses: PHP 500.00 [fact:f2]",
      question: "What are my recorded funds?", references: new Map(),
    });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.answer).toBe("Recorded funds are PHP 100.00.");
    expect(result.metadata.amountCheck).toBe("revised");
  });

  it("does not use a valid starting-funds tag to certify an incorrect current-funds claim", async () => {
    const ask = scripted(
      "Your current recorded funds are PHP 500.00 [fact:f2].",
      "Your current recorded funds are PHP 100.00 [fact:f1].",
    );
    const result = await groundAnswer(ask, {
      context: "Current recorded funds: PHP 100.00 [fact:f1]\nStarting available funds: PHP 500.00 [fact:f2]",
      question: "What are my current recorded funds?", references: new Map(),
    });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.answer).toBe("Your current recorded funds are PHP 100.00.");
    expect(result.metadata.amountCheck).toBe("revised");
  });

  it("does not let an incidental could make an asserted expense hypothetical", async () => {
    const ask = scripted(
      "Your electricity expense was PHP 900 and could affect your savings.",
      "Your records do not show an electricity expense.",
    );
    const result = await groundAnswer(ask, {
      context: "Current recorded funds: PHP 100.00", question: "Was electricity PHP 900?", references: new Map(),
    });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.answer).toBe("Your records do not show an electricity expense.");
  });

  it("preserves a correctly tagged comparison of current and starting funds", async () => {
    const ask = scripted("Your current recorded funds are PHP 100.00 [fact:f1], compared with starting available funds of PHP 500.00 [fact:f2].");
    const result = await groundAnswer(ask, {
      context: "Current recorded funds: PHP 100.00 [fact:f1]\nStarting available funds: PHP 500.00 [fact:f2]",
      question: "How do current and starting funds compare?", references: new Map(),
    });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.answer).toBe("Your current recorded funds are PHP 100.00, compared with starting available funds of PHP 500.00.");
    expect(result.metadata.amountCheck).toBe("passed");
  });
});

// Context lines and answers below are from real Gemini answers on the demo
// bakery data, where every one of these correct sentences used to be removed.
describe("Ask FinSight keeps correct answers whole", () => {
  const dashboard = [
    "Starting monthly expense estimate: PHP 62,000.00 [fact:f2]",
    "Total recorded expenses this period: PHP 76,650.00 [fact:f6]",
    "- Ingredients: PHP 28,360.00 — 37.0% of period expenses, new this period, no prior baseline [fact:f7]",
    "- Rent: PHP 19,000.00 — 24.8% of period expenses, new this period, no prior baseline [fact:f8]",
    "- Wages: PHP 14,400.00 — 18.8% of period expenses, new this period, no prior baseline [fact:f9]",
    "Matching \"ingredients\": 13 record(s) totalling PHP 28,360.00 [fact:f17]",
    "- \"Bulk flour and butter\" PHP 7,900.00 on 2026-10-28 in Ingredients [ref:e30] [fact:f20]",
    "- [HIGH] Unusual Ingredients expense: unusual for this category; Your usual amount in this category is PHP 1,683.00 [fact:f21]",
    "- Sales recorded this month: PHP 2,670.00 of PHP 62,000.00 needed (4.3% covered) [fact:f13]",
    "- Adjusted daily target from here: PHP 2,472.08 [fact:f15]",
  ].join("\n");

  it.each([
    "**Rent** followed as your second largest expense at PHP 19,000.00 [fact:f8].",
    "You spent the most on **Ingredients** at PHP 28,360.00 [fact:f7], which made up 37.0% [fact:f7] of your period expenses.",
    "Your business is behind your monthly recovery pace [fact:f15], with PHP 2,670.00 [fact:f13] recorded in sales out of your PHP 62,000.00 [fact:f13] target.",
    "Your business is behind the monthly pace you need, with **PHP 2,670.00** [fact:f13] recorded in sales.",
    "You have PHP 76,650.00 [fact:f6] in total recorded expenses so far, with **Rent** [fact:f8] making up a large share at PHP 19,000.00 [fact:f8].",
    "That made up about 37.0% of your total recorded expenses of PHP 76,650.00 [fact:f6, f7] for the period.",
    "This covers **4.3%** [fact:f13] of your monthly expense estimate of **PHP 62,000.00** [fact:f2].",
    "Your next highest spending category is Rent at PHP 19,000.00, followed by Wages at PHP 14,400.00 [fact:f9].",
    "Ingredients is your highest spending category at PHP 28,360.00 [fact:f7].",
    "You need to sell **PHP 2,472.08** [fact:f15] today to stay on track with your monthly goals.",
  ])("passes a correctly cited sentence that shares a generic word with another line: %s", async (answer) => {
    const ask = scripted(answer);
    const result = await groundAnswer(ask, { context: dashboard, question: "How is my business doing?", references: new Map() });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.metadata.amountCheck).toBe("passed");
  });

  it("still rejects a category given another category's figure", async () => {
    const ask = scripted(
      "**Rent** was your largest expense at PHP 28,360.00 [fact:f7].",
      "**Rent** was PHP 19,000.00 [fact:f8].",
    );
    const result = await groundAnswer(ask, { context: dashboard, question: "What was rent?", references: new Map() });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.answer).toBe("**Rent** was PHP 19,000.00.");
  });

  it("checks a tagged total against its own fact, not a record named later in the sentence", async () => {
    const flour = new Map<string, RecordReference>([
      ["[ref:e30]", { kind: "record", recordType: "expense", id: 30, label: "Bulk flour and butter", amount: 7900, date: "2026-10-28" }],
    ]);
    const answer = "You spent **PHP 28,360.00** [fact:f17] on ingredients across 13 recorded transactions [fact:f17], "
      + "which includes **Bulk flour and butter** [ref:e30] for **PHP 7,900.00** [fact:f20].";
    const ask = scripted(answer);
    const result = await groundAnswer(ask, { context: dashboard, question: "How much on ingredients?", references: flour });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.metadata.amountCheck).toBe("passed");

    const wrong = scripted("Your **Bulk flour and butter** [ref:e30] cost PHP 28,360.00.", "Your **Bulk flour and butter** [ref:e30] cost PHP 7,900.00.");
    await groundAnswer(wrong, { context: dashboard, question: "What did the flour cost?", references: flour });
    expect(wrong).toHaveBeenCalledTimes(2);
  });

  it("still rejects a share given to the wrong category", async () => {
    const ask = scripted("Rent makes up 37.0% of your period expenses [fact:f7].", "Rent makes up 24.8% of your period expenses [fact:f8].");
    const result = await groundAnswer(ask, { context: dashboard, question: "What share is rent?", references: new Map() });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.answer).toBe("Rent makes up 24.8% of your period expenses.");
  });

  it("rejects a figure that a combined tag does not cover", async () => {
    const ask = scripted("Rent was PHP 2,670.00 [fact:f7, f8].", "Rent was PHP 19,000.00 [fact:f7, f8].");
    const result = await groundAnswer(ask, { context: dashboard, question: "What was rent?", references: new Map() });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.answer).toBe("Rent was PHP 19,000.00.");
  });

  it("holds untagged figures to a combined tag that cites the whole sentence", async () => {
    const ask = scripted(
      "Rent came to PHP 2,670.00, with wages at PHP 14,400.00 [fact:f8, f9].",
      "Rent came to PHP 19,000.00, with wages at PHP 14,400.00 [fact:f8, f9].",
    );
    const result = await groundAnswer(ask, { context: dashboard, question: "Rent and wages?", references: new Map() });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.answer).toBe("Rent came to PHP 19,000.00, with wages at PHP 14,400.00.");
  });

  it("keeps the surviving sentences of a paragraph together when one is trimmed", async () => {
    const bad = "Rent was PHP 19,000.00 [fact:f8]. That leaves PHP 9,999.00 for supplies. Ingredients cost PHP 28,360.00 [fact:f7].\n\nCheck your review queue.";
    const result = await groundAnswer(scripted(bad, bad), { context: dashboard, question: "Summary?", references: new Map() });
    expect(result.metadata.amountCheck).toBe("trimmed");
    expect(result.answer).toBe("Rent was PHP 19,000.00. Ingredients cost PHP 28,360.00.\n\nCheck your review queue.");
  });
});
