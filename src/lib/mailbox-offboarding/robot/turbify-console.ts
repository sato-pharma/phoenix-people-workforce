/**
 * The real Turbify console driver.
 *
 * 🔴 WHAT IS VERIFIED HERE AND WHAT IS NOT — read this before trusting any selector below.
 *
 * The SIGN-IN selectors were read from the live page on 2026-09-24: login.turbify.com is a Next.js
 * app whose form is a plain `input[type=email]` + `input[type=password]` with a submit button
 * reading "Log in to My Account", and there is NO CAPTCHA on it. Those are real.
 *
 * The MAILBOX selectors are NOT. Reaching the screens that reset a password and revoke app
 * passwords requires an authenticated session, and this repository holds no Turbify credential —
 * deliberately. So `MAILBOX_SELECTORS` below is a CALIBRATION SURFACE, not a working set, and the
 * driver REFUSES to run until it has been filled in against the real console and
 * `TURBIFY_SELECTORS_CALIBRATED` is flipped. It fails closed, loudly, with the reason.
 *
 * That refusal is the whole point. The alternative — plausible-looking guessed selectors — would
 * produce a driver that clicks nothing, finds nothing, and reports a clean run over live mailboxes.
 * A robot that silently does nothing is indistinguishable from one that worked, and the register
 * would fill with `revoked` rows for mailboxes that are still open. There is no API to catch it.
 *
 * HOW TO CALIBRATE. Open the two screens in a signed-in browser, copy the real selectors in, set
 * TURBIFY_SELECTORS_CALIBRATED to true, and run once with PHOENIX_TURBIFY_ROBOT_DRY_RUN=true.
 *
 * WHY puppeteer AND NOT playwright. Playwright is a devDependency here and is not in the
 * production image; `puppeteer-core` plus system Chromium is what the Dockerfile already
 * provisions for PDF rendering (src/lib/pdf/chromium.ts). This reuses that, so the robot adds no
 * dependency and no image weight.
 */

import { loadPuppeteer, resolveChromiumPath, type ChromiumPage } from "@/lib/pdf/chromium";

import type { RobotStepResult, TurbifyConsoleDriver } from "./driver";

/** The console's own sign-in page. Confirmed to redirect here from ecp.turbify.com. */
const LOGIN_URL = "https://login.turbify.com/login?.done=https%3A%2F%2Fecp.turbify.com%2F";

/** Read from the live page on 2026-09-24. These are real. */
const LOGIN_SELECTORS = {
  email: 'input[type="email"]',
  password: 'input[type="password"]',
  submit: 'button[type="submit"]',
} as const;

/**
 * 🔴 NOT YET REAL. Fill these in against the signed-in console, then flip the flag below.
 * Every value is deliberately left as a placeholder that cannot accidentally match anything.
 */
const MAILBOX_SELECTORS = {
  /** How one mailbox is opened from the account list. */
  mailboxRow: "__UNCALIBRATED__",
  /** The control that resets the mailbox password. */
  resetPassword: "__UNCALIBRATED__",
  /** The confirmation the console shows AFTER a successful reset. */
  resetConfirmation: "__UNCALIBRATED__",
  /** The screen or control listing app passwords. */
  appPasswordsList: "__UNCALIBRATED__",
  /** The control that revokes one app password. */
  revokeAppPassword: "__UNCALIBRATED__",
  /** What the console shows when no app passwords remain. */
  appPasswordsEmpty: "__UNCALIBRATED__",
} as const;

/**
 * Flip to true only once every selector above has been read from the real console.
 *
 * A boolean rather than an env var on purpose: this is a property of the CODE being correct, not of
 * the environment being configured, and an env var would let a misconfigured deploy arm an
 * uncalibrated robot.
 */
export const TURBIFY_SELECTORS_CALIBRATED = false;

export class TurbifyConsoleNotCalibratedError extends Error {
  constructor() {
    super(
      "The Turbify console driver has not been calibrated: MAILBOX_SELECTORS in "
      + "src/lib/mailbox-offboarding/robot/turbify-console.ts still holds placeholders. It refuses "
      + "to run rather than report a clean pass over mailboxes it never touched.",
    );
    this.name = "TurbifyConsoleNotCalibratedError";
  }
}

/** The page methods this driver needs, which the PDF-shaped `ChromiumPage` does not declare. */
type ConsolePage = ChromiumPage & {
  goto: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  type: (selector: string, text: string, options?: Record<string, unknown>) => Promise<void>;
  click: (selector: string, options?: Record<string, unknown>) => Promise<void>;
  waitForSelector: (selector: string, options?: Record<string, unknown>) => Promise<unknown>;
  url: () => string;
};

export type TurbifyCredentials = {
  username: string;
  password: string;
};

/**
 * Read the console credential from the environment.
 *
 * Never falls back to a default and never logs the value. Returns null when unset so the caller can
 * refuse with a clear message rather than attempting an anonymous sign-in.
 */
export function readTurbifyCredentials(
  env: { username?: string; password?: string } = {
    username: process.env.PHOENIX_TURBIFY_ADMIN_USER,
    password: process.env.PHOENIX_TURBIFY_ADMIN_PASSWORD,
  },
): TurbifyCredentials | null {
  const username = String(env.username ?? "").trim();
  const password = String(env.password ?? "");
  if (!username || !password) return null;
  return { username, password };
}

/**
 * Build a driver against a real browser.
 *
 * Throws before launching anything when the selectors are uncalibrated or the credential is
 * missing — both are configuration failures, and failing early costs nothing.
 */
export async function createTurbifyConsoleDriver(): Promise<TurbifyConsoleDriver> {
  if (!TURBIFY_SELECTORS_CALIBRATED) throw new TurbifyConsoleNotCalibratedError();

  const credentials = readTurbifyCredentials();
  if (!credentials) {
    throw new Error(
      "PHOENIX_TURBIFY_ADMIN_USER and PHOENIX_TURBIFY_ADMIN_PASSWORD are not both set, so the "
      + "revocation robot cannot sign in to the Turbify console.",
    );
  }

  const puppeteer = await loadPuppeteer();
  const browser = await puppeteer.launch({
    executablePath: resolveChromiumPath(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = (await browser.newPage()) as ConsolePage;

  return {
    async signIn() {
      await page.goto(LOGIN_URL, { waitUntil: "networkidle2" });
      await page.waitForSelector(LOGIN_SELECTORS.email, { timeout: 30_000 });
      await page.type(LOGIN_SELECTORS.email, credentials.username);
      await page.type(LOGIN_SELECTORS.password, credentials.password);
      await page.click(LOGIN_SELECTORS.submit);

      // PROVE the session, never assume it. A sign-in that silently failed would leave every step
      // below finding nothing and reporting success over live mailboxes.
      await page.waitForSelector(MAILBOX_SELECTORS.mailboxRow, { timeout: 45_000 }).catch(() => {
        throw new Error(
          "Signed in to Turbify but the mailbox list never appeared. The credential may be wrong, "
          + "or the account was challenged for a second factor.",
        );
      });
    },

    async resetPassword(): Promise<RobotStepResult> {
      throw new TurbifyConsoleNotCalibratedError();
    },

    async clearAppPasswords(): Promise<RobotStepResult> {
      throw new TurbifyConsoleNotCalibratedError();
    },

    async close() {
      await browser.close().catch(() => {});
    },
  };
}
