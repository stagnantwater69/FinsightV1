/**
 * Smoke test of the PRODUCTION build (playwright.built.config.ts serves
 * `vite build` output through `vite preview`), not the dev server the rest of
 * e2e/ uses.
 *
 * What only a built bundle can get wrong: a lazily loaded page whose chunk is
 * missing or misnamed, a deep link that 404s on reload, a module that only
 * breaks once minified, configuration that dev mode fills in by itself. The
 * network is mocked exactly as in the other specs.
 */
import { expect, test, type Page } from "@playwright/test";
import { loginViaUi, mockBackendSession, mockSupabaseAuth, skipTour } from "../mocks";

function watchBuild(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/assets/") && response.status() >= 400) {
      problems.push(`asset ${url.pathname} answered ${response.status()}`);
    }
  });
  page.on("request", (request) => {
    // The dev server's client; its presence would mean this is not the build.
    if (new URL(request.url()).pathname.startsWith("/@vite/")) problems.push(`dev-server request ${request.url()}`);
  });
  return problems;
}

test("public pages load from the built bundle", async ({ page }) => {
  const problems = watchBuild(page);
  await page.goto("/");
  await expect(page.locator("#root > *").first()).toBeVisible();
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
  expect(problems).toEqual([]);
});

test("a lazily loaded page survives a reload on its deep link, signed in", async ({ page }) => {
  const problems = watchBuild(page);
  await mockSupabaseAuth(page);
  await mockBackendSession(page);
  await skipTour(page);
  await loginViaUi(page);

  const chunks: string[] = [];
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith("/assets/") && path.endsWith(".js")) chunks.push(path);
  });
  await page.goto("/records");
  await expect(page.getByRole("heading", { name: "Records", level: 1 })).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/\/records$/);
  await expect(page.getByRole("heading", { name: "Records", level: 1 })).toBeVisible();

  // Fingerprinted, minified chunks: this really is the production bundle.
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.every((path) => /-[\w-]{8}\.js$/.test(path))).toBe(true);
  expect(problems).toEqual([]);
});
