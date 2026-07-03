import { defineConfig, devices } from "@playwright/test";

/**
 * Separate, standalone Playwright config for the "Synthetic User Journeys"
 * smoke suite (tests/synthetic/). Deliberately independent of
 * playwright.config.ts / tests/e2e: different testDir, no webServer (point
 * SYNTHETIC_BASE_URL at whatever you want to test — local dev, a preview
 * deployment, or production with SYNTHETIC_ALLOW_PRODUCTION=true), and no
 * shared storage state. See tests/synthetic/README.md.
 */
const AUTH_STATE_PATH = "tests/synthetic/.auth/admin.json";

export default defineConfig({
  testDir: "tests/synthetic",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  forbidOnly: true,
  fullyParallel: false,
  // Serialized on purpose: journeys hit a single dev server that compiles
  // each route on demand. Running them concurrently causes a thundering-herd
  // of first-compiles that individually exceed navigationTimeout. One retry
  // mirrors the same safety net tests/e2e/playwright.config.ts already relies on.
  workers: 1,
  retries: 1,
  outputDir: "output/playwright-synthetic",
  globalSetup: "./tests/synthetic/helpers/global-setup.ts",
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "tests/synthetic/report/html" }],
    ["./tests/synthetic/helpers/reporter.ts"],
  ],
  projects: [
    {
      name: "setup",
      testMatch: /helpers\/auth\.setup\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "journeys",
      testMatch: /journeys\/.*\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: AUTH_STATE_PATH,
      },
    },
  ],
  use: {
    baseURL: process.env.SYNTHETIC_BASE_URL,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
