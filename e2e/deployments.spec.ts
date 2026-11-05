import { expect, test } from "@playwright/test";
import { authFile } from "./helpers";

test.use({ storageState: authFile("test-admin") });

test("deployment detail shows the immutable record and manifest", async ({ page }) => {
  await page.goto("/projects/blog/deployments");
  await page.getByRole("region", { name: "Versions" }).getByRole("link").first().click();
  await expect(page).toHaveURL(/\/projects\/blog\/deployments\/[0-9a-f-]{36}$/);

  await expect(page.getByText("Deployment ID")).toBeVisible();
  await expect(page.getByText("Artifact digest")).toBeVisible();
  await expect(page.getByText("Artifact manifest")).toBeVisible();
  await expect(page.getByText("linux-x86_64")).toBeVisible();
  await expect(page.getByText("native-fetch")).toBeVisible();
});

test("roll back an inactive version, then it becomes active", async ({ page }) => {
  await page.goto("/projects/blog/deployments");
  // blog has 3 versions; the last row is the oldest / inactive
  const rows = page.getByRole("region", { name: "Versions" }).locator("tbody tr");
  await rows.last().getByRole("link").click();
  await expect(page).toHaveURL(/\/projects\/blog\/deployments\/[0-9a-f-]{36}$/);

  // Scoped to the version panel. Page-wide, this regex also matches the two
  // <option>s in the list page's State filter and a badge per row, so during
  // the client-side transition off that route it intermittently resolved to
  // five elements and failed strict mode rather than waiting for the detail.
  const status = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: /^Version [0-9a-f]{8}$/ }) })
    .getByText(/^(Active|Inactive)$/);
  await expect(status).toHaveText("Inactive");
  await page.getByRole("button", { name: /roll back to this version/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /^roll back$/i }).click();
  await expect(status).toHaveText("Active");
  await expect(page.getByText(/rolled back to/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /roll back to this version/i })).toHaveCount(0);

  // The list rolls back too: the same confirm dialog, from a row.
  await page.goto("/projects/blog/deployments");
  const older = page
    .getByRole("region", { name: "Versions" })
    .locator("tbody tr")
    .filter({ hasText: "Inactive" })
    .first();
  await older.getByRole("button", { name: /^roll back to/i }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^cancel$/i })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("the active version cannot be deleted", async ({ page }) => {
  await page.goto("/projects/api/deployments");
  await page.getByRole("region", { name: "Versions" }).getByRole("link").first().click();
  await expect(page.getByText(/active version can't be rolled back or deleted/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /delete version/i })).toHaveCount(0);
});
