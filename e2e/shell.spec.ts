import { expect, test } from "@playwright/test";
import { authFile, gotoHydrated } from "./helpers";

test.describe("signed in", () => {
  test.use({ storageState: authFile("test-admin") });

  test("overview shows the headline numbers and recent deployments", async ({ page }) => {
    await gotoHydrated(page, "/");
    await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
    await expect(page.getByRole("group", { name: "Active projects" })).toContainText(/[23]/);
    await expect(page.getByRole("region", { name: "Recent deployments" }).getByRole("row")).not.toHaveCount(1);
    // The Cloud-only pieces are gone, and so is the namespace claim step.
    await expect(page.getByText(/claim your/i)).toHaveCount(0);
  });

  test("the command palette jumps to a page and to a sprout", async ({ page }) => {
    await gotoHydrated(page, "/");
    await page.getByRole("button", { name: "Search" }).click();
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await palette.getByRole("combobox").fill("blog");
    await expect(palette.getByRole("option", { name: /blog/ })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/projects\/blog$/);

    await page.keyboard.press("Control+K");
    await expect(palette).toBeVisible();
    await palette.getByRole("combobox").fill("queues");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/queues$/);
  });

  test("the account menu switches the theme and remembers it under sproutboat-theme", async ({ page }) => {
    await gotoHydrated(page, "/profile");
    await page.getByLabel("Open account menu").click();
    await page.getByRole("menuitemradio", { name: "Light" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(await page.evaluate(() => localStorage.getItem("sproutboat-theme"))).toBe("light");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.getByLabel("Open account menu").click();
    await expect(page.getByRole("menuitemradio", { name: "Light" })).toBeChecked();
    await page.getByRole("menuitemradio", { name: "System" }).click();
  });

  test("the sidebar rail keeps its state under sproutboat-nav", async ({ page }) => {
    await gotoHydrated(page, "/");
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    expect(await page.evaluate(() => localStorage.getItem("sproutboat-nav"))).toBe("collapsed");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-nav", "collapsed");
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    // Links stay reachable by name in the rail.
    await expect(page.getByRole("link", { name: "Sprouts", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    expect(await page.evaluate(() => localStorage.getItem("sproutboat-nav"))).toBe("expanded");
  });

  test("on a phone the sidebar is a drawer that closes after navigating", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoHydrated(page, "/");
    await expect(page.getByRole("link", { name: "Sprouts", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Open navigation" }).click();
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("link", { name: "Sprouts", exact: true }).click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(drawer).toHaveCount(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBe(0);
  });

  test("the sprouts list searches and sorts", async ({ page }) => {
    await gotoHydrated(page, "/projects");
    const table = page.getByRole("region", { name: "Sprouts", exact: true });
    // danger.spec may already have deleted "scratch", so only the lower bound is fixed.
    await expect(table.getByRole("row").nth(2)).toBeVisible();
    await page.getByRole("searchbox").fill("blo");
    await expect(table.getByRole("row")).toHaveCount(2);
    await page.getByRole("searchbox").fill("zzz");
    await expect(table.getByText(/nothing matches/i)).toBeVisible();
    await page.getByRole("searchbox").fill("");
    await table.getByRole("button", { name: "Name" }).click();
    await expect(table.getByRole("columnheader", { name: "Name" })).toHaveAttribute("aria-sort", "ascending");
    await expect(table.getByRole("row").nth(1)).toContainText("api");
    await table.getByRole("button", { name: "Name" }).click();
    await expect(table.getByRole("columnheader", { name: "Name" })).toHaveAttribute("aria-sort", "descending");
    await expect(table.getByRole("row").last()).toContainText("api");
  });

  test("the profile is a read-only account card", async ({ page }) => {
    await gotoHydrated(page, "/profile");
    await expect(page.getByRole("heading", { name: "Profile", level: 1 })).toBeVisible();
    await expect(page.getByText("Namespace", { exact: true })).toBeVisible();
    await expect(page.getByText("test-admin").first()).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveCount(0);
  });
});

test("the login form reveals the password on request", async ({ page }) => {
  await gotoHydrated(page, "/login");
  const password = page.getByLabel(/^password/i);
  await password.fill("hunter2");
  await expect(password).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Show value" }).click();
  await expect(password).toHaveAttribute("type", "text");
});
