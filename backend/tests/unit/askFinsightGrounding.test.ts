import { describe, expect, it, vi } from "vitest";
import { extractQuestionPeriod } from "../../src/lib/questionPeriod";
import { plainFindingReason, plainFindingReasons } from "../../src/lib/findingReasons";
import {
  AMOUNT_FALLBACK_ANSWER,
  groundAnswer,
  isKnownFigure,
  ownersRecords,
  knownNumbers,
  recordTag,
  resolveTags,
  splitFollowUps,
  statedFigures,
  unknownFigures,
  withoutUnknownFigures,
  type RecordReference,
} from "../../src/services/aiAnswer.service";
import type { AskInput, AskResult } from "../../src/services/ai.service";
import { searchTerms } from "../../src/services/aiContext.service";

// A Wednesday, 1 October 2026 — the business's own "today".
const TODAY = new Date(Date.UTC(2026, 9, 1));

describe("extractQuestionPeriod", () => {
  it("reads a month with its year", () => {
    expect(extractQuestionPeriod("How much did I spend on fries in January 2022?", TODAY)).toEqual({
      selection: { kind: "month", month: "2022-01" },
      label: "January 2022",
    });
  });

  it("reads a Filipino month name", () => {
    expect(extractQuestionPeriod("Magkano ang gastos ko noong Enero 2022?", TODAY)?.label).toBe("January 2022");
  });

  it("takes the most recent past occurrence of a month named without a year", () => {
    expect(extractQuestionPeriod("what did I spend in august", TODAY)?.label).toBe("August 2026");
    expect(extractQuestionPeriod("what did I spend in december", TODAY)?.label).toBe("December 2025");
  });

  it("does not read the word 'may' as a month unless a year is beside it", () => {
    expect(extractQuestionPeriod("May I see my expenses?", TODAY)).toBeNull();
    expect(extractQuestionPeriod("May utang ba ako?", TODAY)).toBeNull();
    expect(extractQuestionPeriod("spending in May 2025", TODAY)?.label).toBe("May 2025");
  });

  it("reads relative periods in English and Filipino", () => {
    expect(extractQuestionPeriod("how was last month", TODAY)?.label).toBe("September 2026");
    expect(extractQuestionPeriod("kumusta ngayong buwan", TODAY)?.label).toBe("October 2026");
    expect(extractQuestionPeriod("this week so far?", TODAY)).toEqual({ selection: { kind: "week" }, label: "this week" });
    expect(extractQuestionPeriod("all time totals", TODAY)).toEqual({ selection: { kind: "all" }, label: "all time" });
  });

  it("reads last week as the previous Monday-to-Sunday", () => {
    const period = extractQuestionPeriod("what changed last week", TODAY);
    expect(period?.selection).toEqual({ kind: "rolling", days: 7, endDate: new Date(Date.UTC(2026, 8, 27)) });
  });

  it("reads 'last N days' within a bound", () => {
    expect(extractQuestionPeriod("past 14 days please", TODAY)?.selection).toEqual({ kind: "rolling", days: 14 });
    expect(extractQuestionPeriod("last 900 days", TODAY)).toBeNull();
  });

  it("reads a whole year as a window ending on 31 December", () => {
    const period = extractQuestionPeriod("total for 2022?", TODAY);
    expect(period?.label).toBe("2022");
    expect(period?.selection).toEqual({ kind: "rolling", days: 365, endDate: new Date(Date.UTC(2022, 11, 31)) });
  });

  it("returns null when nothing names a period", () => {
    expect(extractQuestionPeriod("Why was this flagged?", TODAY)).toBeNull();
  });
});

describe("plainFindingReason", () => {
  it("translates the amount-outlier detector's shorthand", () => {
    expect(plainFindingReason("Detected by iqr")).toBe("Well outside the usual range of amounts for this category");
    expect(plainFindingReason("Detected by both")).toMatch(/Two separate checks/);
    expect(plainFindingReason("Detected by z-score")).toMatch(/higher than the average/);
    expect(plainFindingReason("The category baseline average is 347.33")).toBe(
      "Your usual amount in this category is PHP 347.33",
    );
  });

  it("passes plain reasons through and drops non-strings", () => {
    expect(plainFindingReasons(["The amounts are nearly identical", 4, null])).toEqual(["The amounts are nearly identical"]);
    expect(plainFindingReasons("not an array")).toEqual([]);
  });
});

describe("amount grounding", () => {
  const context = "Total: PHP 11,000.00\nUsual: PHP 347.33\nShare: 12.5% of expenses\nRecord on 2022-01-10";
  const known = knownNumbers(context);

  it("finds money and percentages but not dates or counts", () => {
    const figures = statedFigures("You spent PHP 550.00 on 2022-01-10 across 9 records, 12.5% of the total.");
    expect(figures.map((f) => [f.kind, f.value])).toEqual([
      ["money", 550],
      ["percent", 12.5],
    ]);
  });

  it("allows the rounding a person does when speaking", () => {
    expect(isKnownFigure({ raw: "PHP 347", value: 347, kind: "money" }, known)).toBe(true);
    expect(isKnownFigure({ raw: "about PHP 300", value: 300, kind: "money" }, known)).toBe(true);
    expect(isKnownFigure({ raw: "₱11k", value: 11000, kind: "money" }, known)).toBe(true);
    expect(isKnownFigure({ raw: "13%", value: 13, kind: "percent" }, known)).toBe(true);
  });

  it("rejects figures the model worked out itself", () => {
    // 11,000 - 347.33 — arithmetic, which RULE 1 forbids.
    expect(unknownFigures("That leaves PHP 10,652.67 for the rest.", known)).toEqual(["PHP 10,652.67"]);
    expect(unknownFigures("You'll need about ₱25,000 more.", known)).toEqual(["₱25,000"]);
  });

  it("rejects sign flips and does not reuse a count as money or a percentage", () => {
    const typed = knownNumbers(
      "Current recorded funds: PHP -500.00\nOperating days: 30\nCoverage: 12.5%",
    );

    expect(unknownFigures("You have PHP 500.00 available.", typed)).toEqual(["PHP 500.00"]);
    expect(unknownFigures("Your monthly expenses are PHP 30.00.", typed)).toEqual(["PHP 30.00"]);
    expect(unknownFigures("Your expense growth is 30%.", typed)).toEqual(["30%"]);
    expect(unknownFigures("Funds are PHP -500.00 and coverage is 12.5%.", typed)).toEqual([]);
  });

  it("preserves leading, Unicode, and accounting negative signs", () => {
    expect(statedFigures("Losses were -₱500.00, −₱600.00, (PHP 700.00), −12.5%, and (13%)."))
      .toEqual([
        { raw: "-₱500.00", value: -500, kind: "money" },
        { raw: "−₱600.00", value: -600, kind: "money" },
        { raw: "(PHP 700.00)", value: -700, kind: "money" },
        { raw: "−12.5%", value: -12.5, kind: "percent" },
        { raw: "(13%)", value: -13, kind: "percent" },
      ]);

    const positive = knownNumbers(
      "Recorded amounts: PHP 500.00, PHP 600.00, PHP 700.00. Rates: 12.5% and 13%.",
    );
    expect(
      unknownFigures("Losses were -₱500.00, −₱600.00, (PHP 700.00), −12.5%, and (13%).", positive),
    ).toEqual([
      "-₱500.00",
      "−₱600.00",
      "(PHP 700.00)",
      "−12.5%",
      "(13%)",
    ]);
  });

  it("removes only the sentences and bullets that carry an unknown figure", () => {
    const answer = "Your usual is PHP 347.33. You'd save PHP 2,000 by cutting it. It's worth a look.\n- Total PHP 11,000\n- Saving PHP 4,000";
    expect(withoutUnknownFigures(answer, known)).toBe("Your usual is PHP 347.33. It's worth a look.\n- Total PHP 11,000");
  });
});

describe("tags and follow-ups", () => {
  const fries: RecordReference = { kind: "record", recordType: "expense", id: 343, label: "Frozen fries x5", amount: 550, date: "2022-01-10" };
  const allowed = new Map([[recordTag("expense", 343), fries]]);

  it("resolves only tags the context carried, and removes every tag from the prose", () => {
    const resolved = resolveTags(
      "**Frozen fries x5** [ref:e343] was higher than usual. Another one [ref:e999] too. See [page:review-queue] or [page:admin].",
      allowed,
    );
    expect(resolved.references).toEqual([fries]);
    expect(resolved.pages).toEqual([{ key: "review-queue", label: "Needs review" }]);
    expect(resolved.text).toBe("**Frozen fries x5** was higher than usual. Another one too. See or.");
    expect(resolveTags("You can check the rest anytime on [page:records].", allowed).text).toBe(
      "You can check the rest anytime.",
    );
    expect(resolved.text).not.toMatch(/\[(ref|page):/);
  });

  it("parses the FOLLOW-UPS line off the end and bounds it", () => {
    const { body, followUps } = splitFollowUps(
      "It was higher than usual.\nFOLLOW-UPS: What's my usual? | Show January? | not a question | Which category is highest?",
    );
    expect(body).toBe("It was higher than usual.");
    expect(followUps).toEqual(["What's my usual?", "Show January?", "Which category is highest?"]);
  });
});

describe("groundAnswer", () => {
  const context = "Usual: PHP 347.33\nRecord: Frozen fries PHP 550.00 [ref:e343]";
  const references = new Map<string, RecordReference>([
    ["[ref:e343]", { kind: "record", recordType: "expense", id: 343, label: "Frozen fries", amount: 550, date: "2022-01-10" }],
  ]);

  function scripted(...answers: string[]) {
    const calls: AskInput[] = [];
    const ask = vi.fn(async (input: AskInput): Promise<AskResult> => {
      calls.push(input);
      return { answer: answers.shift()!, provider: "gemini" };
    });
    return { ask, calls };
  }

  it("passes a grounded answer through with its references and follow-ups", async () => {
    const { ask } = scripted("The fries [ref:e343] cost PHP 550.00 against your usual PHP 347.33.\nFOLLOW-UPS: Why is it flagged?");
    const result = await groundAnswer(ask, { context, question: "why?", references });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.answer).toBe("The fries cost PHP 550.00 against your usual PHP 347.33.");
    expect(result.metadata.references.map((r) => r.id)).toEqual([343]);
    expect(result.metadata.followUps).toEqual(["Why is it flagged?"]);
    expect(result.metadata.amountCheck).toBe("passed");
  });

  it("retries once with a revision note when a figure is not in context", async () => {
    const { ask, calls } = scripted("That's PHP 202.67 above usual.", "That's above your usual PHP 347.33.");
    const result = await groundAnswer(ask, { context, question: "how much above?", references });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(calls[1]!.revisionNote).toContain("PHP 202.67");
    expect(result.answer).toBe("That's above your usual PHP 347.33.");
    expect(result.metadata.amountCheck).toBe("revised");
  });

  it("revises a positive balance claim when the grounded balance is negative", async () => {
    const negativeContext = "Current recorded funds: PHP -500.00";
    const { ask, calls } = scripted(
      "You have PHP 500.00 available.",
      "Your recorded funds are PHP -500.00.",
    );

    const result = await groundAnswer(ask, {
      context: negativeContext,
      question: "What are my current funds?",
      references: new Map(),
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]!.revisionNote).toContain("PHP 500.00");
    expect(result.answer).toBe("Your recorded funds are PHP -500.00.");
    expect(result.metadata.amountCheck).toBe("revised");
  });

  it("trims what the retry still gets wrong, and falls back when nothing is left", async () => {
    const trimmed = await groundAnswer(scripted("PHP 202.67 above.", "PHP 202.67 above. Worth a look.").ask, {
      context,
      question: "q",
      references,
    });
    expect(trimmed.answer).toBe("Worth a look.");
    expect(trimmed.metadata.amountCheck).toBe("trimmed");

    const empty = await groundAnswer(scripted("PHP 202.67 above.", "Still PHP 202.67.").ask, { context, question: "q", references });
    expect(empty.answer).toBe(AMOUNT_FALLBACK_ANSWER);
  });

  it("accepts a figure the owner typed in the question", async () => {
    const { ask } = scripted("A ₱11,000 fridge would be noticeable.");
    const result = await groundAnswer(ask, { context, question: "What if I spend ₱11,000 on a fridge?", references });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.metadata.amountCheck).toBe("passed");
  });

  it("leaves the outage placeholder alone and offers no actions with it", async () => {
    const ask = vi.fn(async (): Promise<AskResult> => ({ answer: "FinSight can't reach its AI assistant right now.", provider: "unavailable" }));
    const result = await groundAnswer(ask, {
      context,
      question: "q",
      references,
      actions: [{ kind: "open-spending-impact", amount: 1, label: "Open" }],
    });
    expect(result.provider).toBe("unavailable");
    expect(result.metadata.actions).toEqual([]);
  });
});

describe("searchTerms", () => {
  it("keeps the nouns that say which records the owner means", () => {
    expect(searchTerms("How much did I spend on fries in January 2022?")).toEqual(["fries"]);
    expect(searchTerms("Magkano ang binili ko sa Meralco nung nakaraang buwan?")).toEqual(["meralco"]);
    expect(searchTerms("Compare burger wrappers and frozen fries")).toEqual(["burger", "wrappers", "frozen"]);
  });

  it("finds nothing to search in a question about FinSight itself", () => {
    expect(searchTerms("Why was this flagged?")).toEqual([]);
    expect(searchTerms("How can I reduce my expenses?")).toEqual([]);
    expect(searchTerms("What needs my attention?")).toEqual([]);
  });
});

describe("ownersRecords", () => {
  it("speaks of the owner's records, not Fin's", () => {
    expect(ownersRecords("My records don't show that, since my current records only cover January.")).toBe(
      "Your records don't show that, since your current records only cover January.",
    );
    expect(ownersRecords("I checked my data.")).toBe("I checked your records.");
    expect(ownersRecords("Your records look fine.")).toBe("Your records look fine.");
  });
});
