import { defineConfig, devices } from "@playwright/test";

const AUTH_STATE_PATH = "tests/e2e/.auth/user.json";

export default defineConfig({
  expect: {
    timeout: 10_000,
  },
  forbidOnly: true,
  fullyParallel: false,
  outputDir: "output/playwright",
  projects: [
    // Auth setup — runs first, saves authenticated browser state
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },
    // Main test suite — uses the saved auth state
    {
      name: "chromium",
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: AUTH_STATE_PATH,
      },
    },
  ],
  reporter: [["list"], ["html", { open: "never", outputFolder: "output/playwright-report" }]],
  retries: 1,
  testDir: "tests/e2e",
  timeout: 60_000,
  use: {
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
});
