import { defineConfig } from "vitest/config";
import { config as loadEnv } from "dotenv";

// Loaded at config time so source modules never fall through to backend/.env
// and accidentally connect an integration test to the hosted project.
const testEnv = loadEnv({ path: ".env.test" }).parsed ?? {};

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
