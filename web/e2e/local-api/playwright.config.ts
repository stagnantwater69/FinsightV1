import { defineConfig } from "@playwright/test";

const origin = process.env.FINSIGHT_LOCAL_BROWSER_ORIGIN;
if (!origin || new URL(origin).hostname !== "127.0.0.1") throw new Error("An owned loopback browser origin is required");

export default defineConfig({
  testDir: ".",
  testMatch: "journeys.spec.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 45_000,
  outputDir: process.env.FINSIGHT_LOCAL_BROWSER_OUTPUT,
  reporter: [["list"], ["json", { outputFile: process.env.FINSIGHT_LOCAL_BROWSER_RESULTS }]],
  use: { baseURL: origin, viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure",
    serviceWorkers: "block", ...(process.env.FINSIGHT_LOCAL_BROWSER_CHANNEL ? { channel: process.env.FINSIGHT_LOCAL_BROWSER_CHANNEL } : {}) },
});
