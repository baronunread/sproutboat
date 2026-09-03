import { expect, test } from "@playwright/test";
import { loginViaEmulator } from "./helpers";

test("an unauthenticated visitor is redirected to /login", async ({ page }) => {
  await page.goto("/projects");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("button", { name: /continue with github/i })).toBeVisible();
});

test("sign in through GitHub, land on the dashboard, then sign out", async ({ page }) => {
  await loginViaEmulator(page, "andrea");
  // avatar image (not the initial fallback) + admin badge for andrea
  await expect(page.getByRole("img", { name: /avatar$/i })).toBeVisible();
  await expect(page.getByRole("banner").getByText("Admin", { exact: true })).toBeVisible();

  await page.getByLabel("Open account menu").click();
  await page.getByRole("button", { name: /log out/i }).click();
  await expect(page).toHaveURL(/\/login$/);
});
