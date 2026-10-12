import type { AvailableFundsCalculation, MonthlyExpenseBasis } from "./types";
import { formatMoney } from "./money";
import { formatMonthLabel, shiftMonthKey } from "./monthEndReview";

/** Formats a date-only API value without shifting it through the device timezone. */
export function formatFinancialDate(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-PH", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** The latest month the API can accept as complete, based on its business-local as-of date. */
export function latestCompletableMonth(asOfDate: string): string {
  const currentMonth = /^\d{4}-\d{2}-\d{2}$/.test(asOfDate) ? asOfDate.slice(0, 7) : "";
  return currentMonth ? shiftMonthKey(currentMonth, -1) : "";
}

/** Plain provenance for the current funds figure. Every amount comes from the server response. */
export function availableFundsProvenance(calculation: AvailableFundsCalculation): string {
  const salesLabel = calculation.confirmedSalesRecordCount === 1 ? "sale" : "sales";
  const expensesLabel = calculation.confirmedExpenseRecordCount === 1 ? "expense" : "expenses";
  return [
    `Started at ${formatMoney(calculation.baselineAmount)} on ${formatFinancialDate(calculation.baselineDate)}.`,
    `Added ${formatMoney(calculation.confirmedSalesAdded)} from ${calculation.confirmedSalesRecordCount} confirmed ${salesLabel}.`,
    `Deducted ${formatMoney(calculation.confirmedExpensesDeducted)} from ${calculation.confirmedExpenseRecordCount} confirmed ${expensesLabel}.`,
  ].join(" ");
}

/** Explains whether the current monthly figure came from the owner's estimate or complete records. */
export function monthlyExpenseBasisProvenance(basis: MonthlyExpenseBasis): string {
  if (basis.source === "previous_complete_month") {
    const recordLabel = basis.eligibleRecordCount === 1 ? "record" : "records";
    return basis.sourceMonth
      ? `Using ${basis.eligibleRecordCount} eligible expense ${recordLabel} from ${formatMonthLabel(basis.sourceMonth)}.`
      : `Using ${basis.eligibleRecordCount} eligible expense ${recordLabel} from the latest month confirmed complete.`;
  }
  return "Using your starting estimate until you confirm a complete past month of expense records.";
}
