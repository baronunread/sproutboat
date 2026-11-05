import { expect, test } from "@playwright/test";
import { loginViaEmulator } from "./helpers";

test("an unauthenticated visitor is redirected to /login", async ({ page }) => {
  await page.goto("/projects");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("button", { name: /continue with github/i })).toBeVisible();
});

test("sign in through GitHub, land on the dashboard, then sign out", async ({ page }) => {
  await loginViaEmulator(page, "test-admin");
  // Assert the identity, not the <img>. The emulator advertises an avatar_url
  // (/avatars/u/<login>) that it does not serve and that its seed file cannot
  // override, so the Avatar always falls back to the initial. The menu trigger
  // and the username inside it prove the selected GitHub profile made it through.
  await expect(page.getByLabel("Open account menu")).toBeVisible();
  await expect(page.getByRole("banner").getByText("Admin", { exact: true })).toBeVisible();

  await page.getByLabel("Open account menu").click();
  // Scoped to the open account menu: sign-in lands on /profile, which also
  // renders the username as its heading, so an unscoped text match hits two
  // elements. Scoped by role, not by a styling class: those move.
  const menu = page.getByRole("menu");
  await expect(menu.getByText("test-admin", { exact: true })).toBeVisible();
  await menu.getByRole("menuitem", { name: /log out/i }).click();
  await expect(page).toHaveURL(/\/login$/);
});
