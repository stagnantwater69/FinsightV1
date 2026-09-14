import type { ReconciliationMode } from "../../lib/allocation";
import { ApiError } from "../../middleware/error.middleware";
import type { ConfirmInput, ItemisedConfirmInput, ReceiptSplit } from "./types";

/**
 * The one rule for which confirm fields may travel together. The controller
 * schema turns each issue into a validation error, and confirmReceipt turns
 * the first into a 400, so a body that reaches the books has passed it twice
 * and no financial field in it was ignored.
 */
export interface ConfirmationModeIssue {
  /** Empty for a conflict between fields, otherwise the offending field. */
  path: string[];
  message: string;
}

export const CONFIRM_MODE_MESSAGES = {
  both: "Send either splits or itemAssignments, not both",
  neither: "Send splits for a manual confirmation or itemAssignments for an itemised one",
  itemisedOnly: (field: "additionalItems" | "reconciliation") =>
    `${field} only applies to an itemised confirmation`,
} as const;

/** Presence is what decides the mode, so `splits: []` is still a manual body. */
interface ModeFields {
  splits?: unknown;
  itemAssignments?: unknown;
  additionalItems?: unknown;
  reconciliation?: unknown;
}

export function confirmationModeIssues(input: ModeFields): ConfirmationModeIssue[] {
  const manual = input.splits !== undefined;
  const itemised = input.itemAssignments !== undefined;
  const issues: ConfirmationModeIssue[] = [];

  if (manual && itemised) issues.push({ path: [], message: CONFIRM_MODE_MESSAGES.both });
  if (!manual && !itemised) issues.push({ path: [], message: CONFIRM_MODE_MESSAGES.neither });
  if (manual) {
    for (const field of ["additionalItems", "reconciliation"] as const) {
      if (input[field] !== undefined) {
        issues.push({ path: [field], message: CONFIRM_MODE_MESSAGES.itemisedOnly(field) });
      }
    }
  }
  return issues;
}

export function isConfirmInput(input: ModeFields): input is ConfirmInput {
  return confirmationModeIssues(input).length === 0;
}

export type ResolvedConfirmation =
  | { mode: "manual"; splits: ReceiptSplit[] }
  | {
      mode: "itemised";
      itemAssignments: ItemisedConfirmInput["itemAssignments"];
      additionalItems: NonNullable<ItemisedConfirmInput["additionalItems"]>;
      reconciliation: ReconciliationMode;
    };

/**
 * Names the mode the service is about to book under. Refuses the first
 * violation itself, since the service is also called directly and cannot rely
 * on the controller having run the schema.
 */
export function resolveConfirmationMode(input: ConfirmInput): ResolvedConfirmation {
  const [issue] = confirmationModeIssues(input);
  if (issue) throw new ApiError(400, issue.message);
  if (input.itemAssignments !== undefined) {
    return {
      mode: "itemised",
      itemAssignments: input.itemAssignments,
      additionalItems: input.additionalItems ?? [],
      reconciliation: input.reconciliation ?? { mode: "none" },
    };
  }
  return { mode: "manual", splits: input.splits };
}
