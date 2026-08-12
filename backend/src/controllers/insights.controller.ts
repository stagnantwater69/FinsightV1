import type { Request, Response } from "express";
import { z } from "zod";
import * as insightsService from "../services/insights.service";
import { AnomalyFindingFeedback, AnomalyFindingSeverity, AnomalyFindingStatus, AnomalyFindingType, RecurringPatternStatus } from "@prisma/client";
import * as findingService from "../services/anomalyDetection/finding.service";
import * as recurringService from "../services/anomalyDetection/recurring.service";
import { anomalyEvaluation } from "../services/anomalyDetection/evaluation.service";

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
  .transform((value) => new Date(`${value}T00:00:00.000Z`))
  .refine((d) => !Number.isNaN(d.getTime()), "endDate is not a real date")
  .optional();

const periodQuerySchema = z.object({
  businessProfileId: z.coerce.number().int().positive(),
  periodDays: z.coerce.number().int().positive().max(366).default(30),
  endDate: endDateSchema,
});

// Recovery is month-to-date, so there is no period to select — coverageDays
// only controls how many recent days the daily-coverage table shows.
const recoveryQuerySchema = z.object({
  businessProfileId: z.coerce.number().int().positive(),
  coverageDays: z.coerce.number().int().positive().max(31).default(14),
});

const spendingImpactQuerySchema = z.object({
  businessProfileId: z.coerce.number().int().positive(),
  plannedAmount: z.coerce.number().nonnegative(),
  periodDays: z.coerce.number().int().positive().max(366).default(30),
});

export async function expenseBehavior(req: Request, res: Response) {
  const query = periodQuerySchema.parse(req.query);
  const result = await insightsService.getExpenseBehavior(
    req.user!.id,
    query.businessProfileId,
    query.periodDays,
    query.endDate,
  );
  res.status(200).json(result);
}

export async function recoveryInsight(req: Request, res: Response) {
  const query = recoveryQuerySchema.parse(req.query);
  const result = await insightsService.getRecoveryInsight(req.user!.id, query.businessProfileId, query.coverageDays);
  res.status(200).json(result);
}

export async function spendingImpact(req: Request, res: Response) {
  const query = spendingImpactQuerySchema.parse(req.query);
  const result = await insightsService.simulateSpendingImpact(
    req.user!.id,
    query.businessProfileId,
    query.plannedAmount,
    query.periodDays
  );
  res.status(200).json(capPercentOfFunds(result));
}

const findingQuerySchema = z.object({
  businessProfileId: z.coerce.number().int().positive(),
  type: z.nativeEnum(AnomalyFindingType).optional(),
  status: z.nativeEnum(AnomalyFindingStatus).optional(),
  severity: z.nativeEnum(AnomalyFindingSeverity).optional(),
  take: z.coerce.number().int().positive().max(100).default(50),
  cursorId: z.coerce.number().int().positive().optional(),
});

const findingReviewSchema = z.object({
  status: z.enum([AnomalyFindingStatus.CONFIRMED, AnomalyFindingStatus.DISMISSED, AnomalyFindingStatus.RESOLVED]),
  feedback: z.nativeEnum(AnomalyFindingFeedback),
});

export async function findings(req: Request, res: Response) {
  const query = findingQuerySchema.parse(req.query);
  const items = await findingService.listFindings(req.user!.id, query.businessProfileId, query);
  res.status(200).json({
    items: items.map((item) => ({ ...item, score: item.score === null ? null : Number(item.score) })),
    nextCursor: items.length === query.take ? items.at(-1)!.id : null,
  });
}

export async function findingsSummary(req: Request, res: Response) {
  const query = z.object({ businessProfileId: z.coerce.number().int().positive() }).parse(req.query);
  res.status(200).json(await findingService.findingSummary(req.user!.id, query.businessProfileId));
}

export async function reviewFinding(req: Request, res: Response) {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const input = findingReviewSchema.parse(req.body);
  const item = await findingService.reviewFinding(req.user!.id, id, input);
  res.status(200).json({ ...item, score: item.score === null ? null : Number(item.score) });
}

export async function recurringPatterns(req: Request, res: Response) {
  const query = z.object({ businessProfileId: z.coerce.number().int().positive() }).parse(req.query);
  const patterns = await recurringService.listRecurringPatterns(req.user!.id, query.businessProfileId);
  res.status(200).json(patterns.map((pattern) => ({
    ...pattern,
    expectedAmount: Number(pattern.expectedAmount),
    amountTolerance: Number(pattern.amountTolerance),
    confidence: Number(pattern.confidence),
  })));
}

export async function reviewRecurringPattern(req: Request, res: Response) {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const input = z.object({ status: z.nativeEnum(RecurringPatternStatus) }).parse(req.body);
  res.status(200).json(await recurringService.reviewRecurringPattern(req.user!.id, id, input.status));
}

export async function findingsMetrics(req: Request, res: Response) {
  const query = z.object({ businessProfileId: z.coerce.number().int().positive() }).parse(req.query);
  res.status(200).json(await anomalyEvaluation(req.user!.id, query.businessProfileId));
}

// JSON has no Infinity — cap it to a clearly-synthetic large number the
// client can special-case, rather than silently losing the value to null.
export function capPercentOfFunds<T extends { percentOfFunds: number }>(result: T): T {
  return { ...result, percentOfFunds: Number.isFinite(result.percentOfFunds) ? result.percentOfFunds : 999999 };
}
