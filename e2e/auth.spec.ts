import { expect, test } from "@playwright/test";
import { loginViaEmulator } from "./helpers";

test("an unauthenticated visitor is redirected to /login", async ({ page }) => {
  await page.goto("/projects");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("button", { name: /continue with github/i })).toBeVisible();
});

test("sign in through GitHub, land on the dashboard, then sign out", async ({ page }) => {
  await loginViaEmulator(page, "andrea");
  // Assert the identity, not the <img>. The emulator advertises an avatar_url
  // (/avatars/u/<login>) that it does not serve and that its seed file cannot
  // override, so Avatar's onError always swaps the image for the initial
  // fallback — the old `getByRole("img")` check only passed when it beat that
  // error event. The menu trigger and the username inside it are what actually
  // prove andrea's GitHub profile made it through.
  await expect(page.getByLabel("Open account menu")).toBeVisible();
  await expect(page.getByRole("banner").getByText("Admin", { exact: true })).toBeVisible();

  await page.getByLabel("Open account menu").click();
  // Scoped to the open account menu: sign-in lands on /profile, which also
  // renders the username as its <h2>, so an unscoped text match hits two
  // elements. Scoped by structure, not by a styling class — those move.
  const menu = page.locator("header details[open]");
  await expect(menu.getByText("andrea", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /log out/i }).click();
  await expect(page).toHaveURL(/\/login$/);
});
