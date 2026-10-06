import { test as setup, expect } from "@playwright/test";

/**
 * Logs in once via the real /login form using a Super Admin test account and
 * persists the authenticated browser state so every journey can reuse it.
 * Mirrors tests/e2e/auth.setup.ts, but reads SYNTHETIC_ADMIN_HR_ID /
 * SYNTHETIC_ADMIN_PASSWORD (validated present by helpers/global-setup.ts
 * before this ever runs) and navigates relative to SYNTHETIC_BASE_URL.
 */
const AUTH_STATE_PATH = "tests/synthetic/.auth/admin.json";

setup("authenticate as synthetic admin", async ({ page }) => {
  const hrId = process.env.SYNTHETIC_ADMIN_HR_ID!;
  const password = process.env.SYNTHETIC_ADMIN_PASSWORD!;

  await page.goto("/login", { waitUntil: "domcontentloaded" });

  // Located by the input id, not the label — see the note in tests/e2e/auth.setup.ts.
  const hrIdInput = page.locator("#login-id");
  await expect(hrIdInput).toBeVisible({ timeout: 15_000 });

  await hrIdInput.fill(hrId);
  await page.locator("#login-password").fill(password);

  await Promise.all([
    page.waitForURL((url) => !url.pathname.includes("/login"), {
      timeout: 60_000,
      waitUntil: "domcontentloaded",
    }),
    // Anchored. The login page renders "Sign in with biometrics" beside "Sign in", so an
    // unanchored /Sign in/i resolves to TWO visible buttons — a Playwright strict-mode error,
    // not a pick. Measured on the staging login form, where both buttons render.
    page.getByRole("button", { name: /^Sign in$/i }).click(),
  ]);

  await expect(page.locator("body")).toBeVisible();

  await page.context().storageState({ path: AUTH_STATE_PATH });
});
