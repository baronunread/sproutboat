import { expect, test, type Page } from "@playwright/test";
import { authFile, gotoHydrated } from "./helpers";

/** Body rows of a resource table: the ikada Table is a labelled scroll region, so it is addressed by that label. */
const rowsOf = (page: Page, label: RegExp) => page.getByRole("region", { name: label }).getByRole("row");

/**
 * #76: the surfaces that existed only in the CLI until now: account storage
 * resources, project secrets, and the limits view.
 */
test.use({ storageState: authFile("test-admin") });

test("#77: KV has its own page: create, rename and delete a namespace", async ({ page }) => {
  await gotoHydrated(page, "/kv");
  await expect(page.getByRole("heading", { name: "KV namespaces" })).toBeVisible();

  await page.getByRole("button", { name: /create namespace/i }).click();
  // Toasts are role=dialog too, so each dialog is addressed by its title.
  const create = page.getByRole("dialog", { name: "Create namespace" });
  await create.getByLabel("Name").fill("e2e-sessions");
  await create.getByRole("button", { name: /create namespace/i }).click();
  await expect(create).toHaveCount(0);

  const row = rowsOf(page, /kv namespaces/i).filter({ hasText: "e2e-sessions" });
  await expect(row).toBeVisible();
  // The cell deliberately truncates to 14 characters, so the full id lives in
  // the title of the code element, which the copy control also copies.
  await expect(row.getByRole("cell").nth(1).locator("code")).toHaveAttribute("title", /^kv_[0-9a-f]{24}$/);
  await expect(row.getByRole("cell").nth(2)).toContainText(/not bound/i); // the "Used by" column

  await row.getByRole("button", { name: "Rename e2e-sessions" }).click();
  const rename = page.getByRole("dialog", { name: "Rename e2e-sessions" });
  await rename.getByLabel("Name").fill("e2e-renamed");
  await rename.getByRole("button", { name: /^save$/i }).click();
  const renamed = rowsOf(page, /kv namespaces/i).filter({ hasText: "e2e-renamed" });
  await expect(renamed).toBeVisible();

  await renamed.getByRole("button", { name: "Delete e2e-renamed" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete e2e-renamed?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /delete namespace/i }).click();
  await expect(rowsOf(page, /kv namespaces/i).filter({ hasText: "e2e-renamed" })).toHaveCount(0);
});

test("#77: each kind is its own page and only lists its own resources", async ({ page }) => {
  await page.goto("/r2");
  await expect(page.getByRole("heading", { name: "R2 buckets" })).toBeVisible();
  await expect(rowsOf(page, /r2 buckets/i).filter({ hasText: "uploads" })).toBeVisible();
  await expect(rowsOf(page, /r2 buckets/i).filter({ hasText: "sessions" })).toHaveCount(0); // the KV one

  await page.goto("/queues");
  await expect(page.getByRole("heading", { name: "Queues" })).toBeVisible();
  await expect(rowsOf(page, /queues/i).filter({ hasText: "jobs" })).toBeVisible();
});

test("the Used by column links a resource to the project that binds it", async ({ page }) => {
  await page.goto("/kv");
  const row = rowsOf(page, /kv namespaces/i).filter({ hasText: "sessions" });
  await expect(row.getByRole("link", { name: "blog" })).toBeVisible();
});

test("a malformed name is rejected before submitting", async ({ page }) => {
  await gotoHydrated(page, "/d1");
  await page.getByRole("button", { name: /create database/i }).click();
  const dialog = page.getByRole("dialog", { name: "Create database" });
  await dialog.getByLabel("Name").fill("Not A Slug");
  await expect(dialog.getByText(/lowercase letters, numbers, and hyphens only/i)).toBeVisible();
  // The form keeps its submit button enabled so it can explain itself: submitting a bad name keeps the dialog open.
  await dialog.getByRole("button", { name: /create database/i }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/lowercase letters, numbers, and hyphens only/i)).toBeVisible();
});

test("secrets: add and delete a project secret", async ({ page }) => {
  await page.goto("/projects/blog/settings");
  await expect(page.getByRole("heading", { name: "Secrets" })).toBeVisible();

  await page.getByRole("button", { name: /^add secret$/i }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Name").fill("E2E_TOKEN");
  const value = form.getByLabel("Value", { exact: true });
  await value.fill("s3cret-value");
  await expect(value).toHaveAttribute("type", "password");
  await form.getByRole("button", { name: /show value/i }).click();
  await expect(value).toHaveAttribute("type", "text");
  await form.getByRole("button", { name: /save secret/i }).click();

  const row = page.getByRole("region", { name: "Secrets" }).locator("tbody tr").filter({ hasText: "E2E_TOKEN" });
  await expect(row).toBeVisible();
  await expect(page.getByText(/applies on the next deploy/i).first()).toBeVisible();
  await expect(row).not.toContainText("s3cret-value"); // the API never returns a value

  await row.getByRole("button", { name: /^delete/i }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /delete secret/i }).click();
  await expect(
    page.getByRole("region", { name: "Secrets" }).locator("tbody tr").filter({ hasText: "E2E_TOKEN" }),
  ).toHaveCount(0);
});

test("a lowercase secret name is rejected inline", async ({ page }) => {
  await page.goto("/projects/blog/settings");
  await page.getByRole("button", { name: /^add secret$/i }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Name").fill("lower case");
  await expect(form.getByText(/upper_snake_case/i).first()).toBeVisible();
  await expect(form.getByRole("button", { name: /save secret/i })).toBeDisabled();
});

test("limits page shows the account's caps and per-project rows", async ({ page }) => {
  await page.goto("/settings/usage");
  await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
  await expect(page.getByText(/protect the box/i)).toBeVisible();
  await expect(page.getByRole("meter", { name: "Projects" })).toBeVisible();
  await expect(page.getByRole("meter", { name: "Projects" })).toContainText(/\d+ of \d+/);
  await expect(rowsOf(page, /per-project usage/i).filter({ hasText: "blog" })).toBeVisible();
});

test("bindings tab lists what the active version declares", async ({ page }) => {
  await page.goto("/projects/blog/bindings");
  await expect(page.getByRole("heading", { name: "Bindings" })).toBeVisible();
});

test("triggers tab holds the route and custom domains", async ({ page }) => {
  await page.goto("/projects/blog/triggers");
  await expect(page.getByRole("heading", { name: "Route" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Custom domains" })).toBeVisible();
  await page.getByRole("button", { name: /^add domain$/i }).click();
  await expect(page.getByRole("dialog").getByLabel(/hostname/i)).toBeVisible();
});
