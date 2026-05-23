import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";

export default defineConfig({
  expect: {
    timeout: 10_000,
  },
  forbidOnly: true,
  fullyParallel: false,
  outputDir: "output/playwright",
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        baseURL,
      },
    },
  ],
  reporter: [["list"], ["html", { open: "never", outputFolder: "output/playwright-report" }]],
  retries: process.env.CI ? 2 : 1,
  testDir: "tests/e2e",
  timeout: 60_000,
  use: {
    actionTimeout: 15_000,
    baseURL,
    navigationTimeout: 30_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
