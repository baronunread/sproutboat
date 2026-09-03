import { expect, test } from "@playwright/test";
import { authFile } from "./helpers";

test.use({ storageState: authFile("andrea") });

test("deployment detail shows the immutable record and manifest", async ({ page }) => {
  await page.goto("/projects/blog/deployments");
  await page.getByRole("list", { name: "Versions" }).getByRole("link").first().click();
  await expect(page).toHaveURL(/\/projects\/blog\/deployments\/[0-9a-f-]{36}$/);

  await expect(page.getByText("Deployment ID")).toBeVisible();
  await expect(page.getByText("Artifact digest")).toBeVisible();
  await expect(page.getByText("Artifact manifest")).toBeVisible();
  await expect(page.getByText("linux-x86_64")).toBeVisible();
  await expect(page.getByText("native-fetch")).toBeVisible();
});

test("roll back a superseded version, then it becomes active", async ({ page }) => {
  await page.goto("/projects/blog/deployments");
  // blog has 3 versions; the last row is the oldest / superseded
  const rows = page.getByRole("list", { name: "Versions" }).getByRole("listitem");
  await rows.last().getByRole("link").click();
  await expect(page).toHaveURL(/\/projects\/blog\/deployments\/[0-9a-f-]{36}$/);

  // The detail view renders exactly one lifecycle badge, on the version panel.
  const status = page.getByText(/^(Active|Superseded)$/);
  await expect(status).toHaveText("Superseded");
  await page.getByRole("button", { name: /roll back to this version/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /^roll back$/i }).click();
  await expect(status).toHaveText("Active");
  await expect(page.getByRole("button", { name: /roll back to this version/i })).toHaveCount(0);
});

test("the active version cannot be deleted", async ({ page }) => {
  await page.goto("/projects/api/deployments");
  await page.getByRole("list", { name: "Versions" }).getByRole("link").first().click();
  await expect(page.getByText(/active version can't be rolled back or deleted/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /delete version/i })).toHaveCount(0);
});
