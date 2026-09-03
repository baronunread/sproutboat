import { expect, test } from "@playwright/test";
import { authFile } from "./helpers";

/**
 * #76 — the surfaces that existed only in the CLI until now: account storage
 * resources, project secrets, and the usage-against-limits view.
 */
test.use({ storageState: authFile("andrea") });

test("#77 — KV has its own page: create, rename and delete a namespace", async ({ page }) => {
  await page.goto("/kv");
  await expect(page.getByRole("heading", { name: "KV namespaces" })).toBeVisible();

  await page.getByRole("link", { name: /create namespace/i }).click();
  await expect(page).toHaveURL(/\/kv\/new$/);
  await page.getByLabel(/namespace name/i).fill("e2e-sessions");
  await page.getByRole("button", { name: /create namespace/i }).click();
  await expect(page).toHaveURL(/\/kv$/);

  const row = page.locator(".log-table tbody tr", { hasText: "e2e-sessions" });
  await expect(row).toBeVisible();
  await expect(row).toContainText(/kv_[0-9a-f]{24}/);

  await row.getByRole("button", { name: /^rename$/i }).click();
  await page.getByLabel(/new name for e2e-sessions/i).fill("e2e-renamed");
  await page.getByRole("button", { name: /^save$/i }).click();
  const renamed = page.locator(".log-table tbody tr", { hasText: "e2e-renamed" });
  await expect(renamed).toBeVisible();

  await renamed.getByRole("button", { name: /^delete$/i }).click();
  const dialog = page.locator("dialog.confirm-dialog[open]");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /delete namespace/i }).click();
  await expect(page.locator(".log-table tbody tr", { hasText: "e2e-renamed" })).toHaveCount(0);
});

test("#77 — each kind is its own page and only lists its own resources", async ({ page }) => {
  await page.goto("/r2");
  await expect(page.getByRole("heading", { name: "R2 buckets" })).toBeVisible();
  await expect(page.locator(".log-table tbody tr", { hasText: "uploads" })).toBeVisible();
  await expect(page.locator(".log-table tbody tr", { hasText: "sessions" })).toHaveCount(0); // the KV one

  await page.goto("/queues");
  await expect(page.getByRole("heading", { name: "Queues" })).toBeVisible();
  await expect(page.locator(".log-table tbody tr", { hasText: "jobs" })).toBeVisible();
});

test("a malformed name is rejected before submitting", async ({ page }) => {
  await page.goto("/d1/new");
  await page.getByLabel(/database name/i).fill("Not A Slug");
  await expect(page.getByText(/lowercase letters, digits and hyphens only/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /create database/i })).toBeDisabled();
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
