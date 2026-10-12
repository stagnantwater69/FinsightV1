import { logger } from "../config/logger";
import type { PeriodSelection } from "../lib/reportingPeriod";
import {
  getExpenseBehaviorForOwnedBusiness,
  type ExpenseBehaviorResult,
} from "./insights.service";
import { requireOwnedBusinessContext } from "./ownedBusinessContext.service";
import {
  getReductionOpportunitiesForOwnedBusiness,
  type ReductionOpportunity,
  type ReductionOpportunityResponse,
} from "./reductionOpportunity.service";

export type ExpenseOverviewPanel<T> =
  | { status: "available"; data: T }
  | { status: "unavailable"; data: null };

export type DashboardExpenseComparison = Pick<
  ExpenseBehaviorResult,
  "period" | "totals" | "categoryTrends"
>;

export interface DashboardExpenseOverviewResponse {
  view: "dashboard";
  comparison: ExpenseOverviewPanel<DashboardExpenseComparison>;
  topOpportunity: ExpenseOverviewPanel<ReductionOpportunity | null>;
}

export interface ExpenseInsightOverviewResponse {
  view: "detail";
  behavior: ExpenseOverviewPanel<ExpenseBehaviorResult>;
  opportunities: ExpenseOverviewPanel<ReductionOpportunityResponse>;
}

export type ExpenseOverviewResponse =
  | DashboardExpenseOverviewResponse
  | ExpenseInsightOverviewResponse;

export interface ExpenseOverviewTimings {
  totalMs: number;
  ownershipMs: number;
  expenseBehaviorMs: number;
  reductionOpportunitiesMs: number;
}

export interface TimedExpenseOverviewResult<T extends ExpenseOverviewResponse> {
  result: T;
  timings: ExpenseOverviewTimings;
}

type SettledPanel<T> = {
  panel: ExpenseOverviewPanel<T>;
  durationMs: number;
};

async function settlePanel<T>(
  name: "expense-behavior" | "reduction-opportunities",
  promise: Promise<T>,
  startedAt: number,
): Promise<SettledPanel<T>> {
  try {
    return {
      panel: { status: "available", data: await promise },
      durationMs: performance.now() - startedAt,
    };
  } catch (error) {
    logger.warn(
      { panel: name, errorName: error instanceof Error ? error.name : "UnknownError" },
      "expense overview panel unavailable",
    );
    return {
      panel: { status: "unavailable", data: null },
      durationMs: performance.now() - startedAt,
    };
  }
}

function mapPanel<T, U>(
  settled: SettledPanel<T>,
  select: (value: T) => U,
): ExpenseOverviewPanel<U> {
  return settled.panel.status === "available"
    ? { status: "available", data: select(settled.panel.data) }
    : settled.panel;
}

function selectTopOpportunity(response: ReductionOpportunityResponse): ReductionOpportunity | null {
  if (response.dataQuality.status === "insufficient") return null;
  const top = response.opportunities[0];
  return top && top.confidence !== "limited" ? top : null;
}

export function getExpenseOverview(
  userId: number,
  businessProfileId: number,
  period: number | PeriodSelection,
  view: "dashboard",
  endDate?: Date,
): Promise<TimedExpenseOverviewResult<DashboardExpenseOverviewResponse>>;
export function getExpenseOverview(
  userId: number,
  businessProfileId: number,
  period: number | PeriodSelection,
  view: "detail",
  endDate?: Date,
): Promise<TimedExpenseOverviewResult<ExpenseInsightOverviewResponse>>;
export function getExpenseOverview(
  userId: number,
  businessProfileId: number,
  period: number | PeriodSelection,
  view: "dashboard" | "detail",
  endDate?: Date,
): Promise<TimedExpenseOverviewResult<ExpenseOverviewResponse>>;
export async function getExpenseOverview(
  userId: number,
  businessProfileId: number,
  period: number | PeriodSelection,
  view: "dashboard" | "detail",
  endDate?: Date,
): Promise<TimedExpenseOverviewResult<ExpenseOverviewResponse>> {
  const totalStartedAt = performance.now();
  const ownershipStartedAt = performance.now();
  const context = await requireOwnedBusinessContext(userId, businessProfileId);
  const ownershipMs = performance.now() - ownershipStartedAt;

  const behaviorStartedAt = performance.now();
  const behaviorPromise = getExpenseBehaviorForOwnedBusiness(context, period, endDate);
  const opportunitiesStartedAt = performance.now();
  const opportunitiesPromise = getReductionOpportunitiesForOwnedBusiness(context, period, {
    endDate,
    behavior: behaviorPromise,
  });

  const [behavior, opportunities] = await Promise.all([
    settlePanel("expense-behavior", behaviorPromise, behaviorStartedAt),
    settlePanel("reduction-opportunities", opportunitiesPromise, opportunitiesStartedAt),
  ]);
  const timings: ExpenseOverviewTimings = {
    totalMs: performance.now() - totalStartedAt,
    ownershipMs,
    expenseBehaviorMs: behavior.durationMs,
    reductionOpportunitiesMs: opportunities.durationMs,
  };

  if (view === "dashboard") {
    return {
      result: {
        view,
        comparison: mapPanel(behavior, ({ period, totals, categoryTrends }) => ({
          period,
          totals,
          categoryTrends,
        })),
        topOpportunity: mapPanel(opportunities, selectTopOpportunity),
      },
      timings,
    };
  }

  return {
    result: {
      view,
      behavior: behavior.panel,
      opportunities: opportunities.panel,
    },
    timings,
  };
}
