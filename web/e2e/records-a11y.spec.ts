/**
 * WEB-F01, in the real page composition. Records mounts its own Add expense /
 * Add sales popups, so several <dialog>s share the document (AppShell used to
 * mount Quick Add's copies too). With fixed element ids the open sales popup was named
 * "Add expense" in Chromium's accessibility tree and its money-entry controls
 * had no accessible names. The unit test in src/components/Modal.a11y.test.tsx
 * covers the components in isolation; this is the same question asked of the
 * pages that actually mount them together.
 */
import { expect, test } from "@playwright/test";
import { loginViaUi, mockBackendSession, mockSupabaseAuth } from "./mocks";

test.beforeEach(async ({ page }) => {
  await mockSupabaseAuth(page);
  await mockBackendSession(page);
  await page.route("**/records/search**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], nextCursor: null }) }),
  );
  await page.route("**/records/flagged/count**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ expenses: 0, sales: 0, total: 0 }) }),
  );
  await loginViaUi(page);
});

test("Add sales on Records opens a dialog named for sales with named fields", async ({ page }) => {
  // A date filter keeps the page off its first-run empty state, which is
  // where the "+ Add sales" toolbar button lives.
  await page.goto("/records?dateFrom=2026-01-01");
  await expect(page.getByRole("heading", { name: "Records", exact: true })).toBeVisible();

  await page.getByRole("button", { name: /add sales/i }).click();

  const dialog = page.getByRole("dialog", { name: "Add sale" });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Add expense" })).toHaveCount(0);

  await expect(dialog.getByRole("textbox", { name: /description/i })).toBeVisible();
  await expect(dialog.getByRole("spinbutton", { name: /amount/i })).toBeVisible();
  await expect(dialog.getByLabel(/^date/i)).toBeVisible();

  // No element id appears twice anywhere on the page.
  const duplicates = await page.evaluate(() => {
    const ids = Array.from(document.querySelectorAll("[id]")).map((el) => el.id);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  });
  expect(duplicates).toEqual([]);
});
