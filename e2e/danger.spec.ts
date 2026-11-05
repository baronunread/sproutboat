import { expect, test } from "@playwright/test";
import { authFile, gotoHydrated } from "./helpers";

test("project deletion requires the exact typed name", async ({ browser }) => {
  const context = await browser.newContext({ storageState: authFile("test-admin") });
  const page = await context.newPage();
  await page.goto("/projects");

  const row = page
    .getByRole("region", { name: "Sprouts", exact: true })
    .getByRole("row")
    .filter({ hasText: "scratch" });
  await row.getByRole("button", { name: "Delete scratch" }).click();

  // The confirmation is a dialog, portalled out of the row.
  const dialog = page.getByRole("dialog");
  const confirmButton = dialog.getByRole("button", { name: /delete permanently/i });
  await expect(confirmButton).toBeDisabled();
  await dialog.getByPlaceholder("scratch").fill("wrong");
  await expect(confirmButton).toBeDisabled();
  await dialog.getByPlaceholder("scratch").fill("scratch");
  await expect(confirmButton).toBeEnabled();

  await confirmButton.click();
  await expect(page.getByText(/deleted scratch/i)).toBeVisible();
  await expect(page.getByRole("link", { name: "scratch", exact: true })).toHaveCount(0);
  await context.close();
});

test("account deletion signs out and redirects to /login", async ({ browser }) => {
  const context = await browser.newContext({ storageState: authFile("deletable") });
  const page = await context.newPage();
  await gotoHydrated(page, "/settings");

  // The danger zone opens a dialog; the delete button inside stays disabled until the username matches.
  const open = page.getByRole("button", { name: /^delete account$/i });
  await expect(open).toBeEnabled(); // the account (and so the expected username) has loaded
  await open.click();
  const dialog = page.getByRole("dialog", { name: /delete your account/i });
  const del = dialog.getByRole("button", { name: /delete my account/i });
  await expect(del).toBeDisabled();
  await dialog.getByLabel(/type deletable to confirm/i).fill("deletable");
  await expect(del).toBeEnabled();

  await del.click();
  await expect(page).toHaveURL(/\/login$/);
  await context.close();
});
