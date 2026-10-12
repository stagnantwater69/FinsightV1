import type { ChatPageKey, ChatRecordReference } from "./types";

/**
 * Where Ask FinSight's link buttons go on the web.
 *
 * The server only ever sends a page KEY or a record id it resolved itself;
 * the route is decided here, so a model can never steer the browser to a URL
 * of its own invention.
 */
export const CHAT_PAGE_ROUTES: Record<ChatPageKey, string> = {
  dashboard: "/dashboard",
  records: "/records",
  "review-queue": "/records/flagged",
  "expense-insights": "/insights/expense-behavior",
  recovery: "/insights/recovery",
  "spending-impact": "/insights/spending-impact",
  categories: "/records/categories",
  "add-expense": "/records/expenses/new",
  "add-sales": "/records/sales/new",
  "scan-receipt": "/records/receipts/new",
};

/**
 * Expenses open on the Records list with the row highlighted — the same
 * `highlightRecordId` link a notification uses. Sales have no highlight on
 * that list, so they open their own edit screen.
 */
export function recordHref(reference: ChatRecordReference): string {
  return reference.recordType === "expense"
    ? `/records?highlightRecordId=${reference.id}`
    : `/records/sales/${reference.id}/edit`;
}
