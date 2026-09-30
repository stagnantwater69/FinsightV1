/** Mocked-network coverage for the two account and business settings surfaces. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  loginViaUi,
  mockBackendSession,
  mockSupabaseAuth,
  skipTour,
  TEST_BUSINESS_PROFILE,
} from "./mocks";

const VISUAL_AUDIT_DIR = process.env.SETTINGS_VISUAL_AUDIT_DIR;

async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

async function useTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((value) => {
    window.localStorage.setItem("finsight.theme", value);
    document.documentElement.dataset.theme = value;
  }, theme);
}

async function navigateInApp(page: Page, path: string) {
  await page.evaluate((nextPath) => {
    window.history.pushState({}, "", nextPath);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

async function capture(page: Page, name: string) {
  if (!VISUAL_AUDIT_DIR) return;
  await mkdir(VISUAL_AUDIT_DIR, { recursive: true });
  await page.screenshot({
    path: join(VISUAL_AUDIT_DIR, `${name}.png`),
    fullPage: true,
  });
}

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await mockSupabaseAuth(page);
  await mockBackendSession(page);
  await loginViaUi(page);
});

test("business profile exposes dirty, cancel, and saved states", async ({
  page,
}) => {
  const patches: Array<Record<string, unknown>> = [];
  await page.route("**/business-profiles/10", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const input = route.request().postDataJSON() as Record<string, unknown>;
    patches.push(input);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...TEST_BUSINESS_PROFILE, ...input }),
    });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await useTheme(page, "light");

  await expect(
    page.getByRole("heading", { name: "Business profile", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Business identity" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Planning figures" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Business tools" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Where these settings are used" }),
  ).toBeVisible();
  await expect(page.locator("button", { hasText: "Change logo" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Manage schedule/ })).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Manage notifications/ }),
  ).toBeVisible();

  const businessName = page.getByLabel("Business name");
  const cancel = page.getByRole("button", { name: "Cancel", exact: true });
  const save = page.getByRole("button", { name: "Save changes" });
  await expect(cancel).toBeDisabled();
  await expect(save).toBeDisabled();
  await expect(page.getByText("Everything is up to date")).toBeVisible();

  await businessName.fill("Ana's Corner Store");
  await expect(page.getByText("You have unsaved changes")).toBeVisible();
  await expect(cancel).toBeEnabled();
  await expect(save).toBeEnabled();

  await cancel.click();
  await expect(businessName).toHaveValue(TEST_BUSINESS_PROFILE.name);
  await expect(page.getByText("Everything is up to date")).toBeVisible();
  expect(patches).toHaveLength(0);

  await businessName.fill("Ana's Corner Store");
  await save.click();
  await expect(page.getByText("Changes saved")).toBeVisible();
  await expect(page.getByText("Business profile updated")).toBeVisible();
  expect(patches).toHaveLength(1);
  expect(patches[0]).toMatchObject({ name: "Ana's Corner Store" });
  await expect(save).toBeDisabled();
  await expectNoHorizontalOverflow(page);
});

test("business and personal profile layouts reflow in light and dark themes", async ({
  page,
}) => {
  const surfaces = [
    {
      path: "/business-profiles",
      slug: "business",
      heading: "Business profile",
      assertActions: async () => {
        await expect(
          page.locator("button", { hasText: "Change logo" }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Save changes" }),
        ).toBeVisible();
      },
    },
    {
      path: "/profile",
      slug: "personal",
      heading: "My profile",
      assertActions: async () => {
        await expect(
          page.locator("button", { hasText: "Change photo" }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Edit profile" }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Change password" }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Log out on all devices" }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Delete account" }),
        ).toBeVisible();
      },
    },
  ] as const;

  for (const surface of surfaces) {
    for (const theme of ["light", "dark"] as const) {
      await useTheme(page, theme);
      for (const viewport of [
        { label: "desktop", width: 1440, height: 900 },
        { label: "mobile", width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport);
        await navigateInApp(page, surface.path);
        await expect(
          page.getByRole("heading", {
            name: surface.heading,
            exact: true,
          }),
        ).toBeVisible();
        await surface.assertActions();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expectNoHorizontalOverflow(page);
        await page.evaluate(() => window.scrollTo(0, 0));
        await capture(
          page,
          `${surface.slug}-${theme}-${viewport.label}`,
        );
      }
    }
  }
});
