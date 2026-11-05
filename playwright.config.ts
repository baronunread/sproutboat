import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against a running `bun run dev:local` stack. `globalSetup`
 * fails fast if the stack is down and (re)seeds it via `bun run seed`.
 *
 * Without SPROUTBOAT_E2E_PLAIN the stack is the Portless one on https. With it
 * (CI, or anywhere Portless cannot bind), start the stack the same way and
 * point Playwright at it: E2E_BASE_URL, E2E_CONTROL_URL and E2E_EMULATOR_URL are
 * printed by `SPROUTBOAT_E2E_PLAIN=1 bun run dev:local`.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // one shared control-plane DB
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL || "https://dashboard.sproutboat.localhost",
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
