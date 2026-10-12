import { isAxiosError } from "axios";

function retrySeconds(value: unknown): number | null {
  if (typeof value === "string" && /^\d+$/.test(value.trim())) value = Number(value.trim());
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Header timing takes precedence; the body also works when CORS hides the header. */
export function getRetryAfterSeconds(err: unknown, now = Date.now()): number | null {
  if (!isAxiosError(err) || err.response?.status !== 429) return null;
  const headers = err.response.headers;
  const header = typeof headers?.get === "function"
    ? headers.get("Retry-After")
    : Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
  const seconds = retrySeconds(header);
  if (seconds !== null) return seconds;
  if (typeof header === "string" && /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(header.trim())) {
    const deadline = Date.parse(header.trim());
    if (Number.isFinite(deadline)) return Math.max(0, Math.ceil((deadline - now) / 1000));
  }
  const data = err.response.data as { retryAfterSeconds?: unknown } | undefined;
  return typeof data?.retryAfterSeconds === "number" ? retrySeconds(data.retryAfterSeconds) : null;
}

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
    if (err.response?.status === 429) {
      const seconds = getRetryAfterSeconds(err);
      if (seconds !== null) return `Too many requests. Try again in ${seconds}s.`;
      return typeof data?.error === "string" && data.error
        ? data.error
        : "Too many requests. Please wait a moment and try again.";
    }
    if (data?.error) return data.error;
    if (!err.response) {
      return "We couldn't reach FinSight. Check your connection and try again.";
    }
    if (err.response.status >= 500) {
      return "FinSight is temporarily unavailable. Please try again in a moment.";
    }
    return "Something went wrong. Please try again.";
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

/** The API refused a transaction date for being after the business's today. */
export function isFutureDateError(err: unknown): boolean {
  if (!isAxiosError(err)) return false;
  const data = err.response?.data as { code?: string } | undefined;
  return data?.code === "FUTURE_DATE";
}
