import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

/*
 * The journeys most likely to differ by engine, in Firefox and WebKit:
 * sign-in, a file upload, a financial write, navigation, and recovery from
 * rejected requests. The full suite stays on Chromium (playwright.config.ts)
 * to keep its runtime down, and a plain `npm run test:e2e` does not need these
 * two browsers installed.
 *
 * Served from the production build, not the dev server: two engines loading
 * pages that Vite compiles on first request timed out on first attempts, and
 * the build is what these browsers will actually run.
 */
const journeys = ["auth-shell", "csv-import", "expenses", "navigation-cache", "hardening-recovery"]
  .map((name) => `**/${name}.spec.ts`);

export default defineConfig({
  ...base,
  testMatch: journeys,
  // WebKit takes up to ~29s for the longest CSV journey on a CI-sized machine,
  // against Playwright's default 30s.
  timeout: 60_000,
  // With two engines on two workers, WebKit occasionally needed more than the
  // default 5s for an assertion to settle (1 in 78 runs without retries, a
  // different journey each time). Not used to paper over a real wait.
  expect: { timeout: 10_000 },
  use: { ...base.use, baseURL: "http://127.0.0.1:4175" },
  webServer: {
    command: "npm run build && npx vite preview --host 127.0.0.1 --port 4175 --strictPort",
    url: "http://127.0.0.1:4175/login",
    reuseExistingServer: false,
    timeout: 240_000,
  },
  projects: [
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
