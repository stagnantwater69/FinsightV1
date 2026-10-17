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
