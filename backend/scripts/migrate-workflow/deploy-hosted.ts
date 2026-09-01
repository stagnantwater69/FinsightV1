// Hosted-deployment guard CLI.
//
// This is the ONLY path in this workflow that is allowed to ever run a
// migration command against a hosted target, and only once every friction
// check in hostedGuard.ts passes. Per ticket P1A this command is
// implemented and unit-tested (via hostedGuard.ts, using mocked/synthetic
// connection strings only) but is never exercised against a real hosted
// target as part of this ticket — actually running it against the live
// Supabase project remains a separate, explicit, human-gated action.
//
// Deliberately does NOT call dotenv/config on backend/.env. The hosted
// DIRECT_URL must already be present in the process environment (e.g.
// injected by a real CI deployment job's secrets, or explicitly exported by
// a human operator who has reviewed what they're doing) — this script never
// reaches into backend/.env on its own.

import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  ConnectionUrlError,
  formatSanitizedTarget,
  parseConnectionUrl,
  sanitizeTarget,
} from "./urlSafety";
import { evaluateHostedDeployment, neverPersistConfirmation } from "./hostedGuard";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

interface CliArgs {
  environment?: string;
  projectRef?: string;
  confirmProject?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token?.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        args.set(key, value);
        i++;
      }
    }
  }
  return {
    environment: args.get("environment"),
    projectRef: args.get("project-ref"),
    confirmProject: args.get("confirm-project"),
  };
}

function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

export function main(argv: string[]): number {
  const parsed = parseArgs(argv);
  const rawUrl = process.env.DIRECT_URL;

  // Show the sanitized target as early as possible, independent of whether
  // the confirmation flags end up matching, so the operator always sees
  // what they'd be pointing at before the pass/fail verdict is printed.
  if (rawUrl) {
    try {
      const target = sanitizeTarget(parsed.environment ?? "(unset)", parseConnectionUrl(rawUrl));
      console.log(`[migrate:deploy-hosted] target: ${formatSanitizedTarget(target)}`);
    } catch (err) {
      const message = err instanceof ConnectionUrlError ? err.message : (err as Error).message;
      console.log(`[migrate:deploy-hosted] target: <could not parse DIRECT_URL: ${message}>`);
    }
  } else {
    console.log("[migrate:deploy-hosted] target: <DIRECT_URL not set>");
  }

  const verdict = evaluateHostedDeployment({
    environment: parsed.environment,
    projectRef: parsed.projectRef,
    confirmProject: parsed.confirmProject,
    rawUrl,
    ciDeployApproved: process.env.FINSIGHT_CI_DEPLOY_APPROVED === "1",
    isInteractive: isInteractive(),
  });

  neverPersistConfirmation();

  if (!verdict.allowed) {
    console.error(`[migrate:deploy-hosted] REFUSED: ${verdict.reason}`);
    return 1;
  }

  console.log(`[migrate:deploy-hosted] Confirmed target: ${formatSanitizedTarget(verdict.target)}`);
  console.log("[migrate:deploy-hosted] Running prisma migrate deploy against the confirmed hosted target...");

  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: process.env,
  });

  return 0;
}

/* c8 ignore start -- CLI entrypoint; the guard logic it calls is unit tested
   directly in hostedGuard.test.ts against mocked/synthetic URLs. This file
   is intentionally never executed against a real hosted target by any
   automated test or by this ticket's own work. */
if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
/* c8 ignore stop */
