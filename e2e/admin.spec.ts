import { expect, test } from "@playwright/test";
import { authFile } from "./helpers";

test.use({ storageState: authFile("andrea") });

test("non-admins never see the admin area", async ({ browser }) => {
  const context = await browser.newContext({ storageState: authFile("sofia") });
  const page = await context.newPage();
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/$/); // redirected home
  await expect(page.getByText("Admin", { exact: true })).toHaveCount(0);
  await context.close();
});

test("admin overview shows platform stats", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Accounts", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Deployments", exact: true })).toBeVisible();
});

test("ban an account, verify it, then unban", async ({ page }) => {
  await page.goto("/admin/users");
  const sofiaRow = page.getByRole("list", { name: "User accounts" }).getByRole("listitem").filter({ hasText: "sofia@example.test" });
  await expect(sofiaRow).toContainText("Active");

  await sofiaRow.getByRole("button", { name: /^ban$/i }).click();
  await sofiaRow.getByLabel("Ban reason").fill("e2e abuse");
  await sofiaRow.getByLabel("Duration").selectOption({ label: "7 days" });
  await sofiaRow.getByRole("button", { name: /ban account/i }).click();

  await expect(sofiaRow).toContainText("Banned");
  await expect(sofiaRow).toContainText(/e2e abuse/);

  await sofiaRow.getByRole("button", { name: /unban/i }).click();
  await expect(sofiaRow).toContainText("Active");
});
