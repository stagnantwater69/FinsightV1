/**
 * The body sent to PATCH /records/expenses/:id and PATCH /records/sales/:id.
 *
 * Built by a pure function for the same reason receiptConfirm is: a client
 * quietly sending the wrong shape is a failure mode this codebase has already
 * had once, and a function is the only part of a screen that can be tested
 * against the server's schema.
 *
 * The two record types take DIFFERENT fields, and that is the thing most
 * likely to be got wrong here. A sales record has no category and no vendor —
 * the server's sales schema does not define either — so sending them would be
 * silently discarded rather than refused, which is exactly how a bug hides.
 */

export interface ExpenseUpdatePayload {
  categoryId: number;
  date: string;
  description: string;
  /** null CLEARS a vendor. The server's expense schema takes it as nullable. */
  vendor: string | null;
  amount: number;
}

export interface SalesUpdatePayload {
  date: string;
  description: string;
  amount: number;
}

export interface RecordUpdateInput {
  date: string;
  description: string;
  amount: number;
  /** Expense only; ignored for a sales record. */
  categoryId?: number | null;
  /** Expense only; ignored for a sales record. */
  vendor?: string;
}

/** Where the edit is sent. Kept next to the payload so the two cannot disagree. */
export function recordUpdatePath(type: "expense" | "sales", id: number): string {
  return type === "expense" ? `/records/expenses/${id}` : `/records/sales/${id}`;
}

export function buildExpenseUpdatePayload(input: RecordUpdateInput): ExpenseUpdatePayload {
  if (input.categoryId == null) {
    throw new Error("An expense needs a category");
  }
  const vendor = (input.vendor ?? "").trim();
  return {
    categoryId: input.categoryId,
    date: input.date,
    description: input.description.trim(),
    // Empty becomes null rather than "": the owner clearing the field means
    // "there is no vendor", and an empty string would store one that is blank.
    vendor: vendor === "" ? null : vendor,
    amount: input.amount,
  };
}

export function buildSalesUpdatePayload(input: RecordUpdateInput): SalesUpdatePayload {
  return {
    date: input.date,
    description: input.description.trim(),
    amount: input.amount,
  };
}
