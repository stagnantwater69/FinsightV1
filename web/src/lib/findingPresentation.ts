/**
 * The logic behind the unified "Needs review" queue.
 *
 * WHY THIS IS A LIBRARY AND NOT PAGE CODE. FinSight had FIVE places that
 * showed the owner something to review — the flagged-records page, the
 * Expense Insights findings panel, the dashboard alert list, the notification
 * list, and the import summary — each with its own idea of what a flag looks
 * like and none of them aware of the others. The same record could appear
 * twice, once as a "possible duplicate" record and once as a detector finding
 * about that record, with two different sets of buttons and no shared story.
 *
 * ADR-4 (docs/ML-OCR-CSV-UI-PROGRAM.md) fixes the contract: one plain-language
 * title, one to three reasons, the comparison baseline, source and time, a
 * confidence BAND (never a raw score), and the owner's actions. The technical
 * detail — detector, method, version, score, feature deviations — moves to an
 * expandable audit view.
 *
 * This module is where that shape is built, and it is deliberately pure:
 * the components stay thin enough to be obviously correct, and the merge rule
 * (the part that can silently double-count a record) is unit-testable on its
 * own.
 *
 * THE DEDUPLICATION RULE, stated once:
 *
 *   A record appears in the queue EXACTLY ONCE.
 *
 *   - A detector finding wins over the legacy column flags on the same
 *     record. The legacy flag becomes a secondary line on the finding's card,
 *     never a second card.
 *   - A legacy duplicate that belongs to a bulk group stays in that group;
 *     any finding about it folds into the group rather than escaping as its
 *     own card. This is what keeps "discard all 40" safe — two overlapping
 *     surfaces would let the same record be discarded from one and kept from
 *     another.
 */

import { formatMoney } from "../components/Money";
import { alertKindFromType, type AlertKind } from "../components/Alert";
import { findingSignalStrength, type SignalStrength } from "./confidenceBands";
import type {
  AnomalyFinding,
  AnomalyFindingFeedback,
  AnomalyFindingStatus,
  ImportBatchSummary,
  RecordItem,
} from "./types";

// ============================================================
// The filter vocabulary
// ============================================================

/**
 * The four chips, in the order they are shown. Derived from the Alert family's
 * own vocabulary rather than invented alongside it, so a flag reads the same
 * here as it does in the notification list.
 */
export const REVIEW_CATEGORIES = ["duplicate", "unusual", "scan-issue"] as const;
export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];
export type ReviewFilter = "all" | ReviewCategory;

export const CATEGORY_LABELS: Record<ReviewFilter, string> = {
  all: "All",
  duplicate: "Duplicate",
  unusual: "Unusual",
  "scan-issue": "Scan issue",
};

/**
 * Finding type → the Alert family.
 *
 * `alertKindFromType` is asked first — it already resolves "POSSIBLE_DUPLICATE"
 * and "RECURRING_CHANGE" from their names, and reusing it is what stops a
 * sixth vocabulary appearing. It answers "info" for everything it doesn't
 * recognise, which for a FINDING is never right, so the table below covers the
 * statistical detectors it was never written for.
 */
const FINDING_ALERT_KIND: Partial<Record<AnomalyFinding["type"], AlertKind>> = {
  AMOUNT_OUTLIER: "large-expense",
  VELOCITY_ANOMALY: "large-expense",
  TREND_CHANGE: "large-expense",
  BEHAVIORAL_NOVELTY: "large-expense",
  ML_OUTLIER: "large-expense",
};

export function alertKindForFinding(type: AnomalyFinding["type"]): AlertKind {
  const shared = alertKindFromType(type);
  if (shared !== "info") return shared;
  return FINDING_ALERT_KIND[type] ?? "needs-review";
}

export function categoryForAlertKind(kind: AlertKind): ReviewCategory {
  if (kind === "duplicate") return "duplicate";
  // A recurring payment that arrived late or at the wrong amount is an
  // "unusual" thing about the owner's money, not a problem with a photograph.
  if (kind === "large-expense" || kind === "recurring") return "unusual";
  return "scan-issue";
}

// ============================================================
// The card contract
// ============================================================

/** One line of "why", already in the owner's own numbers. */
export interface ReviewReason {
  text: string;
  /**
   * The large-expense threshold explanation is the quality bar every other
   * reason is written against: it names the threshold, says where the number
   * came from, and links to the setting that changes it. It needs a link and
   * money markup, so the page renders it as a component and this flag is how
   * the lib asks for it.
   */
  kind?: "large-expense-threshold";
}

/** What the audit expander shows. Never on the primary card. */
export interface ReviewAudit {
  method: string | null;
  detectorVersion: string | null;
  score: number | null;
  metadata: Record<string, unknown> | null;
  findingId: number;
  type: string;
  status: AnomalyFindingStatus;
}

export interface ReviewItem {
  /** Stable across reloads: identifies the card for React and for busy state. */
  key: string;
  category: ReviewCategory;
  alertKind: AlertKind;
  title: string;
  /** One to three. More than three stops being read. */
  reasons: ReviewReason[];
  /** What FinSight compared this against. Null when the detector said nothing. */
  baseline: string | null;
  /** "FinSight's duplicate check" / "Flagged on import" — where it came from. */
  source: string;
  /** ISO timestamp of when it was noticed, or null for a legacy flag. */
  detectedAt: string | null;
  signal: SignalStrength;
  /** The detector finding, when one exists. */
  finding: AnomalyFinding | null;
  /** The record the card is about, when the queue could resolve one. */
  record: RecordItem | null;
  /** Legacy column flags folded onto this card as a secondary line. */
  legacy: { duplicate: boolean; largeExpense: boolean; needsReview: boolean };
  audit: ReviewAudit | null;
  /** Pre-filled question for the Ask FinSight drawer. Never sent unprompted. */
  explainQuestion: string;
}

// ============================================================
// Duplicate groups — unchanged behaviour, moved here to be testable
// ============================================================

/**
 * Every flagged duplicate belongs to EXACTLY ONE group, which is the property
 * that makes bulk actions safe. Grouping is by import batch first (the real
 * story is "this file was imported twice", and one decision settles the whole
 * file), then by the record they all duplicate.
 */
export interface DuplicateGroup {
  key: string;
  batch: ImportBatchSummary | null;
  records: RecordItem[];
  /** Findings about records in this group, folded in rather than shown twice. */
  findings: AnomalyFinding[];
  category: ReviewCategory;
}

function groupDuplicates(duplicates: RecordItem[], batches: ImportBatchSummary[]): DuplicateGroup[] {
  const batchById = new Map(batches.map((b) => [b.id, b]));
  const importGroups = new Map<number, RecordItem[]>();
  const matchGroups = new Map<string, RecordItem[]>();

  for (const record of duplicates) {
    if (record.importBatchId) {
      const list = importGroups.get(record.importBatchId) ?? [];
      list.push(record);
      importGroups.set(record.importBatchId, list);
      continue;
    }
    // Falls back to the record's own id so a copy whose original has since
    // been deleted still forms a group of one rather than being dropped.
    const key = `match-${record.duplicateOfRecordId ?? `self-${record.type}-${record.id}`}`;
    const list = matchGroups.get(key) ?? [];
    list.push(record);
    matchGroups.set(key, list);
  }

  return [
    ...[...importGroups.entries()].map(([batchId, records]) => ({
      key: `import-${batchId}`,
      batch: batchById.get(batchId) ?? null,
      records,
      findings: [] as AnomalyFinding[],
      category: "duplicate" as const,
    })),
    ...[...matchGroups.entries()].map(([key, records]) => ({
      key,
      batch: null,
      records,
      findings: [] as AnomalyFinding[],
      category: "duplicate" as const,
    })),
  ];
}

// ============================================================
// Reasons and baselines
// ============================================================

function num(metadata: Record<string, unknown> | null | undefined, key: string): number | null {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * What FinSight measured this against, in the owner's own figures.
 *
 * This is the line that separates "your books are odd" from "here is the
 * number I compared yours to". Every detector that recorded enough metadata to
 * say gets a sentence; the ones that didn't say nothing rather than something
 * vague, because a baseline the owner cannot check is worse than none.
 */
export function comparisonBaseline(finding: AnomalyFinding): string | null {
  const meta = (finding.metadata ?? null) as Record<string, unknown> | null;

  switch (finding.type) {
    case "AMOUNT_OUTLIER":
    case "ML_OUTLIER": {
      const mean = num(meta, "categoryMean");
      const count = num(meta, "historyCount");
      if (mean === null) return null;
      return count === null
        ? `Compared against your usual ${formatMoney(mean)} in this category.`
        : `Compared against your usual ${formatMoney(mean)} in this category, across ${count} past record${count === 1 ? "" : "s"}.`;
    }
    case "POSSIBLE_DUPLICATE": {
      const matched = num(meta, "matchedExpenseRecordId");
      const days = num(meta, "dateDistanceDays");
      if (matched === null) return null;
      const when =
        days === null
          ? ""
          : days === 0
            ? " recorded on the same day"
            : ` recorded ${days} day${days === 1 ? "" : "s"} apart`;
      return `Compared against expense #${matched} you already had${when}.`;
    }
    case "VELOCITY_ANOMALY": {
      const window = num(meta, "windowDays");
      const baseline = num(meta, "baselineMedianCount");
      const current = num(meta, "currentCount");
      if (window === null || baseline === null) return null;
      const now = current === null ? "" : `${current} against `;
      return `Compared against ${now}your usual ${baseline} in a ${window}-day stretch.`;
    }
    case "TREND_CHANGE": {
      const previous = num(meta, "previous");
      const window = num(meta, "windowDays");
      if (previous === null) return null;
      return window === null
        ? `Compared against ${formatMoney(previous)} in the period before.`
        : `Compared against ${formatMoney(previous)} over the previous ${window} days.`;
    }
    case "RECURRING_CHANGE": {
      const expected = num(meta, "expectedAmount");
      const interval = num(meta, "intervalDays");
      if (expected === null && interval === null) return null;
      if (expected === null) return `Compared against a payment you expect about every ${interval} days.`;
      return interval === null
        ? `Compared against the ${formatMoney(expected)} you usually pay.`
        : `Compared against the ${formatMoney(expected)} you usually pay about every ${interval} days.`;
    }
    default: {
      const scope = str(meta, "scope");
      return scope ? `Compared against this business's own ${scope} history.` : null;
    }
  }
}

/** Where the flag came from, said plainly. */
export function sourceLabel(finding: AnomalyFinding | null, record: RecordItem | null): string {
  if (finding) {
    switch (finding.type) {
      case "POSSIBLE_DUPLICATE":
        return "FinSight's duplicate check";
      case "RECURRING_CHANGE":
        return "FinSight's recurring-payment watch";
      case "TREND_CHANGE":
      case "VELOCITY_ANOMALY":
        return "FinSight's spending-pattern check";
      default:
        return "FinSight's expense check";
    }
  }
  if (record?.source === "CSV_UPLOAD") return "Flagged when this file was imported";
  if (record?.source === "RECEIPT_SCAN") return "Flagged when this receipt was scanned";
  return "Flagged when this record was saved";
}

/** A plain-language title for a legacy flag that has no detector finding. */
function legacyTitle(record: RecordItem): string {
  if (record.duplicateStatus === "Flagged") return `"${record.description}" may already be in your records`;
  if (record.largeExpenseFlag) return `"${record.description}" is large for your business`;
  return `"${record.description}" is waiting on your confirmation`;
}

function legacyCategory(record: RecordItem): ReviewCategory {
  if (record.duplicateStatus === "Flagged") return "duplicate";
  if (record.largeExpenseFlag) return "unusual";
  return record.source === "RECEIPT_SCAN" ? "scan-issue" : "unusual";
}

function legacyAlertKind(record: RecordItem): AlertKind {
  if (record.duplicateStatus === "Flagged") return "duplicate";
  if (record.largeExpenseFlag) return "large-expense";
  return "needs-review";
}

function legacyReasons(record: RecordItem): ReviewReason[] {
  if (record.largeExpenseFlag) return [{ text: "", kind: "large-expense-threshold" }];
  if (record.duplicateStatus === "Flagged") {
    return [
      {
        text: "Another record has the same date, amount and description — an exact match on all three.",
      },
    ];
  }
  if (record.source === "RECEIPT_SCAN") {
    return [
      {
        text: "This came from a scanned receipt and hasn't been confirmed yet. FinSight doesn't count an unread value as settled.",
      },
    ];
  }
  return [{ text: "This record is waiting on your confirmation before FinSight counts it as settled." }];
}

/**
 * The question the "Explain this flag" button primes the drawer with.
 *
 * Names the record and the comparison rather than asking a generic question,
 * for the same reason the Expense Insights drawer names the category that
 * rose: the owner reads the question before sending it, and a specific one
 * they can edit is worth more than a starter chip.
 */
export function explainQuestion(finding: AnomalyFinding | null, record: RecordItem | null): string {
  if (finding) {
    const amount = record ? ` (${formatMoney(record.amount)})` : "";
    return `Why did FinSight flag "${finding.title}"${amount}? Explain the comparison behind it.`;
  }
  if (record) {
    return `Why is "${record.description}" (${formatMoney(record.amount)}) waiting for review?`;
  }
  return "What needs my review right now, and why?";
}

// ============================================================
// The merge
// ============================================================

/** Identity for a record across both sources. Findings only ever reference
 *  ExpenseRecord, so the type prefix is what stops an expense #7 and a sales
 *  record #7 colliding. */
function recordKey(type: "expense" | "sales", id: number): string {
  return `${type}-${id}`;
}

export interface ReviewQueueInput {
  findings: AnomalyFinding[];
  records: RecordItem[];
  batches: ImportBatchSummary[];
}

export interface ReviewQueue {
  /** Bulk-resolvable duplicate groups. Always rendered before single cards. */
  groups: DuplicateGroup[];
  items: ReviewItem[];
  /** Per-chip counts, so a filter can say how much it hides. */
  counts: Record<ReviewFilter, number>;
}

export function buildReviewQueue({ findings, records, batches }: ReviewQueueInput): ReviewQueue {
  const duplicates = records.filter((r) => r.duplicateStatus === "Flagged");
  const groups = groupDuplicates(duplicates, batches);

  // Every record already accounted for by a bulk group. A finding about one of
  // these folds into the group; it must not escape as its own card, or the
  // group's "discard all" and the card's "keep" would act on the same record.
  const groupedKeys = new Set<string>();
  for (const group of groups) {
    for (const record of group.records) groupedKeys.add(recordKey(record.type, record.id));
  }

  const recordByKey = new Map(records.map((r) => [recordKey(r.type, r.id), r]));
  const items: ReviewItem[] = [];
  /** Records a finding has already spoken for — their legacy flags fold in. */
  const claimedKeys = new Set<string>();

  for (const finding of findings) {
    const key = finding.expenseRecordId === null ? null : recordKey("expense", finding.expenseRecordId);

    if (key && groupedKeys.has(key)) {
      const group = groups.find((g) => g.records.some((r) => recordKey(r.type, r.id) === key));
      group?.findings.push(finding);
      claimedKeys.add(key);
      continue;
    }

    const record = key ? (recordByKey.get(key) ?? null) : null;
    if (key) claimedKeys.add(key);

    const alertKind = alertKindForFinding(finding.type);
    items.push({
      key: `finding-${finding.id}`,
      category: categoryForAlertKind(alertKind),
      alertKind,
      title: finding.title,
      // Capped at three: the detectors already write theirs in the owner's own
      // figures, and a fourth line is where a card stops being read.
      reasons: finding.reasons.slice(0, 3).map((text) => ({ text })),
      baseline: comparisonBaseline(finding),
      source: sourceLabel(finding, record),
      detectedAt: finding.detectedAt,
      signal: findingSignalStrength(finding.severity, finding.score),
      finding,
      record,
      legacy: {
        duplicate: record?.duplicateStatus === "Flagged",
        largeExpense: Boolean(record?.largeExpenseFlag),
        needsReview: record?.reviewStatus === "Needs Review",
      },
      audit: {
        method: finding.method ?? null,
        detectorVersion: finding.detectorVersion ?? null,
        score: finding.score,
        metadata: (finding.metadata ?? null) as Record<string, unknown> | null,
        findingId: finding.id,
        type: finding.type,
        status: finding.status,
      },
      explainQuestion: explainQuestion(finding, record),
    });
  }

  for (const record of records) {
    const key = recordKey(record.type, record.id);
    if (groupedKeys.has(key) || claimedKeys.has(key)) continue;

    items.push({
      key: `record-${key}`,
      category: legacyCategory(record),
      alertKind: legacyAlertKind(record),
      title: legacyTitle(record),
      reasons: legacyReasons(record),
      baseline: null,
      source: sourceLabel(null, record),
      detectedAt: null,
      // A column flag carries no model behind it. It fired on a rule the owner
      // set themselves, which is a fact rather than a confidence — "Fairly
      // confident" is the honest middle, and claiming more would be inventing
      // certainty a boolean does not have.
      signal: record.largeExpenseFlag ? "moderate" : "weak",
      finding: null,
      record,
      legacy: {
        duplicate: record.duplicateStatus === "Flagged",
        largeExpense: Boolean(record.largeExpenseFlag),
        needsReview: record.reviewStatus === "Needs Review",
      },
      audit: null,
      explainQuestion: explainQuestion(null, record),
    });
  }

  const counts: Record<ReviewFilter, number> = {
    all: groups.length + items.length,
    duplicate: groups.length + items.filter((i) => i.category === "duplicate").length,
    unusual: items.filter((i) => i.category === "unusual").length,
    "scan-issue": items.filter((i) => i.category === "scan-issue").length,
  };

  return { groups, items, counts };
}

export function filterQueue(queue: ReviewQueue, filter: ReviewFilter): { groups: DuplicateGroup[]; items: ReviewItem[] } {
  if (filter === "all") return { groups: queue.groups, items: queue.items };
  return {
    groups: filter === "duplicate" ? queue.groups : [],
    items: queue.items.filter((i) => i.category === filter),
  };
}

// ============================================================
// Owner feedback
// ============================================================

/**
 * ALL FIVE feedback values, each reachable from every finding card.
 *
 * Only two were reachable before ("Confirm" and "Expected / dismiss"), which
 * meant three of the five labels the evaluation harness measures precision
 * against could never be produced by a real owner — the feedback column looked
 * populated while carrying almost no information. INCORRECT_MATCH in
 * particular is the single most valuable one for the duplicate detector, and
 * it was the one with no button.
 *
 * `status` is not a separate choice the owner makes: it follows from what they
 * said. Confirming keeps the finding, dismissing rejects it, and "no longer
 * relevant" resolves it — three different states in the owner's own words.
 */
export interface FeedbackAction {
  feedback: AnomalyFindingFeedback;
  status: Extract<AnomalyFindingStatus, "CONFIRMED" | "DISMISSED" | "RESOLVED">;
  label: string;
  /** Announced after the action, echoing what the owner actually said. */
  toast: string;
  /** Primary actions lead the row; the rest sit after them, still buttons. */
  primary: boolean;
}

const CONFIRM_UNUSUAL: FeedbackAction = {
  feedback: "CONFIRMED_UNUSUAL",
  status: "CONFIRMED",
  label: "Yes — this was unusual",
  toast: "Noted — you confirmed this one was unusual",
  primary: true,
};
const EXPECTED: FeedbackAction = {
  feedback: "EXPECTED_TRANSACTION",
  status: "DISMISSED",
  label: "This is normal for my business",
  toast: "Noted — FinSight will treat this as normal for you",
  primary: true,
};
const IS_DUPLICATE: FeedbackAction = {
  feedback: "DUPLICATE",
  status: "CONFIRMED",
  label: "It is a duplicate",
  toast: "Noted — recorded as a duplicate",
  primary: true,
};
const INCORRECT_MATCH: FeedbackAction = {
  feedback: "INCORRECT_MATCH",
  status: "DISMISSED",
  label: "Wrong match — these are different",
  toast: "Noted — FinSight matched the wrong record",
  primary: true,
};
const NO_LONGER_RELEVANT: FeedbackAction = {
  feedback: "NO_LONGER_RELEVANT",
  status: "RESOLVED",
  label: "No longer relevant",
  toast: "Cleared from your review queue",
  primary: false,
};

/** Ordered by how likely the owner is to mean it, per category. */
export function feedbackActions(category: ReviewCategory): FeedbackAction[] {
  if (category === "duplicate") {
    return [IS_DUPLICATE, INCORRECT_MATCH, EXPECTED, CONFIRM_UNUSUAL, NO_LONGER_RELEVANT];
  }
  return [CONFIRM_UNUSUAL, EXPECTED, INCORRECT_MATCH, IS_DUPLICATE, NO_LONGER_RELEVANT];
}
