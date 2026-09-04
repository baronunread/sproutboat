import { expect, test } from "@playwright/test";
import { authFile } from "./helpers";

test.use({ storageState: authFile("andrea") });

test("project settings show the active artifact manifest with copy buttons", async ({ page }) => {
  await page.goto("/projects/blog/settings");
  await expect(page.getByRole("heading", { name: "Active artifact" })).toBeVisible();
  await expect(page.getByText("Target ABI")).toBeVisible();
  await expect(page.getByText("Compatibility profile")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy" }).first()).toBeVisible();
});

test("API tokens list and revoke through the confirm dialog", async ({ page }) => {
  await page.goto("/settings/tokens");
  const list = page.getByRole("list", { name: "API tokens" }).getByRole("listitem");
  await expect(list).toHaveCount(1);
  await expect(list).toContainText(/laptop/i);

  // #76 — revoking opens a confirmation dialog instead of window.confirm.
  // Radix's AlertDialog exposes role=alertdialog, which is a distinct role
  // from dialog as far as getByRole is concerned.
  await list.getByRole("button", { name: /^revoke$/i }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /revoke token/i }).click();
  await expect(page.getByText(/no api tokens yet/i)).toBeVisible();
});
