import type { Request, Response } from "express";
import { z } from "zod";
import * as insightsService from "../services/insights.service";
import * as expenseOverviewService from "../services/expenseOverview.service";
import { AnomalyFindingFeedback, AnomalyFindingSeverity, AnomalyFindingStatus, AnomalyFindingType, RecurringPatternStatus } from "@prisma/client";
import * as findingService from "../services/anomalyDetection/finding.service";
import * as recurringService from "../services/anomalyDetection/recurring.service";
import * as recurringScheduleService from "../services/recurringSchedule.service";
import { moneyAmountSchema, nonnegativeMoneyAmountSchema } from "../lib/money";
import { MONTH_KEY_PATTERN, periodQueryFields, selectionFromQuery, type PeriodSelection } from "../lib/reportingPeriod";
import { anomalyEvaluation } from "../services/anomalyDetection/evaluation.service";
import { plainFindingReasons } from "../lib/findingReasons";
import {
  getReductionOpportunities,
  simulateReductionOpportunity,
  recordReductionOpportunityFeedback,
} from "../services/reductionOpportunity.service";

/**
 * The day a window ends on, as `YYYY-MM-DD`.
 *
 * Optional everywhere — omitted means today, which is what every window did
 * before. It exists so a client can ask for "the 30 days ending 31 Jul 2025"
 * when a business's records stop there, instead of being told it has no
 * expenses because the only window on offer ends today.
 *
 * Parsed as UTC midnight to match the date-only columns it is compared against;
 * `new Date("2025-07-31")` already does that, and the regex is what stops a
 * datetime or a local-format string sneaking in and shifting the window by a
 * day.
 */
const endDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "endDate must be YYYY-MM-DD")
  .date("endDate is not a real date")
  .transform((value) => new Date(`${value}T00:00:00.000Z`))
  .optional();

const periodQuerySchema = z.object({
  businessProfileId: z.coerce.number().int().positive().max(2147483647),
  periodDays: z.coerce.number().int().positive().max(366).default(30),
  endDate: endDateSchema,
  /** This week, a calendar month, or all time. Wins over `periodDays`/`endDate` when sent. */
  ...periodQueryFields,
});

const expenseOverviewQuerySchema = periodQuerySchema.extend({
  view: z.enum(["dashboard", "detail"]),
});

/** The period filter's selection when one was sent; the legacy `periodDays` number otherwise. */
function periodFrom(query: z.infer<typeof periodQuerySchema>): number | PeriodSelection {
  return query.period ? selectionFromQuery(query) : query.periodDays;
}

function setExpenseOverviewServerTiming(
  res: Response,
  timings: expenseOverviewService.ExpenseOverviewTimings,
): void {
  const phases: [string, number][] = [
    ["total", timings.totalMs],
    ["ownership", timings.ownershipMs],
    ["expense-behavior", timings.expenseBehaviorMs],
    ["reduction-opportunities", timings.reductionOpportunitiesMs],
  ];
  res.setHeader(
    "Server-Timing",
    phases
      .filter(([, duration]) => Number.isFinite(duration))
      .map(([name, duration]) => `${name};dur=${Math.max(0, duration).toFixed(1)}`)
      .join(", "),
  );
}

const recoveryQuerySchema = z.object({
  businessProfileId: z.coerce.number().int().positive().max(2147483647),
  coverageDays: z.coerce.number().int().positive().max(31).default(14),
  period: z.enum(["week", "month"]).optional(),
  month: z.string().regex(MONTH_KEY_PATTERN, "month must be YYYY-MM").optional(),
}).superRefine((query, ctx) => {
  if (query.period === "month" && !query.month) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["month"],
      message: "month is required when period is month",
    });
  }
  if (query.period !== "month" && query.month) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["month"],
      message: "month is only valid when period is month",
    });
  }
});

const monthEndReviewQuerySchema = z.object({
  businessProfileId: z.coerce.number().int().positive().max(2147483647),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM"),
});

const spendingImpactQuerySchema = z.object({
  businessProfileId: z.coerce.number().int().positive().max(2147483647),
  plannedAmount: z.coerce.number().pipe(nonnegativeMoneyAmountSchema),
  periodDays: z.coerce.number().int().positive().max(366).default(30),
  ...periodQueryFields,
});

export async function expenseOverview(req: Request, res: Response) {
  const query = expenseOverviewQuerySchema.parse(req.query);
  const { result, timings } = await expenseOverviewService.getExpenseOverview(
    req.user!.id,
    query.businessProfileId,
    periodFrom(query),
    query.view,
    query.endDate,
  );
  setExpenseOverviewServerTiming(res, timings);
  res.status(200).json(result);
}

export async function expenseBehavior(req: Request, res: Response) {
  const query = periodQuerySchema.parse(req.query);
  const result = await insightsService.getExpenseBehavior(
    req.user!.id,
    query.businessProfileId,
    periodFrom(query),
    query.endDate,
  );
  res.status(200).json(result);
}

export async function reductionOpportunities(req: Request, res: Response) {
  const query = periodQuerySchema.parse(req.query);
  const result = await getReductionOpportunities(
    req.user!.id,
    query.businessProfileId,
    periodFrom(query),
    query.endDate,
  );
  res.status(200).json(result);
}

// Body, not query — POST /insights/reduction-simulation (§12.2 of the plan).
// The client sends only category/period/reduction-kind/value; the server
// derives every baseline figure from the owner's own records.
const reductionSimulationBodySchema = z.object({
  businessProfileId: z.number().int().positive().max(2147483647),
  categoryId: z.number().int().positive().max(2147483647),
  periodDays: z.number().int().positive().max(366).optional(),
  endDate: endDateSchema,
  period: z.enum(["week", "month", "all"]).optional(),
  month: z.string().regex(MONTH_KEY_PATTERN, "month must be YYYY-MM").optional(),
  reduction: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("percent"), value: z.number() }),
    z.object({ kind: z.literal("amount"), value: z.number() }),
  ]),
});

export async function reductionSimulation(req: Request, res: Response) {
  const body = reductionSimulationBodySchema.parse(req.body);
  // One of the two ways of naming a period is required; the service owns the
  // arithmetic for both.
  if (!body.period && body.periodDays === undefined) {
    throw new z.ZodError([{ code: "custom", path: ["periodDays"], message: "periodDays or period is required" }]);
  }
  const { period, month, ...rest } = body;
  const result = await simulateReductionOpportunity(req.user!.id, {
    ...rest,
    ...(period ? { period: selectionFromQuery({ period, month }) } : {}),
  });
  res.status(200).json(result);
}

// Body, not query — POST /insights/reduction-opportunities/feedback (§15 Phase
// 5). A lightweight "was this useful?" signal on a card that is itself
// computed-not-persisted; only the feedback row is written.
const reductionOpportunityFeedbackBodySchema = z.object({
  businessProfileId: z.number().int().positive().max(2147483647),
  opportunityId: z.string().min(1),
  rating: z.enum(["helpful", "not_relevant"]),
});

export async function reductionOpportunityFeedback(req: Request, res: Response) {
  const body = reductionOpportunityFeedbackBodySchema.parse(req.body);
  const result = await recordReductionOpportunityFeedback(
    req.user!.id,
    body.businessProfileId,
    body.opportunityId,
    body.rating,
  );
  res.status(200).json(result);
}

// Body, not query — POST /insights/recovery-scenario, matching the same
// sibling-simulation convention as POST /insights/reduction-simulation
// (§12.2/§13.2): a hypothetical, non-persisting "what if expected monthly
// expenses were X" scenario, not a data query, so it takes the single scalar
// input in a request body rather than as a query-string parameter.
const recoveryScenarioBodySchema = z.object({
  businessProfileId: z.number().int().positive().max(2147483647),
  assumedExpectedMonthlyExpenses: z.number(),
});

export async function recoveryScenario(req: Request, res: Response) {
  const body = recoveryScenarioBodySchema.parse(req.body);
  const result = await insightsService.simulateRecoveryScenario(
    req.user!.id,
    body.businessProfileId,
    body.assumedExpectedMonthlyExpenses,
  );
  res.status(200).json(result);
}

export async function recoveryInsight(req: Request, res: Response) {
  const query = recoveryQuerySchema.parse(req.query);
  const period = query.period === "week"
    ? ({ kind: "week" } as const)
    : query.period === "month"
      ? ({ kind: "month", month: query.month! } as const)
      : undefined;
  const result = await insightsService.getRecoveryInsight(
    req.user!.id,
    query.businessProfileId,
    query.coverageDays,
    period,
  );
  res.status(200).json(result);
}

export async function monthEndReview(req: Request, res: Response) {
  const query = monthEndReviewQuerySchema.parse(req.query);
  const result = await insightsService.getMonthEndReview(req.user!.id, query.businessProfileId, query.month);
  res.status(200).json(result);
}

export async function spendingImpact(req: Request, res: Response) {
  const query = spendingImpactQuerySchema.parse(req.query);
  const result = await insightsService.simulateSpendingImpact(
    req.user!.id,
    query.businessProfileId,
    query.plannedAmount,
    query.period ? selectionFromQuery(query) : query.periodDays
  );
  res.status(200).json(capPercentOfFunds(result));
}

const findingQuerySchema = z.object({
  businessProfileId: z.coerce.number().int().positive().max(2147483647),
  type: z.nativeEnum(AnomalyFindingType).optional(),
  status: z.nativeEnum(AnomalyFindingStatus).optional(),
  severity: z.nativeEnum(AnomalyFindingSeverity).optional(),
  take: z.coerce.number().int().positive().max(100).default(50),
  cursorId: z.coerce.number().int().positive().max(2147483647).optional(),
});

const findingReviewSchema = z.object({
  status: z.enum([AnomalyFindingStatus.CONFIRMED, AnomalyFindingStatus.DISMISSED, AnomalyFindingStatus.RESOLVED]),
  feedback: z.nativeEnum(AnomalyFindingFeedback),
});

export async function findings(req: Request, res: Response) {
  const query = findingQuerySchema.parse(req.query);
  const items = await findingService.listFindings(req.user!.id, query.businessProfileId, query);
  res.status(200).json({
    // Reasons are translated out of detector shorthand ("Detected by iqr") on
    // the way out; the stored rows keep the detector's wording for audit.
    items: items.map((item) => ({
      ...item,
      score: item.score === null ? null : Number(item.score),
      reasons: plainFindingReasons(item.reasons),
    })),
    nextCursor: items.length === query.take ? items.at(-1)!.id : null,
  });
}

export async function findingsSummary(req: Request, res: Response) {
  const query = z.object({ businessProfileId: z.coerce.number().int().positive().max(2147483647) }).parse(req.query);
  res.status(200).json(await findingService.findingSummary(req.user!.id, query.businessProfileId));
}

export async function reviewFinding(req: Request, res: Response) {
  const id = z.coerce.number().int().positive().max(2147483647).parse(req.params.id);
  const input = findingReviewSchema.parse(req.body);
  const item = await findingService.reviewFinding(req.user!.id, id, input);
  res.status(200).json({ ...item, score: item.score === null ? null : Number(item.score), reasons: plainFindingReasons(item.reasons) });
}

export async function recurringPatterns(req: Request, res: Response) {
  const query = z.object({ businessProfileId: z.coerce.number().int().positive().max(2147483647) }).parse(req.query);
  const patterns = await recurringService.listRecurringPatterns(req.user!.id, query.businessProfileId);
  res.status(200).json(patterns.map((pattern) => ({
    ...pattern,
    expectedAmount: Number(pattern.expectedAmount),
    amountTolerance: Number(pattern.amountTolerance),
    confidence: Number(pattern.confidence),
  })));
}

/*
 * Narrowed from `z.nativeEnum(RecurringPatternStatus)`, the way findingReviewSchema
 * above narrows its status: the enum also carries CANDIDATE (the detector's own
 * starting state, not a review outcome) and DISABLED, which NO code in
 * backend/src reads or writes. Accepting either let a client park a pattern in a
 * state nothing would ever act on again. Pausing is `isActive` on the schedule.
 */
const recurringPatternReviewSchema = z.object({
  status: z.enum([RecurringPatternStatus.CONFIRMED, RecurringPatternStatus.DISMISSED]),
});

export async function reviewRecurringPattern(req: Request, res: Response) {
  const id = z.coerce.number().int().positive().max(2147483647).parse(req.params.id);
  const input = recurringPatternReviewSchema.parse(req.body);
  const pattern = await recurringService.reviewRecurringPattern(req.user!.id, id, input.status);
  // Coerced for the same reason the list above is: returned raw, the three
  // Decimal columns serialize as `{ s, e, d }` objects, so the row this hands
  // back has a different shape from the row the list handed out.
  res.status(200).json({
    ...pattern,
    expectedAmount: Number(pattern.expectedAmount),
    amountTolerance: Number(pattern.amountTolerance),
    confidence: Number(pattern.confidence),
  });
}

/*
 * EXPORTED for the contract tests — the clients' `maxLength` on the label box is
 * checked against this rule rather than against a copy of it. See
 * expenseRecord.controller.ts for the full reasoning.
 */
export const createRecurringScheduleSchema = z.object({
  businessProfileId: z.number().int().positive().max(2147483647),
  categoryId: z.number().int().positive().max(2147483647),
  label: z.string().min(1).max(255),
  vendor: z.string().max(150).optional(),
  // Bounded at a year: FinSight watches payments an owner can forget within a
  // cycle, and a schedule longer than annual would raise its first finding
  // after the business's own planning horizon.
  intervalDays: z.number().int().positive().max(366),
  expectedAmount: moneyAmountSchema,
  // 0..1 mirrors the column's CHECK — a tolerance is a fraction of the amount.
  amountTolerance: z.number().min(0).max(1).optional(),
  nextDueDate: z.string().date(),
  isActive: z.boolean().optional(),
});

const updateRecurringScheduleSchema = z.object({
  categoryId: z.number().int().positive().max(2147483647).optional(),
  label: z.string().min(1).max(255).optional(),
  vendor: z.string().max(150).nullable().optional(),
  intervalDays: z.number().int().positive().max(366).optional(),
  expectedAmount: moneyAmountSchema.optional(),
  amountTolerance: z.number().min(0).max(1).optional(),
  nextDueDate: z.string().date().optional(),
  isActive: z.boolean().optional(),
});

export async function recurringSchedules(req: Request, res: Response) {
  const query = z.object({ businessProfileId: z.coerce.number().int().positive().max(2147483647) }).parse(req.query);
  res.status(200).json(await recurringScheduleService.listRecurringSchedules(req.user!.id, query.businessProfileId));
}

export async function createRecurringSchedule(req: Request, res: Response) {
  const input = createRecurringScheduleSchema.parse(req.body);
  res.status(201).json(await recurringScheduleService.createRecurringSchedule(req.user!.id, input));
}

export async function updateRecurringSchedule(req: Request, res: Response) {
  const id = z.coerce.number().int().positive().max(2147483647).parse(req.params.id);
  const input = updateRecurringScheduleSchema.parse(req.body);
  res.status(200).json(await recurringScheduleService.updateRecurringSchedule(req.user!.id, id, input));
}

export async function deleteRecurringSchedule(req: Request, res: Response) {
  const id = z.coerce.number().int().positive().max(2147483647).parse(req.params.id);
  await recurringScheduleService.deleteRecurringSchedule(req.user!.id, id);
  res.status(204).send();
}

export async function confirmRecurringPattern(req: Request, res: Response) {
  const id = z.coerce.number().int().positive().max(2147483647).parse(req.params.id);
  res.status(201).json(await recurringScheduleService.confirmRecurringPattern(req.user!.id, id));
}

export async function findingsMetrics(req: Request, res: Response) {
  const query = z.object({ businessProfileId: z.coerce.number().int().positive().max(2147483647) }).parse(req.query);
  res.status(200).json(await anomalyEvaluation(req.user!.id, query.businessProfileId));
}

// JSON has no Infinity — cap it to a clearly-synthetic large number the
// client can special-case, rather than silently losing the value to null.
export function capPercentOfFunds<T extends { percentOfFunds: number }>(result: T): T {
  return { ...result, percentOfFunds: Number.isFinite(result.percentOfFunds) ? result.percentOfFunds : 999999 };
}
