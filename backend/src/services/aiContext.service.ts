// Builds the CONTEXT block that every Ask FinSight message is grounded in.
//
// Two rules drive the design here:
//   1. Data is pulled fresh on every message, never cached from when the
//      drawer opened. If the owner records an expense mid-conversation and
//      then asks a follow-up, the follow-up sees it.
//   2. The AI is never asked to compute anything. Every number in the
//      context comes from the same deterministic services the screens use
//      (insights.service / dashboard.service) — the model's only job is to
//      put those numbers into plain language.

import type { BusinessProfile } from "@prisma/client";
import { prisma } from "../config/prisma";
import { extractScenario, type ExtractedScenario } from "../lib/scenario";
import { resolveBusinessToday, utcAddDays, utcDateKey, utcEndOfDay } from "../lib/dates";
import { dueStateOf } from "./recurringSchedule.service";
import { RUNTIME_DETECTION_CONFIG } from "./anomalyDetection/config";
import { COUNTED_EXPENSE } from "./financialPosition.service";
import { simulateReductionOpportunity, type ReductionSpec } from "./reductionOpportunity.service";
import {
  COMPLETENESS_CUE,
  HYPOTHETICAL_CUE,
  PURCHASE_WORD,
  RECURRING_CUE,
  recordedTransaction,
  recoveryWhatIf,
  reductionWhatIf,
  type RecoveryWhatIf,
} from "../lib/chatIntents";
import { extractComparedMonths } from "../lib/questionPeriod";
import { getDashboardSummary } from "./dashboard.service";
import {
  getExpenseBehavior,
  getRecoveryInsight,
  loadRecoveryTargets,
  simulateRecoveryScenario,
  simulateSpendingImpact,
} from "./insights.service";
import { NOTICEABLE_BAND_FRACTION, type RecoveryChangeReason, type RecoveryStatus, type RecoveryTargets } from "./analysis.service";
import { SUGGESTED_CHECK_CATALOGUE, type ReductionOpportunity } from "./reductionOpportunity.service";
import { calculateAvailableFundsForOwnedBusiness } from "./financialPosition.service";
import type { OwnedBusinessContext } from "./ownedBusinessContext.service";
import { extractQuestionPeriod, type QuestionPeriod } from "../lib/questionPeriod";
import { resolveReportingWindow, windowDateFilter, type PeriodSelection } from "../lib/reportingPeriod";
import { plainFindingReasons } from "../lib/findingReasons";
import { ApiError } from "../middleware/error.middleware";
import { recordTag, tagFinancialFacts, type ChatAction, type RecordReference } from "./aiAnswer.service";

export const INTERACTION_MODULES = [
  "Expense Insights",
  "Spending Impact",
  "Recovery Target",
  "Dashboard",
  // The unified review queue's "Explain this flag" entry point. Context is the
  // owner's open findings and flagged records — bounded, server-derived
  // evidence only, per the strategy doc's rule that the model phrases
  // already-calculated facts rather than judging records itself.
  "Records Review",
] as const;
export type InteractionModule = (typeof INTERACTION_MODULES)[number];

// The period the drawer reasons over when the question doesn't name one.
const DEFAULT_PERIOD_DAYS = 30;
const TOP_CATEGORIES_IN_SNAPSHOT = 5;
const LARGEST_EXPENSES_IN_SNAPSHOT = 5;
// How far ahead, and how many, owner-declared repeating payments are listed.
const UPCOMING_PAYMENT_DAYS = 30;
const MAX_UPCOMING_PAYMENTS = 6;
const RECENT_ACTIVITY_DAYS = 7;
const MAX_UNREAD_ALERTS = 3;
const TOP_VENDORS = 5;
const MAX_COMPARED_CATEGORIES = 12;
const MAX_RECURRING_CANDIDATES = 3;
const MAX_RECURRING_ACTIONS = 2;
// Both spellings exist: receipts file into "Uncategorized", CSV imports into "Uncategorised".
const UNCATEGORISED_NAMES = ["Uncategorized", "Uncategorised"];
export const MAX_AI_CONTEXT_BYTES = 24_000;
export const MAX_AI_ANALYSIS_CATEGORIES = 25;
export const MAX_AI_INSUFFICIENT_HISTORY_CATEGORIES = 20;
const CONTEXT_OMISSION_NOTICE = "[Additional lower-priority context omitted to fit the request budget.]";
// Days of daily-coverage history the Recovery Target block tabulates.
const RECOVERY_COVERAGE_DAYS = 7;

// ============================================================
// Per-message loaders
// ============================================================
//
// The snapshot and the detail blocks legitimately need some of the SAME
// server-computed figures (expense behaviour; recovery targets). Before the
// Dashboard was widened each context used a given figure once, so fetching it
// per block cost nothing; a Dashboard message now assembles four blocks on top
// of the snapshot and would otherwise pay for the same expensive reads twice
// on a billed, latency-sensitive path.
//
// These loaders exist so blocks SHARE one in-flight promise instead of issuing
// their own query. Two properties are load-bearing:
//
//   - Memoization is scoped to a single buildModuleContext call and dies with
//     it. A process-wide cache would break rule 1 at the top of this file:
//     every message is grounded in data read fresh at that moment, so an
//     owner who records an expense mid-conversation sees it in the next reply.
//   - Sharing must not serialize anything. Each block calls its loader
//     synchronously before its first await, so the first caller starts the
//     query and every later caller awaits that same promise inside the one
//     Promise.all wave — nobody waits for another block to finish.
type ExpenseBehavior = Awaited<ReturnType<typeof getExpenseBehavior>>;

interface ContextLoaders {
  behavior: () => Promise<ExpenseBehavior>;
  recoveryTargets: () => Promise<RecoveryTargets>;
}

function once<T>(load: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | undefined;
  // Caches the PROMISE, not the resolved value, so callers in the same wave
  // share one query rather than racing to start a second one.
  return () => (inFlight ??= load());
}

/**
 * The records this message's context mentions, keyed by the tag the model is
 * told to cite. aiAnswer.service resolves the model's tags against THIS map
 * only, so a link can only ever open a record the server itself put in front
 * of the model — from this owner's own business profile, on this message.
 */
export class ReferenceRegistry {
  readonly entries = new Map<string, RecordReference>();

  tag(
    recordType: "expense" | "sales",
    record: { id: number; description: string; amount: unknown; date: Date },
  ): string {
    const tag = recordTag(recordType, record.id);
    if (!this.entries.has(tag)) {
      this.entries.set(tag, {
        kind: "record",
        recordType,
        id: record.id,
        label: record.description.slice(0, 80),
        amount: Number(record.amount),
        date: utcDateKey(record.date),
      });
    }
    return tag;
  }
}

/**
 * What a chat can be about, beyond its module: the one flag or record the
 * owner opened it from. Validated against the owner's business profile on
 * every message; see `focusLines`.
 */
export type ChatFocus =
  | { kind: "finding"; findingId: number }
  | { kind: "record"; recordType: "expense" | "sales"; recordId: number };

function periodSelectionOf(period: QuestionPeriod | null): number | PeriodSelection {
  return period?.selection ?? DEFAULT_PERIOD_DAYS;
}

function periodLabelOf(period: QuestionPeriod | null): string {
  return period?.label ?? `last ${DEFAULT_PERIOD_DAYS} days`;
}

/** The same window the period label names, as a record date filter. */
function periodDateFilter(period: QuestionPeriod | null, today: Date) {
  const selection = period?.selection ?? { kind: "rolling" as const, days: DEFAULT_PERIOD_DAYS };
  return windowDateFilter(resolveReportingWindow(selection, today), today);
}

function loadExpenseBehaviorForContext(
  userId: number,
  businessProfileId: number,
  period: number | PeriodSelection,
) {
  return getExpenseBehavior(userId, businessProfileId, period, undefined, {
    maximumAnalysisCategories: MAX_AI_ANALYSIS_CATEGORIES,
  });
}

export function contextWithinBudget(
  priorityLines: readonly string[],
  requiredTailLines: readonly string[],
  maximumBytes = MAX_AI_CONTEXT_BYTES,
): string {
  const selected: string[] = [];
  let omitted = false;
  for (let index = 0; index < priorityLines.length; index += 1) {
    const hasMore = index < priorityLines.length - 1;
    const candidate = [
      ...selected,
      priorityLines[index]!,
      ...(hasMore ? [CONTEXT_OMISSION_NOTICE] : []),
      ...requiredTailLines,
    ].join("\n");
    if (Buffer.byteLength(candidate, "utf8") > maximumBytes) {
      omitted = true;
      break;
    }
    selected.push(priorityLines[index]!);
  }

  if (selected.length < priorityLines.length) omitted = true;
  const context = [...selected, ...(omitted ? [CONTEXT_OMISSION_NOTICE] : []), ...requiredTailLines].join("\n");
  if (Buffer.byteLength(context, "utf8") <= maximumBytes) return context;

  let bounded = "";
  let boundedBytes = 0;
  for (const character of context) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (boundedBytes + characterBytes > maximumBytes) break;
    bounded += character;
    boundedBytes += characterBytes;
  }
  return bounded;
}

function peso(n: number): string {
  return `PHP ${n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Authoritative, server-decided phrasing for `recovery.status` (plan §8.1/§9.7)
// — replaces the old needsSetup/onTrack special-casing here now that `status`
// is finer-grained and covers cases (no_current_month_data, covered, ahead)
// that boolean pair couldn't express.
function recoveryStatusPhrase(status: RecoveryStatus): string {
  switch (status) {
    case "needs_setup":
      return "SETUP NEEDED — the starting monthly expense estimate is missing, so there is no target to compare against";
    case "no_current_month_data":
      return "NO SALES RECORDED THIS MONTH — there is nothing to compare pace against yet";
    case "data_incomplete":
      return "DATA INCOMPLETE — some records need review before this can be trusted";
    case "covered":
      return "COVERED — the sales coverage target for this month has been reached";
    case "ahead":
      return "AHEAD OF PACE — recorded sales are running above the expected pace to date";
    case "on_pace":
      return "ON PACE — recorded sales are within the expected pace to date";
    case "behind":
      return "BEHIND — the adjusted daily target is now above the original daily target";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function profileLines(profile: BusinessProfile): string[] {
  return [
    "=== BUSINESS PROFILE ===",
    `Name: ${profile.name} (${profile.type})`,
    `Opening balance: ${peso(Number(profile.availableFunds))} (baseline date ${utcDateKey(profile.availableFundsBaselineDate)})`,
    `Starting monthly expense estimate: ${peso(Number(profile.expectedMonthlyExpenses))}`,
    `Operating days per month: ${profile.operatingDays}`,
    `Owner's large-expense threshold: ${Number(profile.largeExpenseThresholdPercent)}%`,
  ];
}

// ============================================================
// General financial snapshot (B4)
// ============================================================
//
// Needed because "suggest ways to cut costs" and "interpret this scenario"
// can't be answered from one screen's numbers. Without this the model has
// no choice but to produce filler like "reduce unnecessary spending".
//
// `loaders` is optional and defaults to fetching everything itself, so the
// exported signature stays source-compatible for any caller that doesn't
// participate in a shared per-message wave.
export async function buildFinancialSnapshot(
  userId: number,
  profile: BusinessProfile,
  today: Date,
  loaders?: Partial<ContextLoaders>,
  options: { refs?: ReferenceRegistry; period?: QuestionPeriod | null } = {}
): Promise<string[]> {
  const refs = options.refs ?? new ReferenceRegistry();
  const period = options.period ?? null;
  const ownedContext = { userId, profile } as OwnedBusinessContext;
  const periodWhere = { businessProfileId: profile.id, date: periodDateFilter(period, today) };
  const [
    behavior, recovery, availableFunds, flaggedExpenses, duplicateCount, largestExpenses, periodSales,
    bestSalesDay, weakestSalesDay, expensesNeedingReview, salesNeedingReview,
  ] = await Promise.all([
    (loaders?.behavior ?? (() => loadExpenseBehaviorForContext(userId, profile.id, periodSelectionOf(period))))(),
    (loaders?.recoveryTargets ?? (() => loadRecoveryTargets(profile, today)))(),
    calculateAvailableFundsForOwnedBusiness(ownedContext, today),
    prisma.expenseRecord.findMany({
      where: { businessProfileId: profile.id, largeExpenseFlag: true, date: { lte: utcEndOfDay(today) } },
      orderBy: { date: "desc" },
      take: 5,
      include: { category: true },
    }),
    prisma.expenseRecord.count({ where: { businessProfileId: profile.id, duplicateStatus: "Flagged" } }),
    prisma.expenseRecord.findMany({
      where: periodWhere,
      orderBy: [{ amount: "desc" }, { id: "desc" }],
      take: LARGEST_EXPENSES_IN_SNAPSHOT,
      select: { id: true, description: true, amount: true, date: true, category: { select: { name: true } } },
    }),
    // Every sales record in the window, the same rule the Dashboard total uses.
    prisma.salesReferenceRecord.aggregate({ where: periodWhere, _sum: { amount: true }, _count: { _all: true } }),
    // Days are totalled by the database; "take" keeps an all-time question to one row each.
    prisma.salesReferenceRecord.groupBy({
      by: ["date"], where: periodWhere, _sum: { amount: true }, orderBy: [{ _sum: { amount: "desc" } }, { date: "desc" }], take: 1,
    }),
    prisma.salesReferenceRecord.groupBy({
      by: ["date"], where: periodWhere, _sum: { amount: true }, orderBy: [{ _sum: { amount: "asc" } }, { date: "desc" }], take: 1,
    }),
    prisma.expenseRecord.count({ where: { businessProfileId: profile.id, reviewStatus: "Needs Review" } }),
    prisma.salesReferenceRecord.count({ where: { businessProfileId: profile.id, reviewStatus: "Needs Review" } }),
  ]);

  const lines = ["", `=== FINANCIAL SNAPSHOT (${periodLabelOf(period)}) ===`];

  lines.push(
    `Current recorded funds: ${peso(availableFunds.calculatedAmount)} as of ${availableFunds.asOfDate}`,
    `Funds calculation: ${peso(availableFunds.baselineAmount)} opening balance + ${peso(availableFunds.confirmedSalesAdded)} confirmed sales - ${peso(availableFunds.confirmedExpensesDeducted)} confirmed expenses.`,
  );

  const totalCurrent = behavior.totals.current;
  const totalPrevious = behavior.totals.previous;

  if (totalCurrent === 0 && totalPrevious === 0) {
    lines.push("No expense records in this period, so there is no spending pattern to describe yet.");
  } else {
    lines.push(`Total recorded expenses this period: ${peso(totalCurrent)}`);
    lines.push(
      totalPrevious > 0
        ? `Previous equivalent period: ${peso(totalPrevious)} — overall spending is ${
            totalCurrent > totalPrevious ? "UP" : totalCurrent < totalPrevious ? "DOWN" : "FLAT"
          } by ${peso(Math.abs(totalCurrent - totalPrevious))}.`
        : "No expenses in the previous equivalent period, so there is no trend to compare against."
    );
    if (behavior.categoryTrends.length === 0) {
      lines.push("", "No category detail is available within the bounded analysis window.");
    } else {
      lines.push("", `Top spending categories this period (highest first, with period-over-period change):`);
      for (const t of behavior.categoryTrends.slice(0, TOP_CATEGORIES_IN_SNAPSHOT)) {
        const share = totalCurrent > 0 ? ((t.current / totalCurrent) * 100).toFixed(1) : "0.0";
        const change =
          t.percentChange === null
            ? "new this period, no prior baseline"
            : `${t.direction} ${Math.abs(t.percentChange).toFixed(1)}% vs. previous period (was ${peso(t.previous)})`;
        lines.push(`- ${t.categoryName}: ${peso(t.current)} — ${share}% of period expenses, ${change}`);
      }
      // One line per category, not one shared line: the answer check binds a
      // figure to the words before it on its own line.
      const rest = behavior.categoryTrends.slice(TOP_CATEGORIES_IN_SNAPSHOT);
      if (rest.length > 0) {
        lines.push("", "Other categories this period:");
        for (const t of rest) lines.push(`- ${t.categoryName}: ${peso(t.current)} (was ${peso(t.previous)})`);
      }
      const omittedCategories = behavior.analysisCoverage?.omittedCategoryCount ?? 0;
      if (omittedCategories > 0) {
        lines.push(`- ${omittedCategories} smaller categor${omittedCategories === 1 ? "y is" : "ies are"} not listed.`);
      }
    }
  }

  if (largestExpenses.length > 0) {
    lines.push("", "Largest expense records dated in this period (highest first):");
    for (const e of largestExpenses) {
      lines.push(
        `- "${e.description}" ${peso(Number(e.amount))} on ${utcDateKey(e.date)} (${e.category.name}) ${refs.tag("expense", e)}`
      );
    }
  }

  lines.push(
    "",
    periodSales._count._all > 0
      ? `Sales recorded this period: ${peso(Number(periodSales._sum.amount ?? 0))} across ${periodSales._count._all} sales record(s)`
      : "No sales records are dated in this period."
  );
  const best = bestSalesDay[0];
  const weakest = weakestSalesDay[0];
  if (best && weakest && utcDateKey(best.date) !== utcDateKey(weakest.date)) {
    lines.push(
      `Best sales day this period: ${utcDateKey(best.date)} with ${peso(Number(best._sum.amount ?? 0))}`,
      `Lowest sales day this period (among days with sales recorded): ${utcDateKey(weakest.date)} with ${peso(Number(weakest._sum.amount ?? 0))}`,
    );
  }

  lines.push(
    "",
    `Records waiting for the owner's review (Needs review): ${expensesNeedingReview} expense record(s), ${salesNeedingReview} sales record(s).`
  );

  lines.push("", "Records currently carrying flags:");
  if (flaggedExpenses.length === 0 && duplicateCount === 0) {
    lines.push("- none.");
  } else {
    for (const e of flaggedExpenses) {
      lines.push(
        `- large-expense flag: "${e.description}" ${peso(Number(e.amount))} on ${utcDateKey(e.date)} (${e.category.name}) ${refs.tag("expense", e)}`
      );
    }
    if (duplicateCount > 0) {
      lines.push(`- ${duplicateCount} expense record(s) flagged as a possible duplicate.`);
    }
  }

  lines.push(
    "",
    "Recovery status (month to date):",
    recovery.monthlyExpenseBasis.source === "previous_complete_month"
      ? `- Monthly costs: ${peso(recovery.monthlyExpenseBasis.amount)} from ${recovery.monthlyExpenseBasis.sourceMonth} confirmed expense records (${recovery.monthlyExpenseBasis.eligibleRecordCount} eligible record(s))`
      : `- Monthly costs: ${peso(recovery.monthlyExpenseBasis.amount)} starting estimate; the preceding month's expense records are not confirmed complete`,
    `- Sell this much each day: ${peso(recovery.dailyNeededTarget)} per open day`,
    `- Sales recorded this month: ${peso(recovery.salesThisMonth)} of ${peso(
      recovery.expectedMonthlyExpenses
    )} needed (${recovery.monthCoveragePercent.toFixed(1)}% covered)`,
    `- Remaining target: ${peso(recovery.remainingTarget)} across ${recovery.remainingOperatingDays} remaining operating day(s)`,
    `- New daily goal from here: ${peso(recovery.adjustedDailyTarget)}`,
    `- Overall: ${recoveryStatusPhrase(recovery.status)}`
  );

  return lines;
}

// ============================================================
// Module-specific context
// ============================================================

async function expenseInsightsLines(
  userId: number,
  profile: BusinessProfile,
  loadBehavior?: () => Promise<ExpenseBehavior>,
  refs: ReferenceRegistry = new ReferenceRegistry()
): Promise<string[]> {
  const [behavior, findings] = await Promise.all([
    (loadBehavior ?? (() => loadExpenseBehaviorForContext(userId, profile.id, DEFAULT_PERIOD_DAYS)))(),
    prisma.anomalyFinding.findMany({
      where: { businessProfileId: profile.id, status: "OPEN" },
      orderBy: [{ severity: "desc" }, { detectedAt: "desc" }],
      take: 10,
      include: { expenseRecord: { select: { id: true, description: true, amount: true, date: true } } },
    }),
  ]);
  const lines = ["", "=== EXPENSE BEHAVIOR DETAIL ==="];

  lines.push("Unusual expenses flagged this period (statistical outliers vs. that category's own history):");
  if (behavior.unusualExpenses.length === 0) {
    lines.push("- none flagged.");
  } else {
    for (const u of behavior.unusualExpenses) {
      lines.push(
        `- "${u.description}" ${peso(u.amount)} on ${utcDateKey(u.date)} in ${u.categoryName} — ` +
          `that category normally averages ${peso(u.categoryMean)} ${refs.tag("expense", u)}`
      );
    }
  }

  const totalInsufficient = behavior.analysisCoverage?.insufficientHistoryCategoryCount
    ?? behavior.insufficientHistoryCategories.length;
  if (totalInsufficient > 0) {
    const insufficient = [...behavior.insufficientHistoryCategories].sort(
      (left, right) => left.categoryName.localeCompare(right.categoryName) || left.categoryId - right.categoryId,
    );
    const visible = insufficient.slice(0, MAX_AI_INSUFFICIENT_HISTORY_CATEGORIES);
    const omitted = Math.max(0, totalInsufficient - visible.length);
    lines.push(
      "",
      "Categories with too few records to check for unusual spending yet: " +
        (visible.length > 0
          ? visible.map((c) => `${c.categoryName} (${c.historyCount} record(s))`).join(", ")
          : "none from the analyzed set") +
        (omitted > 0 ? `. ${omitted} additional categor${omitted === 1 ? "y was" : "ies were"} omitted.` : "")
    );
  }

  lines.push("", "Open explainable findings awaiting owner review:");
  if (findings.length === 0) {
    lines.push("- none.");
  } else {
    for (const finding of findings) {
      const reasons = plainFindingReasons(finding.reasons);
      const tag = finding.expenseRecord ? ` ${refs.tag("expense", finding.expenseRecord)}` : "";
      lines.push(`- [${finding.severity}] ${finding.title}: ${reasons.join("; ") || "No additional reason recorded."}${tag}`);
    }
    lines.push("These findings mean unusual or worth reviewing, not confirmed fraud or wrongdoing.");
  }

  return lines;
}

type RecoveryInsight = Awaited<ReturnType<typeof getRecoveryInsight>>;

// Short, human phrase for `RecoveryChangeReason` (plan §8.2/§10.3, Phase 3).
// `no_material_change` deliberately has no phrase — recoveryLines never emits
// a "why it changed" line for it; see the caller.
function recoveryChangeReasonPhrase(reason: RecoveryChangeReason): string {
  switch (reason) {
    case "sales_added":
      return "sales were recorded";
    case "open_day_elapsed":
      return "a day elapsed";
    case "baseline_changed":
    case "schedule_changed":
    case "data_changed":
      return "your setup or schedule changed";
    case "no_material_change":
      return "";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

async function recoveryLines(
  userId: number,
  profile: BusinessProfile,
  loadInsight?: () => Promise<RecoveryInsight>
): Promise<string[]> {
  const recovery = await (loadInsight ?? (() =>
    getRecoveryInsight(userId, profile.id, RECOVERY_COVERAGE_DAYS, undefined, { evaluateAlerts: false })))();
  const lines = [
    "",
    "=== RECOVERY TARGET DETAIL ===",
    `Today's target: ${peso(recovery.todaysTarget)}`,
    `Sales recorded today: ${peso(recovery.todaysSales)}`,
    `Today's gap: ${peso(Math.abs(recovery.todaysGap))} ${recovery.todaysStatus} target`,
    `Calendar days left in this month: ${recovery.calendarDaysLeftInMonth} of ${recovery.daysInMonth}`,
    "",
    "How remaining operating days is derived: the business profile stores a monthly operating-day count, not a weekly schedule, so the remaining operating days figure is an approximation (monthly operating days scaled by the fraction of the month still ahead). Say so if asked how precise it is.",
    "",
    "Recent daily coverage:",
  ];
  for (const d of recovery.dailyCoverage) {
    if (d.status === "closed") {
      lines.push(`- ${d.date}: closed (not an operating day) — recorded ${peso(d.sales)}, no target applies`);
      continue;
    }
    lines.push(`- ${d.date}: recorded ${peso(d.sales)} against ${peso(d.neededTarget as number)} needed — ${d.status} target`);
  }

  // ---- Phase 3 additions (plan §10.3/§11): deterministic facts the Recovery
  // Target page itself would show, provided as plain arithmetic strings —
  // never as a prompt asking the model to interpret the underlying figures.
  // Each is additive; none of them touch the status-derived lines above.
  if (recovery.dataWarnings.length > 0 && recovery.provisionalSalesThisMonth > 0) {
    lines.push(
      `- Note: ${peso(
        recovery.provisionalSalesThisMonth
      )} of this month's recorded sales is pending review or flagged as a possible duplicate; the figures above include it.`
    );
  }

  // Only surfaced when setup isn't already the bigger issue — the
  // "SETUP NEEDED" status line (elsewhere in this context) already covers
  // that more urgent case, and piling this on top of it would be noise.
  if (!recovery.needsSetup && recovery.setupIssues.includes("operating_schedule_missing")) {
    lines.push("- Operating days are approximated from a monthly count, not an exact weekly schedule.");
  }

  if (recovery.changeSincePreviousDay) {
    const { adjustedDailyTargetDelta, primaryReason } = recovery.changeSincePreviousDay;
    // Defensive: "no_material_change" already means "don't add this line",
    // and a defensive zero-delta check covers any other case that would
    // otherwise read as "increased/decreased by PHP 0.00".
    if (primaryReason !== "no_material_change" && adjustedDailyTargetDelta !== 0) {
      const direction = adjustedDailyTargetDelta > 0 ? "increased" : "decreased";
      lines.push(
        `- Since yesterday: adjusted daily target ${direction} by ${peso(
          Math.abs(adjustedDailyTargetDelta)
        )} (${recoveryChangeReasonPhrase(primaryReason)}).`
      );
    }
  }

  return lines;
}

export async function spendingImpactLines(
  userId: number,
  profile: BusinessProfile,
  scenario: ExtractedScenario
): Promise<string[]> {
  const lines = ["", "=== SPENDING IMPACT ==="];

  if (scenario.amount === null) {
    lines.push(
      `An expense is treated as High Impact once it exceeds ${Number(
        profile.largeExpenseThresholdPercent
      )}% of available business funds, Noticeable Impact from ${(
        Number(profile.largeExpenseThresholdPercent) * NOTICEABLE_BAND_FRACTION
      ).toFixed(1)}% up to that, and Low Impact below.`
    );
    if (scenario.looksLikeScenario) {
      lines.push(
        "",
        "IMPORTANT: this message describes a planned purchase but no amount could be read from it. Do NOT estimate, assume, or invent an amount. Ask the owner what amount they have in mind, in one short question."
      );
    } else {
      lines.push(
        "",
        "No planned amount was given in this message. If the question needs one, ask for it rather than assuming a figure."
      );
    }
    return lines;
  }

  // The numbers below come from the same deterministic simulator the
  // Spending Impact screen uses — the model is describing a computed
  // result, not producing one.
  const impact = await simulateSpendingImpact(userId, profile.id, scenario.amount, DEFAULT_PERIOD_DAYS);
  const percentText = Number.isFinite(impact.percentOfFunds)
    ? `${impact.percentOfFunds.toFixed(1)}%`
    : impact.funds.before < 0
      ? "not defined because the recorded balance is already below zero"
      : "not defined because the recorded balance is zero";
  const balanceStateLine = impact.funds.before < 0
    ? "- The recorded balance is already below zero before this planned purchase."
    : impact.funds.before === 0
      ? "- No recorded funds are available before this planned purchase."
      : null;
  const thresholdLine = impact.funds.before > 0
    ? `- Impact band: ${impact.impactBand} (owner's threshold for High Impact is ${impact.thresholdPercent}% of available funds, i.e. ${peso(impact.thresholdAmount)})`
    : `- Impact band: ${impact.impactBand}. The threshold amount is ${peso(impact.thresholdAmount)} because there are no spendable funds.`;

  lines.push(
    "FinSight has already calculated this scenario. Use these exact figures; do not recalculate or round them differently:",
    `- Planned amount detected: ${peso(impact.plannedAmount)}${scenario.label ? ` (described as "${scenario.label}")` : ""}`,
    `- Available business funds before: ${peso(impact.funds.before)}`,
    `- Available business funds after: ${peso(impact.funds.after)}`,
    `- Available funds were calculated from ${peso(impact.availableFundsCalculation.baselineAmount)} opening balance, plus ${peso(impact.availableFundsCalculation.confirmedSalesAdded)} confirmed sales, minus ${peso(impact.availableFundsCalculation.confirmedExpensesDeducted)} confirmed expenses`,
    ...(balanceStateLine ? [balanceStateLine] : []),
    `- Share of available funds used: ${percentText}`,
    thresholdLine,
    `- Recorded expenses this period before: ${peso(impact.periodExpenses.before)}`,
    `- Recorded expenses this period if this is included: ${peso(impact.periodExpenses.after)}`,
    impact.exceedsFunds
      ? "- This amount exceeds the spendable funds on record."
      : impact.plannedAmount === 0
        ? "- The planned amount is zero, so it does not change the recorded balance."
        : "- This amount stays within the available business funds on record.",
    "",
    "Describe this result in plain language. This what-if check was not saved, and it does not tell the owner whether to go ahead with the purchase. Do not give a verdict on whether they should buy it."
  );

  if (scenario.label) {
    lines.push(
      `You may refer to the item as "${scenario.label}". Do not claim to know a category for it unless one of the owner's real categories in the snapshot above obviously matches. You have not been given a category assignment.`
    );
  }

  return lines;
}

// ============================================================
// Selected reduction opportunity (Ask FinSight integration — plan §11)
// ============================================================
//
// The opportunity itself was computed deterministically by
// reductionOpportunity.service (Phases 1-2) on an earlier, separate request.
// This function does NOT recompute anything; it only renders the SAME
// structured object the card already showed the owner into context lines,
// exactly the way spendingImpactLines renders an already-computed
// simulateSpendingImpact result rather than asking the model to produce one.
//
// Trust note: the object arrives from the client (echoing what the
// reduction-opportunities endpoint returned earlier in this session), the
// same trust boundary askSchema's `context` override already documents —
// it only steers the wording of THIS owner's own conversation about their
// own business, it grants no data access requireOwnedBusinessProfile didn't
// already grant, and it is never used to calculate anything. suggestedChecks
// is filtered back against the real controlled catalogue (§9.4) rather than
// trusted verbatim, since that is the one field this function turns into an
// imperative "do this" instruction to the model.
export function reductionOpportunityLines(opportunity: ReductionOpportunity): string[] {
  const ev = opportunity.evidence;
  const lines = ["", "=== SELECTED REDUCTION OPPORTUNITY (from the Expense Insights card the owner opened) ==="];

  lines.push(
    `Category: ${opportunity.categoryName}`,
    `Opportunity type: ${opportunity.type}`,
    `Priority: ${opportunity.priority} — Confidence: ${opportunity.confidence}`,
    `Observation (already decided by FinSight's deterministic rules, not by you): ${opportunity.observation}`,
    `Why the rule selected it: ${opportunity.rationale}`
  );

  lines.push(
    "",
    "Evidence behind this opportunity. These are the ONLY figures for this opportunity — do not compute, estimate, or imply a savings amount from them:",
    `- Current-period category total: ${peso(ev.currentAmount)}`,
    ev.previousAmount === null
      ? "- No previous-period baseline for this category."
      : `- Previous-period category total: ${peso(ev.previousAmount)}`,
    ev.changeAmount === null || ev.changePercent === null
      ? "- No period-over-period change figure is available."
      : `- Change vs. previous period: ${peso(Math.abs(ev.changeAmount))} (${ev.changePercent >= 0 ? "up" : "down"} ${Math.abs(ev.changePercent).toFixed(1)}%)`,
    `- Share of this period's total expenses: ${ev.expenseSharePercent.toFixed(1)}%`,
    `- Records counted this period: ${ev.recordCount}`,
    `- Unusual records flagged in this category: ${ev.unusualRecordCount}`,
    `- Possible duplicates flagged in this category: ${ev.possibleDuplicateCount}`,
    `- Related records linked from the card: ${opportunity.relatedRecordIds.length} (you were not given their individual line items — do not describe specific records beyond the counts above)`
  );

  // Re-validated against the real catalogue rather than trusted verbatim —
  // see the trust note above. A tampered or stale entry is dropped, not
  // repaired, so the model never sees wording FinSight didn't author.
  const controlledChecks = new Set(SUGGESTED_CHECK_CATALOGUE[opportunity.type]);
  const checks = opportunity.suggestedChecks.filter((c) => controlledChecks.has(c));
  lines.push("", "Suggested checks already produced by FinSight's rule catalogue (turn these into a short checklist if asked what to check first — do not invent additional checks):");
  if (checks.length === 0) {
    lines.push("- none carried over from the card; if asked, say you don't have specific checks for this one.");
  } else {
    for (const c of checks) lines.push(`- ${c}`);
  }

  if (opportunity.limitations.length > 0) {
    lines.push("", "Limitations already disclosed on the card — repeat these where relevant instead of implying more certainty than FinSight has:");
    for (const l of opportunity.limitations) lines.push(`- ${l}`);
  }

  lines.push(
    "",
    "STRICT RULES for this opportunity, in addition to your standing rules above:",
    "- This is a review prompt, not a verdict. Never say this expense is unnecessary, wasteful, an error, or wrongdoing — a flag only means \"worth checking\", and a large or growing category can still be a necessary one.",
    "- Do NOT produce, estimate, or imply a peso savings figure for this opportunity. No reduction simulation has been run — only say a simulated figure exists if one is literally present in this context.",
    "- Do NOT recommend a supplier or alternative vendor, and do NOT claim or imply a market price or a fair price for anything.",
    "- Do NOT re-rank this opportunity against others or suggest a different one is more important — FinSight's ranking already decided that; explain the one selected above only.",
    "- If the owner asks something this context cannot answer (e.g. what caused a specific record), say so and point them to the suggested checks rather than guessing."
  );

  return lines;
}

async function dashboardLines(userId: number, profile: BusinessProfile, period: QuestionPeriod | null = null): Promise<string[]> {
  const summary = await getDashboardSummary(userId, profile.id, periodSelectionOf(period));
  const lines = [
    "",
    `=== DASHBOARD SUMMARY (${period ? period.label : `last ${summary.periodDays} days`}) ===`,
    `Total recorded expenses: ${peso(summary.overview.totalExpenses)}`,
    `Total sales recorded: ${peso(summary.overview.totalSalesReference)}`,
    `Records needing review: ${summary.recordsNeedingReview}`,
  ];
  if (summary.alerts.length > 0) {
    lines.push("", "Recent alerts:");
    for (const a of summary.alerts.slice(0, 5)) {
      lines.push(`- [${a.type}] ${a.message}`);
    }
  }
  return lines;
}

// ============================================================
// Entry point
// ============================================================

export interface ModuleContext {
  context: string;
  /** Present only for Spending Impact — lets the caller surface what was parsed. */
  scenario?: ExtractedScenario;
  /** Every record this context tagged — the only records an answer may link to. */
  references: ReadonlyMap<string, RecordReference>;
  /** One-tap actions the server built from the focus and the parsed scenario. */
  actions: ChatAction[];
  /** The period the question named, or null when the default window was used. */
  period: string | null;
}

// ============================================================
// The flag or record the chat was opened from (B2)
// ============================================================

const UNUSUAL_ACTIONS = [
  { label: "Yes — this was unusual", status: "CONFIRMED", feedback: "CONFIRMED_UNUSUAL" },
  { label: "This is normal for my business", status: "DISMISSED", feedback: "EXPECTED_TRANSACTION" },
] as const;
const DUPLICATE_ACTIONS = [
  { label: "It is a duplicate", status: "CONFIRMED", feedback: "DUPLICATE" },
  { label: "Wrong match — these are different", status: "DISMISSED", feedback: "INCORRECT_MATCH" },
] as const;

/**
 * "Explain this flag" used to send only a question, and the context listed
 * the ten newest open findings — so the model picked whichever it liked, and
 * an owner who asked about Business Meals was told about frozen fries. The
 * flag they actually opened now arrives by id and is rendered FIRST, on its
 * own, with the record it is about.
 *
 * Ownership: the lookup is scoped to this business profile, and SHADOW
 * findings are excluded exactly as the review API excludes them. With
 * `strict`, a focus that does not resolve is a 404 — indistinguishable from
 * one that never existed, the same rule every other owned lookup follows. On
 * later messages `strict` is off: a flag the owner has since resolved, or a
 * record deleted mid-conversation, simply drops out of the context.
 */
async function focusLines(
  profile: BusinessProfile,
  focus: ChatFocus,
  refs: ReferenceRegistry,
  strict: boolean
): Promise<{ lines: string[]; actions: ChatAction[] }> {
  if (focus.kind === "finding") {
    const finding = await prisma.anomalyFinding.findFirst({
      where: { id: focus.findingId, businessProfileId: profile.id, status: { not: "SHADOW" } },
      include: {
        expenseRecord: {
          select: { id: true, description: true, amount: true, date: true, vendor: true, category: { select: { name: true } } },
        },
      },
    });
    if (!finding) {
      if (strict) throw new ApiError(404, "Finding not found");
      return { lines: [], actions: [] };
    }

    const record = finding.expenseRecord;
    const metadata = (finding.metadata ?? {}) as Record<string, unknown>;
    const lines = ["", "=== THE FLAG THE OWNER IS ASKING ABOUT ==="];
    lines.push(`Flag: ${finding.title} (severity ${finding.severity.toLowerCase()}, status ${finding.status.toLowerCase()})`);
    if (record) {
      lines.push(
        `Record: "${record.description}" ${peso(Number(record.amount))} on ${utcDateKey(record.date)} in ${record.category.name}` +
          `${record.vendor ? `, from ${record.vendor}` : ""} ${refs.tag("expense", record)}`
      );
    }
    const reasonSubject = record ? `For "${record.description}": ` : "";
    for (const reason of plainFindingReasons(finding.reasons)) lines.push(`- ${reasonSubject}Why it was flagged: ${reason}`);
    if (typeof metadata.categoryMean === "number" && typeof metadata.historyCount === "number") {
      lines.push(
        `- ${reasonSubject}Compared against: the owner's usual ${peso(metadata.categoryMean)} in this category, across ${metadata.historyCount} past record(s)`
      );
    }
    lines.push("This is the flag the owner opened the chat from. Answer about THIS flag; mention other flags only if asked.");

    const options = finding.type === "POSSIBLE_DUPLICATE" ? DUPLICATE_ACTIONS : UNUSUAL_ACTIONS;
    const actions: ChatAction[] =
      finding.status === "OPEN"
        ? options.map((option) => ({ kind: "review-finding", findingId: finding.id, ...option }))
        : [];
    return { lines, actions };
  }

  const record =
    focus.recordType === "expense"
      ? await prisma.expenseRecord.findFirst({
          where: { id: focus.recordId, businessProfileId: profile.id },
          select: { id: true, description: true, amount: true, date: true, reviewStatus: true, duplicateStatus: true, largeExpenseFlag: true },
        })
      : await prisma.salesReferenceRecord.findFirst({
          where: { id: focus.recordId, businessProfileId: profile.id },
          select: { id: true, description: true, amount: true, date: true, reviewStatus: true, duplicateStatus: true },
        });
  if (!record) {
    if (strict) throw new ApiError(404, "Record not found");
    return { lines: [], actions: [] };
  }
  const lines = ["", "=== THE RECORD THE OWNER IS ASKING ABOUT ==="];
  lines.push(
    `${focus.recordType === "expense" ? "Expense" : "Sales"} record: "${record.description}" ${peso(Number(record.amount))} on ${utcDateKey(record.date)} ${refs.tag(focus.recordType, record)}`,
    `- Review status: ${record.reviewStatus}`,
    `- Duplicate check: ${record.duplicateStatus}`
  );
  if ("largeExpenseFlag" in record && record.largeExpenseFlag) {
    lines.push(`- It is above the owner's large-expense threshold of ${Number(profile.largeExpenseThresholdPercent)}% of available funds.`);
  }
  lines.push("This is the record the owner opened the chat from. Answer about THIS record first.");
  return { lines, actions: [] };
}

// ============================================================
// Records matching the question (B7)
// ============================================================

/**
 * Words that say nothing about WHICH records the owner means. What survives
 * is usually an item, vendor or category name — "fries", "meralco", "rent".
 */
const SEARCH_STOPWORDS = new Set(
  (
    "the a an and or of on in at to for from with about how much many what which who when where why did does do " +
    "is are was were be been my our your i we me us you it its this that these those there here than then " +
    "spend spent spending expense expenses cost costs paid pay payment buy bought purchase purchases total " +
    "record records sale sales money amount amounts peso pesos php month months week weeks year years day days " +
    "last past this next ago today yesterday time all ever show give tell list find link open please can could " +
    "would should will just also more most less much any some every each per vs versus compare compared " +
    "category categories flag flagged unusual usual normal high higher low lower " +
    "reduce cut save saving savings help explain mean means need needs attention summarise summarize summary " +
    "doing going way ways target targets daily pace review reviewed check happened change changed changes " +
    "increase increased decrease decreased biggest largest highest lowest top better worse good bad thing things " +
    "fin finsight business funds left over still again only really above under below least greater bigger " +
    "magkano ilan ano anong saan kailan bakit paano ang ng sa mga ko ako namin natin yung iyong yun ito iyan " +
    "nung noong ngayong nakaraang isang buwan linggo taon araw gastos ginastos binili bayad lahat po ba na pa " +
    "lagpas higit mahigit kulang mababa benta nabenta kita kinita " +
    "january february march april may june july august september october november december " +
    "enero pebrero marso abril mayo hunyo hulyo agosto setyembre oktubre nobyembre disyembre"
  ).split(/\s+/)
);
const MAX_SEARCH_TERMS = 3;
const MAX_MATCHED_RECORDS = 8;

export function searchTerms(question: string): string[] {
  const words = question.toLowerCase().match(/[a-zñ][a-zñ'-]{2,}/g) ?? [];
  const terms: string[] = [];
  for (const word of words) {
    const term = word.replace(/'s$/, "").replace(/^-+|-+$/g, "");
    if (term.length < 3 || SEARCH_STOPWORDS.has(term) || terms.includes(term)) continue;
    terms.push(term);
    if (terms.length >= MAX_SEARCH_TERMS) break;
  }
  return terms;
}

export interface AmountFilter {
  recordType: "expense" | "sales";
  comparison: "gt" | "gte" | "lt" | "lte";
  amount: number;
}

const COMPARISON_WORDS: Record<string, AmountFilter["comparison"]> = {
  over: "gt", above: "gt", "more than": "gt", "greater than": "gt", "higher than": "gt", "bigger than": "gt",
  "lagpas sa": "gt", "higit sa": "gt", mahigit: "gt",
  "at least": "gte",
  under: "lt", below: "lt", "less than": "lt", "lower than": "lt", "kulang sa": "lt", "mababa sa": "lt",
  "at most": "lte",
};
const AMOUNT_FILTER_PATTERN = new RegExp(
  String.raw`\b(${Object.keys(COMPARISON_WORDS).join("|")})\s*(?:₱|php\.?|p(?=\s?\d))?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(k|thousand)?\b` +
    // "more than 3 times", "over 20%" and "under 5 days" are counts, not money.
    String.raw`(?!\s*(?:%|percent|times|records?|days?|weeks?|months?|items?|beses|araw))`,
  "i"
);
const SALES_WORDS = /\b(?:sales?|sold|sell|benta|nabenta|kita|kinita|income|earn(?:ed|ings)?)\b/i;

/** "Expenses over 5,000", "sales below ₱2k". Null when the question names no amount bound. */
export function amountFilter(question: string): AmountFilter | null {
  const match = question.match(AMOUNT_FILTER_PATTERN);
  if (!match) return null;
  const base = Number(`${match[2]!.replace(/,/g, "")}${match[3] ? `.${match[3]}` : ""}`);
  const amount = match[4] ? base * 1000 : base;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    recordType: SALES_WORDS.test(question) ? "sales" : "expense",
    comparison: COMPARISON_WORDS[match[1]!.toLowerCase().replace(/\s+/g, " ")]!,
    amount,
  };
}

const COMPARISON_PHRASE: Record<AmountFilter["comparison"], string> = {
  gt: "over", gte: "of at least", lt: "under", lte: "of at most",
};

/**
 * The model cannot browse records, so a question that filters by amount
 * ("which expenses were over 5,000 last week?") is answered by the database:
 * a count, a total and the largest matching rows.
 */
async function amountFilterLines(
  profile: BusinessProfile,
  question: string,
  today: Date,
  period: QuestionPeriod | null,
  refs: ReferenceRegistry
): Promise<string[]> {
  const filter = amountFilter(question);
  if (!filter) return [];

  const window = period ? resolveReportingWindow(period.selection, today) : null;
  const where = {
    businessProfileId: profile.id,
    date: window ? windowDateFilter(window, today) : { lte: utcEndOfDay(today) },
    amount: { [filter.comparison]: filter.amount },
  };
  const select = { id: true, description: true, amount: true, date: true } as const;
  const orderBy = [{ amount: filter.comparison.startsWith("g") ? "desc" as const : "asc" as const }, { id: "desc" as const }];
  const [aggregate, rows] = filter.recordType === "sales"
    ? await Promise.all([
        prisma.salesReferenceRecord.aggregate({ where, _sum: { amount: true }, _count: { _all: true } }),
        prisma.salesReferenceRecord.findMany({ where, orderBy, take: MAX_MATCHED_RECORDS, select }),
      ])
    : await Promise.all([
        prisma.expenseRecord.aggregate({ where, _sum: { amount: true }, _count: { _all: true } }),
        prisma.expenseRecord.findMany({ where, orderBy, take: MAX_MATCHED_RECORDS, select }),
      ]);

  const noun = filter.recordType === "sales" ? "Sales" : "Expense";
  const scope = period ? period.label : "all records up to today";
  const bound = `${COMPARISON_PHRASE[filter.comparison]} ${peso(filter.amount)}`;
  const count = aggregate._count._all;
  const lines = ["", `=== ${noun.toUpperCase()} RECORDS ${bound.toUpperCase()} (${scope}) ===`];
  if (count === 0) {
    lines.push(`No ${noun.toLowerCase()} records ${bound} in this period.`);
    return lines;
  }
  lines.push(`${noun} records ${bound}: ${count} record(s) totalling ${peso(Number(aggregate._sum.amount ?? 0))}`);
  for (const row of rows) {
    lines.push(`- "${row.description}" ${peso(Number(row.amount))} on ${utcDateKey(row.date)} ${refs.tag(filter.recordType, row)}`);
  }
  if (count > rows.length) lines.push(`- (${count - rows.length} more matching record(s) not listed)`);
  lines.push("These totals were calculated by FinSight. Use them as given; do not add records up yourself.");
  return lines;
}

/**
 * "How much did I spend on fries in January?" needs rows no screen summary
 * carries. Rather than handing the model a search tool, the server reads the
 * question's own nouns and runs ONE bounded, owner-scoped search — the totals
 * below are computed by the database, so the model still only phrases them.
 */
async function matchingRecordLines(
  profile: BusinessProfile,
  question: string,
  today: Date,
  period: QuestionPeriod | null,
  refs: ReferenceRegistry
): Promise<string[]> {
  const terms = searchTerms(question);
  if (terms.length === 0) return [];

  const window = period ? resolveReportingWindow(period.selection, today) : null;
  const dateFilter = window ? windowDateFilter(window, today) : { lte: utcEndOfDay(today) };

  // Sales carry no vendor or category, so the description is the only thing to match.
  const salesSearch = Promise.all(
    terms.map(async (term) => {
      const where = {
        businessProfileId: profile.id,
        date: dateFilter,
        description: { contains: term, mode: "insensitive" as const },
      };
      const [aggregate, rows] = await Promise.all([
        prisma.salesReferenceRecord.aggregate({ where, _sum: { amount: true }, _count: { _all: true } }),
        prisma.salesReferenceRecord.findMany({
          where,
          orderBy: [{ date: "desc" }, { id: "desc" }],
          take: MAX_MATCHED_RECORDS,
          select: { id: true, description: true, amount: true, date: true },
        }),
      ]);
      return { term, aggregate, rows };
    })
  );

  // Lines inside scanned receipts that were saved as expenses. Both the scan
  // and the record must belong to this business; an unsaved scan is not spending.
  const itemSearch = Promise.all(
    terms.map(async (term) => {
      const where = {
        name: { contains: term, mode: "insensitive" as const },
        receiptScan: { businessProfileId: profile.id },
        expenseRecord: { businessProfileId: profile.id, date: dateFilter },
      };
      const [aggregate, rows] = await Promise.all([
        prisma.receiptScanItem.aggregate({ where, _sum: { amount: true }, _count: { _all: true } }),
        prisma.receiptScanItem.findMany({
          where,
          orderBy: [{ expenseRecord: { date: "desc" } }, { id: "desc" }],
          take: MAX_MATCHED_RECORDS,
          select: {
            name: true,
            amount: true,
            expenseRecord: { select: { id: true, description: true, amount: true, date: true } },
          },
        }),
      ]);
      return { term, aggregate, rows };
    })
  );

  const perTerm = await Promise.all(
    terms.map(async (term) => {
      const where = {
        businessProfileId: profile.id,
        date: dateFilter,
        OR: [
          { description: { contains: term, mode: "insensitive" as const } },
          { vendor: { contains: term, mode: "insensitive" as const } },
          { category: { name: { contains: term, mode: "insensitive" as const } } },
        ],
      };
      const [aggregate, rows, needsReview] = await Promise.all([
        prisma.expenseRecord.aggregate({ where, _sum: { amount: true }, _count: { _all: true } }),
        prisma.expenseRecord.findMany({
          where,
          orderBy: [{ date: "desc" }, { id: "desc" }],
          take: MAX_MATCHED_RECORDS,
          select: { id: true, description: true, amount: true, date: true, vendor: true, category: { select: { name: true } } },
        }),
        prisma.expenseRecord.count({ where: { ...where, reviewStatus: "Needs Review" } }),
      ]);
      return { term, aggregate, rows, needsReview };
    })
  );
  const salesPerTerm = await salesSearch;
  const itemPerTerm = await itemSearch;

  const found = perTerm.filter((entry) => entry.aggregate._count._all > 0);
  const salesFound = salesPerTerm.filter((entry) => entry.aggregate._count._all > 0);
  const itemsFound = itemPerTerm.filter((entry) => entry.aggregate._count._all > 0);
  if (found.length === 0 && salesFound.length === 0 && itemsFound.length === 0) return [];

  const scope = period ? period.label : "all records up to today";
  const lines: string[] = [];
  if (itemsFound.length > 0) {
    lines.push("", `=== ITEMS ON SAVED RECEIPTS MATCHING THE QUESTION (${scope}) ===`);
  }
  for (const { term, aggregate, rows } of itemsFound) {
    const count = aggregate._count._all;
    lines.push(`Receipt items matching "${term}": ${count} item line(s) totalling ${peso(Number(aggregate._sum.amount ?? 0))}`);
    for (const row of rows) {
      const record = row.expenseRecord!;
      lines.push(
        `- Item "${row.name}" ${peso(Number(row.amount))}, on the receipt saved ${utcDateKey(record.date)} as "${record.description}" ${refs.tag("expense", record)}`
      );
    }
    if (count > rows.length) lines.push(`- (${count - rows.length} older matching item line(s) not listed)`);
  }
  if (itemsFound.length > 0) {
    lines.push("Receipt item amounts are parts of the expense records they were saved into. Never add them to expense totals.");
  }
  if (salesFound.length > 0) lines.push("", `=== SALES RECORDS MATCHING THE QUESTION (${scope}) ===`);
  for (const { term, aggregate, rows } of salesFound) {
    const count = aggregate._count._all;
    lines.push(`Sales matching "${term}": ${count} record(s) totalling ${peso(Number(aggregate._sum.amount ?? 0))}`);
    for (const row of rows) {
      lines.push(`- "${row.description}" ${peso(Number(row.amount))} on ${utcDateKey(row.date)} ${refs.tag("sales", row)}`);
    }
    if (count > rows.length) lines.push(`- (${count - rows.length} older matching sales record(s) not listed)`);
  }
  if (found.length > 0) lines.push("", `=== EXPENSE RECORDS MATCHING THE QUESTION (${scope}) ===`);
  for (const { term, aggregate, rows, needsReview } of found) {
    const count = aggregate._count._all;
    lines.push(
      `Matching "${term}": ${count} record(s) totalling ${peso(Number(aggregate._sum.amount ?? 0))}` +
        (needsReview > 0 ? ` (${needsReview} of them still waiting for review)` : "")
    );
    for (const row of rows) {
      lines.push(
        `- "${row.description}" ${peso(Number(row.amount))} on ${utcDateKey(row.date)} in ${row.category.name}` +
          `${row.vendor ? `, from ${row.vendor}` : ""} ${refs.tag("expense", row)}`
      );
    }
    if (count > rows.length) lines.push(`- (${count - rows.length} older matching record(s) not listed)`);
  }
  lines.push("These totals were calculated by FinSight. Use them as given; do not add records up yourself.");
  return lines;
}

/**
 * "What bills are coming up?" The owner's own repeating-payment schedules,
 * due within the next month or already past due. Nothing is listed when the
 * recurring feature is off: its due dates are not maintained then.
 */
async function upcomingPaymentLines(profile: BusinessProfile, today: Date): Promise<string[]> {
  if (!RUNTIME_DETECTION_CONFIG.featureFlags.recurring) return [];
  const rows = await prisma.recurringSchedule.findMany({
    where: {
      businessProfileId: profile.id,
      isActive: true,
      nextDueDate: { lte: utcAddDays(today, UPCOMING_PAYMENT_DAYS) },
    },
    orderBy: [{ nextDueDate: "asc" }, { id: "asc" }],
    take: MAX_UPCOMING_PAYMENTS + 1,
    select: { label: true, expectedAmount: true, nextDueDate: true, category: { select: { name: true } } },
  });
  if (rows.length === 0) return [];

  const lines = ["", `=== UPCOMING REPEATING PAYMENTS (set up by the owner, due within ${UPCOMING_PAYMENT_DAYS} days) ===`];
  for (const row of rows.slice(0, MAX_UPCOMING_PAYMENTS)) {
    const state = dueStateOf(row.nextDueDate, today);
    lines.push(
      `- "${row.label}" expected ${peso(Number(row.expectedAmount))}, due ${utcDateKey(row.nextDueDate)} (${row.category.name})` +
        (state === "OVERDUE" ? " — the due date has passed with no matching expense recorded" : state === "DUE_SOON" ? " — due soon" : "")
    );
  }
  if (rows.length > MAX_UPCOMING_PAYMENTS) lines.push("- (more scheduled payments not listed)");
  lines.push("These are amounts the owner expects to pay, not recorded spending. Do not add them up.");
  return lines;
}

type ContextBlock = { lines: string[]; actions: ChatAction[] };
const EMPTY_BLOCK: ContextBlock = { lines: [], actions: [] };

/** "Who do I pay the most?" Counted expenses per vendor for the period, totalled by the database. */
async function topVendorLines(profile: BusinessProfile, today: Date, period: QuestionPeriod | null): Promise<string[]> {
  const rows = await prisma.expenseRecord.groupBy({
    by: ["vendor"],
    where: { businessProfileId: profile.id, ...COUNTED_EXPENSE, vendor: { not: null }, date: periodDateFilter(period, today) },
    _sum: { amount: true },
    _count: { _all: true },
    orderBy: [{ _sum: { amount: "desc" } }],
    take: TOP_VENDORS,
  });
  const named = rows.filter((row) => row.vendor?.trim());
  if (named.length === 0) return [];
  const lines = ["", "Vendors paid the most this period (counted expenses, highest first):"];
  for (const row of named) {
    lines.push(`- ${row.vendor!.trim()}: ${peso(Number(row._sum.amount ?? 0))} across ${row._count._all} record(s)`);
  }
  return lines;
}

/**
 * "October vs September." Two months side by side, per category, using the
 * same counted-expense rule as the category trends above. One figure per line:
 * the answer check binds a figure to the words before it on its own line.
 */
async function monthComparisonLines(
  profile: BusinessProfile,
  today: Date,
  months: [QuestionPeriod, QuestionPeriod],
): Promise<string[]> {
  const read = async (month: QuestionPeriod) => {
    const where = { businessProfileId: profile.id, date: windowDateFilter(resolveReportingWindow(month.selection, today), today) };
    const [byCategory, expenses, sales] = await Promise.all([
      prisma.expenseRecord.groupBy({ by: ["categoryId"], where: { ...where, ...COUNTED_EXPENSE }, _sum: { amount: true } }),
      prisma.expenseRecord.aggregate({ where: { ...where, ...COUNTED_EXPENSE }, _sum: { amount: true } }),
      prisma.salesReferenceRecord.aggregate({ where, _sum: { amount: true } }),
    ]);
    return {
      label: month.label,
      byCategory: new Map(byCategory.map((row) => [row.categoryId, Number(row._sum.amount ?? 0)])),
      expenses: Number(expenses._sum.amount ?? 0),
      sales: Number(sales._sum.amount ?? 0),
    };
  };
  const [earlier, later] = await Promise.all(months.map(read)) as [Awaited<ReturnType<typeof read>>, Awaited<ReturnType<typeof read>>];
  const ids = [...new Set([...earlier.byCategory.keys(), ...later.byCategory.keys()])];
  const names = new Map(
    (await prisma.expenseCategory.findMany({ where: { businessProfileId: profile.id, id: { in: ids } }, select: { id: true, name: true } }))
      .map((category) => [category.id, category.name]),
  );

  const lines = ["", `=== MONTH COMPARISON: ${earlier.label} and ${later.label} ===`];
  const pair = (subject: string, before: number, after: number) => {
    lines.push(`- ${subject} in ${earlier.label}: ${peso(before)}`, `- ${subject} in ${later.label}: ${peso(after)}`);
    lines.push(
      before === after
        ? `- ${subject} did not change from ${earlier.label} to ${later.label}.`
        : `- ${subject} change from ${earlier.label} to ${later.label}: ${after > before ? "up" : "down"} ${peso(Math.abs(after - before))}`,
    );
  };
  pair("Total counted expenses", earlier.expenses, later.expenses);
  pair("Total sales recorded", earlier.sales, later.sales);
  const ranked = ids
    .map((id) => ({ id, before: earlier.byCategory.get(id) ?? 0, after: later.byCategory.get(id) ?? 0 }))
    .sort((a, b) => Math.max(b.before, b.after) - Math.max(a.before, a.after));
  for (const row of ranked.slice(0, MAX_COMPARED_CATEGORIES)) pair(names.get(row.id) ?? "Unnamed category", row.before, row.after);
  if (ranked.length > MAX_COMPARED_CATEGORIES) lines.push(`- ${ranked.length - MAX_COMPARED_CATEGORIES} smaller categories not listed.`);
  lines.push("FinSight calculated these totals and differences. Use them as given; do not add or subtract figures yourself.");
  return lines;
}

/**
 * "What if I sell 3,000 a day?" and "what if my monthly costs were 100k?".
 * Daily sales are projected over the open days Recovery Target already counts;
 * monthly costs go through the same simulator the Recovery Target page uses.
 * Nothing is saved either way. One figure per line, for the answer check.
 */
async function recoveryWhatIfLines(
  userId: number,
  profile: BusinessProfile,
  today: Date,
  whatIf: RecoveryWhatIf,
): Promise<string[]> {
  const footer = "FinSight calculated these figures and saved nothing. Use them as given; do not recalculate them.";
  if (whatIf.kind === "monthly-costs") {
    const scenario = await simulateRecoveryScenario(userId, profile.id, whatIf.amount);
    return [
      "",
      `=== RECOVERY WHAT-IF: if monthly costs were ${peso(whatIf.amount)} ===`,
      `Monthly costs Recovery Target uses now: ${peso(scenario.current.expectedMonthlyExpenses)}`,
      `New daily goal now: ${peso(scenario.current.adjustedDailyTarget)}`,
      `New daily goal in this what-if: ${peso(scenario.hypothetical.adjustedDailyTarget)}`,
      `Sales still needed this month now: ${peso(scenario.current.remainingTarget)}`,
      `Sales still needed this month in this what-if: ${peso(scenario.hypothetical.remainingTarget)}`,
      footer,
    ];
  }

  const targets = await loadRecoveryTargets(profile, today);
  const days = targets.remainingOperatingDays;
  const lines = ["", `=== RECOVERY WHAT-IF: selling ${peso(whatIf.amount)} on each open day left this month ===`];
  if (days <= 0) {
    lines.push("There are no open days left this month, so this pace would not change this month's figures.");
    return lines;
  }
  const added = Number((whatIf.amount * days).toFixed(2));
  const remaining = targets.remainingTarget;
  lines.push(
    `Open days left this month, as Recovery Target counts them: ${days}`,
    `Sales this pace would add by month end: ${peso(added)}`,
    `Sales still needed this month now: ${peso(remaining)}`,
    added >= remaining
      ? `Sales this pace would add beyond what is still needed: ${peso(Number((added - remaining).toFixed(2)))}`
      : `Sales still uncovered at month end at this pace: ${peso(Number((remaining - added).toFixed(2)))}`,
    `New daily goal now, for comparison: ${peso(targets.adjustedDailyTarget)}`,
    footer,
  );
  return lines;
}

/**
 * "What if I cut Supplies by 10%?" through the Reduction Opportunities
 * simulator. The category must be one of the owner's own, named in the question.
 */
async function reductionWhatIfLines(
  userId: number,
  profile: BusinessProfile,
  question: string,
  spec: ReductionSpec,
  period: QuestionPeriod | null,
): Promise<string[]> {
  const q = question.toLowerCase();
  const categories = await prisma.expenseCategory.findMany({ where: { businessProfileId: profile.id }, select: { id: true, name: true } });
  const category = categories
    .filter((c) => c.name.trim().length >= 3 && q.includes(c.name.trim().toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length)[0];
  const header = "=== COST-CUT WHAT-IF ===";
  if (!category) {
    return ["", header, "The owner asked about cutting a cost, but the question names none of their categories. Ask which category they mean."];
  }
  try {
    const result = await simulateReductionOpportunity(userId, {
      businessProfileId: profile.id,
      categoryId: category.id,
      period: period?.selection ?? { kind: "rolling", days: DEFAULT_PERIOD_DAYS },
      reduction: spec,
    });
    return [
      "",
      `=== COST-CUT WHAT-IF: ${result.categoryName}, cut by ${spec.kind === "percent" ? `${spec.value}%` : peso(spec.value)} (${periodLabelOf(period)}) ===`,
      `${result.categoryName} spending in the period as recorded: ${peso(result.categoryExpenses.before)}`,
      `${result.categoryName} spending in the period with this cut: ${peso(result.categoryExpenses.after)}`,
      `Amount this cut takes off: ${peso(result.hypotheticalReduction)}`,
      `Total counted expenses in the period as recorded: ${peso(result.totalExpenses.before)}`,
      `Total counted expenses in the period with this cut: ${peso(result.totalExpenses.after)}`,
      "This is a planning scenario on past spending: no record changed, and available funds are untouched. Use these figures as given.",
    ];
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 400) throw error;
    return [
      "",
      header,
      `FinSight could not calculate this cut for ${category.name}: the category has no counted expenses in this period, or the cut is larger than its total. Say so, and suggest a smaller cut or a different period.`,
    ];
  }
}

/**
 * "Is my data complete?" Gaps that make every other figure less reliable:
 * open days with no sales recorded, and records still uncategorised. Records
 * waiting for review and receipts waiting to be confirmed are in other blocks.
 */
async function completenessLines(
  profile: BusinessProfile,
  today: Date,
  loadInsight: () => Promise<RecoveryInsight>,
): Promise<string[]> {
  const [insight, uncategorised] = await Promise.all([
    loadInsight(),
    prisma.expenseRecord.count({
      where: {
        businessProfileId: profile.id,
        OR: UNCATEGORISED_NAMES.map((name) => ({ category: { name: { equals: name, mode: "insensitive" as const } } })),
      },
    }),
  ]);
  const todayKey = utcDateKey(today);
  // Today is still in progress, so no sales yet is not a gap.
  const quiet = insight.dailyCoverage
    .filter((day) => day.status !== "closed" && day.sales === 0 && day.date !== todayKey)
    .map((day) => day.date);
  return [
    "",
    "=== IS THE DATA COMPLETE? ===",
    quiet.length > 0
      ? `Open days in the last ${RECOVERY_COVERAGE_DAYS} days with no sales recorded: ${quiet.join(", ")}`
      : `Every open day in the last ${RECOVERY_COVERAGE_DAYS} days has sales recorded.`,
    `Expense records still without a category (Uncategorized): ${uncategorised}`,
    "Missing sales, unreviewed records and uncategorised records all make totals less reliable. Say which gaps exist plainly, without blame.",
  ];
}

/**
 * Repeating expenses the detector noticed and the owner has not answered yet,
 * with a button to watch each. Off with the recurring feature, like the
 * schedules themselves.
 */
async function recurringCandidateBlock(profile: BusinessProfile): Promise<ContextBlock> {
  if (!RUNTIME_DETECTION_CONFIG.featureFlags.recurring) return EMPTY_BLOCK;
  const patterns = await prisma.recurringPattern.findMany({
    where: { businessProfileId: profile.id, status: "CANDIDATE" },
    orderBy: [{ confidence: "desc" }, { id: "asc" }],
    take: MAX_RECURRING_CANDIDATES,
    select: { id: true, description: true, vendor: true, expectedAmount: true, intervalDays: true, nextExpectedDate: true },
  });
  if (patterns.length === 0) return EMPTY_BLOCK;
  const lines = ["", "=== REPEATING EXPENSES FINSIGHT NOTICED (the owner has not set these up as repeating payments) ==="];
  for (const pattern of patterns) {
    lines.push(
      `- "${pattern.description}"${pattern.vendor ? ` from ${pattern.vendor}` : ""}: usually ${peso(Number(pattern.expectedAmount))}, about every ${pattern.intervalDays} days, next expected ${utcDateKey(pattern.nextExpectedDate)}`,
    );
  }
  lines.push("Buttons under this answer let the owner have FinSight watch these as repeating payments. Mention that only if it helps.");
  const actions: ChatAction[] = patterns.slice(0, MAX_RECURRING_ACTIONS).map((pattern) => ({
    kind: "watch-recurring-pattern",
    patternId: pattern.id,
    label: `Watch "${pattern.description.slice(0, 40)}" as a repeating payment`,
  }));
  return { lines, actions };
}

/**
 * "I paid 500 for rice today." Offers the filled-in form rather than saving
 * anything, and holds back when a record of that amount is already there
 * from the past week, so a mention of something already recorded does not
 * become a duplicate.
 */
async function recordedTransactionBlock(
  profile: BusinessProfile,
  today: Date,
  question: string,
  refs: ReferenceRegistry,
): Promise<ContextBlock> {
  const said = recordedTransaction(question);
  if (!said) return EMPTY_BLOCK;
  const expense = said.recordType === "expense";
  const where = { businessProfileId: profile.id, amount: said.amount, date: { gte: utcAddDays(today, -7), lte: utcEndOfDay(today) } };
  const select = { id: true, description: true, amount: true, date: true } as const;
  const existing = expense
    ? await prisma.expenseRecord.findFirst({ where, orderBy: [{ date: "desc" }, { id: "desc" }], select })
    : await prisma.salesReferenceRecord.findFirst({ where, orderBy: [{ date: "desc" }, { id: "desc" }], select });
  const header = `=== WHAT THE OWNER SAYS THEY ${expense ? "PAID" : "SOLD"} ===`;
  if (existing) {
    return {
      lines: [
        "",
        header,
        `${expense ? "An expense" : "A sales"} record of the same amount is already in the records: "${existing.description}" ${peso(Number(existing.amount))} on ${utcDateKey(existing.date)} ${refs.tag(said.recordType, existing)}`,
        "Ask whether this is the same one before suggesting they add it again. Do not say anything was recorded just now.",
      ],
      actions: [],
    };
  }
  return {
    lines: [
      "",
      header,
      `The owner says they ${expense ? "paid" : "sold"} ${peso(said.amount)}${expense && said.description ? ` for "${said.description}"` : ""}. This is NOT in their records yet.`,
      "A button under this answer opens the form filled in; nothing is saved until the owner saves it. Say so in one short sentence and never say it has been recorded.",
    ],
    actions: [{
      kind: "prefill-record",
      recordType: said.recordType,
      amount: said.amount,
      description: said.description,
      label: expense ? "Add this expense" : "Add this sale",
    }],
  };
}

/**
 * "What's happening in my business?" What was ADDED recently, by when it was
 * recorded rather than the date on the record, so a batch of last month's
 * receipts typed in yesterday still shows up as yesterday's activity.
 */
async function recentActivityLines(profile: BusinessProfile): Promise<string[]> {
  const since = new Date(Date.now() - RECENT_ACTIVITY_DAYS * 24 * 60 * 60 * 1000);
  const recent = { businessProfileId: profile.id, createdAt: { gte: since } };
  const [expenses, sales, scans, waitingScans, imports] = await Promise.all([
    prisma.expenseRecord.aggregate({ where: recent, _sum: { amount: true }, _count: { _all: true } }),
    prisma.salesReferenceRecord.aggregate({ where: recent, _sum: { amount: true }, _count: { _all: true } }),
    prisma.receiptScan.count({ where: recent }),
    prisma.receiptScan.count({
      where: { businessProfileId: profile.id, confirmationStatus: "Pending", processingStatus: "Complete" },
    }),
    prisma.cSVImportBatch.count({ where: recent }),
  ]);

  const lines = ["", `=== RECENT ACTIVITY (records added in the last ${RECENT_ACTIVITY_DAYS} days, whatever date they carry) ===`];
  lines.push(
    expenses._count._all > 0
      ? `Expenses added: ${expenses._count._all} record(s) totalling ${peso(Number(expenses._sum.amount ?? 0))}`
      : "Expenses added: none.",
    sales._count._all > 0
      ? `Sales added: ${sales._count._all} record(s) totalling ${peso(Number(sales._sum.amount ?? 0))}`
      : "Sales added: none.",
    `Receipts scanned: ${scans}. Scanned receipts read and waiting for the owner to confirm (any age): ${waitingScans}.`,
    `Spreadsheet (CSV) imports started: ${imports}.`,
  );
  return lines;
}

/** Unread alerts, for every screen but the Dashboard, whose summary already lists them. */
async function unreadAlertLines(userId: number, profile: BusinessProfile, includeMessages: boolean): Promise<string[]> {
  const where = { userId, businessProfileId: profile.id, readStatus: false };
  const [count, latest] = await Promise.all([
    prisma.notification.count({ where }),
    includeMessages
      ? prisma.notification.findMany({
          where,
          orderBy: [{ dateCreated: "desc" }, { id: "desc" }],
          take: MAX_UNREAD_ALERTS,
          select: { type: true, message: true },
        })
      : Promise.resolve([]),
  ]);
  const lines = ["", `Unread alerts: ${count}`];
  for (const alert of latest) lines.push(`- [${alert.type}] ${alert.message}`);
  return lines;
}

/**
 * Context for the review queue's "Explain this flag" action.
 *
 * The evidence is entirely server-derived: open findings with their
 * detector-written reasons, plus the legacy record-level flags. The framing
 * line matters as much as the data — every finding is "unusual", never
 * "fraudulent", and the model is told so explicitly because a review screen
 * is exactly where an over-eager wording would do the most damage.
 */
async function recordsReviewLines(profile: BusinessProfile, refs: ReferenceRegistry = new ReferenceRegistry()): Promise<string[]> {
  const [findings, flaggedDuplicates, largeExpenses] = await Promise.all([
    prisma.anomalyFinding.findMany({
      where: { businessProfileId: profile.id, status: "OPEN" },
      orderBy: [{ severity: "desc" }, { detectedAt: "desc" }],
      take: 10,
      include: { expenseRecord: { select: { id: true, description: true, amount: true, date: true, vendor: true } } },
    }),
    prisma.expenseRecord.count({ where: { businessProfileId: profile.id, duplicateStatus: "Flagged" } }),
    prisma.expenseRecord.count({ where: { businessProfileId: profile.id, largeExpenseFlag: true } }),
  ]);

  const lines = ["", "=== RECORDS NEEDING REVIEW ==="];
  lines.push(`Possible duplicate records awaiting review: ${flaggedDuplicates}`);
  lines.push(`Records over the owner's large-expense threshold: ${largeExpenses}`);
  if (findings.length === 0) {
    lines.push("No open detector findings.");
  } else {
    lines.push("Open findings (each is a review prompt, NOT confirmed fraud or a confirmed error):");
    for (const finding of findings) {
      const record = finding.expenseRecord;
      const subject = record
        ? `${record.description} — ${peso(Number(record.amount))} on ${utcDateKey(record.date)}${record.vendor ? ` (${record.vendor})` : ""} ${refs.tag("expense", record)}`
        : "profile-level pattern";
      const reasons = plainFindingReasons(finding.reasons).slice(0, 3).join("; ");
      lines.push(`- [${finding.severity}] ${finding.title}: ${subject}. Why flagged: ${reasons}`);
    }
  }
  lines.push(
    "When the owner asks about a flag, explain the comparison behind it in plain language and suggest checking the record — never assert wrongdoing, and never invent findings not listed above.",
  );
  return lines;
}

// The Dashboard is the one screen an owner opens without a question already in
// mind, so its conversation wanders: "why is this so high", "am I on pace",
// "what's in my review queue". A single dashboard summary can't answer any of
// those, and the drawer has no way to switch modules mid-conversation, so the
// Dashboard gets the union of the three detail blocks that back those
// questions. Every other module stays deliberately narrow — that narrowness is
// what stops an expense-behaviour question from being answered with recovery
// arithmetic.
//
// Token cost of the union is small: the expensive shared part
// (buildFinancialSnapshot) already runs for every module, and these blocks are
// only ~5-11 lines each. The real cost is the extra DB round-trips, which is
// why they are fetched concurrently in the same Promise.all as the snapshot
// rather than awaited one after another — this sits on a per-message,
// billed-model path where latency is user-visible.
//
// Spending Impact is deliberately NOT in the union. Its block is driven by
// extractScenario(question): with no planned purchase in the message it
// degrades to a generic banding blurb plus an instruction to ask for an
// amount, which would be the largest block in the context and pure noise on a
// dashboard question. Outside Spending Impact the block is added by
// buildModuleContext only when the message is an explicit what-if purchase
// with an amount.
function moduleDetailPromises(
  userId: number,
  profile: BusinessProfile,
  module: InteractionModule,
  scenario: ExtractedScenario | undefined,
  loadBehavior: () => Promise<ExpenseBehavior>,
  loadRecoveryInsight: () => Promise<RecoveryInsight>,
  reductionOpportunity: ReductionOpportunity | undefined,
  refs: ReferenceRegistry = new ReferenceRegistry(),
  period: QuestionPeriod | null = null
): Promise<string[]>[] {
  switch (module) {
    case "Expense Insights":
      // The selected-opportunity block is additive to the normal Expense
      // Insights detail, not a replacement for it — an owner can still ask
      // about anything else on the screen in the same conversation. It only
      // ever attaches to THIS module (plan §11.1/§5.4): no new
      // InteractionModule value, no other module renders it.
      return reductionOpportunity
        ? [expenseInsightsLines(userId, profile, loadBehavior, refs), Promise.resolve(reductionOpportunityLines(reductionOpportunity))]
        : [expenseInsightsLines(userId, profile, loadBehavior, refs)];
    case "Recovery Target":
      return [recoveryLines(userId, profile, loadRecoveryInsight)];
    case "Spending Impact":
      return [spendingImpactLines(userId, profile, scenario!)];
    case "Records Review":
      return [recordsReviewLines(profile, refs)];
    case "Dashboard":
    default:
      // Dashboard's own summary first so it reads as the answer to "how am I
      // doing"; the rest follow as supporting detail. Each block keeps its own
      // === SECTION === header so the model can tell which numbers came from
      // where instead of blending them.
      return [
        dashboardLines(userId, profile, period),
        expenseInsightsLines(userId, profile, loadBehavior, refs),
        recoveryLines(userId, profile, loadRecoveryInsight),
        recordsReviewLines(profile, refs),
      ];
  }
}

// The steering line is what keeps a narrow module narrow, so widening the
// Dashboard's context without widening its steering line would leave the model
// refusing to use data it was just given.
function steeringLine(module: InteractionModule, hasReductionOpportunity: boolean, hasScenario = false): string {
  if (module === "Dashboard") {
    return (
      "The owner is currently looking at the Dashboard screen. This context also covers their expense behaviour, " +
      "recovery pace and review queue, so a question that ranges across those can be answered directly from what is above. " +
      (hasScenario
        ? "The planned purchase in this message has already been calculated — see the SPENDING IMPACT section above."
        : "Do not invite questions about planned purchases — no purchase scenario has been calculated for this message.")
    );
  }
  if (module === "Expense Insights" && hasReductionOpportunity) {
    return (
      "The owner opened this conversation from a Reduction Opportunity card in Expense Insights — see the " +
      "\"SELECTED REDUCTION OPPORTUNITY\" section above and its strict rules. Answer about that opportunity first; " +
      "you may still use the rest of this context (their broader expense behaviour) if they ask something wider."
    );
  }
  return `The owner is currently looking at the ${module} screen. Stay scoped to that unless they clearly ask about something else in this context.`;
}

export async function buildModuleContext(
  userId: number,
  profile: BusinessProfile,
  module: InteractionModule,
  question: string,
  reductionOpportunity?: ReductionOpportunity,
  options: {
    focus?: ChatFocus | null;
    /** A focus that fails to resolve 404s (first message) rather than being dropped (later ones). */
    strictFocus?: boolean;
  } = {}
): Promise<ModuleContext> {
  // Business-local, not server-UTC — getRecoveryInsight/simulateRecoveryScenario
  // resolve "today" this same way (see insights.service.ts), and this value
  // feeds the unshared loadRecoveryTargets(profile, today) call below plus the
  // "Today's date" line the model is given. A raw utcToday() here would drift
  // out of sync with getRecoveryInsight's own resolution for roughly a third
  // of every day (whenever the business's local calendar date has already
  // turned over but the server's UTC date hasn't), silently showing the AI a
  // different "today" than the Recovery Target screen itself uses.
  const today = resolveBusinessToday(profile.timezone);
  // Spending Impact always parses the message. Anywhere else a what-if is
  // calculated only for an unmistakable planned purchase with an amount, so
  // "how much did I spend on rice?" or "what if I sell 3,000 a day?" never
  // turns into a purchase simulation.
  const extracted = extractScenario(question);
  // A sales-pace, monthly-cost or cost-cut what-if is not a planned purchase,
  // even when it says "spending".
  const recoveryIf = recoveryWhatIf(question);
  const reductionIf = module === "Spending Impact" ? null : reductionWhatIf(question);
  const otherWhatIf = recoveryIf !== null || reductionIf !== null;
  const askedWhatIf =
    module !== "Spending Impact" &&
    !otherWhatIf &&
    extracted.amount !== null &&
    HYPOTHETICAL_CUE.test(question) &&
    PURCHASE_WORD.test(question);
  const scenario = module === "Spending Impact" || askedWhatIf ? extracted : undefined;
  // The period the question names ("January", "last month", "ngayong linggo"),
  // or null for the default rolling window. Recovery figures are month-to-date
  // by definition and deliberately ignore it.
  const period = extractQuestionPeriod(question, today);
  const refs = new ReferenceRegistry();

  // One expense-behaviour read per message, shared by the snapshot and the
  // Expense Insights block (identical arguments, so a second read could only
  // return the same rows at more cost).
  const loadBehavior = once(() => loadExpenseBehaviorForContext(userId, profile.id, periodSelectionOf(period)));

  // The recovery detail block already computes the snapshot's recovery targets
  // on its way to the daily-coverage table — getRecoveryInsight returns those
  // targets verbatim alongside its own figures. So when a module renders that
  // block, the snapshot reads its targets off the same result instead of
  // running loadRecoveryTargets a second time; when it doesn't, the snapshot
  // keeps doing the cheaper targets-only read on its own. The numbers are the
  // same either way — both paths anchor on the same business-local day and
  // the same profile row.
  const loadRecoveryInsight = once(() => getRecoveryInsight(userId, profile.id, RECOVERY_COVERAGE_DAYS, undefined, { evaluateAlerts: false }));
  const rendersRecoveryDetail = module === "Dashboard" || module === "Recovery Target";

  // The focus resolves first and on its own: when it is strict and does not
  // belong to this owner, nothing else should be read or billed.
  const focus = options.focus
    ? await focusLines(profile, options.focus, refs, options.strictFocus ?? false)
    : { lines: [], actions: [] };

  const comparedMonths = extractComparedMonths(question, today);
  const checksCompleteness = rendersRecoveryDetail || COMPLETENESS_CUE.test(question);
  const [
    snapshot, matches, filtered, whatIf, recoveryScenario, costCut, comparison, vendors, completeness,
    recorded, recurring, activity, alerts, upcoming, ...details
  ] = await Promise.all([
    buildFinancialSnapshot(
      userId,
      profile,
      today,
      {
        behavior: loadBehavior,
        recoveryTargets: rendersRecoveryDetail ? loadRecoveryInsight : undefined,
      },
      { refs, period }
    ),
    matchingRecordLines(profile, question, today, period, refs),
    // A what-if amount is a plan, not a filter on past records.
    askedWhatIf || otherWhatIf || module === "Spending Impact"
      ? Promise.resolve<string[]>([])
      : amountFilterLines(profile, question, today, period, refs),
    askedWhatIf ? spendingImpactLines(userId, profile, extracted) : Promise.resolve<string[]>([]),
    recoveryIf ? recoveryWhatIfLines(userId, profile, today, recoveryIf) : Promise.resolve<string[]>([]),
    reductionIf ? reductionWhatIfLines(userId, profile, question, reductionIf, period) : Promise.resolve<string[]>([]),
    comparedMonths ? monthComparisonLines(profile, today, comparedMonths) : Promise.resolve<string[]>([]),
    topVendorLines(profile, today, period),
    // Shares the Recovery Target read on the screens that load it anyway.
    checksCompleteness ? completenessLines(profile, today, loadRecoveryInsight) : Promise.resolve<string[]>([]),
    recordedTransactionBlock(profile, today, question, refs),
    RECURRING_CUE.test(question) ? recurringCandidateBlock(profile) : Promise.resolve(EMPTY_BLOCK),
    recentActivityLines(profile),
    unreadAlertLines(userId, profile, module !== "Dashboard"),
    upcomingPaymentLines(profile, today),
    ...moduleDetailPromises(userId, profile, module, scenario, loadBehavior, loadRecoveryInsight, reductionOpportunity, refs, period),
  ]);

  const actions: ChatAction[] = [...focus.actions, ...recorded.actions, ...recurring.actions];
  if (scenario?.amount != null && scenario.amount > 0) {
    actions.push({ kind: "open-spending-impact", amount: scenario.amount, label: "Open this in Spending Impact" });
  }

  // What the question asked for comes straight after the snapshot, so the
  // budget drops background blocks before it drops the answer.
  const priorityLines = [
    ...profileLines(profile),
    ...focus.lines,
    ...snapshot,
    ...recorded.lines,
    ...matches,
    ...filtered,
    ...whatIf,
    ...recoveryScenario,
    ...costCut,
    ...comparison,
    ...recurring.lines,
    ...completeness,
    ...vendors,
    ...activity,
    ...alerts,
    ...details.flat(),
    // Last on purpose: the budget drops from the end, so this goes first.
    ...upcoming,
  ];
  const requiredTailLines = [
    "",
    steeringLine(module, module === "Expense Insights" && Boolean(reductionOpportunity), askedWhatIf),
    ...(focus.lines.length > 0
      ? ["The owner opened this chat from the specific item described under \"THE FLAG/RECORD THE OWNER IS ASKING ABOUT\" above. That item comes first."]
      : []),
    period
      ? `The owner asked about ${period.label}. Figures labelled with that period cover it; recovery figures are always the current month to date.`
      : `No period was named, so figures cover the last ${DEFAULT_PERIOD_DAYS} days unless labelled otherwise.`,
    `Today's date: ${utcDateKey(today)}. All amounts are Philippine pesos.`,
  ];

  const context = contextWithinBudget(tagFinancialFacts(priorityLines), requiredTailLines);
  return {
    context,
    scenario,
    references: new Map([...refs.entries].filter(([tag]) => context.includes(tag))),
    actions,
    period: period?.label ?? null,
  };
}
