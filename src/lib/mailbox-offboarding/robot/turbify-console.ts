/**
 * The real Turbify console driver.
 *
 * 🔴 WHAT IS VERIFIED HERE AND WHAT IS NOT — read this before trusting any selector below.
 *
 * The SIGN-IN selectors were read from the live page on 2026-09-24: login.turbify.com is a Next.js
 * app whose form is a plain `input[type=email]` + `input[type=password]` with a submit button
 * reading "Log in to My Account", and there is NO CAPTCHA on it. Those are real.
 *
 * The MAILBOX selectors are PARTLY real. The per-mailbox action LABELS were read from the live
 * Email Control Panel on 2026-09-24 — Reset password, More actions, Delete user — but the INSIDES
 * of the reset dialog and the delete-confirmation dialog were not, because reading them means
 * clicking a live admin over 288 real mailboxes. So `MAILBOX_SELECTORS` below is still a CALIBRATION
 * SURFACE, not a working set, and the driver REFUSES to run until every value is real and
 * `TURBIFY_SELECTORS_CALIBRATED` is flipped. It fails closed, loudly, with the reason.
 *
 * That refusal is the whole point. The alternative — plausible-looking guessed selectors — would
 * produce a driver that clicks nothing, finds nothing, and reports a clean run over live mailboxes;
 * or worse, one whose guessed delete-confirmation selector confirms the wrong thing. A robot that
 * silently does nothing is indistinguishable from one that worked, and the register would fill with
 * `revoked` rows for mailboxes that are still open. There is no API to catch it.
 *
 * HOW TO CALIBRATE. Capture the reset dialog and the delete-confirmation dialog (two screenshots,
 * or an inspection session that is permitted to click the live console), copy the real selectors
 * in, set TURBIFY_SELECTORS_CALIBRATED to true, and run once with PHOENIX_TURBIFY_ROBOT_DRY_RUN=true.
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
 * 🔴 PARTLY CALIBRATED. The console's LAYOUT was inspected live on 2026-09-24 (Email Control Panel,
 * ecp.turbify.com), so the button TEXT below is real: the per-mailbox actions are exactly
 * "Reset password", "Edit", "Transfer account" and "Delete user", the last three behind a
 * "More actions" menu. What is NOT yet captured is the INSIDE of the two dialogs — the reset
 * dialog's confirm control and the delete dialog's confirm control — because reading them means
 * clicking a live admin over 288 real mailboxes, which is guarded. Those stay `__UNCALIBRATED__`
 * and the flag below stays false until two screenshots of those dialogs fill them in.
 *
 * A driver that ran with a guessed delete-confirmation selector could fail to confirm (harmless) or
 * confirm the wrong thing (catastrophic), so it refuses to run at all until every value is real.
 * The `label:` fields are the human text seen on the console; a calibration turns each into the
 * actual selector/xpath its automation library needs.
 */
const MAILBOX_SELECTORS = {
  /** The account-list search box. Confirmed present ("Search users..."). */
  searchBox: { label: "Search users...", selector: "__UNCALIBRATED__" },
  /** How one mailbox row is opened/selected from the filtered list. */
  mailboxRow: { label: "<the row for the searched address>", selector: "__UNCALIBRATED__" },
  /** Confirmed label: "Reset password" (shown directly on the row and in the More actions menu). */
  resetPassword: { label: "Reset password", selector: "__UNCALIBRATED__" },
  /** Inside the reset dialog — the control that commits the new password. NEEDS A SCREENSHOT. */
  resetConfirm: { label: "<reset dialog confirm button>", selector: "__UNCALIBRATED__" },
  /** The confirmation the console shows AFTER a successful reset. NEEDS A SCREENSHOT. */
  resetConfirmation: { label: "<post-reset success banner>", selector: "__UNCALIBRATED__" },
  /** Confirmed label: "More actions" opens the menu holding Delete user. */
  moreActions: { label: "More actions", selector: "__UNCALIBRATED__" },
  /** Confirmed label: "Delete user" (in the More actions menu and the Edit dialog). */
  deleteUser: { label: "Delete user", selector: "__UNCALIBRATED__" },
  /** Inside the delete dialog — the control that confirms the permanent deletion. NEEDS A SCREENSHOT. */
  deleteConfirm: { label: "<delete dialog confirm button>", selector: "__UNCALIBRATED__" },
  /** What the console shows once the mailbox is gone. NEEDS A SCREENSHOT. */
  deleteConfirmation: { label: "<post-delete confirmation>", selector: "__UNCALIBRATED__" },
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
      await page.waitForSelector(MAILBOX_SELECTORS.searchBox.selector, { timeout: 45_000 }).catch(() => {
        throw new Error(
          "Signed in to Turbify but the mailbox list never appeared. The credential may be wrong, "
          + "or the account was challenged for a second factor.",
        );
      });
    },

    async resetPassword(): Promise<RobotStepResult> {
      throw new TurbifyConsoleNotCalibratedError();
    },

    async deleteMailbox(): Promise<RobotStepResult> {
      throw new TurbifyConsoleNotCalibratedError();
    },

    async close() {
      await browser.close().catch(() => {});
    },
  };
}
