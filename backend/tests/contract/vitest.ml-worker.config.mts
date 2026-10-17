import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: { FINSIGHT_REQUIRE_ML_WORKER_CONTRACT: "1" },
    include: ["tests/contract/mlWorkerContract.test.ts"],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 25_000,
  },
});
