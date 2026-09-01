// Migration-authoring wrapper (local mode only).
//
// `prisma migrate dev` is broken on this repo: shadow-database replay fails
// on the RLS-enabling statement in migration
// 20260806153854_secure_application_tables_from_data_api (see
// docs/SECURITY.md / the P1A ticket). This wrapper works around the broken
// shadow-db step by diffing a disposable scratch database (which has the
// real migration history applied via `prisma migrate deploy`, no shadow db
// involved) against prisma/schema.prisma, and writing the result into a new
// timestamped migration directory following this repo's existing
// `prisma/migrations/<timestamp>_<name>/migration.sql` convention.
//
// Local-mode only. Never loads backend/.env. Always targets a disposable
// scratch database unless the caller passes --target-url pointing at
// something on the local allowlist (defined in urlSafety.ts).

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ConnectionUrlError,
  formatSanitizedTarget,
  isLocalAllowedHost,
  parseConnectionUrl,
  sanitizeTarget,
} from "./urlSafety";
import { createScratchDatabase, teardownScratchDatabase, type ScratchDatabase } from "./scratchDb";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCHEMA_PATH = path.join(REPO_ROOT, "prisma", "schema.prisma");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "prisma", "migrations");

export interface AuthorArgs {
  environment: string;
  name: string;
  /** Explicit override target — must still pass the local allowlist. */
  targetUrl?: string;
  keepScratch: boolean;
}

export function parseAuthorArgs(argv: string[]): AuthorArgs {
  const args = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--keep-scratch") {
      flags.add("keep-scratch");
      continue;
    }
    if (token?.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Flag --${key} requires a value.`);
      }
      args.set(key, value);
      i++;
    }
  }

  const environment = args.get("environment");
  if (!environment) {
    throw new Error("Missing required --environment <name> (e.g. --environment local).");
  }

  return {
    environment,
    name: args.get("name") ?? "unnamed_change",
    targetUrl: args.get("target-url"),
    keepScratch: flags.has("keep-scratch"),
  };
}

function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

function sanitizeMigrationName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unnamed_change";
}

/** Enforces the local-mode allowlist on whatever URL will actually be used. */
export function assertLocalTarget(environment: string, rawUrl: string): void {
  const parsed = parseConnectionUrl(rawUrl);
  if (!isLocalAllowedHost(parsed.host)) {
    const target = sanitizeTarget(environment, parsed);
    throw new Error(
      `Refusing to run migration-authoring in local mode against ${formatSanitizedTarget(target)} — ` +
        "host is not on the local allowlist (localhost, 127.0.0.1, ::1, host.docker.internal, finsight-test-db). " +
        "The migration-authoring wrapper never targets a hosted database; use the separate, guarded " +
        "hosted-deployment command for that, with explicit human confirmation."
    );
  }
}

export async function runAuthorWorkflow(argsInput: string[]): Promise<{ migrationDir: string | null }> {
  const args = parseAuthorArgs(argsInput);

  let scratch: ScratchDatabase | null = null;
  let sourceUrl: string;

  if (args.targetUrl) {
    assertLocalTarget(args.environment, args.targetUrl);
    sourceUrl = args.targetUrl;
  } else {
    console.log(`[migrate:author:${args.environment}] Spinning up disposable scratch database...`);
    scratch = await createScratchDatabase();
    assertLocalTarget(args.environment, scratch.directUrl);
    sourceUrl = scratch.directUrl;
  }

  const sourceParsed = parseConnectionUrl(sourceUrl);
  const sourceSanitized = sanitizeTarget(args.environment, sourceParsed);
  console.log(`[migrate:author] source: ${formatSanitizedTarget(sourceSanitized)}`);
  console.log(`[migrate:author] target: prisma/schema.prisma`);

  try {
    let diffSql: string;
    try {
      diffSql = execFileSync(
        "npx",
        [
          "prisma",
          "migrate",
          "diff",
          "--from-url",
          sourceUrl,
          "--to-schema-datamodel",
          SCHEMA_PATH,
          "--script",
        ],
        { cwd: REPO_ROOT, encoding: "utf8" }
      );
    } catch (err) {
      throw new Error(`prisma migrate diff failed: ${(err as Error).message}`);
    }

    const trimmed = diffSql.trim();
    const isEmptyDiff =
      trimmed === "" || /-- This is an empty migration\./i.test(trimmed) || !/\S/.test(trimmed.replace(/^--.*$/gm, ""));

    if (isEmptyDiff) {
      console.log("[migrate:author] No schema drift detected — schema.prisma already matches the applied migration history. Nothing written.");
      return { migrationDir: null };
    }

    const dirName = `${timestamp()}_${sanitizeMigrationName(args.name)}`;
    const migrationDir = path.join(MIGRATIONS_DIR, dirName);
    mkdirSync(migrationDir, { recursive: true });
    writeFileSync(path.join(migrationDir, "migration.sql"), diffSql, "utf8");

    console.log(`[migrate:author] Wrote ${path.relative(REPO_ROOT, migrationDir)}/migration.sql`);
    console.log(
      "[migrate:author] Review this SQL by hand before committing — it was generated against a " +
        "disposable scratch database, not the historical shadow-db replay path."
    );

    return { migrationDir };
  } finally {
    if (scratch && !args.keepScratch) {
      console.log(`[migrate:author] Tearing down scratch database ${scratch.containerName}...`);
      teardownScratchDatabase(scratch.containerName);
    } else if (scratch) {
      console.log(
        `[migrate:author] --keep-scratch set: leaving ${scratch.containerName} running on port ${scratch.port}. ` +
          `Tear it down manually with: docker rm -f ${scratch.containerName}`
      );
    }
  }
}

/* c8 ignore start -- CLI entrypoint, exercised manually / in integration use, not unit tests */
if (require.main === module) {
  runAuthorWorkflow(process.argv.slice(2))
    .then(({ migrationDir }) => {
      process.exit(migrationDir ? 0 : 0);
    })
    .catch((err) => {
      const message = err instanceof ConnectionUrlError ? err.message : (err as Error).message;
      console.error(`[migrate:author] FAILED: ${message}`);
      process.exit(1);
    });
}
/* c8 ignore stop */
