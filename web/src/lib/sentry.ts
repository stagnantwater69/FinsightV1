import * as Sentry from "@sentry/browser";
import { scrubEvent } from "./errorScrub";

/*
 * Loaded only through lib/errorReporting.ts, and only when VITE_SENTRY_DSN is
 * set, so a build without a DSN never downloads the SDK.
 */

export function start(dsn: string): void {
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: () => null,
  });
}

export function capture(error: unknown, tags: Record<string, string>): void {
  Sentry.withScope((scope) => {
    for (const [key, value] of Object.entries(tags)) scope.setTag(key, value);
    Sentry.captureException(error);
  });
}
