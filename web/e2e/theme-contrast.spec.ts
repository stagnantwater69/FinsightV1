/**
 * Text contrast (WCAG 2 AA) on the main screens in every theme, measured by
 * axe in a real browser so the theme's actual colours are what gets checked.
 * Mocked data only: it shows the screens as rendered, not every state.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { loginViaUi, mockBackendSession, mockSupabaseAuth, skipTour } from "./mocks";

// Mid-animation text is partly transparent and would read as low contrast.
test.use({ reducedMotion: "reduce" });

async function contrastViolations(page: Page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
  const { violations } = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
  return violations.flatMap((violation) => violation.nodes.map((node) => `${node.target.join(" ")}: ${node.failureSummary ?? ""}`));
}

for (const theme of ["classic", "light", "dark"] as const) {
  test(`text contrast meets WCAG AA in the ${theme} theme`, async ({ page }) => {
    await page.addInitScript((chosen) => localStorage.setItem("finsight.theme", chosen), theme);
    await skipTour(page);
    await mockSupabaseAuth(page);
    await mockBackendSession(page);
    const items = [
      { id: 1, type: "expense", businessProfileId: 10, categoryId: 100, description: "Synthetic supplier order", date: "2026-10-13T00:00:00Z", amount: 1250, source: "MANUAL_ENTRY", reviewStatus: "Reviewed", duplicateStatus: "Not Duplicate" },
      { id: 2, type: "sales", businessProfileId: 10, description: "Synthetic daily sales", date: "2026-10-12T00:00:00Z", amount: 4800, source: "MANUAL_ENTRY", reviewStatus: "Needs Review", duplicateStatus: "Not Duplicate" },
    ];
    await page.route("**/records/search**", (route) => route.fulfill({ json: { items, nextCursor: null } }));
    await page.route("**/records/flagged/count**", (route) => route.fulfill({ json: { expenses: 0, sales: 1, total: 1 } }));

    await page.goto("/login");
    await expect(page.getByRole("button", { name: /sign in|log in/i }).first()).toBeVisible();
    const found = { login: await contrastViolations(page) };

    await loginViaUi(page);
    for (const [name, path, heading] of [
      ["dashboard", "/dashboard", /./],
      ["records", "/records?dateFrom=2026-01-01", /^Records$/],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
      Object.assign(found, { [name]: await contrastViolations(page) });
    }

    expect(found).toEqual({ login: [], dashboard: [], records: [] });
  });
}
