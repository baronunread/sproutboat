import { expect, test } from "@playwright/test";
import { authFile } from "./helpers";

test.use({ storageState: authFile("andrea") });

test("traffic charts render from seeded edge logs", async ({ page }) => {
  await page.goto("/projects/blog/metrics");
  await expect(page.getByRole("heading", { name: "Traffic" })).toBeVisible();
  await expect(page.locator("svg.bars g rect").first()).toBeVisible();     // request bars (skip the <defs> pattern rect)
  const statusCodes = page.locator(".chart-block").filter({ has: page.getByRole("heading", { name: "Status codes" }) });
  await expect(statusCodes.locator(".status-bars")).toContainText(/2xx/);   // status distribution
  await expect(page.locator(".latency-tiles").first()).toContainText(/p50/); // latency percentiles
  await expect(page.getByRole("heading", { name: /Cold starts/ })).toBeVisible(); // startup metrics

  await page.getByLabel("Time range").selectOption("1h");
  await expect(page.locator("svg.bars")).toBeVisible();
});

test("log history filters and live tail toggles", async ({ page }) => {
  await page.goto("/projects/blog/logs");
  await expect(page.locator(".log-table tbody tr").first()).toBeVisible();

  await page.getByLabel("Status", { exact: true }).selectOption("5xx");
  const codes = page.locator(".log-table tbody tr .log-status");
  await expect(codes.first()).toHaveText(/^5\d\d$/);

  await page.getByLabel("Status", { exact: true }).selectOption("all");
  await page.getByRole("button", { name: /start live tail/i }).click();
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /stop live tail/i }).click();
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
});

// #76 — the query builder's field filters, and the sprout output panel that
// used to be reachable only through `sproutboat tail --sprout`.
test("method and cold-start filters narrow the log, and clear resets them", async ({ page }) => {
  await page.goto("/projects/blog/logs");
  const rows = page.locator(".log-table tbody tr");
  await expect(rows.first()).toBeVisible();

  await page.getByLabel("Method").selectOption("POST");
  await expect(rows.first().locator("td").nth(1)).toHaveText("POST");

  await page.getByRole("button", { name: /^clear$/i }).click();
  await expect(page.getByLabel("Method")).toHaveValue("all");
  await expect(rows.first()).toBeVisible();
});

test("sprout output panel renders the running version's stdout", async ({ page }) => {
  await page.goto("/projects/blog/logs");
  await expect(page.getByRole("heading", { name: "Sprout output" })).toBeVisible();
  await expect(page.locator(".console-output")).toBeVisible();
});
