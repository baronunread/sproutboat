import { expect, test } from "@playwright/test";
import { authFile } from "./helpers";

test.use({ storageState: authFile("andrea") });

test.beforeEach(async ({ page }) => {
  await page.goto("/projects/blog/observability");
});

test("traffic charts render from seeded edge logs", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Traffic" })).toBeVisible();
  await expect(page.locator("svg.bars g rect").first()).toBeVisible();     // request bars (skip the <defs> pattern rect)
  await expect(page.locator(".status-bars")).toContainText(/2xx/);          // status distribution
  await expect(page.locator(".latency-tiles")).toContainText(/p50/);        // latency percentiles

  await page.getByLabel("Chart time range").selectOption("1h");
  await expect(page.locator("svg.bars")).toBeVisible();
});

test("log history filters and live tail toggles", async ({ page }) => {
  await expect(page.locator(".log-table tbody tr").first()).toBeVisible();

  await page.getByLabel("Filter by status class").selectOption("5xx");
  const codes = page.locator(".log-table tbody tr .log-status");
  await expect(codes.first()).toHaveText(/^5\d\d$/);

  await page.getByLabel("Filter by status class").selectOption("all");
  await page.getByRole("button", { name: /start live tail/i }).click();
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /stop live tail/i }).click();
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
});
