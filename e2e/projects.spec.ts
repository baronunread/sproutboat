import { expect, test } from "@playwright/test";
import { authFile, openProject } from "./helpers";

test.use({ storageState: authFile("andrea") });

test("projects list links into the control room", async ({ page }) => {
  await page.goto("/projects");
  await expect(page.getByRole("link", { name: "blog", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "api", exact: true })).toBeVisible();
});

test("control room: navigate all four sections, back/forward, and deep links", async ({ page }) => {
  await openProject(page, "blog");

  const sections = page.getByRole("navigation", { name: "Project sections" });
  for (const [label, path] of [
    ["Deployments", "/projects/blog/deployments"],
    ["Observability", "/projects/blog/observability"],
    ["Settings", "/projects/blog/settings"],
    ["Overview", "/projects/blog"],
  ] as const) {
    await sections.getByRole("link", { name: label }).click();
    await expect(page).toHaveURL(new RegExp(`${path.replace(/\//g, "\\/")}$`));
    await expect(sections.locator(`[aria-current="page"]`)).toHaveText(label);
  }

  await page.goBack();
  await expect(page).toHaveURL(/\/projects\/blog\/settings$/);

  // deep link + reload
  await page.goto("/projects/blog/observability");
  await expect(page.getByRole("heading", { name: /request logs/i })).toBeVisible();
});

test("an unknown project shows a not-found state", async ({ page }) => {
  await page.goto("/projects/does-not-exist");
  await expect(page.getByText(/no project named/i)).toBeVisible();
});
