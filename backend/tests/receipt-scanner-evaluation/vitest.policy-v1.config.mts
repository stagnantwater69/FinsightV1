import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/receipt-scanner-evaluation/policy-v1-*.test.ts"],
    testTimeout: 30_000,
  },
});
