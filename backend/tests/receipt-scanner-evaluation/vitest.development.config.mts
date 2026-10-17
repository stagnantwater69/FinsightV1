import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/receipt-scanner-evaluation/development-cohort.test.ts", "tests/receipt-scanner-evaluation/readiness-cohort.test.ts", "tests/receipt-scanner-evaluation/capture-condition-metrics.test.ts"],
  },
});
