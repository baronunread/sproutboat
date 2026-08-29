import { expect, test } from "@playwright/test";
import { authFile } from "./helpers";

test.use({ storageState: authFile("andrea") });

test("non-operators never see the operator area", async ({ browser }) => {
  const context = await browser.newContext({ storageState: authFile("sofia") });
  const page = await context.newPage();
  await page.goto("/operator");
  await expect(page).toHaveURL(/\/$/); // redirected home
  await expect(page.getByText("Operator", { exact: true })).toHaveCount(0);
  await context.close();
});

test("operator overview shows platform stats", async ({ page }) => {
  await page.goto("/operator");
  await expect(page.getByRole("heading", { name: "Operator" })).toBeVisible();
  await expect(page.locator(".metric-card", { hasText: /^Accounts/ })).toBeVisible();
  await expect(page.locator(".metric-card", { hasText: /^Deployments/ })).toBeVisible();
});

test("ban an account, verify it, then unban", async ({ page }) => {
  await page.goto("/operator/users");
  const sofiaRow = page.locator(".user-item", { hasText: "sofia@example.test" });
  await expect(sofiaRow.locator(".status", { hasText: "Active" })).toBeVisible();

  await sofiaRow.getByRole("button", { name: /^ban…$/i }).click();
  await sofiaRow.getByLabel("Ban reason").fill("e2e abuse");
  await sofiaRow.getByLabel("Ban duration").selectOption({ label: "7 days" });
  await sofiaRow.getByRole("button", { name: /ban account/i }).click();

  await expect(sofiaRow.locator(".status", { hasText: "Banned" })).toBeVisible();
  await expect(sofiaRow).toContainText(/e2e abuse/);

  await sofiaRow.getByRole("button", { name: /unban/i }).click();
  await expect(sofiaRow.locator(".status", { hasText: "Active" })).toBeVisible();
});
