/*
 * WHAT MAY LEAVE THE SERVER IN AN ERROR REPORT.
 *
 * Error reports go to a third party (Sentry). FinSight holds owners' financial
 * records and credentials, so a report carries the error's type, its stack and
 * the request's method, route and id, and nothing the owner typed. These
 * functions enforce that on every event, whatever code produced it:
 *
 * - The request (body, headers, cookies, query string) and the user are
 *   dropped outright, never filtered field by field.
 * - Breadcrumbs are dropped: none are collected, and any that appear could
 *   carry URLs or log text.
 * - Free text (messages, exception values) is redacted for emails, bearer
 *   tokens, JWTs and connection strings.
 * - A Prisma validation error's message dumps the arguments it was called
 *   with, which are record contents. Only its first and last lines are kept:
 *   the operation and the reason.
 */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const BEARER = /\bBearer\s+\S+/gi;
const CONNECTION_STRING = /\b(?:postgres(?:ql)?|redis|mysql|mongodb(?:\+srv)?):\/\/\S+/gi;

export function scrubText(text: string): string {
  return text
    .replace(CONNECTION_STRING, "[connection-string]")
    .replace(BEARER, "Bearer [token]")
    .replace(JWT, "[token]")
    .replace(EMAIL, "[email]");
}

function scrubExceptionValue(type: string | undefined, value: string): string {
  if (type?.startsWith("PrismaClient")) {
    const lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
    const kept = lines.length > 2 ? [lines[0], lines[lines.length - 1]] : lines;
    return scrubText(kept.join(" … "));
  }
  return scrubText(value);
}

/** The slice of a Sentry event this touches; kept structural so tests need no SDK. */
export interface ScrubbableEvent {
  message?: string;
  request?: unknown;
  user?: unknown;
  breadcrumbs?: unknown;
  exception?: { values?: Array<{ type?: string; value?: string }> };
}

export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  delete event.request;
  delete event.user;
  delete event.breadcrumbs;
  if (event.message) event.message = scrubText(event.message);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubExceptionValue(exception.type, exception.value);
  }
  return event;
}
