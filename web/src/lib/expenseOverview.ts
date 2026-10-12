import type {
  ExpenseBehavior,
  ReductionOpportunity,
  ReductionOpportunityResponse,
} from "./types";

export type ExpenseOverviewPanel<T> =
  | { status: "available"; data: T }
  | { status: "unavailable"; data: null };

export type DashboardExpenseComparison = Pick<
  ExpenseBehavior,
  "period" | "totals" | "categoryTrends"
>;

export interface DashboardExpenseOverview {
  view: "dashboard";
  comparison: ExpenseOverviewPanel<DashboardExpenseComparison>;
  topOpportunity: ExpenseOverviewPanel<ReductionOpportunity | null>;
}

export interface DetailExpenseOverview {
  view: "detail";
  behavior: ExpenseOverviewPanel<ExpenseBehavior>;
  opportunities: ExpenseOverviewPanel<ReductionOpportunityResponse>;
}
