import { test as setup, expect } from "@playwright/test";

import { totpCode, totpStepAt } from "../../../src/lib/auth/second-step";

/**
 * Logs in once via the real /login form using a Super Admin test account and
 * persists the authenticated browser state so every journey can reuse it.
 * Mirrors tests/e2e/auth.setup.ts, but reads SYNTHETIC_ADMIN_HR_ID /
 * SYNTHETIC_ADMIN_PASSWORD (validated present by helpers/global-setup.ts
 * before this ever runs) and navigates relative to SYNTHETIC_BASE_URL.
 *
 * THE SECOND SIGN-IN STEP (src/lib/auth/second-step.ts) IS SWITCHED OFF (owner, 19 Nov 2026: "remove
 * the auth code feature"), so a right password signs straight in. This setup waits for whichever comes
 * first, the next page or the code field, so it passes either way. While the step was on, a Super
 * Admin's password sign-in also asked for a 6-digit authenticator code, and this account is a Super
 * Admin. Its authenticator key is the
 * repository secret SYNTHETIC_ADMIN_TOTP_SECRET (set up on the server on 14 Nov 2026, never shown),
 * so this setup makes the current code itself and types it where a person would. "Do not ask on this
 * browser for 30 days" is unticked: every run is a fresh browser, and a remembered one would only
 * leave a row behind.
 */
const AUTH_STATE_PATH = "tests/synthetic/.auth/admin.json";

setup("authenticate as synthetic admin", async ({ page }) => {
  const hrId = process.env.SYNTHETIC_ADMIN_HR_ID!;
  const password = process.env.SYNTHETIC_ADMIN_PASSWORD!;
  const totpSecret = process.env.SYNTHETIC_ADMIN_TOTP_SECRET!;

  await page.goto("/login", { waitUntil: "domcontentloaded" });

  // Located by the input id, not the label — see the note in tests/e2e/auth.setup.ts.
  const hrIdInput = page.locator("#login-id");
  await expect(hrIdInput).toBeVisible({ timeout: 15_000 });

  await hrIdInput.fill(hrId);
  await page.locator("#login-password").fill(password);

  await page.getByRole("button", { name: /^Sign in$/i }).click();

  // The password is right: either it signs straight in (the step is switched off) or the same card shows
  // the code field. Each wait settles to a word, never a rejection, so the one that loses leaves nothing behind.
  const codeInput = page.locator("#login-second-step-code");
  const first = await Promise.race([
    page
      .waitForURL((url) => !url.pathname.includes("/login"), { timeout: 60_000, waitUntil: "domcontentloaded" })
      .then(() => "signed_in" as const, () => null),
    codeInput.waitFor({ state: "visible", timeout: 60_000 }).then(() => "code" as const, () => null),
  ]);
  if (first === null) throw new Error("The sign-in neither left /login nor asked for a code within 60 seconds.");
  if (first === "signed_in") {
    await expect(page.locator("body")).toBeVisible();
    await page.context().storageState({ path: AUTH_STATE_PATH });
    return;
  }
  // Never a code in its last seconds: it could expire between typing and the server's check.
  const secondsLeft = 30 - (Math.floor(Date.now() / 1000) % 30);
  if (secondsLeft < 5) await page.waitForTimeout(secondsLeft * 1000 + 500);
  const code = totpCode(totpSecret, totpStepAt(Date.now()));
  if (!code) throw new Error("SYNTHETIC_ADMIN_TOTP_SECRET is not a valid authenticator key.");
  await codeInput.fill(code);
  await page.locator("#login-trust-device").uncheck({ force: true });

  await Promise.all([
    page.waitForURL((url) => !url.pathname.includes("/login"), {
      timeout: 60_000,
      waitUntil: "domcontentloaded",
    }),
    page.getByRole("button", { name: /^Check the code and sign in$/i }).click(),
  ]);

  await expect(page.locator("body")).toBeVisible();

  await page.context().storageState({ path: AUTH_STATE_PATH });
});
