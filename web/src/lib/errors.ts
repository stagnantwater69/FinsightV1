import { isAxiosError } from "axios";

export function getErrorMessage(err: unknown): string {
  if (isAxiosError(err)) {
    const data = err.response?.data as { error?: string } | undefined;
    if (data?.error) return data.error;
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong. Please try again.";
}

/**
 * The per-field messages a rejected request came back with.
 *
 * The API answers a failed `zod` parse with
 * `{ error: "Validation failed", details: flatten() }`, where `flatten()`
 * gives `{ formErrors, fieldErrors }`. Both clients were throwing that away
 * and showing one sentence — "Please check the highlighted fields and try
 * again" — while highlighting nothing, which sends the owner looking for a
 * marker the screen never drew.
 *
 * Returns `{}` for anything that is not a field-level rejection, so a caller
 * can always spread it without asking what kind of failure it had.
 */
export function getFieldErrors(err: unknown): Record<string, string> {
  if (!isAxiosError(err)) return {};
  const details = (err.response?.data as { details?: { fieldErrors?: Record<string, string[]> } } | undefined)
    ?.details;
  if (!details?.fieldErrors) return {};

  const out: Record<string, string> = {};
  for (const [field, messages] of Object.entries(details.fieldErrors)) {
    // The first message only. zod can report several for one field and
    // stacking them under an input turns a correction into a reading task.
    const first = messages?.[0];
    if (typeof first === "string" && first) out[field] = first;
  }
  return out;
}
