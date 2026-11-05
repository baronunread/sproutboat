import { expect, test } from "@playwright/test";
import { authFile, gotoHydrated } from "./helpers";

test.use({ storageState: authFile("test-admin") });

test("project settings show the active artifact manifest with copy buttons", async ({ page }) => {
  await page.goto("/projects/blog/settings");
  await expect(page.getByRole("heading", { name: "Active artifact" })).toBeVisible();
  await expect(page.getByText("Target ABI")).toBeVisible();
  await expect(page.getByText("Compatibility profile")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy" }).first()).toBeVisible();
});

test("API tokens list and revoke through the confirm dialog", async ({ page }) => {
  await gotoHydrated(page, "/settings/tokens");
  const rows = page.getByRole("region", { name: "API tokens" }).locator("tbody tr");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText(/laptop/i);

  // #76: revoking opens a confirmation dialog instead of window.confirm.
  await rows.getByRole("button", { name: /^revoke /i }).click();
  const dialog = page.getByRole("dialog", { name: /^revoke/i });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /revoke token/i }).click();
  await expect(page.getByText(/no api tokens yet/i)).toBeVisible();
});
