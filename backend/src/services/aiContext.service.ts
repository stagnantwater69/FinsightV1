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
import { resolveBusinessToday, utcDateKey, utcEndOfDay } from "../lib/dates";
import { getDashboardSummary } from "./dashboard.service";
import { getExpenseBehavior, getRecoveryInsight, loadRecoveryTargets, simulateSpendingImpact } from "./insights.service";
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
    `Starting available funds: ${peso(Number(profile.availableFunds))} (baseline date ${utcDateKey(profile.availableFundsBaselineDate)})`,
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
  const [behavior, recovery, availableFunds, flaggedExpenses, duplicateCount] = await Promise.all([
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
  ]);

  const lines = ["", `=== FINANCIAL SNAPSHOT (${periodLabelOf(period)}) ===`];

  lines.push(
    `Current recorded funds: ${peso(availableFunds.calculatedAmount)} as of ${availableFunds.asOfDate}`,
    `Funds calculation: ${peso(availableFunds.baselineAmount)} starting funds + ${peso(availableFunds.confirmedSalesAdded)} confirmed sales - ${peso(availableFunds.confirmedExpensesDeducted)} confirmed expenses.`,
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
    }
  }

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
      ? `- Monthly expense basis: ${peso(recovery.monthlyExpenseBasis.amount)} from ${recovery.monthlyExpenseBasis.sourceMonth} confirmed expense records (${recovery.monthlyExpenseBasis.eligibleRecordCount} eligible record(s))`
      : `- Monthly expense basis: ${peso(recovery.monthlyExpenseBasis.amount)} starting estimate; the preceding month's expense records are not confirmed complete`,
    `- Daily needed target: ${peso(recovery.dailyNeededTarget)} per operating day`,
    `- Sales reference recorded this month: ${peso(recovery.salesThisMonth)} of ${peso(
      recovery.expectedMonthlyExpenses
    )} needed (${recovery.monthCoveragePercent.toFixed(1)}% covered)`,
    `- Remaining target: ${peso(recovery.remainingTarget)} across ${recovery.remainingOperatingDays} remaining operating day(s)`,
    `- Adjusted daily target from here: ${peso(recovery.adjustedDailyTarget)}`,
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
    `Today's recorded sales reference: ${peso(recovery.todaysSales)}`,
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
    `- Available funds were calculated from ${peso(impact.availableFundsCalculation.baselineAmount)} starting funds, plus ${peso(impact.availableFundsCalculation.confirmedSalesAdded)} confirmed sales, minus ${peso(impact.availableFundsCalculation.confirmedExpensesDeducted)} confirmed expenses`,
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
    `Total recorded sales reference: ${peso(summary.overview.totalSalesReference)}`,
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
    "fin finsight business funds left over still again only really " +
    "magkano ilan ano anong saan kailan bakit paano ang ng sa mga ko ako namin natin yung iyong yun ito iyan " +
    "nung noong ngayong nakaraang isang buwan linggo taon araw gastos ginastos binili bayad lahat po ba na pa " +
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

  const found = perTerm.filter((entry) => entry.aggregate._count._all > 0);
  if (found.length === 0) return [];

  const scope = period ? period.label : "all records up to today";
  const lines = ["", `=== EXPENSE RECORDS MATCHING THE QUESTION (${scope}) ===`];
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
// dashboard question. Scenario parsing therefore stays where it was, on the
// Spending Impact module only.
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
function steeringLine(module: InteractionModule, hasReductionOpportunity: boolean): string {
  if (module === "Dashboard") {
    return (
      "The owner is currently looking at the Dashboard screen. This context also covers their expense behaviour, " +
      "recovery pace and review queue, so a question that ranges across those can be answered directly from what is above. " +
      "Do not invite questions about planned purchases — no purchase scenario has been calculated for this message."
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
  const scenario = module === "Spending Impact" ? extractScenario(question) : undefined;
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

  const [snapshot, matches, ...details] = await Promise.all([
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
    ...moduleDetailPromises(userId, profile, module, scenario, loadBehavior, loadRecoveryInsight, reductionOpportunity, refs, period),
  ]);

  const actions: ChatAction[] = [...focus.actions];
  if (scenario?.amount != null && scenario.amount > 0) {
    actions.push({ kind: "open-spending-impact", amount: scenario.amount, label: "Open this in Spending Impact" });
  }

  const priorityLines = [
    ...profileLines(profile),
    ...focus.lines,
    ...snapshot,
    ...matches,
    ...details.flat(),
  ];
  const requiredTailLines = [
    "",
    steeringLine(module, module === "Expense Insights" && Boolean(reductionOpportunity)),
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
