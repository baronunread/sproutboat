import { expect, test } from "@playwright/test";
import { authFile, chooseOption } from "./helpers";

test.use({ storageState: authFile("test-admin") });

test("non-admins never see the admin area", async ({ browser }) => {
  const context = await browser.newContext({ storageState: authFile("member") });
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
  const memberRow = page
    .getByRole("list", { name: "User accounts" })
    .getByRole("listitem")
    .filter({ hasText: "member@example.test" });
  await expect(memberRow).toContainText("Active");

  await memberRow.getByRole("button", { name: /^ban$/i }).click();
  await memberRow.getByLabel("Ban reason").fill("e2e abuse");
  await chooseOption(page, memberRow.getByRole("combobox", { name: "Duration" }), "7 days");
  await memberRow.getByRole("button", { name: /ban account/i }).click();

  await expect(memberRow).toContainText("Banned");
  await expect(memberRow).toContainText(/e2e abuse/);

  await memberRow.getByRole("button", { name: /unban/i }).click();
  await expect(memberRow).toContainText("Active");
});
