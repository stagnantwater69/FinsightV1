import { expect, test } from "@playwright/test";

test("login form exposes the complete recovery and registration journey", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveAttribute("type", "email");
  await expect(page.getByLabel("Password")).toHaveAttribute("type", "password");

  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page).toHaveURL(/\/recover-password$/);
  await expect(page.getByRole("heading", { name: /reset/i })).toBeVisible();

  await page.goto("/login");
  await page.getByRole("link", { name: "Register" }).click();
  await expect(page).toHaveURL(/\/register$/);
  await expect(page.getByRole("heading", { name: /create|register/i })).toBeVisible();
});
