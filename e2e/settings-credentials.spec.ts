import { expect, test } from "@playwright/test";
import { authFile } from "./helpers";

test.use({ storageState: authFile("andrea") });

test("project settings show the active artifact manifest with copy buttons", async ({ page }) => {
  await page.goto("/projects/blog/settings");
  await expect(page.getByRole("heading", { name: "Active artifact" })).toBeVisible();
  await expect(page.getByText("Target ABI")).toBeVisible();
  await expect(page.getByText("Compatibility profile")).toBeVisible();
  await expect(page.getByText(/no runtime variables, secrets/i)).toBeVisible();
  await expect(page.locator(".copy-button").first()).toBeVisible();
});

test("CLI credentials list and revoke", async ({ page }) => {
  await page.goto("/settings");
  const list = page.locator(".credential-list li");
  await expect(list).toHaveCount(1);
  await expect(list).toContainText(/laptop/i);

  page.once("dialog", (dialog) => dialog.accept());
  await list.getByRole("button", { name: /revoke/i }).click();
  await expect(page.getByText(/no cli credentials yet/i)).toBeVisible();
});
