import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { expect, type Page } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));

/** storageState path for a demo user seeded by `bun run seed --e2e`. */
export function authFile(login: string): string {
  const path = resolve(here, ".auth", `${login}.json`);
  if (!existsSync(path)) throw new Error(`missing ${path} — run the seeder (global-setup does this)`);
  return path;
}

/** Real browser login through the GitHub emulator. Used by auth.spec; other specs reuse storageState. */
export async function loginViaEmulator(page: Page, login: string): Promise<void> {
  await page.goto("/login");
  // The button's click handler only exists once React hydrates; retry until the
  // sign-in it triggers actually redirects to the emulator.
  await expect(async () => {
    await page.getByRole("button", { name: /continue with github/i }).click();
    await page.waitForURL(/localhost:4000/, { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await page.getByRole("button", { name: new RegExp(`\\b${login}\\b`) }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login") && url.host.includes("dashboard"));
}

export async function openProject(page: Page, name: string): Promise<void> {
  await page.goto("/projects");
  await page.getByRole("link", { name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${name}$`));
}
