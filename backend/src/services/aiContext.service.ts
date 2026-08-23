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
import { utcDateKey, utcToday } from "../lib/dates";
import { getDashboardSummary } from "./dashboard.service";
import { getExpenseBehavior, getRecoveryInsight, loadRecoveryTargets, simulateSpendingImpact } from "./insights.service";
import { NOTICEABLE_BAND_FRACTION, type RecoveryTargets } from "./analysis.service";

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

function peso(n: number): string {
  return `PHP ${n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function profileLines(profile: BusinessProfile): string[] {
  return [
    "=== BUSINESS PROFILE ===",
    `Name: ${profile.name} (${profile.type})`,
    `Available business funds: ${peso(Number(profile.availableFunds))}`,
    `Expected monthly expenses: ${peso(Number(profile.expectedMonthlyExpenses))}`,
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
  loaders?: Partial<ContextLoaders>
): Promise<string[]> {
  const [behavior, recovery, flaggedExpenses, duplicateCount] = await Promise.all([
    (loaders?.behavior ?? (() => getExpenseBehavior(userId, profile.id, DEFAULT_PERIOD_DAYS)))(),
    (loaders?.recoveryTargets ?? (() => loadRecoveryTargets(profile, today)))(),
    prisma.expenseRecord.findMany({
      where: { businessProfileId: profile.id, largeExpenseFlag: true },
      orderBy: { date: "desc" },
      take: 5,
      include: { category: true },
    }),
    prisma.expenseRecord.count({ where: { businessProfileId: profile.id, duplicateStatus: "Flagged" } }),
  ]);

  const lines = ["", `=== FINANCIAL SNAPSHOT (last ${DEFAULT_PERIOD_DAYS} days) ===`];

  const totalCurrent = behavior.categoryTrends.reduce((sum, t) => sum + t.current, 0);
  const totalPrevious = behavior.categoryTrends.reduce((sum, t) => sum + t.previous, 0);

  if (behavior.categoryTrends.length === 0) {
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

  lines.push("", "Records currently carrying flags:");
  if (flaggedExpenses.length === 0 && duplicateCount === 0) {
    lines.push("- none.");
  } else {
    for (const e of flaggedExpenses) {
      lines.push(
        `- large-expense flag: "${e.description}" ${peso(Number(e.amount))} on ${utcDateKey(e.date)} (${e.category.name})`
      );
    }
    if (duplicateCount > 0) {
      lines.push(`- ${duplicateCount} expense record(s) flagged as a possible duplicate.`);
    }
  }

  lines.push(
    "",
    "Recovery status (month to date):",
    `- Daily needed target: ${peso(recovery.dailyNeededTarget)} per operating day`,
    `- Sales reference recorded this month: ${peso(recovery.salesThisMonth)} of ${peso(
      recovery.expectedMonthlyExpenses
    )} needed (${recovery.monthCoveragePercent.toFixed(1)}% covered)`,
    `- Remaining target: ${peso(recovery.remainingTarget)} across ${recovery.remainingOperatingDays} remaining operating day(s)`,
    `- Adjusted daily target from here: ${peso(recovery.adjustedDailyTarget)}`,
    `- Overall: ${recovery.onTrack ? "ON TRACK" : "BEHIND — the adjusted daily target is now above the original daily target"}`
  );

  return lines;
}

// ============================================================
// Module-specific context
// ============================================================

async function expenseInsightsLines(
  userId: number,
  profile: BusinessProfile,
  loadBehavior?: () => Promise<ExpenseBehavior>
): Promise<string[]> {
  const [behavior, findings] = await Promise.all([
    (loadBehavior ?? (() => getExpenseBehavior(userId, profile.id, DEFAULT_PERIOD_DAYS)))(),
    prisma.anomalyFinding.findMany({
      where: { businessProfileId: profile.id, status: "OPEN" },
      orderBy: [{ severity: "desc" }, { detectedAt: "desc" }],
      take: 10,
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
          `that category normally averages ${peso(u.categoryMean)} (z-score ${u.zScore.toFixed(2)})`
      );
    }
  }

  if (behavior.insufficientHistoryCategories.length > 0) {
    lines.push(
      "",
      "Categories with too few records to check for unusual spending yet: " +
        behavior.insufficientHistoryCategories
          .map((c) => `${c.categoryName} (${c.historyCount} record(s))`)
          .join(", ")
    );
  }

  lines.push("", "Open explainable findings awaiting owner review:");
  if (findings.length === 0) {
    lines.push("- none.");
  } else {
    for (const finding of findings) {
      const reasons = Array.isArray(finding.reasons) ? finding.reasons.filter((reason): reason is string => typeof reason === "string") : [];
      lines.push(`- [${finding.severity}] ${finding.title}: ${reasons.join("; ") || "No additional reason recorded."}`);
    }
    lines.push("These findings mean unusual or worth reviewing, not confirmed fraud or wrongdoing.");
  }

  return lines;
}

type RecoveryInsight = Awaited<ReturnType<typeof getRecoveryInsight>>;

async function recoveryLines(
  userId: number,
  profile: BusinessProfile,
  loadInsight?: () => Promise<RecoveryInsight>
): Promise<string[]> {
  const recovery = await (loadInsight ?? (() => getRecoveryInsight(userId, profile.id, RECOVERY_COVERAGE_DAYS)))();
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
    lines.push(`- ${d.date}: recorded ${peso(d.sales)} against ${peso(d.neededTarget)} needed — ${d.status} target`);
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
    : "more than 100% (there are no available funds recorded)";

  lines.push(
    "FinSight has already calculated this scenario. Use these exact figures — do not recalculate or round them differently:",
    `- Planned amount detected: ${peso(impact.plannedAmount)}${scenario.label ? ` (described as "${scenario.label}")` : ""}`,
    `- Available business funds before: ${peso(impact.funds.before)}`,
    `- Available business funds after: ${peso(impact.funds.after)}`,
    `- Share of available funds used: ${percentText}`,
    `- Impact band: ${impact.impactBand} (owner's threshold for High Impact is ${impact.thresholdPercent}% of available funds, i.e. ${peso(impact.thresholdAmount)})`,
    `- Recorded expenses this period before: ${peso(impact.periodExpenses.before)}`,
    `- Recorded expenses this period if this is included: ${peso(impact.periodExpenses.after)}`,
    impact.exceedsFunds
      ? "- This amount EXCEEDS the available business funds on record."
      : "- This amount stays within the available business funds on record.",
    "",
    "Describe this result in plain language. This is a what-if check that was not saved, and it does not tell the owner whether to go ahead with the purchase — do not give a verdict on whether they should buy it."
  );

  if (scenario.label) {
    lines.push(
      `You may refer to the item as "${scenario.label}". Do not claim to know a category for it unless one of the owner's real categories in the snapshot above obviously matches — you have not been given a category assignment.`
    );
  }

  return lines;
}

async function dashboardLines(userId: number, profile: BusinessProfile): Promise<string[]> {
  const summary = await getDashboardSummary(userId, profile.id, DEFAULT_PERIOD_DAYS);
  const lines = [
    "",
    `=== DASHBOARD SUMMARY (last ${summary.periodDays} days) ===`,
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
async function recordsReviewLines(profile: BusinessProfile): Promise<string[]> {
  const [findings, flaggedDuplicates, largeExpenses] = await Promise.all([
    prisma.anomalyFinding.findMany({
      where: { businessProfileId: profile.id, status: "OPEN" },
      orderBy: [{ severity: "desc" }, { detectedAt: "desc" }],
      take: 10,
      include: { expenseRecord: { select: { description: true, amount: true, date: true, vendor: true } } },
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
        ? `${record.description} — ${peso(Number(record.amount))} on ${utcDateKey(record.date)}${record.vendor ? ` (${record.vendor})` : ""}`
        : "profile-level pattern";
      const reasons = Array.isArray(finding.reasons) ? (finding.reasons as string[]).slice(0, 3).join("; ") : "";
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
  loadRecoveryInsight: () => Promise<RecoveryInsight>
): Promise<string[]>[] {
  switch (module) {
    case "Expense Insights":
      return [expenseInsightsLines(userId, profile, loadBehavior)];
    case "Recovery Target":
      return [recoveryLines(userId, profile, loadRecoveryInsight)];
    case "Spending Impact":
      return [spendingImpactLines(userId, profile, scenario!)];
    case "Records Review":
      return [recordsReviewLines(profile)];
    case "Dashboard":
    default:
      // Dashboard's own summary first so it reads as the answer to "how am I
      // doing"; the rest follow as supporting detail. Each block keeps its own
      // === SECTION === header so the model can tell which numbers came from
      // where instead of blending them.
      return [
        dashboardLines(userId, profile),
        expenseInsightsLines(userId, profile, loadBehavior),
        recoveryLines(userId, profile, loadRecoveryInsight),
        recordsReviewLines(profile),
      ];
  }
}

// The steering line is what keeps a narrow module narrow, so widening the
// Dashboard's context without widening its steering line would leave the model
// refusing to use data it was just given.
function steeringLine(module: InteractionModule): string {
  if (module === "Dashboard") {
    return (
      "The owner is currently looking at the Dashboard screen. This context also covers their expense behaviour, " +
      "recovery pace and review queue, so a question that ranges across those can be answered directly from what is above. " +
      "Do not invite questions about planned purchases — no purchase scenario has been calculated for this message."
    );
  }
  return `The owner is currently looking at the ${module} screen. Stay scoped to that unless they clearly ask about something else in this context.`;
}

export async function buildModuleContext(
  userId: number,
  profile: BusinessProfile,
  module: InteractionModule,
  question: string
): Promise<ModuleContext> {
  const today = utcToday();
  const scenario = module === "Spending Impact" ? extractScenario(question) : undefined;

  // One expense-behaviour read per message, shared by the snapshot and the
  // Expense Insights block (identical arguments, so a second read could only
  // return the same rows at more cost).
  const loadBehavior = once(() => getExpenseBehavior(userId, profile.id, DEFAULT_PERIOD_DAYS));

  // The recovery detail block already computes the snapshot's recovery targets
  // on its way to the daily-coverage table — getRecoveryInsight returns those
  // targets verbatim alongside its own figures. So when a module renders that
  // block, the snapshot reads its targets off the same result instead of
  // running loadRecoveryTargets a second time; when it doesn't, the snapshot
  // keeps doing the cheaper targets-only read on its own. The numbers are the
  // same either way — both paths anchor on the same UTC day and the same
  // profile row.
  const loadRecoveryInsight = once(() => getRecoveryInsight(userId, profile.id, RECOVERY_COVERAGE_DAYS));
  const rendersRecoveryDetail = module === "Dashboard" || module === "Recovery Target";

  const [snapshot, ...details] = await Promise.all([
    buildFinancialSnapshot(userId, profile, today, {
      behavior: loadBehavior,
      recoveryTargets: rendersRecoveryDetail ? loadRecoveryInsight : undefined,
    }),
    ...moduleDetailPromises(userId, profile, module, scenario, loadBehavior, loadRecoveryInsight),
  ]);

  const lines = [
    ...profileLines(profile),
    ...snapshot,
    ...details.flat(),
    "",
    steeringLine(module),
    `Today's date: ${utcDateKey(today)}. All amounts are Philippine pesos.`,
  ];

  return { context: lines.join("\n"), scenario };
}
