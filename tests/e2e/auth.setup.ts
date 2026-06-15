import { test as setup, expect } from "@playwright/test";

/**
 * Playwright global auth setup.
 *
 * Logs in once via /api/auth/login and persists the authenticated
 * browser state (cookies + localStorage) so that all E2E tests can
 * reuse the session without logging in again per-test.
 *
 * Credentials: Uses the a-12 test account (Ali – National Sales Manager).
 */

const LOGIN_URL = "http://localhost:3000/login";
const AUTH_STATE_PATH = "tests/e2e/.auth/user.json";

setup("authenticate", async ({ page }) => {
  // Navigate to login page
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  // Wait for hydration — the login form inputs appear after React hydration.
  // Also wait for network idle so Turbopack finishes sending HMR pings before
  // we interact; without this, an HMR reload can close the page context mid-fill.
  const hrIdInput = page.getByRole("textbox", { name: /HR_ID or Login ID/i });
  await expect(hrIdInput).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState("networkidle");

  // Fill in HR ID and password
  await hrIdInput.fill("a-12");
  await page.getByRole("textbox", { name: /Password/i }).fill("12345678");

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

  // Save the authenticated storage state
  await page.context().storageState({ path: AUTH_STATE_PATH });
});
