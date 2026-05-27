import { defineConfig, devices } from "@playwright/test";

const AUTH_STATE_PATH = "tests/e2e/.auth/user.json";
const DATA_USER_AUTH_STATE_PATH = "tests/e2e/.auth/data-user.json";

const hasDataUser = Boolean(
  process.env.PLAYWRIGHT_DATA_USER_HRID && process.env.PLAYWRIGHT_DATA_USER_PASSWORD,
);

export default defineConfig({
  expect: {
    timeout: 10_000,
  },
  forbidOnly: true,
  fullyParallel: false,
  outputDir: "output/playwright",
  projects: [
    // Auth setup — runs first, saves authenticated browser state for Ali (NSM)
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },
    // Auth setup for the data-bearing user (only meaningful when env vars are set;
    // otherwise the setup self-skips and the dependent project is empty).
    {
      name: "setup-data-user",
      testMatch: /auth\.data-user\.setup\.ts/,
    },
    // Main test suite — uses the saved Ali auth state
    {
      name: "chromium",
      dependencies: ["setup"],
      testIgnore: /data-bearing\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: AUTH_STATE_PATH,
      },
    },
    // Data-bearing test suite — only runs when a data user is configured
    ...(hasDataUser
      ? [
          {
            name: "chromium-data-user",
            dependencies: ["setup-data-user"],
            testMatch: /data-bearing\.spec\.ts/,
            use: {
              ...devices["Desktop Chrome"],
              storageState: DATA_USER_AUTH_STATE_PATH,
            },
          },
        ]
      : []),
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
