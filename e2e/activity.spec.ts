import { expect, test } from "@playwright/test";
import { authFile, chooseOption, gotoHydrated } from "./helpers";

/**
 * The Activity feed, fed by the events the seeder writes: 34 for test-admin across blog, api and
 * scratch over about three weeks, two for member, and a backup that belongs to the box itself.
 */
test.use({ storageState: authFile("test-admin") });

const rowsIn = (page: import("@playwright/test").Page) => page.getByRole("main").locator("section[aria-label] li");

test("the feed groups events by day and shows a row per event", async ({ page }) => {
  await gotoHydrated(page, "/activity");
  await expect(page.getByRole("heading", { name: "Activity", level: 1 })).toBeVisible();
  // Events are spaced 14 hours apart, so a page spans several days.
  await expect.poll(() => page.locator("main section[aria-label] h2").count()).toBeGreaterThanOrEqual(2);
  const rows = rowsIn(page);
  await expect(rows).toHaveCount(25);
  await expect(rows.first()).toContainText("secret.set");
  await expect(rows.first().getByRole("link", { name: "blog" })).toBeVisible();

  // The details disclosure shows the event's data as a description list.
  await rows
    .first()
    .getByRole("button", { name: /show details/i })
    .click();
  await expect(rows.first().getByText("API_KEY", { exact: true })).toBeVisible();
});

test("the type filter narrows the feed to one group", async ({ page }) => {
  await gotoHydrated(page, "/activity");
  await expect(rowsIn(page)).toHaveCount(25);
  await chooseOption(page, page.getByRole("combobox", { name: "Type" }), "Secrets");
  await expect.poll(() => rowsIn(page).filter({ hasNotText: "secret.set" }).count()).toBe(0);
  await expect(rowsIn(page).first()).toContainText("secret.set");
});

test("Load older appends the next page", async ({ page }) => {
  await gotoHydrated(page, "/activity");
  const rows = rowsIn(page);
  await expect(rows).toHaveCount(25);
  await page.getByRole("button", { name: "Load older" }).click();
  await expect.poll(() => rows.count()).toBeGreaterThan(25);
});

test("a project's Activity tab shows only that project", async ({ page }) => {
  await gotoHydrated(page, "/projects/blog/activity");
  const rows = rowsIn(page);
  await expect(rows.first()).toBeVisible();
  await expect(rows.filter({ hasText: /\b(api|scratch)\b/ })).toHaveCount(0);
  await expect(rows.filter({ hasText: /\bblog\b/ }).first()).toBeVisible();
});

test("admins can switch to every account; members cannot", async ({ page, browser }) => {
  await gotoHydrated(page, "/activity");
  await expect(page.getByText("backup.created")).toHaveCount(0); // the box's own event is admin-only
  await page.getByRole("switch", { name: "All accounts" }).click();
  await expect(page.getByText("backup.created")).toBeVisible();

  const context = await browser.newContext({ storageState: authFile("member") });
  const memberPage = await context.newPage();
  await gotoHydrated(memberPage, "/activity");
  await expect(rowsIn(memberPage).first()).toBeVisible();
  await expect(memberPage.getByRole("switch", { name: "All accounts" })).toHaveCount(0);
  await context.close();
});
