import { defineConfig, devices } from "@playwright/test";

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
