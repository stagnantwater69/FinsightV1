import { defineConfig } from "vitest/config";
import { config as loadEnv } from "dotenv";

// Loaded at config time so source modules never fall through to backend/.env
// and accidentally connect an integration test to the hosted project.
const fileEnv = loadEnv({ path: ".env.test" }).parsed ?? {};
// An explicitly supplied test environment wins over the checked-in local
// defaults. This lets CI and isolated audit databases choose their own local
// port while preserving the hard local/finsight_test guard in globalSetup.
const testEnv = Object.fromEntries(
  Object.entries(fileEnv).map(([key, fallback]) => [key, process.env[key] ?? fallback]),
);

const shared = {
  environment: "node" as const,
  env: testEnv,
  testTimeout: 120_000,
  hookTimeout: 120_000,
};

export default defineConfig({
  test: {
    // Files in tests/integration share and truncate ONE dedicated PostgreSQL
    // database, so nothing here may run in parallel with anything else.
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    projects: [
      {
        test: {
          ...shared,
          name: "unit",
          // No globalSetup: tests/unit must run with no Postgres anywhere.
          // rateLimit.middleware.ts:38-41 states that contract explicitly
          // (the in-memory bucket stub exists so the unit suites need no
          // database), and until this split the suite contradicted it — a
          // contributor without the container got a `prisma migrate deploy`
          // crash before the first test file loaded, and skipped the gate.
          // Anything here that reaches for prisma belongs in tests/integration.
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
        test: {
          ...shared,
          name: "database",
          // Everything that needs the real migration history applied to the
          // throwaway database: integration, contract, and the performance
          // suite that seeds through prisma.
          globalSetup: ["./tests/setup/globalSetup.ts"],
          include: ["tests/**/*.test.ts"],
          exclude: ["**/node_modules/**", "tests/unit/**"],
        },
      },
    ],
  },
});
