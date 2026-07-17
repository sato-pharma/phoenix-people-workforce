import { defineConfig, devices } from "@playwright/test";

/**
 * Staging-targeted Playwright config.
 *
 * Unlike the default `playwright.config.ts` (which boots a LOCAL server via
 * `webServer` and talks to whatever `.env.local` points at), this config runs the
 * existing specs against an ALREADY-DEPLOYED remote app given by PLAYWRIGHT_BASE_URL
 * — e.g. the staging Cloud Run service. No local server is started, so there is no
 * risk of accidentally driving a `.env.local`-configured production database.
 *
 * Run:
 *   PLAYWRIGHT_BASE_URL="https://phoenix-hr-staging-...run.app" \
 *     pnpm exec playwright test --config playwright.staging.config.ts submit-expense
 */

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL;
if (!BASE_URL) {
  throw new Error("PLAYWRIGHT_BASE_URL is required for the staging config (the remote app URL).");
}

const AUTH_STATE_PATH = "tests/e2e/.auth/user.json";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  forbidOnly: true,
  fullyParallel: false,
  retries: 1,
  outputDir: "output/playwright-staging",
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    actionTimeout: 25_000,
    navigationTimeout: 45_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      dependencies: ["setup"],
      use: { storageState: AUTH_STATE_PATH },
    },
  ],
});
