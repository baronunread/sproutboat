import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { expect, type Locator, type Page } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));

/** storageState path for a demo user seeded by `bun run seed --e2e`. */
export function authFile(login: string): string {
  const path = resolve(here, ".auth", `${login}.json`);
  if (!existsSync(path)) throw new Error(`missing ${path} — run the seeder (global-setup does this)`);
  return path;
}

/** The dashboard and the GitHub emulator, as the stack was started (see tools/dev-local.ts for the plain-http variant). */
const dashboardHost = new URL(process.env.E2E_BASE_URL || "https://dashboard.sproutboat.localhost").host;
const emulatorHost = new URL(process.env.E2E_EMULATOR_URL || "http://localhost:4000").host;

/** Real browser login through the GitHub emulator. Used by auth.spec; other specs reuse storageState. */
export async function loginViaEmulator(page: Page, login: string): Promise<void> {
  await page.goto("/login");
  // The button's click handler only exists once React hydrates; retry until the
  // sign-in it triggers actually redirects to the emulator.
  await expect(async () => {
    await page.getByRole("button", { name: /continue with github/i }).click();
    await page.waitForURL((url) => url.host === emulatorHost, { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await page.getByRole("button", { name: new RegExp(`\\b${login}\\b`) }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login") && url.host === dashboardHost);
}

export async function openProject(page: Page, name: string): Promise<void> {
  await page.goto("/projects");
  await page.getByRole("link", { name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${name}$`));
}

/**
 * Pick a value in a select. Both the ikada Select (Base UI) and the legacy
 * SelectField (Radix) are listboxes behind a `combobox` trigger, not native
 * <select>s, so `selectOption` does not apply and the options are portalled
 * to <body>: the trigger may be scoped to a row, the option never is. Options
 * are chosen by their visible label, since a listbox has no value attribute to
 * match on.
 */
export async function chooseOption(page: Page, trigger: Locator, option: string | RegExp): Promise<void> {
  await trigger.click();
  await page.getByRole("option", { name: option }).click();
}

/**
 * Navigate and wait until React has hydrated the page. The dashboard is a prerendered SPA, so the
 * server markup is clickable before any handler exists: a click in that window does nothing and the
 * test fails for a reason that has nothing to do with the feature. React stamps its fiber on the DOM
 * nodes it owns, which is the one signal that the handlers are attached.
 */
export async function gotoHydrated(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForFunction(() => {
    const content = document.getElementById("content");
    return content !== null && Object.keys(content).some((key) => key.startsWith("__reactFiber$"));
  });
}
