import { defineConfig, devices } from "@playwright/test";

/*
 * The production-build smoke suite (e2e/built). Builds with the same Vite env
 * the rest of e2e uses, then serves dist/ with `vite preview`, so lazy chunks,
 * deep-link reloads and minified code are exercised as they ship.
 */
export default defineConfig({
  testDir: "./e2e/built",
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: "http://127.0.0.1:4174", trace: "retain-on-failure" },
  webServer: {
    command: "npm run build && npx vite preview --host 127.0.0.1 --port 4174 --strictPort",
    url: "http://127.0.0.1:4174/login",
    reuseExistingServer: false,
    timeout: 240_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
