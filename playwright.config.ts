import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against a running `bun run dev:local` stack. `globalSetup`
 * fails fast if the stack is down and (re)seeds it via `bun run seed`.
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
