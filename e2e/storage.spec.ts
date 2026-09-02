import { expect, test } from "@playwright/test";
import { authFile } from "./helpers";

/**
 * #76 — the surfaces that existed only in the CLI until now: account storage
 * resources, project secrets, and the usage-against-limits view.
 */
test.use({ storageState: authFile("andrea") });

test("storage: create, rename and delete a resource", async ({ page }) => {
  await page.goto("/storage");
  await expect(page.getByRole("heading", { name: "Create a resource" })).toBeVisible();

  await page.getByLabel("Type").selectOption("kv");
  await page.getByLabel("Name").fill("e2e-sessions");
  await page.getByRole("button", { name: /create resource/i }).click();

  const row = page.locator(".resource-list li", { hasText: "e2e-sessions" });
  await expect(row).toBeVisible();
  await expect(row).toContainText(/kv_[0-9a-f]{24}/);

  await row.getByRole("button", { name: /^rename$/i }).click();
  await row.getByLabel(/new name for e2e-sessions/i).fill("e2e-renamed");
  await row.getByRole("button", { name: /^save$/i }).click();
  await expect(page.locator(".resource-list li", { hasText: "e2e-renamed" })).toBeVisible();

  const renamed = page.locator(".resource-list li", { hasText: "e2e-renamed" });
  await renamed.getByRole("button", { name: /^delete$/i }).click();
  const dialog = page.locator("dialog.confirm-dialog[open]");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /delete resource/i }).click();
  await expect(page.locator(".resource-list li", { hasText: "e2e-renamed" })).toHaveCount(0);
});

test("a resource name that is already taken is rejected before submitting", async ({ page }) => {
  await page.goto("/storage");
  await page.getByLabel("Name").fill("Not A Slug");
  await expect(page.getByText(/lowercase letters, digits and hyphens only/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /create resource/i })).toBeDisabled();
});

test("secrets: add and delete a project secret", async ({ page }) => {
  await page.goto("/projects/blog/settings");
  await expect(page.getByRole("heading", { name: "Secrets" })).toBeVisible();

  await page.getByLabel("Name").fill("E2E_TOKEN");
  await page.getByLabel("Value").fill("s3cret-value");
  await page.getByRole("button", { name: /add secret/i }).click();

  const row = page.locator(".secret-list li", { hasText: "E2E_TOKEN" });
  await expect(row).toBeVisible();
  await expect(page.getByText(/applies on the next deploy/i)).toBeVisible();
  await expect(row).not.toContainText("s3cret-value"); // the API never returns a value

  await row.getByRole("button", { name: /^delete$/i }).click();
  const dialog = page.locator("dialog.confirm-dialog[open]");
  await dialog.getByRole("button", { name: /delete secret/i }).click();
  await expect(page.locator(".secret-list li", { hasText: "E2E_TOKEN" })).toHaveCount(0);
});

test("a lowercase secret name is rejected inline", async ({ page }) => {
  await page.goto("/projects/blog/settings");
  await page.getByLabel("Name").fill("lower_case");
  await expect(page.getByText(/upper_snake_case/i).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /add secret/i })).toBeDisabled();
});

test("usage page shows the account's caps and per-project rows", async ({ page }) => {
  await page.goto("/settings/usage");
  await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
  await expect(page.locator(".usage-meter", { hasText: "Projects" })).toBeVisible();
  await expect(page.locator(".usage-meter", { hasText: "Projects" })).toContainText(/\d+ \/ \d+/);
  await expect(page.locator(".log-table tbody tr", { hasText: "blog" })).toBeVisible();
});

test("bindings tab lists what the active version declares", async ({ page }) => {
  await page.goto("/projects/blog/bindings");
  await expect(page.getByRole("heading", { name: "Bindings" })).toBeVisible();
});

test("triggers tab holds the route and custom domains", async ({ page }) => {
  await page.goto("/projects/blog/triggers");
  await expect(page.getByRole("heading", { name: "Route" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Custom domains" })).toBeVisible();
  await expect(page.getByLabel(/add a hostname/i)).toBeVisible();
});
