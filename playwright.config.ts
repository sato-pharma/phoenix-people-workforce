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
  webServer: {
    // In CI: serve the pre-built production bundle (no HMR, no Turbopack lazy-compile
    // latency — avoids the networkidle / login-timeout flakiness seen with `next dev`).
    // Locally: use the dev server for hot-reload convenience.
    command: process.env.CI ? "pnpm run start" : "pnpm run dev -- -p 3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // 🔴 127.0.0.1, NEVER `localhost` — inside a container `localhost` can resolve to `::1` FIRST,
    // and `next start` binds IPv4, so the readiness poll is refused for the whole 120 s while the
    // server itself logs nothing at all. Measured 2026-09-27 on the self-hosted Railway runner: the
    // same step passes hosted 0.4 s after the server's banner and times out in the container after
    // 120 s, with identical server output up to that point — so the difference is the resolution
    // order, not the server. On GitHub's runners `localhost` already resolves to 127.0.0.1, which
    // is why this is not a special case for one environment but simply the unambiguous spelling.
    // Pinned by tests/next-build-cpu-cap.test.ts.
    url: "http://127.0.0.1:3000/login",
  },
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
      // outstation-roles is dev-auth-only (localhost + NODE_ENV=development); it has its
      // own playwright.dev-auth.config.ts and must not run in the default/CI (prod-mode) run.
      testIgnore: /(data-bearing|outstation-roles)\.spec\.ts/,
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
