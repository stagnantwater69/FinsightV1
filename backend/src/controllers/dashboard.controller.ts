import type { Request, Response } from "express";
import { z } from "zod";
import * as dashboardService from "../services/dashboard.service";
import { periodQueryFields, selectionFromQuery } from "../lib/reportingPeriod";

function setTotalServerTiming(res: Response, startedAt: number): void {
  const duration = performance.now() - startedAt;
  if (!Number.isFinite(duration)) return;
  res.setHeader("Server-Timing", `total;dur=${Math.max(0, duration).toFixed(1)}`);
}

const summaryQuerySchema = z.object({
  businessProfileId: z.coerce.number().int().positive().max(2147483647),
  /*
   * 0 is the "All time" setting — see ALL_TIME_PERIOD in dashboard.service.ts.
   * Kept as part of this field rather than a separate `allTime` flag so there
   * is one source of truth for what the dashboard is showing, and one value to
   * echo back in the response.
   */
  periodDays: z.coerce.number().int().min(0).max(366).default(30),
  /** This week, a calendar month, or all time. Wins over `periodDays` when sent. */
  ...periodQueryFields,
});

export async function summary(req: Request, res: Response) {
  const startedAt = performance.now();
  const query = summaryQuerySchema.parse(req.query);
  const result = await dashboardService.getDashboardSummary(
    req.user!.id,
    query.businessProfileId,
    selectionFromQuery(query),
  );
  setTotalServerTiming(res, startedAt);
  res.status(200).json(result);
}

const cashflowQuerySchema = z.object({
  businessProfileId: z.coerce.number().int().positive().max(2147483647),
  granularity: z.enum(["daily", "monthly"]).default("daily"),
});

export async function cashflow(req: Request, res: Response) {
  const startedAt = performance.now();
  const query = cashflowQuerySchema.parse(req.query);
  const result = await dashboardService.getDashboardCashflow(req.user!.id, query.businessProfileId, query.granularity);
  setTotalServerTiming(res, startedAt);
  res.status(200).json(result);
}
