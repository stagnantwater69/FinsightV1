/*
 * Shared by Expense insight's preview panels and their "See all" pages. The
 * same params and cache scope on both sides is what lets a full page open on
 * the answer the preview already fetched.
 */

import { api } from "../../lib/api";

/** How many rows each preview panel shows before linking to its page. */
export const FINDINGS_PREVIEW_COUNT = 3;
export const SCHEDULES_PREVIEW_COUNT = 5;
export const CANDIDATES_PREVIEW_COUNT = 4;

export const EXPENSE_FINDINGS_PATH = "/insights/expense-behavior/findings";
export const EXPENSE_RECURRING_PATH = "/insights/expense-behavior/recurring";

/**
 * Open findings, as the Expense insight panel reads them. The full page asks
 * with the same params and scope, so it opens on the cached answer.
 */
export function openFindingsRequest(businessProfileId: number) {
  return {
    url: "/insights/findings",
    params: { businessProfileId, status: "OPEN", take: 20 },
    scope: {
      businessProfileId,
      filters: { status: "OPEN" },
      pagination: { cursor: null, limit: 20 },
      tags: ["insights-findings", "financial"],
    },
  };
}

export function recurringPatternsRequest(businessProfileId: number) {
  return {
    url: "/insights/recurring-patterns",
    params: { businessProfileId },
    scope: { businessProfileId, tags: ["recurring-patterns", "financial"] },
  };
}

export function recurringSchedulesRequest(businessProfileId: number) {
  return {
    url: "/insights/recurring-schedules",
    params: { businessProfileId },
    scope: { businessProfileId, tags: ["recurring-schedules", "financial"] },
  };
}

/**
 * Promotes a detector suggestion into an owner-owned schedule. The server does
 * both writes in one transaction and seeds the label from the suggestion.
 */
export function watchRecurringPattern(businessProfileId: number, patternId: number) {
  return api.post(`/insights/recurring-patterns/${patternId}/confirm`, undefined, {
    serverStateScope: { businessProfileId },
  });
}

/** "Not recurring": an ungated endpoint, available even when schedules are off. */
export function dismissRecurringPattern(businessProfileId: number, patternId: number) {
  return api.patch(
    `/insights/recurring-patterns/${patternId}`,
    { status: "DISMISSED" },
    { serverStateScope: { businessProfileId } },
  );
}
