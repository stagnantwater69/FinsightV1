/**
 * The Records Category filter: a plain select up to 20 categories, a
 * type-to-filter combobox past that. Mocked network only (see mocks.ts).
 */
import { expect, test, type Page } from "@playwright/test";
import type { ExpenseCategory, RecordItem } from "../src/lib/types";
import { loginViaUi, mockBackendSession, mockSupabaseAuth, skipTour, TEST_BUSINESS_PROFILE } from "./mocks";

const NAMES = [
  "Inventory", "Utilities", "Rent", "Salaries", "Transport", "Packaging", "Repairs", "Marketing",
  "Bank fees", "Taxes", "Insurance", "Internet", "Water", "Cleaning", "Office supplies", "Meals",
  "Fuel", "Licenses", "Security", "Delivery", "Equipment", "Training", "Donations", "Miscellaneous",
];

function categories(count: number): ExpenseCategory[] {
  return NAMES.slice(0, count).map((name, index) => ({
    id: 200 + index,
    businessProfileId: TEST_BUSINESS_PROFILE.id,
    name,
    description: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  }));
}

function record(id: number, categoryId: number, description: string): RecordItem {
  return {
    id,
    type: "expense",
    businessProfileId: TEST_BUSINESS_PROFILE.id,
    categoryId,
    duplicateOfRecordId: null,
    date: "2026-09-10T00:00:00.000Z",
    description,
    vendor: null,
    amount: 250,
    source: "MANUAL",
    reviewStatus: "Reviewed",
    duplicateStatus: "Not a Duplicate",
    createdAt: "2026-09-10T00:00:00.000Z",
  };
}

async function openRecords(page: Page, list: ExpenseCategory[]) {
  const rows = [record(1, list[0]!.id, "Rice sacks"), record(2, list[list.length - 1]!.id, "Last category spend")];
  const searches: URLSearchParams[] = [];
  await skipTour(page);
  await mockSupabaseAuth(page);
  await mockBackendSession(page, { categories: list });
  await page.route("**/records/search**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    searches.push(params);
    const categoryId = params.get("categoryId");
    const items = categoryId ? rows.filter((row) => String(row.categoryId) === categoryId) : rows;
    await route.fulfill({ json: { items, nextCursor: null } });
  });
  await page.route("**/records/flagged/count**", async (route) => { await route.fulfill({ json: { expenses: 0, sales: 0, total: 0 } }); });
  await page.route("**/records/csv-imports/batches**", async (route) => { await route.fulfill({ json: { items: [], nextCursor: null } }); });
  await loginViaUi(page);
  await page.goto("/records");
  await expect(page.getByRole("heading", { name: "Records", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Rice sacks", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "More filters" }).click();
  return { searches, table: page.getByRole("table") };
}

test("twenty categories keep the native select, and choosing one filters the records", async ({ page }) => {
  const list = categories(20);
  const { searches, table } = await openRecords(page, list);
  const filter = page.locator("#rec-cat");
  await expect(filter).toHaveJSProperty("tagName", "SELECT");
  await expect(page.getByRole("combobox", { name: "Category" })).toHaveJSProperty("tagName", "SELECT");
  await expect(filter.locator("option")).toHaveCount(21);

  await filter.selectOption({ label: "Delivery" });
  await expect(page).toHaveURL(/[?&]categoryId=219(?:&|$)/);
  await expect(table.getByRole("cell", { name: "Last category spend", exact: true })).toBeVisible();
  await expect(table.getByRole("cell", { name: "Rice sacks", exact: true })).toHaveCount(0);
  expect(searches.at(-1)?.get("categoryId")).toBe("219");
});

test("more than twenty categories become a searchable combobox driven by the keyboard", async ({ page }) => {
  const list = categories(24);
  const { searches, table } = await openRecords(page, list);
  const input = page.getByRole("combobox", { name: "Category" });
  await expect(input).toHaveJSProperty("tagName", "INPUT");
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await expect(input).toHaveAttribute("placeholder", "All categories");

  // ArrowDown opens on the current value ("All categories"), and again moves to the first category.
  await input.focus();
  await page.keyboard.press("ArrowDown");
  await expect(input).toHaveAttribute("aria-expanded", "true");
  const listbox = page.getByRole("listbox", { name: "Categories" });
  await expect(listbox.getByRole("option")).toHaveCount(25);
  await page.keyboard.press("ArrowDown");
  const activeId = await input.getAttribute("aria-activedescendant");
  await expect(page.locator(`[id="${activeId}"]`)).toHaveText("Inventory");

  // Escape closes without choosing anything.
  await page.keyboard.press("Escape");
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await expect(listbox).toHaveCount(0);
  await expect(input).toHaveValue("");
  await expect(page).not.toHaveURL(/categoryId=/);

  // Typing narrows the list; matching is case-insensitive substring.
  await input.pressSequentially("SEC");
  await expect(input).toHaveAttribute("aria-expanded", "true");
  await expect(listbox.getByRole("option")).toHaveText(["Security"]);
  await expect(page.getByText("1 of 24 categories match")).toBeAttached();

  await input.fill("zzz");
  await expect(listbox.getByRole("option")).toHaveCount(0);
  await expect(page.getByText("No categories match “zzz”.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("No categories match “zzz”.")).toHaveCount(0);

  await input.pressSequentially("misc");
  await expect(listbox.getByRole("option")).toHaveText(["Miscellaneous"]);
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(`[id="${await input.getAttribute("aria-activedescendant")}"]`)).toHaveText("Miscellaneous");
  await page.keyboard.press("Enter");

  await expect(input).toHaveAttribute("aria-expanded", "false");
  await expect(input).toHaveValue("Miscellaneous");
  await expect(page).toHaveURL(/[?&]categoryId=223(?:&|$)/);
  await expect(table.getByRole("cell", { name: "Last category spend", exact: true })).toBeVisible();
  await expect(table.getByRole("cell", { name: "Rice sacks", exact: true })).toHaveCount(0);
  expect(searches.at(-1)?.get("categoryId")).toBe("223");

  // Back to every category through the "All categories" option, picked with the mouse.
  await input.click();
  await expect(listbox.getByRole("option", { name: "Miscellaneous" })).toHaveAttribute("aria-selected", "true");
  await listbox.getByRole("option", { name: "All categories" }).click();
  await expect(input).toHaveValue("");
  await expect(page).not.toHaveURL(/categoryId=/);
  // The unfiltered page may come from the records cache instead of a new request, so assert the rows.
  await expect(table.getByRole("cell", { name: "Rice sacks", exact: true })).toBeVisible();
  await expect(table.getByRole("cell", { name: "Last category spend", exact: true })).toBeVisible();
});
