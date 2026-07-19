import { defineConfig, devices } from "@playwright/test";

/**
 * dev-auth role config — drives the app as any role WITHOUT a password via
 * /api/dev-auth (localhost + NODE_ENV=development only). No auth.setup / storageState:
 * each test establishes its own role session, so this never depends on a real login.
 *
 * IMPORTANT: point the dev server's env at a SAFE database (staging), never production.
 * This repo's .env.local targets prod — override it before running so the role tests
 * don't read/exercise production data.
 *
 * Run (lets Playwright boot `pnpm run dev`, or reuses one you already have on :3000):
 *   pnpm exec playwright test --config playwright.dev-auth.config.ts
 */
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /(outstation-roles|direct-orders-workflow)\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 1,
  outputDir: "output/playwright-dev-auth",
  reporter: [["list"]],
  webServer: {
    command: "pnpm run dev -- -p 3000",
    reuseExistingServer: true,
    timeout: 120_000,
    url: "http://localhost:3000/login",
  },
  use: {
    baseURL: "http://localhost:3000",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
});
