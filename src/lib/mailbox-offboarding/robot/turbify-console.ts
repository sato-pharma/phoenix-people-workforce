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
import { assertRobotDriverAllowedHere } from "@/lib/platform/robot-service";
import { CONSOLE_VIEWPORT } from "@/lib/turbify/click-delivery";
// The exactly-one-row rule is stated ONCE for the whole Turbify console, in the shared resolver,
// so the revocation driver and the provisioning driver cannot drift into two different ideas of
// when it is safe to click a row action.
import {
  dialogNamesAddress,
  MAILBOX_ROW_QUERY,
  readMailboxRowCells,
  rowIdentityRefusal,
  type ConsoleMailboxRow,
} from "@/lib/turbify/resolve";

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
  /** Confirmed live 2026-09-25: the account filter. Typing an address filters the list to its row. */
  searchBox: { label: "Search users...", selector: 'input[placeholder="Search users..."]' },
  /** The filtered row for the searched address. Not needed by the reset flow — it matches on the
   * OTP dialog's address instead — so it stays an uncalibrated placeholder and gates nothing. */
  mailboxRow: { label: "<the row for the searched address>", selector: "__UNCALIBRATED__" },
  /**
   * Confirmed live 2026-09-25: `button[aria-label="More actions"]` (aria-haspopup="menu",
   * bi-three-dots-vertical icon) opens the row menu holding Delete. The RESET flow does NOT use it —
   * the row has a direct reset button (below) — so this is here for the DELETE flow, which stays
   * gated by `TURBIFY_DELETE_CALIBRATED` until that flow is observed live.
   */
  moreActions: { label: "More actions", selector: 'button[aria-label="More actions"]' },
  /**
   * Confirmed live 2026-09-25: the filtered row carries a DIRECT reset button
   * `button[aria-label="Reset password"]` (title "Reset password", bi-key icon) — no need to open
   * the More-actions menu. One click resets immediately; there is NO confirm step (the OTP dialog
   * below is the result, not a confirmation to click through).
   */
  resetPassword: { label: "Reset password", selector: 'button[aria-label="Reset password"]' },
  /**
   * Confirmed live 2026-09-25: the post-reset dialog is `div.modal-container.modal-medium`
   * (role="dialog"), headed "One-time password" and naming the mailbox, with Show / Copy / Close
   * modal / Send invite / Print. Its appearance NAMING THE TARGET ADDRESS is the reset success
   * signal — the driver records nothing without it.
   */
  resetConfirmation: { label: "One-time password", selector: "div.modal-container" },
  /** Confirmed live 2026-09-25: `button[aria-label="Close modal"]` dismisses the OTP dialog quietly. */
  closeModal: { label: "Close modal", selector: 'button[aria-label="Close modal"]' },
  /** Confirmed label "Delete" (inside the More actions menu, carries `text-text-error`); clicked by text. */
  deleteUser: { label: "Delete", selector: "__TEXT__" },
  /** UNVERIFIED — the confirm control, IF the delete flow has one. Capture on the first live delete. */
  deleteConfirm: { label: "<delete confirm control — unverified>", selector: "__UNCALIBRATED__" },
  /** The real success signal for a delete: the address is GONE from the list on a re-read. */
  deleteConfirmation: { label: "<address absent from the list after delete>", selector: "__UNCALIBRATED__" },
} as const;

/** The reset-flow selectors that must ALL be real before `TURBIFY_RESET_CALIBRATED` may be true. */
const RESET_FLOW_SELECTORS: Record<string, string> = {
  searchBox: MAILBOX_SELECTORS.searchBox.selector,
  resetPassword: MAILBOX_SELECTORS.resetPassword.selector,
  resetConfirmation: MAILBOX_SELECTORS.resetConfirmation.selector,
  closeModal: MAILBOX_SELECTORS.closeModal.selector,
};

/**
 * Two flags, one per irreversibility tier, because reset can be proven and armed long before delete
 * can. Reset is reversible and its whole flow was captured live 2026-09-25 (only the "More actions"
 * trigger selector is still outstanding — see `moreActions` above); delete is permanent, has no
 * restore and no backup, and its confirmation behaviour has never once been observed.
 *
 * Booleans rather than env vars on purpose: this is a property of the CODE being correct (the
 * selectors are real), not of the environment being configured — an env var would let a
 * misconfigured deploy arm an uncalibrated robot. The environment only decides whether the robot
 * runs at all (`PHOENIX_TURBIFY_ROBOT_ENABLED`) and whether it is live or dry
 * (`PHOENIX_TURBIFY_ROBOT_DRY_RUN`).
 *
 * 🔴 Do NOT flip `TURBIFY_RESET_CALIBRATED` while any reset-flow selector is still a placeholder —
 * `createTurbifyConsoleDriver` re-checks and throws if you do, so a half-calibrated flip fails
 * loudly at build time rather than clicking `__UNCALIBRATED__` over a live mailbox.
 */
export const TURBIFY_RESET_CALIBRATED = true;
export const TURBIFY_DELETE_CALIBRATED = false;

/**
 * Back-compat alias: the driver is usable (can sign in and reset) once RESET is calibrated. Delete
 * is gated separately by `TURBIFY_DELETE_CALIBRATED` inside `deleteMailbox`.
 */
export const TURBIFY_SELECTORS_CALIBRATED = TURBIFY_RESET_CALIBRATED;

export class TurbifyConsoleNotCalibratedError extends Error {
  constructor() {
    super(
      "The Turbify console driver has not been calibrated for RESET: reset-flow selectors in "
      + "src/lib/mailbox-offboarding/robot/turbify-console.ts still hold placeholders, or "
      + "TURBIFY_RESET_CALIBRATED is false. It refuses to run rather than report a clean pass over "
      + "mailboxes it never touched.",
    );
    this.name = "TurbifyConsoleNotCalibratedError";
  }
}

export class TurbifyDeleteNotCalibratedError extends Error {
  constructor() {
    super(
      "The Turbify console driver has not been calibrated for DELETE: the delete-confirmation "
      + "behaviour has never been observed and TURBIFY_DELETE_CALIBRATED is false. Delete is "
      + "permanent with no restore and no backup, so it refuses rather than guess a confirmation "
      + "click. The task stays pending and the daily sweep keeps alerting on it — the safe failure.",
    );
    this.name = "TurbifyDeleteNotCalibratedError";
  }
}

/** The page methods this driver needs, which the PDF-shaped `ChromiumPage` does not declare. */
type ConsolePage = ChromiumPage & {
  goto: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  type: (selector: string, text: string, options?: Record<string, unknown>) => Promise<void>;
  click: (selector: string, options?: Record<string, unknown>) => Promise<void>;
  waitForSelector: (selector: string, options?: Record<string, unknown>) => Promise<unknown>;
  waitForFunction: (
    fn: (...args: unknown[]) => unknown,
    options?: Record<string, unknown>,
    ...args: unknown[]
  ) => Promise<unknown>;
  /** Counts matches in the page, for the exactly-one-row guard before a reset click. */
  $$eval: <T>(selector: string, fn: (elements: Element[]) => T) => Promise<T>;
  /**
   * Reads a value out of the page. Typed to take a REAL FUNCTION and nothing else: a string crosses
   * the template-literal layers and arrives changed — one lost backslash turned `/\s+/g` into
   * `/s+/g` and made the console's "Email user" button read "Email u er" for an hour.
   */
  evaluate: <T>(fn: () => T) => Promise<T>;
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
  // FIRST, before anything else is read or launched (audit REC-075): once PHOENIX_ROBOT_SERVICE_URL is
  // set, a robot browser opens on the robot service and nowhere else. src/lib/platform/robot-service.ts.
  assertRobotDriverAllowedHere();
  if (!TURBIFY_RESET_CALIBRATED) throw new TurbifyConsoleNotCalibratedError();

  // Belt and suspenders: never let a flip to true stand while a reset-flow selector is still a
  // placeholder. A misconfigured flip fails HERE, at build time, not by clicking "__UNCALIBRATED__"
  // over a live mailbox.
  const stillPlaceholder = Object.entries(RESET_FLOW_SELECTORS)
    .filter(([, selector]) => selector.includes("__UNCALIBRATED__"))
    .map(([name]) => name);
  if (stillPlaceholder.length > 0) {
    throw new Error(
      `TURBIFY_RESET_CALIBRATED is true but these reset-flow selectors are still placeholders: `
      + `${stillPlaceholder.join(", ")}. Fill them from a live capture before arming reset.`,
    );
  }

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
  // 🔴 EXPLICIT, AND THE SECOND COPY OF A BUG THAT ALREADY COST THREE MAILBOXES. This driver launched
  // with no viewport, so puppeteer's default 800x600 applied — and at 600px tall Turbify's cookie
  // banner (fixed, z-index 99999, 188px) covers everything below y=412, which is where the console's
  // row actions sit. On 2026-10-02 that made the JOINER's clicks land on the banner and report
  // success; the identical defect was still sitting here on 2026-10-03, on the leaver path nobody has
  // run yet, where the click it would have swallowed is **Reset password** on a real employee's
  // mailbox. `click-delivery.ts` carries the measurement.
  await (page as unknown as { setViewport?: (v: { height: number; width: number }) => Promise<void> })
    .setViewport?.({ ...CONSOLE_VIEWPORT })
    .catch(() => {});

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

    async resetPassword(address: string): Promise<RobotStepResult> {
      const email = address.trim().toLowerCase();

      // 1. Filter the list to exactly this mailbox. Triple-click selects any address left from a
      //    previous mailbox in the same run so the type() below replaces it rather than appends.
      await page.waitForSelector(MAILBOX_SELECTORS.searchBox.selector, { timeout: 30_000 });
      await page.click(MAILBOX_SELECTORS.searchBox.selector, { clickCount: 3 });
      await page.type(MAILBOX_SELECTORS.searchBox.selector, email);

      // 2. Click the row's DIRECT "Reset password" button (bi-key). The filtered row carries it
      //    inline — no menu to open — and one click resets immediately with no confirm step. If it
      //    never appears the mailbox is not in the list as expected: THROW, never assume it is
      //    already gone (a silent skip would leave a live mailbox open while the register moved on).
      //    The already-revoked case is handled by the gates in safety.ts upstream, not here.
      const resetButton = await page
        .waitForSelector(MAILBOX_SELECTORS.resetPassword.selector, { timeout: 15_000 })
        .catch(() => null);
      if (!resetButton) {
        throw new Error(
          `Reset ${email}: the row's "Reset password" button never appeared after filtering. `
          + `Not resetting a mailbox whose row could not be found.`,
        );
      }
      // 🔴 2b. EXACTLY ONE ROW, OR NOTHING. Every one of the 288 rows carries its own
      //     `aria-label="Reset password"`, so `click()` takes whichever is FIRST in the document —
      //     and that is this mailbox only if the filter above actually narrowed the list. When it
      //     did not (an address that is a prefix of another, a filter that silently failed), the
      //     first button belongs to somebody else and the click resets a WORKING employee out of
      //     their mail. Step 3 would catch it, but only AFTER the reset had happened: detection is
      //     not prevention, so refuse here instead. `countMatches` is the shared Turbify resolver's
      //     rule — exactly one, or stop — applied to the one flow that is already armed.
      //     🔴 AND IT IS AN IDENTITY CHECK, NOT A COUNT — changed 2026-10-03. The console's search
      //     is a SUBSTRING match, so the "prefix of another address" case this comment already
      //     warned about produces exactly ONE row belonging to somebody else:
      //     `adel.sayed@satopharma.com` matches a search for `el.sayed@satopharma.com` and carries
      //     its own Reset password button. The count said "safe to act".
      const rows = await page
        .$$eval<ConsoleMailboxRow[]>(MAILBOX_ROW_QUERY, readMailboxRowCells)
        .catch(() => null);
      const ambiguous = rowIdentityRefusal(rows, email);
      if (ambiguous) throw new Error(ambiguous);

      await page.click(MAILBOX_SELECTORS.resetPassword.selector);

      // 3. The ONLY success signal: the one-time-password dialog appears NAMING THIS MAILBOX. If it
      //    names a different mailbox (wrong row) or never appears, THROW — never record a reset that
      //    was not positively observed on the exact address asked for. Matching the local-part binds
      //    it to this mailbox without depending on how the dialog renders the full address.
      // 🔴 THE IDENTITY TEST IS `dialogNamesAddress` AND IS NOT RE-WRITTEN HERE. This block used to
      // carry its own copy of the tokenisation, and it carried the same defect: it lowercased the
      // dialog's text BEFORE splitting, so the glue `textContent` leaves between the address and the
      // next label (`…satopharma.comOne-time password:`) was unbreakable and no token ever equalled
      // the address. On the joiner that refused a reset Turbify had already performed and told the
      // owner the dialog "belongs to a different mailbox" about his own mailbox (2026-10-03). The
      // leaver path would have failed identically on its first live reset. One vocabulary, one fix.
      const confirmed = await page
        .waitForFunction(
          (args: unknown) => {
            const { heading } = args as { heading: string };
            const dialog = document.querySelector(".modal-container");
            if (!dialog) return false;
            // The heading only proves A dialog is open; WHICH mailbox it names is decided in node,
            // because the in-page function cannot call the shared resolver.
            return (dialog.textContent ?? "").toLowerCase().includes(heading.toLowerCase());
          },
          { timeout: 20_000 },
          { heading: MAILBOX_SELECTORS.resetConfirmation.label },
        )
        .catch(() => null);
      const dialogText = confirmed
        ? await page
          .evaluate<string>(() => {
            const dialog = document.querySelector(".modal-container");
            return dialog ? (dialog.textContent ?? "") : "";
          })
          .catch(() => "")
        : "";
      if (!confirmed || !dialogNamesAddress(dialogText, email)) {
        throw new Error(
          `Reset ${email}: clicked "Reset password" but the "One-time password" dialog naming `
          + `${email} never appeared. Not recording a reset that was not confirmed on this exact `
          + `mailbox.`,
        );
      }

      // 4. Close the dialog without sending an invite or printing — a leaver needs neither.
      await page.click(MAILBOX_SELECTORS.closeModal.selector).catch(() => {});

      return "done";
    },

    async deleteMailbox(): Promise<RobotStepResult> {
      // Reset can be armed; delete cannot until its confirmation behaviour has been observed on a
      // supervised live deletion (no selectors are written for it yet). A delete task therefore
      // fails loudly — a person looks — rather than guessing a confirmation click on a permanent,
      // unbackuppable action. The flag (exported, gated separately) exists so this refusal is a
      // deliberate, greppable state rather than a forgotten stub.
      throw new TurbifyDeleteNotCalibratedError();
    },

    async close() {
      await browser.close().catch(() => {});
    },
  };
}
