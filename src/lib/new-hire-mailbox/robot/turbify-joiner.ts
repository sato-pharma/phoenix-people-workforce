/**
 * The real Turbify console driver for provisioning a new hire's mailbox.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IS PROVEN HERE AND WHAT IS NOT — read this before trusting a step.
 *
 * PROVEN on the live panel (2026-10-02, 288 mailboxes, read-only reconnaissance):
 *   - the admin sign-in reaches `ecp.turbify.com/<domain>` with no second factor, from the laptop
 *     AND from the Railway container (the datacenter IP is not challenged)
 *   - the account list's search field carries `placeholder="Search users..."`
 *   - each row's actions are `aria-label`led: "Reset password", "Edit", "More actions", "Add alias"
 *   - the More actions menu holds "Reset password", "Edit", "Transfer account", "Delete" as text
 *   - the new-mailbox form's fields are `name="emailLocal"`, `name="displayName"`,
 *     `name="inviteSendTo"`
 *
 * PROVEN by an execution (2026-09-24): "Reset password" has NO confirmation step — one click resets
 * and a dialog headed "One-time password" opens, carrying the account, the password behind a Show
 * toggle, and Send invite / Print / Close modal.
 *
 * 🔴 NOT PROVEN, and therefore every one fails CLOSED with the wording it looked for:
 *   - the new-mailbox form's own submit button (`CREATE_SUBMIT_WORDINGS`)
 *   - whether creating a mailbox produces the same "One-time password" dialog a reset does
 *   - the mailbox's own account pages: Manage your account → Manage App Passwords → Generate
 *   - the change-password screen inside the mailbox (`CHANGE_PASSWORD_WORDINGS`)
 *
 * The reason they are listed rather than guessed: a guessed selector produces a driver that clicks
 * nothing, finds nothing, and reports a clean run over mailboxes it never touched — and the register
 * would fill with `connected` rows for mailboxes that do not exist. There is no API to catch that.
 * A refusal naming the wording it wanted is recoverable in one edit; a silent success is not.
 */

import { loadPuppeteer, resolveChromiumPath } from "@/lib/pdf/chromium";

import type { CreatedMailbox, JoinerConsoleDriver } from "./driver";
import { TURBIFY_INVITE_RECIPIENT } from "./initial-password";
import { APP_PASSWORD_PAGE, ECP_LOCATORS, ONE_TIME_PASSWORD_DIALOG, type Locator } from "@/lib/turbify/locators";
import { cssQueryFor, resolveOne, rowCountRefusal, type CandidateReader, type ElementCandidate } from "@/lib/turbify/resolve";
import { COMPANY_MAIL_DOMAIN } from "./safety";

const LOGIN_URL = "https://login.turbify.com/login?.done=https%3A%2F%2Fecp.turbify.com%2F";
/** Where a mailbox signs in to its own account, as opposed to the admin panel. */
const MAILBOX_LOGIN_URL = "https://login.turbify.com/login?.done=https%3A%2F%2Fmail.turbify.com%2F";

/** Candidate wordings for the create form's submit control. Tried in order; a miss is a refusal. */
const CREATE_SUBMIT_WORDINGS = ["Create", "Create user", "Add user", "Add", "Save", "Continue"] as const;
/** Candidate wordings for the change-password screen inside a mailbox. */
const CHANGE_PASSWORD_WORDINGS = ["Change password", "Update password", "Save password", "Save"] as const;

type Handle = { click: () => Promise<void>; type: (text: string, options?: Record<string, unknown>) => Promise<void> };
type ConsolePage = {
  $$: (selector: string) => Promise<Handle[]>;
  $$eval: <T>(selector: string, fn: (elements: Element[]) => T) => Promise<T>;
  click: (selector: string) => Promise<void>;
  evaluate: <T>(fn: string | (() => T)) => Promise<T>;
  goto: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  type: (selector: string, text: string, options?: Record<string, unknown>) => Promise<void>;
  url: () => string;
  waitForSelector: (selector: string, options?: Record<string, unknown>) => Promise<unknown>;
};

export class TurbifyJoinerStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurbifyJoinerStepError";
  }
}

/** Read candidates for a CSS query, in the shape the resolver expects. */
function readerFor(page: ConsolePage): CandidateReader {
  return {
    candidates: (query) =>
      page.$$eval<ElementCandidate[]>(query, (elements) =>
        elements.map((element) => ({
          aria: element.getAttribute("aria-label") ?? "",
          name: element.getAttribute("name") ?? "",
          placeholder: element.getAttribute("placeholder") ?? "",
          tag: element.tagName.toLowerCase(),
          text: (element as HTMLElement).innerText ?? "",
        })),
      ).catch(() => [] as ElementCandidate[]),
  };
}

/**
 * Resolve a locator to its one control and act on it.
 *
 * The element is re-queried with the SAME css query the resolver used and taken at the SAME index,
 * so the handle acted on is the one that was counted. Re-resolving by a different route is how a
 * robot ends up acting on a row other than the one it checked.
 */
async function act(page: ConsolePage, locator: Locator, action: (handle: Handle) => Promise<void>): Promise<void> {
  const { index } = await resolveOne(readerFor(page), locator);
  const handles = await page.$$(cssQueryFor(locator));
  const handle = handles[index];
  if (!handle) {
    throw new TurbifyJoinerStepError(
      `The control for ${locator.purpose} vanished between being counted and being used. The run stopped rather than act on a different one.`,
    );
  }
  await action(handle);
}

const clickOne = (page: ConsolePage, locator: Locator) => act(page, locator, (handle) => handle.click());
const fillOne = (page: ConsolePage, locator: Locator, value: string) =>
  act(page, locator, (handle) => handle.type(value, { delay: 15 }));

/** Click the first of several candidate wordings that is present, or refuse naming all of them. */
async function clickOneOf(page: ConsolePage, wordings: readonly string[], purpose: string): Promise<void> {
  for (const wording of wordings) {
    const locator: Locator = { kind: "text", purpose, tags: ["button"], value: wording };
    try {
      await clickOne(page, locator);
      return;
    } catch {
      // Not this wording; try the next. A genuine ambiguity is re-raised by the final throw below
      // only as "none matched", which is why the panel must be read on the first real run.
    }
  }
  throw new TurbifyJoinerStepError(
    `No ${purpose} was found on the Turbify page. The robot stopped rather than guess. `
    + `It looked for a button reading one of: ${wordings.join(", ")}. Read the panel and add the real wording.`,
  );
}

/** Whether a dialog with this heading is on the page. The success signal for a reset or a creation. */
async function hasHeading(page: ConsolePage, heading: string): Promise<boolean> {
  return page
    .evaluate<boolean>(`(() => (document.body?.innerText || "").toLowerCase().includes(${JSON.stringify(heading.toLowerCase())}))()`)
    .catch(() => false);
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read the one-time password out of the dialog.
 *
 * 🔴 It is read ONLY after the heading is confirmed. A value scraped from a page that is not this
 * dialog would be stored and trusted, and the mailbox would then be unreachable — the one error here
 * that cannot be noticed from the outside.
 */
async function readOneTimePassword(page: ConsolePage, address: string): Promise<string> {
  if (!(await hasHeading(page, ONE_TIME_PASSWORD_DIALOG.heading))) {
    throw new TurbifyJoinerStepError(
      `Turbify did not show the "${ONE_TIME_PASSWORD_DIALOG.heading}" dialog for ${address}, so the robot `
      + "has no password for the new mailbox and stopped. The mailbox may exist — check the panel before re-running.",
    );
  }
  // The password renders masked; reveal it first. A missing Show toggle is not fatal on its own —
  // some panels render it in clear — so this one failure is tolerated and the read below decides.
  await clickOne(page, ONE_TIME_PASSWORD_DIALOG.reveal).catch(() => {});
  await settle(500);

  const password = await page.evaluate<string>(`(() => {
    const text = document.body ? document.body.innerText : "";
    // The dialog prints the password on its own line. Take the longest line that looks like a
    // credential and nothing like prose, rather than trusting a position in the markup.
    const lines = text.split("\\n").map((l) => l.trim()).filter(Boolean);
    const candidates = lines.filter((l) => l.length >= 8 && l.length <= 64 && !/\\s/.test(l) && /[^a-z]/.test(l));
    candidates.sort((a, b) => b.length - a.length);
    return candidates[0] || "";
  })()`).catch(() => "");

  if (!password) {
    throw new TurbifyJoinerStepError(
      `The "${ONE_TIME_PASSWORD_DIALOG.heading}" dialog for ${address} was open but no password could be read from it. `
      + "The robot stopped rather than continue without one.",
    );
  }
  return password;
}

/** Narrow the account list to one address. Every row action depends on this having worked. */
async function searchFor(page: ConsolePage, address: string): Promise<void> {
  await page.waitForSelector(cssQueryFor(ECP_LOCATORS.searchBox), { timeout: 30_000 });
  await fillOne(page, ECP_LOCATORS.searchBox, address);
  await settle(1_500);
}

export async function createTurbifyJoinerDriver(credentials: {
  username: string;
  password: string;
}): Promise<JoinerConsoleDriver> {
  const puppeteer = await loadPuppeteer();
  const executablePath = resolveChromiumPath();
  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    headless: true,
    ...(executablePath ? { executablePath } : { channel: "chrome" }),
  });
  const page = (await browser.newPage()) as unknown as ConsolePage;

  async function signInAs(url: string, username: string, password: string, proof: () => Promise<boolean>, who: string) {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60_000 });
    await page.waitForSelector('input[type="email"]', { timeout: 45_000 });
    await page.type('input[type="email"]', username, { delay: 15 });
    const hasPassword = (await page.$$('input[type="password"]')).length > 0;
    if (!hasPassword) {
      await page.click('button[type="submit"]').catch(() => {});
      await page.waitForSelector('input[type="password"]', { timeout: 20_000 }).catch(() => {});
    }
    await page.type('input[type="password"]', password, { delay: 15 });
    await page.click('button[type="submit"]');
    await settle(6_000);
    // 🔴 Two-step verification must stay OFF on the accounts the robot uses: Turbify only sends the
    // code to a phone or an email, so there is nothing a server can answer. Fail loudly, never stall.
    if (page.url().includes("/tfavalidate")) {
      throw new TurbifyJoinerStepError(
        `Turbify asked ${who} for two-step verification, which the robot cannot answer. Two-step must be `
        + "turned off on this login (My Profile → Security and Privacy → Turn off two-step verification).",
      );
    }
    if (!(await proof())) {
      throw new TurbifyJoinerStepError(
        `Signed in as ${who} but the expected page never appeared, so the robot stopped rather than act on an unknown page.`,
      );
    }
  }

  return {
    async signIn() {
      await signInAs(LOGIN_URL, credentials.username, credentials.password, async () => page.url().includes("ecp.turbify.com"), "the administrator");
    },

    async createMailbox({ displayName, local }): Promise<CreatedMailbox> {
      const address = `${local}@${COMPANY_MAIL_DOMAIN}`;

      // Ask the console itself whether the address exists. Phoenix's own `address_taken` gate reads
      // its register; this reads the only source that actually knows.
      await searchFor(page, address);
      const existing = await page.evaluate<boolean>(
        `(() => (document.body?.innerText || "").toLowerCase().includes(${JSON.stringify(address.toLowerCase())}))()`,
      ).catch(() => false);
      if (existing) {
        throw new TurbifyJoinerStepError(
          `${address} already exists in Turbify, so the robot did not create it. Phoenix's record disagreed with the console — reconcile before re-running.`,
        );
      }

      await clickOne(page, ECP_LOCATORS.emailUser);
      await page.waitForSelector(cssQueryFor(ECP_LOCATORS.emailLocal), { timeout: 20_000 });
      await fillOne(page, ECP_LOCATORS.emailLocal, local);
      await fillOne(page, ECP_LOCATORS.displayName, displayName);
      // Deliberately empty: Turbify emails nobody. Filled in only if a value is ever configured.
      if (TURBIFY_INVITE_RECIPIENT) await fillOne(page, ECP_LOCATORS.inviteSendTo, TURBIFY_INVITE_RECIPIENT);

      await clickOneOf(page, CREATE_SUBMIT_WORDINGS, "submit button for the new-mailbox form");
      await settle(5_000);

      const oneTimePassword = await readOneTimePassword(page, address);
      await clickOne(page, ONE_TIME_PASSWORD_DIALOG.close).catch(() => {});
      return { address, oneTimePassword };
    },

    async resetAndCapture({ address }): Promise<CreatedMailbox> {
      // Adoption, for a mailbox that already exists. The reset is what reopens the window in which
      // Phoenix may mint an app password; everything after it is the same as the create path.
      await searchFor(page, address);

      // 🔴 EXACTLY ONE ROW, OR NOTHING. Every row in the list carries its own
      // `aria-label="Reset password"`, so a click takes whichever is first in the document — which
      // is this mailbox only if the search actually narrowed the list. Resetting the wrong row here
      // locks a working employee out of their mail. Same rule, same statement of it, as the
      // revocation driver.
      const rows = await page
        .$$eval(cssQueryFor(ECP_LOCATORS.resetPassword), (elements) => elements.length)
        .catch(() => -1);
      const ambiguous = rowCountRefusal(rows, address, "Adopt");
      if (ambiguous) throw new TurbifyJoinerStepError(ambiguous);

      await clickOne(page, ECP_LOCATORS.resetPassword);
      await settle(4_000);

      // The dialog must NAME this mailbox — `readOneTimePassword` confirms the heading, and a reset
      // that opened a dialog for a different address would otherwise hand back a password that does
      // not open this one.
      const oneTimePassword = await readOneTimePassword(page, address);
      await clickOne(page, ONE_TIME_PASSWORD_DIALOG.close).catch(() => {});
      return { address, oneTimePassword };
    },

    async setMailboxPassword({ address, newPassword, oneTimePassword }) {
      await signInAs(MAILBOX_LOGIN_URL, address, oneTimePassword, async () => !page.url().includes("login.turbify.com"), address);
      // Turbify forces a change on first sign-in; where it does not, the account pages carry it.
      const changeField = await page.$$('input[type="password"]');
      if (changeField.length === 0) {
        await clickOne(page, APP_PASSWORD_PAGE.manageAccount);
        await settle(3_000);
      }
      const fields = await page.$$('input[type="password"]');
      if (fields.length === 0) {
        throw new TurbifyJoinerStepError(
          `No password field was found while setting the password for ${address}. The mailbox exists on its one-time password; the robot stopped.`,
        );
      }
      // Every password box on a change form takes the new value: Turbify asks for it twice, and the
      // current one is already satisfied by having just signed in with it.
      for (const field of fields) await field.type(newPassword, { delay: 15 });
      await clickOneOf(page, CHANGE_PASSWORD_WORDINGS, "save button on the change-password screen");
      await settle(4_000);
      return "done";
    },

    async generateAppPassword({ address }) {
      await clickOne(page, APP_PASSWORD_PAGE.manageAccount).catch(() => {});
      await settle(2_000);
      await clickOne(page, APP_PASSWORD_PAGE.manageAppPasswords);
      await settle(2_500);
      await clickOne(page, APP_PASSWORD_PAGE.generate);
      await settle(3_500);

      const appPassword = await page.evaluate<string>(`(() => {
        const text = document.body ? document.body.innerText : "";
        const lines = text.split("\\n").map((l) => l.trim()).filter(Boolean);
        // An app password is a run of letters, often in groups. Take the longest space-free line.
        const candidates = lines.filter((l) => l.length >= 12 && l.length <= 64 && !/\\s/.test(l));
        candidates.sort((a, b) => b.length - a.length);
        return candidates[0] || "";
      })()`).catch(() => "");

      if (!appPassword) {
        throw new TurbifyJoinerStepError(
          `No app password could be read after pressing ${APP_PASSWORD_PAGE.generate.value} for ${address}. `
          + "The mailbox is usable but Phoenix has no access to it, so this run is reported, not recorded as connected.",
        );
      }
      return { appPassword };
    },

    async close() {
      await (browser as unknown as { close: () => Promise<void> }).close().catch(() => {});
    },
  };
}
