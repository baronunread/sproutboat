import { expect, test } from "@playwright/test";
import { authFile, gotoHydrated } from "./helpers";

test.use({ storageState: authFile("test-admin") });

test("non-admins never see the admin area", async ({ browser }) => {
  const context = await browser.newContext({ storageState: authFile("member") });
  const page = await context.newPage();
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/$/); // redirected home
  await expect(page.getByText("Admin", { exact: true })).toHaveCount(0);
  await context.close();
});

test("admin system tab shows platform stats", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
  await expect(page.getByRole("link", { name: "System" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("group", { name: "Accounts", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Deployments", exact: true })).toBeVisible();
});

test("disable an account, verify it, then enable", async ({ page }) => {
  await gotoHydrated(page, "/admin/users");
  const memberRow = page
    .getByRole("region", { name: "User accounts" })
    .getByRole("row")
    .filter({ hasText: "member@example.test" });
  await expect(memberRow).toContainText("Active");

  await memberRow.getByRole("button", { name: /^disable /i }).click();
  await page
    .getByRole("dialog", { name: /^disable member@example.test/i })
    .getByRole("button", { name: /disable account/i })
    .click();

  await expect(memberRow).toContainText("Disabled");

  await memberRow.getByRole("button", { name: /^enable /i }).click();
  await expect(memberRow).toContainText("Active");
});

test("create a user from the dialog and see the starting password", async ({ page }) => {
  // Accounts outlive a reseed, so each run creates its own.
  const unique = `e2e-${Date.now().toString(36)}`;
  await gotoHydrated(page, "/admin/users");
  await page.getByRole("button", { name: "Create user" }).click();
  const dialog = page.getByRole("dialog", { name: /^create/i }); // "Create user", then "Created <name>"
  await dialog.getByLabel("Email").fill(`${unique}@example.test`);
  await dialog.getByLabel("Namespace").fill(unique);
  await dialog.getByRole("button", { name: /generate a password/i }).click();
  await dialog.getByRole("button", { name: /create account/i }).click();
  await expect(dialog.getByText(`Created ${unique}`)).toBeVisible();
  await expect(dialog.getByLabel("Starting password")).toHaveValue(/.{10,}/);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(
    page
      .getByRole("region", { name: "User accounts" })
      .getByRole("row")
      .filter({ hasText: `${unique}@example.test` }),
  ).toBeVisible();
});
