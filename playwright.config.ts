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
    // 🔴 IN CI, RUN THE ARTIFACT PRODUCTION RUNS — `node server.js` out of `.next/standalone`,
    // which is the Dockerfile's own `CMD ["node", "server.js"]` (Dockerfile:173) with its `PORT` and
    // `HOSTNAME` (169, 171). Locally: the dev server, for hot reload.
    //
    // It used to be `pnpm run start`, i.e. `next start`, and Next warns on every run that
    // `"next start" does not work with "output: standalone"`. That warning was read as advisory
    // because it appears on GitHub-hosted runners too, where the step passes — and on 2026-09-27 it
    // was measured NOT advisory on the self-hosted Railway runner: identical output up to the
    // warning, then NOTHING for the full 120 s timeout, no bind, no error, no server. Hosted
    // satisfied the poll 0.62 s after that same warning.
    //
    // 🔴 The decisive fact is that PRODUCTION NEVER USED `next start`. `output: "standalone"` is
    // unconditional (see above) and the Dockerfile runs the standalone server, so CI was starting the
    // app in a mode that ships nowhere while the real artifact went untested. Running the artifact
    // fixes the environment difference and closes that gap in the same change — and the standalone
    // server is a plain Node process, so it also cannot hit the worker-pool ceiling that made the
    // Build step abort in that container.
    //
    // The two static copies the standalone output requires are made by ci.yml's
    // "Assemble the standalone runtime" step, mirroring Dockerfile:113 and 122. Pinned by
    // tests/next-build-cpu-cap.test.ts.
    command: process.env.CI ? "node server.js" : "pnpm run dev -- -p 3000",
    cwd: process.env.CI ? ".next/standalone" : undefined,
    env: process.env.CI ? { PORT: "3000", HOSTNAME: "127.0.0.1" } : undefined,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // 127.0.0.1 rather than `localhost`: unambiguous in a container, where `localhost` can resolve to
    // `::1` first, and identical on GitHub's runners. This was NOT the cause of the timeout above —
    // changing it did not fix that run — but it is the spelling to keep, and `HOSTNAME` above binds
    // the server to the same address so the two cannot disagree.
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
