import { test as setup, expect } from "@playwright/test";

/**
 * Data-bearing user auth setup.
 *
 * Logs in as a user with expense records so that chart / table /
 * insight rendering can be exercised in CI. The default Ali (a-12) NSM
 * account has no personal trips, which means the expense-dashboard
 * E2E tests fall through to the empty-state branch and never touch
 * the Recharts code paths.
 *
 * Configure via environment variables:
 *   PLAYWRIGHT_DATA_USER_HRID      e.g. "b-94"
 *   PLAYWRIGHT_DATA_USER_PASSWORD  e.g. "12345678"
 *
 * If either env var is missing the setup is skipped and any tests
 * depending on this project are also skipped. This keeps the suite
 * green in environments without a data-bearing fixture.
 */

const LOGIN_URL = "http://localhost:3000/login";
const AUTH_STATE_PATH = "tests/e2e/.auth/data-user.json";

const dataUserHrId = process.env.PLAYWRIGHT_DATA_USER_HRID;
const dataUserPassword = process.env.PLAYWRIGHT_DATA_USER_PASSWORD;

setup("authenticate data-bearing user", async ({ page }) => {
  if (!dataUserHrId || !dataUserPassword) {
    setup.skip(
      true,
      "PLAYWRIGHT_DATA_USER_HRID / PLAYWRIGHT_DATA_USER_PASSWORD not set — skipping data-user auth setup.",
    );
    return;
  }

  // Navigate to login page
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  // Wait for hydration
  const hrIdInput = page.getByRole("textbox", { name: /HR_ID or Login ID/i });
  await expect(hrIdInput).toBeVisible({ timeout: 15_000 });

  // Fill in HR ID and password
  await hrIdInput.fill(dataUserHrId);
  await page.getByRole("textbox", { name: /Password/i }).fill(dataUserPassword);

  // Submit the form and wait for the authenticated route to commit.
  await Promise.all([
    page.waitForURL((url) => !url.pathname.includes("/login"), {
      timeout: 45_000,
      waitUntil: "domcontentloaded",
    }),
    page.getByRole("button", { name: /Sign in/i }).click(),
  ]);

  // Verify we landed on an authenticated page
  await expect(page.locator("body")).toBeVisible();

  // Persist storage state to a dedicated path so the default Ali (a-12)
  // session is not overwritten.
  await page.context().storageState({ path: AUTH_STATE_PATH });
});
