import * as Sentry from "@sentry/node";
import { env } from "./env";
import { scrubEvent } from "../lib/errorScrub";

/*
 * Crash and server-error reports, sent to Sentry only when SENTRY_DSN is set.
 * Without it every function here is a no-op, so development and tests send
 * nothing anywhere.
 *
 * Only what is reported explicitly is sent: the default integrations are off,
 * so the SDK installs no process handlers of its own (processFaults.ts owns
 * those and decides when to exit), records no breadcrumbs and patches no
 * modules. Every event passes through lib/errorScrub before it leaves.
 */

let enabled = false;

export function startErrorReporting(service: "api" | "worker"): void {
  if (!env.SENTRY_DSN || env.NODE_ENV === "test") return;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    // Every category off. beforeSend strips these again regardless; this
    // stops them being collected in the first place.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    defaultIntegrations: false,
    integrations: [
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
      Sentry.nodeContextIntegration(),
    ],
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: () => null,
    initialScope: { tags: { service } },
  });
  enabled = true;
}

export interface ErrorContext {
  level?: "fatal" | "error" | "warning";
  requestId?: string;
  method?: string;
  /** The route pattern, e.g. /api/v1/records/expenses/:id, never a filled-in URL. */
  route?: string;
  lane?: string;
  fault?: string;
  /** A rate limiter's name, for usage reports. */
  limiter?: string;
  /** The numeric FinSight user id — never an email or any other identifier. */
  ownerId?: string;
  /**
   * Groups reports into one Sentry issue by these values rather than by stack
   * trace, so one owner's repeated cap hits read as one issue with a count.
   */
  fingerprint?: string[];
}

export function reportError(error: unknown, context: ErrorContext = {}): void {
  if (!enabled) return;
  const { level = "error", fingerprint, ...tags } = context;
  Sentry.withScope((scope) => {
    scope.setLevel(level);
    if (fingerprint) scope.setFingerprint(fingerprint);
    for (const [key, value] of Object.entries(tags)) {
      if (value !== undefined) scope.setTag(key, value);
    }
    Sentry.captureException(error);
  });
}

/** Waits for queued reports to send, so one raised just before exit is not lost. */
export async function flushErrorReporting(timeoutMs = 2000): Promise<void> {
  if (!enabled) return;
  await Sentry.flush(timeoutMs).catch(() => undefined);
}
