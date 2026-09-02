import { expect, test } from "@playwright/test";
import { authFile } from "./helpers";

test("project deletion requires the exact typed name", async ({ browser }) => {
  const context = await browser.newContext({ storageState: authFile("andrea") });
  const page = await context.newPage();
  await page.goto("/projects");

  const row = page.locator(".record-list li", { hasText: "scratch" });
  await row.getByRole("button", { name: /^delete$/i }).click();

  const confirmButton = row.getByRole("button", { name: /delete permanently/i });
  await expect(confirmButton).toBeDisabled();
  await row.getByPlaceholder("scratch").fill("wrong");
  await expect(confirmButton).toBeDisabled();
  await row.getByPlaceholder("scratch").fill("scratch");
  await expect(confirmButton).toBeEnabled();

  await confirmButton.click();
  await expect(page.getByText(/deleted scratch/i)).toBeVisible();
  await expect(page.getByRole("link", { name: "scratch", exact: true })).toHaveCount(0);
  await context.close();
});

test("account deletion signs out and redirects to /login", async ({ browser }) => {
  const context = await browser.newContext({ storageState: authFile("deletable") });
  const page = await context.newPage();
  await page.goto("/settings");

  const del = page.getByRole("button", { name: /^delete account$/i });
  await expect(del).toBeDisabled();
  // The field is disabled until the account (and so the expected username) loads.
  const confirmField = page.getByLabel(/type deletable to confirm/i);
  await expect(confirmField).toBeEnabled();
  await confirmField.fill("deletable");
  await expect(del).toBeEnabled();

  await del.click();
  await expect(page).toHaveURL(/\/login$/);
  await context.close();
});
