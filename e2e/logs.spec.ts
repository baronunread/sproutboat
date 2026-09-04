import { expect, test, type Page } from "@playwright/test";
import { authFile, chooseOption } from "./helpers";

// Body rows of the request log. Anchored on the table's caption and on table
// semantics rather than class names, which are free to change with the styling.
const logRows = (page: Page) => page.getByRole("table", { name: /request log/i }).locator("tbody tr");

test.use({ storageState: authFile("andrea") });

test("traffic charts render from seeded edge logs", async ({ page }) => {
  await page.goto("/projects/blog/metrics");
  await expect(page.getByRole("heading", { name: "Traffic" })).toBeVisible();
  await expect(page.getByRole("img", { name: /requests per time bucket/i })).toBeVisible(); // request bars
  await expect(page.getByRole("heading", { name: "Status codes" })).toBeVisible();
  await expect(page.getByText("2xx", { exact: true })).toBeVisible(); // status distribution
  await expect(page.getByText("p50", { exact: true }).first()).toBeVisible(); // latency percentiles
  await expect(page.getByRole("heading", { name: /Cold starts/ })).toBeVisible(); // startup metrics

  await chooseOption(page, page.getByRole("combobox", { name: "Time range" }), "Last 1 hour");
  await expect(page.getByRole("img", { name: /requests per time bucket/i })).toBeVisible();
});

test("log history filters and live tail toggles", async ({ page }) => {
  await page.goto("/projects/blog/logs");
  await expect(logRows(page).first()).toBeVisible();

  await chooseOption(page, page.getByRole("combobox", { name: "Status" }), "5xx");
  await expect(logRows(page).first().getByRole("cell").nth(2)).toHaveText(/^5\d\d$/);

  await chooseOption(page, page.getByRole("combobox", { name: "Status" }), "All statuses");
  await page.getByRole("button", { name: /start live tail/i }).click();
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /stop live tail/i }).click();
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
});

// #76 — the query builder's field filters, and the sprout output panel that
// used to be reachable only through `sproutboat tail --sprout`.
test("method and cold-start filters narrow the log, and clear resets them", async ({ page }) => {
  await page.goto("/projects/blog/logs");
  const rows = logRows(page);
  await expect(rows.first()).toBeVisible();

  await chooseOption(page, page.getByRole("combobox", { name: "Method" }), "POST");
  await expect(rows.first().getByRole("cell").nth(1)).toHaveText("POST");

  await page.getByRole("button", { name: /^clear$/i }).click();
  // A listbox has no value; the trigger shows the chosen label instead.
  await expect(page.getByRole("combobox", { name: "Method" })).toHaveText("All methods");
  await expect(rows.first()).toBeVisible();
});

test("sprout output panel renders the running version's stdout", async ({ page }) => {
  await page.goto("/projects/blog/logs");
  await expect(page.getByRole("heading", { name: "Sprout output" })).toBeVisible();
  await expect(page.getByLabel("Sprout process output")).toBeVisible();
});
