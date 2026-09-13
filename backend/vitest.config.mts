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

export default defineConfig({
  test: {
    environment: "node",
    env: testEnv,
    globalSetup: ["./tests/setup/globalSetup.ts"],
    // Integration files share and truncate one dedicated PostgreSQL database.
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
