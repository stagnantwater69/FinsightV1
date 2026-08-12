import type { Request } from "express";
import { logger } from "../config/logger";

/**
 * The one place authentication and account-lifecycle events are recorded.
 *
 * WHY A SEPARATE HELPER rather than calling `logger.info` at each site. Two
 * things have to be true of these records and neither survives being
 * hand-rolled twenty times:
 *
 *   1. THE SHAPE MUST BE STABLE. These lines are what an incident is
 *      reconstructed from — "was this address being sprayed, or did one owner
 *      forget their password" is answerable only if every event carries the
 *      same fields under the same names. A free-form message per call site is
 *      unqueryable.
 *   2. NO SECRETS, EVER. Passwords, access tokens and reset links must never
 *      reach a log that gets shipped, tailed in a terminal, or pasted into a
 *      ticket. Funnelling every event through one function means there is one
 *      place to audit that rule rather than one per call.
 *
 * Emails ARE recorded. They are the only identifier that connects an event to
 * a person before a session exists, and without them a spray across a hundred
 * accounts is indistinguishable from a hundred unrelated typos. They are
 * personal data, so log retention is an operational decision, not this file's.
 */
export type SecurityEvent =
  | "login.succeeded"
  | "login.failed"
  | "login.refused_status"
  | "register.started"
  | "register.rejected"
  | "register.rolled_back"
  | "register.verified"
  /**
   * A registration from a known throwaway inbox. NOT a refusal — see the note
   * on `registerSchema`. Informational, and only interesting in bulk: one a
   * month is noise, a hundred in an afternoon is account farming.
   */
  | "register.disposable_domain"
  | "verification.resent"
  | "recovery.requested"
  | "recovery.delivery_failed"
  | "password.changed"
  | "sessions.revoked"
  | "account.status_changed"
  | "account.deletion_requested"
  | "account.deletion_stage"
  | "account.deletion_completed"
  | "account.deletion_failed"
  | "ratelimit.exhausted";

interface SecurityEventDetail {
  /** The FinSight profile id, when one is known. */
  userId?: number;
  /** The address the event concerns. Normalized by the caller. */
  email?: string;
  /** Correlates with the `x-request-id` header echoed to the client. */
  requestId?: string;
  /** Client address as Express resolved it — only meaningful once trust proxy is right. */
  ip?: string;
  /** Anything event-specific: a status transition, a limiter name, a stage. */
  [key: string]: unknown;
}

/**
 * Emits one structured security event.
 *
 * Deliberately at `warn` for the failure-shaped events even though none of them
 * is an application error: they are the lines someone should be able to filter
 * to during an incident without wading through request logs.
 */
export function securityEvent(event: SecurityEvent, detail: SecurityEventDetail = {}): void {
  const failure =
    event.endsWith(".failed") ||
    event.endsWith(".rejected") ||
    event.endsWith(".exhausted") ||
    event.endsWith(".refused_status") ||
    event.endsWith(".rolled_back");
  logger[failure ? "warn" : "info"]({ securityEvent: event, ...detail }, `security: ${event}`);
}

/** Pulls the correlating fields off a request so call sites do not repeat them. */
export function requestContext(req: Request): Pick<SecurityEventDetail, "requestId" | "ip" | "userId"> {
  // `id` is attached by pino-http's genReqId (see app.ts) rather than by
  // Express, so it is read defensively instead of assumed onto the type.
  const id = (req as Request & { id?: unknown }).id;
  return {
    requestId: typeof id === "string" ? id : undefined,
    ip: req.ip,
    userId: req.user?.id,
  };
}
