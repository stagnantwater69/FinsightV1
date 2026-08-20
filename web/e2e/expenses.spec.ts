/**
 * Mocked-network E2E coverage for the add/edit expense flow.
 *
 * As with the other new specs in this directory, no real Supabase project or
 * FinSight backend is involved — every request the app makes is intercepted
 * with `page.route()` and answered with hand-written JSON shaped to
 * `web/src/lib/types.ts`. See mocks.ts for the shared session/context setup
 * this exercises real component logic (validation, state, routing) against.
 */
import { expect, test } from "@playwright/test";
import {
  loginViaUi,
  mockBackendSession,
  mockSupabaseAuth,
  TEST_BUSINESS_PROFILE,
  TEST_CATEGORIES,
} from "./mocks";
import type { RecordDetail, RecordItem } from "../src/lib/types";

test.beforeEach(async ({ page }) => {
  await mockSupabaseAuth(page);
  await mockBackendSession(page);
  await loginViaUi(page);
});

test("adding an expense posts the form and celebrates the business's first record", async ({ page }) => {
  let postedBody: unknown = null;

  await page.route("**/records/expenses", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    postedBody = route.request().postDataJSON();
    const created: RecordItem = {
      id: 501,
      type: "expense",
      businessProfileId: TEST_BUSINESS_PROFILE.id,
      categoryId: TEST_CATEGORIES[0].id,
      duplicateOfRecordId: null,
      date: "2026-08-15",
      description: "Rice sacks",
      vendor: "Metro Market",
      amount: 850.5,
      source: "MANUAL",
      reviewStatus: "Reviewed",
      duplicateStatus: "Not a Duplicate",
      createdAt: "2026-08-15T00:00:00.000Z",
    };
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(created) });
  });

  // Nothing recorded yet for this business — the celebration screen is the
  // one this response should trigger.
  await page.route("**/records/search**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], nextCursor: null }),
    });
  });

  await page.goto("/records/expenses/new");
  await expect(page.getByRole("heading", { name: "Add expense" })).toBeVisible();

  await page.getByLabel("Category").selectOption({ label: TEST_CATEGORIES[0].name });
  await page.getByLabel("Date").fill("2026-08-15");
  await page.getByLabel("Description").fill("Rice sacks");
  await page.getByLabel("Vendor").fill("Metro Market");
  await page.getByLabel("Amount").fill("850.50");
  await page.getByRole("button", { name: "Save expense" }).click();

  await expect(page.getByText("That's your first expense recorded")).toBeVisible();
  await expect(page.getByText("Rice sacks")).toBeVisible();

  expect(postedBody).toMatchObject({
    businessProfileId: TEST_BUSINESS_PROFILE.id,
    categoryId: TEST_CATEGORIES[0].id,
    date: "2026-08-15",
    description: "Rice sacks",
    vendor: "Metro Market",
    amount: 850.5,
  });
});

test("editing an expense loads the existing record and submits changes", async ({ page }) => {
  const existing: RecordDetail = {
    id: 777,
    type: "expense",
    businessProfileId: TEST_BUSINESS_PROFILE.id,
    categoryId: TEST_CATEGORIES[1].id,
    duplicateOfRecordId: null,
    date: "2026-08-01T00:00:00.000Z",
    description: "Electric bill",
    vendor: "Meralco",
    amount: 3200,
    source: "MANUAL",
    reviewStatus: "Reviewed",
    duplicateStatus: "Not a Duplicate",
    createdAt: "2026-08-01T00:00:00.000Z",
    origin: null,
  };

  let patchedBody: unknown = null;

  await page.route("**/records/expenses/777", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(existing) });
      return;
    }
    if (route.request().method() === "PATCH") {
      patchedBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...existing, amount: 3450 }),
      });
      return;
    }
    await route.fallback();
  });

  await page.route("**/records/search**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [existing], nextCursor: null }),
    });
  });
  await page.route("**/records/flagged**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) });
  });

  await page.goto("/records/expenses/777/edit");
  await expect(page.getByRole("heading", { name: "Edit expense" })).toBeVisible();
  await expect(page.getByLabel("Description")).toHaveValue("Electric bill");
  await expect(page.getByLabel("Amount")).toHaveValue("3200");

  await page.getByLabel("Amount").fill("3450");
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page).toHaveURL(/\/records$/);
  await expect(page.getByText("Changes saved")).toBeVisible();
  expect(patchedBody).toMatchObject({ amount: 3450 });
});
