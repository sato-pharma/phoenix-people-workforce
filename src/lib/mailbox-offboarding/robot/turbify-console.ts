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
 * 🔴 TWO-STEP VERIFICATION MUST BE OFF ON THE ROBOT'S LOGIN — and this is a fail-closed check, not a
 * thing the robot can answer. Proven live on 2026-09-24: a headless sign-in with the correct
 * password did NOT reach the console; it advanced to a page titled "Two-Step Verification" at
 * `/tfavalidate` and sent a one-time code. Turbify's two-step verification only sends that code to a
 * mobile phone or email (verified against Turbify help article SLN29023) — it offers NO
 * authenticator-app option — so a headless server cannot generate or receive it. Unattended
 * operation therefore requires two-step verification to be turned OFF on the Turbify login the robot
 * uses (My Profile → Security and Privacy → Turn off two-step verification), a decision the owner
 * took on 2026-09-24 accepting that it removes 2FA from the account that controls every mailbox.
 *
 * If the challenge page appears anyway (2-step re-enabled, or the datacenter IP is challenged even
 * without it), `signIn` throws rather than proceed: a silent stall over live mailboxes is the one
 * outcome worse than stopping.
 */
const TWO_STEP_CHALLENGE_PATH = "/tfavalidate";

/**
 * 🔴 BEHAVIOUR MAPPED LIVE, PUPPETEER SELECTORS NOT YET WRITTEN OR PROVEN. The console was walked on
 * 2026-09-24 (Email Control Panel, ecp.turbify.com, 288 mailboxes). What is now KNOWN for certain:
 *
 *   - The account list has a "Search users..." box; typing an address filters to that mailbox's row.
 *   - Each row has "Add alias", "Reset password", "Edit" and a "More actions" menu. The menu holds
 *     "Reset password", "Edit", "Transfer account" and "Delete".
 *   - 🔴 "Reset password" HAS NO CONFIRMATION. One click resets the password immediately and opens a
 *     dialog headed "One-time password" showing the email account, the new one-time password
 *     (Show / Copy), a login link, and "Send invite" / "Print" / "Close modal". The appearance of
 *     that dialog with the matching email account IS the success signal; the robot then closes it
 *     without sending or printing (a leaver needs no invite).
 *   - 🔴 "Delete" — its confirmation behaviour is UNVERIFIED. It was NOT clicked, because reset
 *     proved this console executes destructive actions with no "are you sure", and a delete is
 *     permanent with no restore and no backup. Whether Delete opens a confirm dialog or deletes on
 *     the click must be observed on the FIRST supervised live deletion, never guessed.
 *
 * The `label:` fields are the confirmed on-screen text; `selector` stays `__UNCALIBRATED__` because
 * the production driver runs headless puppeteer, whose click needs a DOM/xpath selector that a
 * supervised live session must still capture and PROVE. The flag below stays false until then: a
 * delete flow that has never once been run is not something this file will arm over live mailboxes.
 */

/** Reset is a single immediate click — there is no confirmation dialog to click through. */
export const TURBIFY_RESET_HAS_NO_CONFIRMATION = true;

/** Whether Delete opens a confirm dialog is unknown until the first supervised live deletion. */
export const TURBIFY_DELETE_CONFIRMATION_BEHAVIOUR = "unverified" as const;

const MAILBOX_SELECTORS = {
  /** Confirmed label "Search users..."; typing an address filters the list to that row. */
  searchBox: { label: "Search users...", selector: "__UNCALIBRATED__" },
  /** The filtered row for the searched address — the scope every row-action click must be inside. */
  mailboxRow: { label: "<the row for the searched address>", selector: "__UNCALIBRATED__" },
  /** Confirmed label "Reset password". One click; NO confirm dialog. */
  resetPassword: { label: "Reset password", selector: "__UNCALIBRATED__" },
  /** Confirmed: the post-reset dialog is headed "One-time password" — the reset success signal. */
  resetConfirmation: { label: "One-time password", selector: "__UNCALIBRATED__" },
  /** Confirmed label "Close modal" — dismisses the one-time-password dialog without informing anyone. */
  closeModal: { label: "Close modal", selector: "__UNCALIBRATED__" },
  /** Confirmed label "More actions" — opens the row menu holding Delete. */
  moreActions: { label: "More actions", selector: "__UNCALIBRATED__" },
  /** Confirmed label "Delete" (inside the More actions menu). */
  deleteUser: { label: "Delete", selector: "__UNCALIBRATED__" },
  /** UNVERIFIED — the confirm control, IF the delete flow has one. Capture on the first live delete. */
  deleteConfirm: { label: "<delete confirm control — unverified>", selector: "__UNCALIBRATED__" },
  /** The real success signal for a delete: the address is GONE from the list on a re-read. */
  deleteConfirmation: { label: "<address absent from the list after delete>", selector: "__UNCALIBRATED__" },
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

      // Fail closed on a second-factor challenge — the robot cannot answer one (Turbify only sends
      // the code to a phone/email, never an authenticator app). Reaching this page means 2-step is
      // on for this login; stop loudly rather than stall silently over live mailboxes.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      if (page.url().includes(TWO_STEP_CHALLENGE_PATH)) {
        throw new Error(
          "Turbify presented two-step verification, which the robot cannot answer. Two-step "
          + "verification must be turned OFF on the login the robot uses (My Profile → Security and "
          + "Privacy → Turn off two-step verification).",
        );
      }

      // PROVE the session, never assume it. A sign-in that silently failed would leave every step
      // below finding nothing and reporting success over live mailboxes.
      await page.waitForSelector(MAILBOX_SELECTORS.searchBox.selector, { timeout: 45_000 }).catch(() => {
        throw new Error(
          "Signed in to Turbify but the mailbox list never appeared. The credential may be wrong, "
          + "or the account was challenged (a CAPTCHA or a second factor that was not cleared).",
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
