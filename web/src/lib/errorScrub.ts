/*
 * What may leave the browser in an error report. A DELIBERATE COPY of
 * backend/src/lib/errorScrub.ts (the two projects share no build), minus the
 * Prisma rule that only applies server-side. See that file for the reasoning.
 *
 * The request (URL, headers), the user and breadcrumbs are dropped outright;
 * free text is redacted for emails, bearer tokens, JWTs and connection
 * strings. Recovery and confirmation codes travel in URLs, which is one more
 * reason the request goes.
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
    if (exception.value) exception.value = scrubText(exception.value);
  }
  return event;
}
