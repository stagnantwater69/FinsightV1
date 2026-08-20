import { describe, expect, it } from "vitest";
import {
  alertKindForFinding,
  buildReviewQueue,
  categoryForAlertKind,
  comparisonBaseline,
  explainQuestion,
  feedbackActions,
  filterQueue,
  sourceLabel,
} from "./findingPresentation";
import type { AnomalyFinding, AnomalyFindingFeedback, ImportBatchSummary, RecordItem } from "./types";

/**
 * WHAT THIS FILE GUARDS.
 *
 * The merge rule. Five surfaces used to show the owner things to review, and
 * the same record could appear on two of them with different buttons — answer
 * one and the other sat there looking unanswered. Worse, a record could be in
 * a bulk duplicate group AND on its own card, so "discard all 40" and "keep"
 * could act on the same row and whichever ran second would target a record
 * that no longer existed.
 *
 * So: a record appears EXACTLY ONCE. That is the invariant these tests exist
 * to hold, and it is checked from both directions — a finding never escapes a
 * group, and a legacy flag never becomes a second card next to a finding.
 */

function record(over: Partial<RecordItem> = {}): RecordItem {
  return {
    id: 1,
    type: "expense",
    businessProfileId: 1,
    duplicateOfRecordId: null,
    date: "2026-03-04T00:00:00.000Z",
    description: "Rice sack",
    amount: 2400,
    source: "MANUAL_ENTRY",
    reviewStatus: "Needs Review",
    duplicateStatus: "Not Checked",
    createdAt: "2026-03-04T00:00:00.000Z",
    ...over,
  } as RecordItem;
}

function finding(over: Partial<AnomalyFinding> = {}): AnomalyFinding {
  return {
    id: 10,
    expenseRecordId: 1,
    type: "AMOUNT_OUTLIER",
    severity: "MEDIUM",
    score: 0.5,
    title: "Unusually large Inventory expense",
    reasons: ["PHP 2,400 is about 4x your usual Inventory expense."],
    status: "OPEN",
    detectedAt: "2026-03-05T00:00:00.000Z",
    method: "zscore-iqr",
    detectorVersion: "amount-outlier-v2",
    metadata: { categoryMean: 600, historyCount: 12 },
    ...over,
  };
}

const batches: ImportBatchSummary[] = [
  { id: 7, title: "March expenses.csv", uploadDate: "2026-03-01T00:00:00.000Z", status: "Reviewed" },
];

describe("category vocabulary", () => {
  it("reuses the Alert family rather than inventing a sixth one", () => {
    expect(alertKindForFinding("POSSIBLE_DUPLICATE")).toBe("duplicate");
    expect(alertKindForFinding("RECURRING_CHANGE")).toBe("recurring");
    // The statistical detectors alertKindFromType was never written for.
    expect(alertKindForFinding("AMOUNT_OUTLIER")).toBe("large-expense");
    expect(alertKindForFinding("VELOCITY_ANOMALY")).toBe("large-expense");
    expect(alertKindForFinding("ML_OUTLIER")).toBe("large-expense");
  });

  it("maps every alert kind onto one of the three chips", () => {
    expect(categoryForAlertKind("duplicate")).toBe("duplicate");
    expect(categoryForAlertKind("large-expense")).toBe("unusual");
    expect(categoryForAlertKind("recurring")).toBe("unusual");
    expect(categoryForAlertKind("needs-review")).toBe("scan-issue");
    expect(categoryForAlertKind("info")).toBe("scan-issue");
  });
});

describe("buildReviewQueue — deduplication", () => {
  it("folds a legacy flag onto the detector's card instead of making a second one", () => {
    const queue = buildReviewQueue({
      findings: [finding()],
      records: [record({ id: 1, largeExpenseFlag: true })],
      batches,
    });

    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]!.finding?.id).toBe(10);
    // The legacy flag survives as a secondary fact on the same card.
    expect(queue.items[0]!.legacy.largeExpense).toBe(true);
  });

  it("keeps a finding about a grouped duplicate inside that group", () => {
    const queue = buildReviewQueue({
      findings: [finding({ id: 11, type: "POSSIBLE_DUPLICATE", expenseRecordId: 2 })],
      records: [
        record({ id: 2, importBatchId: 7, duplicateStatus: "Flagged" }),
        record({ id: 3, importBatchId: 7, duplicateStatus: "Flagged" }),
      ],
      batches,
    });

    expect(queue.groups).toHaveLength(1);
    expect(queue.groups[0]!.records).toHaveLength(2);
    expect(queue.groups[0]!.findings.map((f) => f.id)).toEqual([11]);
    // The invariant: the finding did NOT also escape as a card.
    expect(queue.items).toHaveLength(0);
  });

  it("gives a window-level finding its own card even with no record behind it", () => {
    const queue = buildReviewQueue({
      findings: [finding({ id: 12, type: "TREND_CHANGE", expenseRecordId: null })],
      records: [],
      batches,
    });
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]!.record).toBeNull();
    expect(queue.items[0]!.category).toBe("unusual");
  });

  it("does not confuse an expense and a sales record with the same id", () => {
    const queue = buildReviewQueue({
      findings: [finding({ expenseRecordId: 5 })],
      records: [
        record({ id: 5, type: "expense", largeExpenseFlag: true }),
        record({ id: 5, type: "sales", description: "Cash sales" }),
      ],
      batches,
    });
    // Findings only ever reference expenses; the sales record keeps its card.
    expect(queue.items).toHaveLength(2);
    expect(queue.items.filter((i) => i.finding !== null)).toHaveLength(1);
  });

  it("counts each chip against what it will actually show", () => {
    const queue = buildReviewQueue({
      findings: [finding({ id: 20, expenseRecordId: 1 })],
      records: [
        record({ id: 1 }),
        record({ id: 2, duplicateStatus: "Flagged", duplicateOfRecordId: 9 }),
        record({ id: 3, source: "RECEIPT_SCAN", reviewStatus: "Needs Review" }),
      ],
      batches,
    });

    expect(queue.counts.all).toBe(queue.groups.length + queue.items.length);
    expect(queue.counts.duplicate).toBe(1);
    expect(queue.counts.unusual).toBe(1);
    expect(queue.counts["scan-issue"]).toBe(1);
  });
});

describe("filterQueue", () => {
  const queue = buildReviewQueue({
    findings: [finding({ id: 30, expenseRecordId: 1 })],
    records: [
      record({ id: 1 }),
      record({ id: 2, duplicateStatus: "Flagged", duplicateOfRecordId: 9 }),
      record({ id: 3, source: "RECEIPT_SCAN" }),
    ],
    batches,
  });

  it("shows everything under All", () => {
    const visible = filterQueue(queue, "all");
    expect(visible.groups).toHaveLength(1);
    expect(visible.items).toHaveLength(2);
  });

  it("shows the bulk groups only under Duplicate", () => {
    expect(filterQueue(queue, "duplicate").groups).toHaveLength(1);
    expect(filterQueue(queue, "unusual").groups).toHaveLength(0);
    expect(filterQueue(queue, "scan-issue").groups).toHaveLength(0);
  });

  it("narrows the cards to one category", () => {
    expect(filterQueue(queue, "unusual").items.map((i) => i.finding?.id)).toEqual([30]);
    expect(filterQueue(queue, "scan-issue").items).toHaveLength(1);
  });
});

describe("comparisonBaseline", () => {
  it("names the figure the owner was compared against", () => {
    expect(comparisonBaseline(finding())).toBe(
      "Compared against your usual PHP 600 in this category, across 12 past records.",
    );
  });

  it("names the record a duplicate was matched to", () => {
    expect(
      comparisonBaseline(
        finding({ type: "POSSIBLE_DUPLICATE", metadata: { matchedExpenseRecordId: 412, dateDistanceDays: 0 } }),
      ),
    ).toBe("Compared against expense #412 you already had recorded on the same day.");
  });

  it("says nothing rather than something vague when the detector recorded nothing", () => {
    expect(comparisonBaseline(finding({ metadata: null }))).toBeNull();
    expect(comparisonBaseline(finding({ type: "BEHAVIORAL_NOVELTY", metadata: {} }))).toBeNull();
  });
});

describe("sourceLabel and explainQuestion", () => {
  it("says where a legacy flag came from", () => {
    expect(sourceLabel(null, record({ source: "CSV_UPLOAD" }))).toBe(
      "Flagged when this file was imported",
    );
    expect(sourceLabel(null, record({ source: "RECEIPT_SCAN" }))).toBe(
      "Flagged when this receipt was scanned",
    );
  });

  it("primes the drawer with the finding's own words, not a generic question", () => {
    const question = explainQuestion(finding(), record());
    expect(question).toContain("Unusually large Inventory expense");
    expect(question).toContain("PHP 2,400");
  });
});

describe("feedbackActions", () => {
  it("makes all five feedback values reachable from any card", () => {
    const all: AnomalyFindingFeedback[] = [
      "CONFIRMED_UNUSUAL",
      "EXPECTED_TRANSACTION",
      "DUPLICATE",
      "INCORRECT_MATCH",
      "NO_LONGER_RELEVANT",
    ];
    for (const category of ["duplicate", "unusual", "scan-issue"] as const) {
      const offered = feedbackActions(category).map((a) => a.feedback);
      expect([...offered].sort()).toEqual([...all].sort());
    }
  });

  it("leads with the answer the owner is most likely to mean", () => {
    expect(feedbackActions("duplicate")[0]!.feedback).toBe("DUPLICATE");
    expect(feedbackActions("unusual")[0]!.feedback).toBe("CONFIRMED_UNUSUAL");
  });

  it("maps each answer onto a review status the API accepts", () => {
    for (const action of feedbackActions("unusual")) {
      expect(["CONFIRMED", "DISMISSED", "RESOLVED"]).toContain(action.status);
    }
  });
});
