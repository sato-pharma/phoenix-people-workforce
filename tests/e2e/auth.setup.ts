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

const LOGIN_URL = `${process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000"}/login`;
const AUTH_STATE_PATH = "tests/e2e/.auth/user.json";

setup("authenticate", async ({ page }) => {
  // Navigate to login page
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  // Wait for hydration — the login form inputs appear after React hydration.
  // 🔴 LOCATED BY ITS INPUT ID, NEVER BY THE LABEL TEXT. This was
  // `getByRole("textbox", { name: /HR_ID or Login ID/i })`, and on 2026-10-06 #5418 renamed the
  // label to "HR ID, Login ID or Sato email" — `HR_ID` with an underscore stopped existing, the
  // locator matched nothing, and the login smoke failed on `main`. That is the production deploy
  // gate (AGENTS.md §2), so a copy change withheld the deploy of the very feature that made it.
  // `id="login-id"` is what the field's own `<label htmlFor>` points at; it is the stable handle,
  // and the one thing a wording change cannot move. Three files located this field by its label —
  // this one, tests/e2e/auth.data-user.setup.ts and tests/synthetic/helpers/auth.setup.ts — and
  // they must move together, or the next green run just relocates the failure.
  const hrIdInput = page.locator("#login-id");
  await expect(hrIdInput).toBeVisible({ timeout: 15_000 });
  // No networkidle wait: in CI we run next start (production build, no HMR) so
  // there are no Turbopack pings to settle. In local dev, retries handle any
  // mid-fill HMR reload.

  // Fill in HR ID and password
  await hrIdInput.fill("a-12");
  await page.locator("#login-password").fill("12345678");

  // Submit the form and wait for the authenticated route to commit.
  await Promise.all([
    page.waitForURL((url) => !url.pathname.includes("/login"), {
      timeout: 60_000,
      waitUntil: "domcontentloaded",
    }),
    page.getByRole("button", { name: /^Sign in$/i }).click(),
  ]);

  // Verify we landed on an authenticated page
  await expect(page.locator("body")).toBeVisible();

  // Save the authenticated storage state
  await page.context().storageState({ path: AUTH_STATE_PATH });
});
