/**
 * Measures the controls that commit cdbec78 brought up to the 44px touch
 * floor, at four viewport widths and in every theme each surface renders in.
 * Mocked network only (see mocks.ts); the measurements are real layout boxes.
 *
 * Authenticated pages use the account theme (`finsight.theme`: classic, light,
 * dark). Public pages pin `data-theme="classic"` on their own wrapper and
 * theme through `finsight.landingTheme` (light, dark) instead, so that is the
 * theme set they are measured in. The error boundary sits outside every
 * provider and reads the account theme the index.html boot script applies.
 */
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { RecordDetail, RecordItem } from "../src/lib/types";
import { loginViaUi, mockBackendSession, mockSupabaseAuth, skipTour, TEST_BUSINESS_PROFILE, TEST_CATEGORIES } from "./mocks";

const MIN = 44;
const WIDTHS = [320, 390, 768, 1440] as const;
const APP_THEMES = ["classic", "light", "dark"] as const;
const LANDING_THEMES = ["light", "dark"] as const;

test.describe.configure({ timeout: 240_000 });

type Kind =
  | "AccountMenu theme option"
  | "AppShell mobile logo link"
  | "DataTable sort header"
  | "Toast action"
  | "ErrorBoundary reload"
  | "PublicLayout resources menu item"
  | "PublicLayout footer link"
  | "PublicLayout breadcrumb link"
  | "Contact link"
  | "RecordOriginPanel sibling link"
  | "FlaggedRecords record link";

interface Measurement { kind: Kind; name: string; width: number; theme: string; w: number; h: number }

class Ledger {
  readonly rows: Measurement[] = [];
  constructor(private readonly page: Page) {}

  /**
   * Every visible match must be at least 44x44. With `fillsContainer`, the
   * target must also span that container's full height, which is how the
   * table header and toast fixes reach 44px without growing their row.
   */
  async measure(kind: Kind, controls: Locator, ctx: { width: number; theme: string }, fillsContainer?: (control: Locator) => Locator) {
    let measured = 0;
    for (const control of await controls.all()) {
      if (!(await control.isVisible())) continue;
      await control.scrollIntoViewIfNeeded();
      const box = await control.boundingBox();
      expect(box, `${kind} has a layout box`).not.toBeNull();
      const text = ((await control.getAttribute("aria-label")) ?? (await control.innerText())).trim().replace(/\s+/g, " ");
      const href = await control.getAttribute("href");
      const name = href ? `${text} -> ${href}` : text;
      const where = `${kind} "${name}" at ${ctx.width}px, ${ctx.theme}`;
      const size = `${box!.width.toFixed(1)}x${box!.height.toFixed(1)}`;
      expect.soft(box!.width, `${where} width (measured ${size})`).toBeGreaterThanOrEqual(MIN);
      expect.soft(box!.height, `${where} height (measured ${size})`).toBeGreaterThanOrEqual(MIN);
      if (fillsContainer) {
        const container = await fillsContainer(control).boundingBox();
        expect(container).not.toBeNull();
        expect.soft(Math.abs(box!.y - container!.y), `${where} reaches the top of its container`).toBeLessThanOrEqual(1);
        expect.soft(
          Math.abs(box!.y + box!.height - (container!.y + container!.height)),
          `${where} reaches the bottom of its container (control ${size}, container height ${container!.height.toFixed(1)})`,
        ).toBeLessThanOrEqual(1);
      }
      await control.evaluate((element) => element.setAttribute("data-tap-measured", ""));
      this.rows.push({ kind, name, width: ctx.width, theme: ctx.theme, w: box!.width, h: box!.height });
      measured += 1;
    }
    return measured;
  }

  /** No measured control may intersect another interactive element inside `group`. */
  async expectNoOverlap(group: Locator, label: string) {
    const overlaps = await group.evaluate((root) => {
      const selector = "a[href], button, input, select, textarea, [role=option], [role=menuitem], [role=radio], [role=tab]";
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const controls = [...root.querySelectorAll(selector)].filter(visible);
      const found: string[] = [];
      for (const measured of controls.filter((element) => element.hasAttribute("data-tap-measured"))) {
        const a = measured.getBoundingClientRect();
        for (const other of controls) {
          if (other === measured || other.contains(measured) || measured.contains(other)) continue;
          const b = other.getBoundingClientRect();
          const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (x > 0.5 && y > 0.5) {
            const text = (element: Element) => (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40);
            found.push(`"${text(measured)}" overlaps "${text(other)}" by ${x.toFixed(1)}x${y.toFixed(1)}`);
          }
        }
      }
      root.ownerDocument.querySelectorAll("[data-tap-measured]").forEach((element) => element.removeAttribute("data-tap-measured"));
      return found;
    });
    expect.soft(overlaps, `${label}: measured controls must not overlap sibling controls`).toEqual([]);
  }

  expectKinds(expected: Partial<Record<Kind, number>>, testInfo: TestInfo) {
    for (const [kind, minimumDistinct] of Object.entries(expected) as [Kind, number][]) {
      const rows = this.rows.filter((row) => row.kind === kind);
      expect(rows.length, `${kind} was measured at least once`).toBeGreaterThan(0);
      expect(new Set(rows.map((row) => row.name)).size, `${kind}: distinct controls measured`).toBeGreaterThanOrEqual(minimumDistinct);
    }
    const summary = Object.keys(expected).map((kind) => {
      const rows = this.rows.filter((row) => row.kind === kind);
      const smallest = rows.reduce((min, row) => (row.w * row.h < min.w * min.h ? row : min));
      const widths = [...new Set(rows.map((row) => row.width))].join("/");
      return `${kind}: ${rows.length} boxes at ${widths}px, smallest ${smallest.w.toFixed(1)}x${smallest.h.toFixed(1)} ("${smallest.name}" ${smallest.width}px ${smallest.theme})`;
    });
    console.log(summary.join("\n"));
    void testInfo.attach("tap-target-measurements", { body: JSON.stringify(this.rows, null, 2), contentType: "application/json" });
  }
}

async function setAppTheme(page: Page, theme: string) {
  await page.evaluate((value) => localStorage.setItem("finsight.theme", value), theme);
}

async function signIn(page: Page) {
  await skipTour(page);
  await mockSupabaseAuth(page);
  await mockBackendSession(page);
  await page.route("**/records/flagged/count**", async (route) => { await route.fulfill({ json: { expenses: 0, sales: 0, total: 0 } }); });
  await loginViaUi(page);
}

function expense(id: number, description: string, overrides: Partial<RecordItem> = {}): RecordItem {
  return {
    id,
    type: "expense",
    businessProfileId: TEST_BUSINESS_PROFILE.id,
    categoryId: TEST_CATEGORIES[0]!.id,
    duplicateOfRecordId: null,
    date: "2026-09-10T00:00:00.000Z",
    description,
    vendor: "Metro Market",
    amount: 850,
    source: "MANUAL",
    reviewStatus: "Reviewed",
    duplicateStatus: "Not a Duplicate",
    createdAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

test("app shell, account menu, records table and undo toast", async ({ page }, testInfo) => {
  const ledger = new Ledger(page);
  await signIn(page);
  await page.route("**/records/search**", async (route) => {
    await route.fulfill({ json: { items: [expense(1, "Rice sacks"), expense(2, "Cooking oil")], nextCursor: null } });
  });
  await page.route("**/records/expenses/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    await route.fulfill({ status: 200, json: {} });
  });

  for (const width of WIDTHS) {
    for (const theme of APP_THEMES) {
      const ctx = { width, theme };
      await page.setViewportSize({ width, height: 900 });
      await setAppTheme(page, theme);
      await page.goto("/records");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByText("Rice sacks", { exact: true }).filter({ visible: true }).first()).toBeVisible();

      const header = page.locator("header").filter({ has: page.locator('a[aria-label="FinSight home"]') });
      if (width < 1024) {
        expect(await ledger.measure("AppShell mobile logo link", header.locator('a[aria-label="FinSight home"]'), ctx)).toBe(1);
        await ledger.expectNoOverlap(header, `app header ${width}px ${theme}`);
      }

      if (width >= 1024) {
        const sortHeaders = page.locator("thead th button");
        expect(await ledger.measure("DataTable sort header", sortHeaders, ctx, (button) => button.locator("xpath=ancestor::th[1]"))).toBeGreaterThan(0);
        await ledger.expectNoOverlap(page.locator("thead"), `records table header ${width}px ${theme}`);
        // The header row must not sit on top of the row controls below it.
        await page.evaluate(() => window.scrollTo(0, 0));
        const coveredRowControls = await page.locator("tbody").evaluate((tbody) =>
          [...tbody.querySelectorAll<HTMLElement>("a[href], button")].flatMap((control) => {
            const rect = control.getBoundingClientRect();
            if (rect.width === 0 || rect.bottom > window.innerHeight) return [];
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            if (!hit || hit === control || control.contains(hit)) return [];
            const cover = hit.closest("th, thead") ? "the table header" : hit.tagName.toLowerCase();
            return [`"${control.getAttribute("aria-label") ?? control.textContent?.trim()}" is covered by ${cover}`];
          }));
        expect.soft(coveredRowControls, `records table rows at ${width}px ${theme}`).toEqual([]);
      }

      await page.getByRole("button", { name: /Account menu$/ }).click();
      const accountMenu = page.getByRole("dialog", { name: "Account" });
      await expect(accountMenu).toBeVisible();
      expect(await ledger.measure("AccountMenu theme option", accountMenu.getByRole("radio"), ctx)).toBe(3);
      await ledger.expectNoOverlap(accountMenu, `account menu ${width}px ${theme}`);
      await expect(accountMenu.getByRole("radio", { name: THEME_LABEL[theme] })).toHaveAttribute("aria-checked", "true");
      await page.getByRole("button", { name: /Account menu$/ }).click();
      await expect(accountMenu).toHaveCount(0);

      // The second row: at 1024px and up the table header covers the first one (asserted above).
      await page.getByRole("button", { name: "Delete Cooking oil", exact: true }).filter({ visible: true }).click();
      await page.getByRole("dialog", { name: 'Delete "Cooking oil"?' }).getByRole("button", { name: "Delete record" }).click();
      const undo = page.getByRole("button", { name: "Undo", exact: true });
      await expect(undo).toBeVisible();
      expect(await ledger.measure("Toast action", undo, ctx, (button) => button.locator("xpath=.."))).toBe(1);
      await ledger.expectNoOverlap(undo.locator("xpath=.."), `toast ${width}px ${theme}`);
    }
  }

  ledger.expectKinds({
    "AppShell mobile logo link": 1,
    "DataTable sort header": 1,
    "AccountMenu theme option": 3,
    "Toast action": 1,
  }, testInfo);
});

const THEME_LABEL: Record<string, string> = { classic: "Classic", light: "Light", dark: "Dark" };

test("flagged duplicate group record links", async ({ page }, testInfo) => {
  const ledger = new Ledger(page);
  await signIn(page);
  const flagged = [
    expense(31, "Rice sacks", { duplicateStatus: "Flagged", duplicateOfRecordId: 30 }),
    expense(32, "Rice sacks", { duplicateStatus: "Flagged", duplicateOfRecordId: 30 }),
  ];
  await page.route("**/records/flagged?*", async (route) => { await route.fulfill({ json: { items: flagged, nextCursor: null } }); });
  await page.route("**/insights/findings**", async (route) => { await route.fulfill({ json: { items: [], nextCursor: null } }); });
  await page.route("**/records/csv-imports/batches**", async (route) => { await route.fulfill({ json: { items: [], nextCursor: null } }); });

  for (const width of WIDTHS) {
    for (const theme of APP_THEMES) {
      const ctx = { width, theme };
      await page.setViewportSize({ width, height: 900 });
      await setAppTheme(page, theme);
      await page.goto("/records/flagged");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.getByRole("button", { name: "Show these 2 records" }).click();
      const list = page.locator("ul").filter({ has: page.locator('a[href="/records/expenses/31/edit"]') });
      await expect(list).toBeVisible();
      expect(await ledger.measure("FlaggedRecords record link", list.getByRole("link"), ctx)).toBe(2);
      await ledger.expectNoOverlap(list, `flagged group ${width}px ${theme}`);
    }
  }
  ledger.expectKinds({ "FlaggedRecords record link": 2 }, testInfo);
});

test("receipt origin sibling links on an edited expense", async ({ page }, testInfo) => {
  const ledger = new Ledger(page);
  await signIn(page);
  const detail: RecordDetail = {
    ...expense(900, "Paper supplies", { source: "RECEIPT", receiptScanId: 700 }),
    origin: {
      kind: "receipt_scan",
      scanId: 700,
      scannedAt: "2026-09-10T00:00:00.000Z",
      extractedVendor: "Synthetic Paper Shop",
      imageUrl: null,
      items: [],
      itemsSubtotal: 850,
      siblings: [
        { id: 901, description: "Ink cartridges", amount: 400, categoryId: TEST_CATEGORIES[1]!.id, categoryName: TEST_CATEGORIES[1]!.name },
        { id: 902, description: "Tape", amount: 60, categoryId: TEST_CATEGORIES[0]!.id, categoryName: TEST_CATEGORIES[0]!.name },
      ],
    },
  };
  await page.route("**/records/expenses/900", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ json: detail });
  });

  for (const width of WIDTHS) {
    for (const theme of APP_THEMES) {
      const ctx = { width, theme };
      await page.setViewportSize({ width, height: 900 });
      await setAppTheme(page, theme);
      await page.goto("/records/expenses/900/edit");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const siblingList = page.locator("ul").filter({ has: page.locator('a[href="/records/expenses/901/edit"]') });
      await expect(siblingList).toBeVisible();
      expect(await ledger.measure("RecordOriginPanel sibling link", siblingList.getByRole("link"), ctx)).toBe(2);
      await ledger.expectNoOverlap(siblingList, `origin siblings ${width}px ${theme}`);
    }
  }
  ledger.expectKinds({ "RecordOriginPanel sibling link": 2 }, testInfo);
});

const FOOTER_LINKS = ["Features", "Blogs & Articles", "Video Tutorials", "FAQ Center", "Contact Us", "Privacy Policy", "Terms of Service"];

test("public header resources menu, breadcrumb, contact links and footer", async ({ page }, testInfo) => {
  const ledger = new Ledger(page);
  await page.goto("/contact");
  for (const width of WIDTHS) {
    for (const theme of LANDING_THEMES) {
      const ctx = { width, theme: `landing-${theme}` };
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((value) => localStorage.setItem("finsight.landingTheme", value), theme);
      await page.goto("/contact");
      await expect(page.locator("html")).toHaveAttribute("data-landing-theme", theme);

      const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
      await expect(breadcrumb).toBeVisible();
      expect(await ledger.measure("PublicLayout breadcrumb link", breadcrumb.getByRole("link", { name: "Home" }), ctx)).toBe(1);
      await ledger.expectNoOverlap(breadcrumb, `breadcrumb ${width}px ${theme}`);

      const contactLinks = page.locator("main").locator('a[href^="mailto:"], a[href="/faqs"]').filter({ hasNotText: "FAQ Center" });
      expect(await ledger.measure("Contact link", contactLinks, ctx)).toBe(2);
      await ledger.expectNoOverlap(page.locator("main"), `contact page ${width}px ${theme}`);

      const footer = page.locator("footer");
      let footerMeasured = 0;
      for (const name of FOOTER_LINKS) {
        footerMeasured += await ledger.measure("PublicLayout footer link", footer.getByRole("link", { name, exact: true }), ctx);
      }
      expect(footerMeasured).toBe(FOOTER_LINKS.length);
      await ledger.expectNoOverlap(footer, `footer ${width}px ${theme}`);

      const resources = page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Resources" });
      if (await resources.isVisible()) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await resources.click();
        const menu = page.getByRole("menu");
        await expect(menu).toBeVisible();
        expect(await ledger.measure("PublicLayout resources menu item", menu.getByRole("menuitem"), ctx)).toBe(3);
        await ledger.expectNoOverlap(menu, `resources menu ${width}px ${theme}`);
        await page.keyboard.press("Escape");
        await expect(menu).toHaveCount(0);
      } else {
        expect(width, "Resources is only hidden below the md breakpoint").toBeLessThan(768);
      }
    }
  }
  ledger.expectKinds({
    "PublicLayout breadcrumb link": 1,
    "Contact link": 2,
    "PublicLayout footer link": FOOTER_LINKS.length,
    "PublicLayout resources menu item": 3,
  }, testInfo);
});

test("error boundary reload button", async ({ page }, testInfo) => {
  const ledger = new Ledger(page);
  // A route chunk that fails to load is a real render-time throw the top-level boundary catches.
  await page.route(/\/src\/pages\/Terms\.tsx(?:\?.*)?$/, (route) => route.abort("failed"));
  await page.goto("/login");
  for (const width of WIDTHS) {
    for (const theme of APP_THEMES) {
      const ctx = { width, theme };
      await page.setViewportSize({ width, height: 900 });
      await setAppTheme(page, theme);
      await page.goto("/terms");
      await expect(page.getByRole("heading", { name: "Something broke on this page" })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const reload = page.getByRole("button", { name: "Reload the page" });
      expect(await ledger.measure("ErrorBoundary reload", reload, ctx)).toBe(1);
      await ledger.expectNoOverlap(page.locator("body"), `error boundary ${width}px ${theme}`);
    }
  }
  ledger.expectKinds({ "ErrorBoundary reload": 1 }, testInfo);
});
