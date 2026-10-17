import type { DashboardSummary } from "../../lib/types";
import type { DashboardExpenseOverview, ExpenseOverviewPanel } from "../../lib/expenseOverview";
import { periodParams, type PeriodSelection } from "../../lib/reportingPeriod";
import { useCachedFeed, type FeedState } from "./useDashboardFeeds";

function panelState<T>(feed: FeedState<DashboardExpenseOverview>, panel: ExpenseOverviewPanel<T> | undefined) {
  if (panel) return panel.status === "available" ? "ready" : "error";
  return feed.status === "loading" ? "loading" : "error";
}

export function useDashboardOverview(businessProfileId: number | null, selection: PeriodSelection, periodReady: boolean) {
  const enabled = businessProfileId !== null && periodReady;
  const params = enabled ? { businessProfileId, ...periodParams(selection) } : null;
  const summaryFeed = useCachedFeed<DashboardSummary>(
    "/dashboard/summary", params, businessProfileId, ["dashboard", "financial"], { period: selection },
  );
  const expenseEnabled = enabled && selection.kind !== "all";
  const expenseFeed = useCachedFeed<DashboardExpenseOverview>(
    "/insights/expense-overview", expenseEnabled ? { ...params, view: "dashboard" } : null,
    businessProfileId, ["dashboard", "financial", "expense-overview"], { period: selection },
  );
  const overview = expenseFeed.state.data;
  const comparisonPanel = overview?.comparison;
  const opportunityPanel = overview?.topOpportunity;
  const top = opportunityPanel?.status === "available" ? opportunityPanel.data : null;
  const hasUsableDetails = comparisonPanel?.status === "available" || opportunityPanel?.status === "available";

  return {
    summary: summaryFeed.state.data,
    overviewUpdatedAt: summaryFeed.updatedAt,
    loading: businessProfileId !== null && summaryFeed.state.status === "loading",
    error: summaryFeed.error,
    reload: summaryFeed.reload,
    comparison: comparisonPanel?.status === "available" ? comparisonPanel.data : null,
    comparisonState: expenseEnabled ? panelState(expenseFeed.state, comparisonPanel) : "ready",
    topOpportunity: top && top.confidence !== "limited" ? top : null,
    opportunityState: expenseEnabled ? panelState(expenseFeed.state, opportunityPanel) : "ready",
    overviewRefreshError: expenseFeed.state.status === "error" && hasUsableDetails ? expenseFeed.error : null,
    reloadExpenseOverview: expenseFeed.reload,
  };
}
