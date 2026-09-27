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
    // 🔴 `PORT` IS THE WHOLE STORY, AND IT IS THE ONE LINE THAT MUST NOT BE REMOVED. A self-hosted
    // runner inherits its Railway service's entire environment, and that service sets `PORT=8080`.
    // Both `next start` and the standalone server bind `process.env.PORT`, falling back to 3000 only
    // when it is UNSET — which is the case on GitHub's hosted runners and nowhere else. So the server
    // came up healthily on 8080 while the readiness poll watched 3000, and the step burned its full
    // 120 s timeout against a port nothing was listening on.
    //
    // Proved from inside the container on 2026-09-28, not inferred:
    //
    //     $ printenv PORT
    //     8080
    //     $ timeout 10 ./node_modules/.bin/next start
    //     ▲ Next.js 16.3.3   - Local: http://localhost:8080   ✓ Ready in 93ms
    //
    // 🔴 SO TWO EARLIER READINGS OF THIS TIMEOUT WERE BOTH WRONG, and the record should say so. It was
    // not IPv6 (`127.0.0.1` changed nothing — there was nothing to connect to on any address), and it
    // was not `output: "standalone"`. The `"next start" does not work with "output: standalone"`
    // warning IS advisory: the server prints it and serves anyway, 93 ms later. Every symptom followed
    // from the port alone — the silence, the 120 s, the instant success on hosted.
    //
    // WHY THE STANDALONE COMMAND STAYS ANYWAY, on its own merits rather than as the fix: the Dockerfile
    // ships `CMD ["node", "server.js"]` (Dockerfile:173) with `PORT`/`HOSTNAME` (169, 171), so running
    // the artifact makes the smoke test exercise what production actually runs instead of a mode that
    // ships nowhere. Its two static copies are made by ci.yml's "Assemble the standalone runtime" step,
    // mirroring Dockerfile:113 and 122. Pinned by tests/next-build-cpu-cap.test.ts.
    command: process.env.CI ? "node server.js" : "pnpm run dev -- -p 3000",
    cwd: process.env.CI ? ".next/standalone" : undefined,
    env: process.env.CI ? { PORT: "3000", HOSTNAME: "127.0.0.1" } : undefined,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // 127.0.0.1 rather than `localhost`: unambiguous in a container, and identical on GitHub's
    // runners. It was NOT the cause of the timeout above and did not fix it, but it is the spelling to
    // keep, and `HOSTNAME` above binds the server to the same address so the two cannot disagree. The
    // PORT in this URL and the PORT in `env` above are the pair that has to match — that is the whole
    // failure, so keep them on adjacent lines where a reader cannot change one and miss the other.
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
