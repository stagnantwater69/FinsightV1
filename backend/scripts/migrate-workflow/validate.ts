// Short-term sanctioned migration-validation workflow (ticket P1A).
//
// `npm run migrate:validate` runs, in order, halting immediately on the
// first failure (no step is skipped or continued past on error):
//
//   1. create/diff  — `prisma migrate diff --from-empty --to-schema-datamodel`
//      sanity-checks that prisma/schema.prisma still compiles to valid SQL.
//      Needs no database at all.
//   2. prisma validate — schema-level correctness.
//   3. deploy to a disposable scratch database — full existing migration
//      history applied via `prisma migrate deploy`, no shadow db involved
//      (that's the step that's broken on this repo; this route avoids it).
//   4. prisma migrate status — asserted clean against the scratch database.
//   5. backend tests, serially, against `finsight_test` — a separate,
//      pre-existing container reserved for integration tests
//      (`npm run test:db:up`), untouched by the scratch database above.
//   6. tear down the scratch database.
//
// Nothing here ever reads backend/.env or touches the hosted Supabase
// project — every URL used is either --from-empty (no DB) or a freshly
// created 127.0.0.1 scratch container.

import { execFileSync, execSync } from "node:child_process";
import path from "node:path";
import { createScratchDatabase, teardownScratchDatabase, type ScratchDatabase } from "./scratchDb";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCHEMA_PATH = path.join(REPO_ROOT, "prisma", "schema.prisma");

function step(label: string, fn: () => void): void {
  console.log(`\n[migrate:validate] === ${label} ===`);
  fn();
}

function isTestDbContainerUp(): boolean {
  try {
    const out = execSync('docker ps --filter "name=^finsight-test-db$" --format "{{.Names}}"', {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    return out.trim() === "finsight-test-db";
  } catch {
    return false;
  }
}

export async function runValidationPipeline(): Promise<void> {
  step("1/6 create/diff (schema compiles to valid SQL from empty)", () => {
    execFileSync(
      "npx",
      ["prisma", "migrate", "diff", "--from-empty", "--to-schema-datamodel", SCHEMA_PATH, "--script"],
      { cwd: REPO_ROOT, stdio: "inherit" }
    );
  });

  step("2/6 prisma validate", () => {
    execFileSync("npx", ["prisma", "validate"], { cwd: REPO_ROOT, stdio: "inherit" });
  });

  let scratch: ScratchDatabase | null = null;
  try {
    step("3/6 deploy full migration history to a disposable scratch database", () => {
      // createScratchDatabase() both creates the container AND runs
      // `prisma migrate deploy` against it — this is intentionally the
      // same call used by the authoring wrapper, so both paths exercise
      // identical deploy logic.
    });
    scratch = await createScratchDatabase();

    step("4/6 prisma migrate status (against the scratch database)", () => {
      execFileSync("npx", ["prisma", "migrate", "status"], {
        cwd: REPO_ROOT,
        stdio: "inherit",
        env: { ...process.env, DATABASE_URL: scratch!.directUrl, DIRECT_URL: scratch!.directUrl },
      });
    });

    step("5/6 backend tests, serially, against finsight_test", () => {
      if (!isTestDbContainerUp()) {
        throw new Error(
          "finsight-test-db container is not running. Run `npm run test:db:up` first — " +
            "migrate:validate does not start or reuse it as scratch space (it is reserved for tests)."
        );
      }
      execFileSync("npm", ["test"], { cwd: REPO_ROOT, stdio: "inherit" });
    });
  } finally {
    if (scratch) {
      step("6/6 tear down scratch database", () => {
        teardownScratchDatabase(scratch!.containerName);
      });
    }
  }

  console.log("\n[migrate:validate] All steps passed.");
}

/* c8 ignore start -- CLI entrypoint; orchestration is exercised manually /
   via integration use, not unit tests (unit tests cover the pure pieces:
   urlSafety.ts, hostedGuard.ts). */
if (require.main === module) {
  runValidationPipeline().catch((err) => {
    console.error(`\n[migrate:validate] FAILED: ${(err as Error).message}`);
    process.exit(1);
  });
}
/* c8 ignore stop */
