// Confirmation/friction logic for the hosted-deployment guard. Pure and
// side-effect-free: no network calls, no process.env reads, nothing that
// touches a real database. The CLI wrapper (deploy-hosted.ts) is the only
// place that may act on an ALLOW verdict, and even then, only by handing off
// to `prisma migrate deploy` — this module never runs that itself.
//
// This module is exercised only against mocked/synthetic connection strings
// in tests; it is not run against a real hosted target anywhere in this
// ticket (P1A). Actually deploying to the hosted Supabase project remains a
// separate, explicitly human-gated action per README.md.

import { ConnectionUrlError, parseConnectionUrl, sanitizeTarget, type SanitizedTarget } from "./urlSafety";

export interface HostedGuardInput {
  environment: string | undefined;
  projectRef: string | undefined;
  confirmProject: string | undefined;
  /** Raw connection string for the hosted target (never logged in full). */
  rawUrl: string | undefined;
  /** Set only by a real CI deployment job — never a developer's local shell. */
  ciDeployApproved: boolean;
  /** Whether the current process has an interactive TTY available. */
  isInteractive: boolean;
}

export type HostedGuardVerdict =
  | { allowed: true; target: SanitizedTarget }
  | { allowed: false; reason: string };

const GENERIC_CONFIRMATIONS = new Set(["yes", "y", "ok", "okay", "confirm", "true", "1"]);

/**
 * Evaluates whether a hosted deployment is authorized to proceed, WITHOUT
 * performing any network I/O. Returns a verdict; the caller decides what to
 * do with it (in this ticket, the caller must never act on `allowed: true`
 * by actually running a hosted migrate command).
 */
export function evaluateHostedDeployment(input: HostedGuardInput): HostedGuardVerdict {
  if (!input.environment || input.environment.trim() === "") {
    return { allowed: false, reason: "Missing required --environment <name>." };
  }

  if (!input.projectRef || input.projectRef.trim() === "") {
    return { allowed: false, reason: "Missing required --project-ref <ref>." };
  }

  if (!input.confirmProject || input.confirmProject.trim() === "") {
    return { allowed: false, reason: "Missing required --confirm-project <ref>." };
  }

  // Reject generic yes/y/etc even if someone tried to pass one as the ref.
  if (GENERIC_CONFIRMATIONS.has(input.confirmProject.trim().toLowerCase())) {
    return {
      allowed: false,
      reason:
        'Generic confirmations like "yes" are not accepted for --confirm-project. ' +
        "You must type the exact project ref a second time.",
    };
  }

  if (input.projectRef.trim() !== input.confirmProject.trim()) {
    return {
      allowed: false,
      reason: `--project-ref (${input.projectRef}) and --confirm-project (${input.confirmProject}) do not match.`,
    };
  }

  if (!input.isInteractive && !input.ciDeployApproved) {
    return {
      allowed: false,
      reason:
        "Refusing to run noninteractively without FINSIGHT_CI_DEPLOY_APPROVED=1. " +
        "This variable must be set only by a real CI deployment job, never a developer's local shell.",
    };
  }

  let parsed;
  try {
    parsed = parseConnectionUrl(input.rawUrl);
  } catch (err) {
    const message = err instanceof ConnectionUrlError ? err.message : "Unknown parse error.";
    return { allowed: false, reason: `Could not parse target connection string: ${message}` };
  }

  const target = sanitizeTarget(input.environment, parsed);
  return { allowed: true, target };
}

/** Never persist a hosted-deploy confirmation anywhere (no .env write, no
 *  config file, no cache). This function exists purely as a documented,
 *  greppable no-op so a future edit that tries to add persistence has to
 *  delete an explicit comment saying not to. */
export function neverPersistConfirmation(): void {
  // Intentionally does nothing. Do not add file/env writes here.
}
