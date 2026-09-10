import { isAxiosError } from "axios";

/**
 * What went wrong, in words the person reading it can act on.
 *
 * THE NO-RESPONSE BRANCH IS THE ONE THAT MATTERS. When a request never gets an
 * answer — the connection dropped, a proxy gave up, the request outran the
 * client timeout — axios raises an Error whose `message` is "Network Error" or
 * "timeout of 90000ms exceeded", and falling through to `err.message` put those
 * words in front of a shop owner as the app's own explanation.
 *
 * They are also actively misleading. A recovery request that was still being
 * rate-limit-checked against a slow database, and which the browser abandoned
 * at six seconds, reported "Network Error" on a perfectly healthy connection to
 * a server that was about to answer. The honest reading of an unanswered
 * request is "we could not reach FinSight", and the useful next step is to try
 * again — so that is what it says, for every cause, because the client cannot
 * tell them apart and the remedy is the same either way.
 *
 * A response that DID arrive still wins: the backend's own `error` string is
 * written for this audience and is more specific than anything guessable here.
 */
export function getErrorMessage(err: unknown): string {
  if (isAxiosError(err)) {
    const data = err.response?.data as { error?: string } | undefined;
    if (data?.error) return data.error;
    if (!err.response) {
      return "We couldn't reach FinSight. Check your connection and try again.";
    }
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
