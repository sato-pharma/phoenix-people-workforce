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

import { logInfo } from "@/lib/observability/log";
import { loadPuppeteer, resolveChromiumPath } from "@/lib/pdf/chromium";
import {
  buildControlReport,
  CONTROL_READ_EXPRESSION,
  controlReportEnabled,
  type ObservedControl,
} from "@/lib/turbify/control-report";

import type { CreatedMailbox, JoinerConsoleDriver } from "./driver";
import { TURBIFY_INVITE_RECIPIENT } from "./initial-password";
import { APP_PASSWORD_PAGE, ECP_LOCATORS, ONE_TIME_PASSWORD_DIALOG, type Locator } from "@/lib/turbify/locators";
import {
  cssQueryFor,
  dialogNamesAddress,
  MAILBOX_ROW_QUERY,
  readExistenceFromRows,
  readMailboxRowCells,
  resolveOne,
  rowIdentityRefusal,
  type CandidateReader,
  type ConsoleMailboxRow,
  type ElementCandidate,
  type ExistenceReading,
} from "@/lib/turbify/resolve";
import {
  clearField,
  clickNode,
  CONSOLE_VIEWPORT,
  decideClickDelivery,
  readHitTest,
  type HitTest,
} from "@/lib/turbify/click-delivery";
import { COMPANY_MAIL_DOMAIN } from "./safety";

const LOGIN_URL = "https://login.turbify.com/login?.done=https%3A%2F%2Fecp.turbify.com%2F";
/** Where a mailbox signs in to its own account, as opposed to the admin panel. */
const MAILBOX_LOGIN_URL = "https://login.turbify.com/login?.done=https%3A%2F%2Fmail.turbify.com%2F";
/** The account list. Reloaded before each existence check, because only the first search filters. */
const consoleUrl = `https://ecp.turbify.com/${COMPANY_MAIL_DOMAIN}`;

/** Candidate wordings for the create form's submit control. Tried in order; a miss is a refusal. */
const CREATE_SUBMIT_WORDINGS = ["Create", "Create user", "Add user", "Add", "Save", "Continue"] as const;
/** Candidate wordings for the change-password screen inside a mailbox. */
const CHANGE_PASSWORD_WORDINGS = ["Change password", "Update password", "Save password", "Save"] as const;

type Handle = {
  click: () => Promise<void>;
  type: (text: string, options?: Record<string, unknown>) => Promise<void>;
  /**
   * 🔴 THE ONLY FORM THAT BINDS THE ELEMENT. `page.evaluate(string, handle)` evaluates the string
   * as an expression and ignores the handle, so an arrow-function string never runs at all —
   * measured 2026-10-02, and it made every click in this driver a no-op. Pass a real function.
   */
  evaluate: <T>(fn: (element: Element) => T) => Promise<T>;
};
type ConsolePage = {
  $$: (selector: string) => Promise<Handle[]>;
  $$eval: <T>(selector: string, fn: (elements: Element[]) => T) => Promise<T>;
  click: (selector: string) => Promise<void>;
  // The second form takes an element handle as the expression's argument, which is how the hit test
  // and the node click reach the ONE element `resolveOne` already matched.
  evaluate: <T>(fn: string | (() => T), arg?: Handle) => Promise<T>;
  setViewport: (viewport: { width: number; height: number }) => Promise<void>;
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

/**
 * Click a control, having first checked that the control is what sits at its own centre.
 *
 * 🔴 A COORDINATE CLICK THAT REPORTS SUCCESS IS NOT EVIDENCE THE CONTROL WAS CLICKED — see
 * `@/lib/turbify/click-delivery`. On 2026-10-02 three mailboxes failed to be created because
 * `handle.click()` silently hit a cookie banner lying over the button, and the step then blamed the
 * selector it was waiting for afterwards.
 *
 * By this point `resolveOne` has matched exactly one element, so dispatching on the node cannot
 * reach anything else — which is why an obstruction is handled rather than refused.
 */
async function clickResolved(page: ConsolePage, locator: Locator): Promise<void> {
  await act(page, locator, async (handle) => {
    const hit = await handle
      .evaluate<HitTest>(readHitTest)
      .catch(() => ({ isTopmost: true, obstruction: null }) as HitTest);
    const delivery = decideClickDelivery(hit, locator.purpose);
    if (delivery.via === "coordinates") {
      await handle.click();
      return;
    }
    logInfo("Turbify click delivered on the node because something was covering the control", {
      labels: { event: "turbify_click_obstructed", purpose: locator.purpose, reason: delivery.reason },
    });
    await handle.evaluate<void>(clickNode);
  });
}

const clickOne = (page: ConsolePage, locator: Locator) => clickResolved(page, locator);
/**
 * Type into a field, CLEARING it first.
 *
 * 🔴 `handle.type()` APPENDS. Measured in the production container 2026-10-02: the robot reuses one
 * page for every candidate in a run, so searching for a second address left the box reading
 * `adel.srour@satopharma.comasmaa.zaghloul@satopharma.com` — 54 characters of two addresses joined.
 * A search box in that state filters to nothing, and the "does this address already exist?" test
 * reads the result: the answer it gives is about a string nobody searched for.
 *
 * Clearing is done on the element rather than with keystrokes so it cannot depend on focus or on
 * how many characters happen to be there.
 */
const fillOne = (page: ConsolePage, locator: Locator, value: string) =>
  act(page, locator, async (handle) => {
    await handle.evaluate<void>(clearField).catch(() => {});
    await handle.type(value, { delay: 15 });
  });

/** Click the first of several candidate wordings that is present, or refuse naming all of them. */
/**
 * Submit the form that is open, resolving the control by TYPE rather than by guessing its wording.
 *
 * 🔴 WHY THIS EXISTS, measured on production 2026-10-03. `clickOneOf` tried the create form's submit
 * by text, in the order Create / Create user / Add user / **Add** / Save / Continue — and the console
 * carries a button whose text is exactly "Add": the row's `aria-label="Add alias"` control. Asked for
 * the page's buttons while the create form was open, it answered `["Add", "Save"]`, so the robot
 * clicked ADD ALIAS, never submitted the form, found no "One-time password" dialog, and reported
 * "the mailbox may exist — check the panel" for a mailbox that was never created. The console's count
 * stayed at 288 through every attempt.
 *
 * A wording list cannot fix that: "Add" matched exactly one element, so the ambiguity guard was
 * satisfied — it was unique and wrong. The submit is identified by `type="submit"` instead, which is
 * what the form's own button carries, and the wording list is kept only as a SANITY CHECK: if the one
 * submit control does not read like a submit, the robot refuses rather than pressing it.
 */
async function submitOpenForm(page: ConsolePage, wordings: readonly string[], purpose: string): Promise<void> {
  const query = 'button[type="submit"]';
  const texts = await page
    .$$eval<string[]>(query, (elements) =>
      elements.map((element) => ((element as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim()),
    )
    .catch(() => [] as string[]);

  if (texts.length === 0) {
    throw new TurbifyJoinerStepError(
      `No ${purpose} was found: the open form carries no button[type="submit"]. The robot stopped `
      + "rather than press a control chosen by its wording, which is how it once pressed Add alias.",
    );
  }
  if (texts.length > 1) {
    throw new TurbifyJoinerStepError(
      `${texts.length} submit buttons are present while looking for the ${purpose} (${texts.join(", ")}), `
      + "so the robot cannot tell which one belongs to the form. Nothing was pressed.",
    );
  }
  const allowed = new Set(wordings.map((wording) => wording.toLowerCase()));
  if (!allowed.has(texts[0].toLowerCase())) {
    throw new TurbifyJoinerStepError(
      `The only submit button on the form reads "${texts[0]}", which is not one of the wordings this `
      + `flow expects (${wordings.join(", ")}). The robot stopped rather than press an unrecognised `
      + "control. Read the panel and add the real wording.",
    );
  }
  await clickResolved(page, { kind: "text", purpose, tags: ["button"], value: texts[0] });
}

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

/**
 * Does this EXACT address have a row in the console, and in what state?
 *
 * The caller loads the page first, because only the FIRST search after a load actually filters — a
 * second search on the same page answers about the address before it.
 *
 * 🔴 The answer comes from the rows' own address cells, never from a row COUNT. The console's search
 * is a SUBSTRING match, so `el.sayed@satopharma.com` returns `adel.sayed@satopharma.com` — one row,
 * the wrong employee — and a count-based reader refused a real new hire for ever. See
 * `readExistenceFromRows`.
 */
async function readExistingRow(page: ConsolePage, address: string): Promise<ExistenceReading> {
  await searchFor(page, address);
  const rows = await page
    .$$eval<ConsoleMailboxRow[]>(MAILBOX_ROW_QUERY, readMailboxRowCells)
    .catch(() => null);
  return readExistenceFromRows(rows, address);
}

/**
 * What to say when the form was submitted and no one-time password appeared.
 *
 * 🔴 The point of this function is that "no password" is NOT the same as "nothing happened", and the
 * old message implied the second. Turbify's create makes the mailbox PENDING and hands the password
 * over through the invitation; the dialog only ever belonged to the RESET path. So this re-reads the
 * row and states plainly whether a mailbox now exists on the live domain, and reports the controls
 * the post-save view offered — which is the only way to learn that flow without a redeploy to turn
 * the control report on.
 *
 * The controls go through `buildControlReport`, which is redaction-first, and the address is passed
 * as a known value so it cannot survive into the message either.
 */
async function describeCreateWithoutPassword(
  page: ConsolePage,
  address: string,
  consoleUrl: string,
): Promise<string> {
  // Read the post-save view BEFORE navigating away from it.
  const observed = await page
    .evaluate<ObservedControl[]>(CONTROL_READ_EXPRESSION)
    .catch(() => [] as ObservedControl[]);
  const report = buildControlReport(`after saving the new-mailbox form for ${address}`, observed, [address]);
  const controls = report.controls.slice(0, 10).join(" · ");

  let landed = "could not be re-read, so whether it exists is unknown";
  try {
    await page.goto(consoleUrl, { timeout: 60_000, waitUntil: "networkidle2" });
    const reading = await readExistingRow(page, address);
    if ("refusal" in reading) landed = "could not be re-read, so whether it exists is unknown";
    else if (!reading.exists) landed = "was NOT created";
    else if (reading.status === "unknown") landed = "WAS CREATED, in a state the row did not name";
    else landed = `WAS CREATED and is ${reading.status.toUpperCase()}`;
  } catch {
    landed = "could not be re-read, so whether it exists is unknown";
  }

  return (
    `Turbify did not show the "${ONE_TIME_PASSWORD_DIALOG.heading}" dialog after saving the form for `
    + `${address}, so the robot holds no password for it. The mailbox ${landed}. Turbify's create path `
    + "hands the password over through its invitation rather than through that dialog, so this half of "
    + "the flow is not calibrated yet"
    + (controls.length > 0 ? `. The view it left behind offered: ${controls}` : ".")
  );
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
      + "has no password for it and stopped. Nothing further was clicked.",
    );
  }
  // 🔴 THE DIALOG MUST NAME THIS MAILBOX. The heading only proves A dialog is open. `resetAndCapture`
  // clicks a row action, and if the filter put somebody else's row first, the dialog that opens is
  // theirs — so reading a password out of it would hand back one that does not open this mailbox and
  // record a reset against the wrong employee. Checked BEFORE the reveal, so the comparison never
  // sees the password. Whole tokens, never `includes`: adel.sayed@satopharma.com contains
  // el.sayed@satopharma.com.
  const dialogText = await page
    .evaluate<string>(`(() => {
      const dialog = document.querySelector(".modal-container");
      const scope = dialog || document.body;
      return scope ? (scope.textContent || "") : "";
    })()`)
    .catch(() => "");
  if (!dialogNamesAddress(dialogText, address)) {
    throw new TurbifyJoinerStepError(
      `The "${ONE_TIME_PASSWORD_DIALOG.heading}" dialog is open but does not name ${address}, so it `
      + "belongs to a different mailbox. The robot stopped rather than hand back a password that does "
      + "not open this one.",
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
  // 🔴 EXPLICIT, because puppeteer's default is 800x600 and at that height Turbify's fixed cookie
  // banner covers the console's own buttons — which is exactly how three mailboxes silently failed
  // to be created on 2026-10-02. `click-delivery.ts` carries the measurement.
  await page.setViewport({ ...CONSOLE_VIEWPORT }).catch(() => {});

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
      //
      // 🔴 FROM THE ROWS' OWN ADDRESSES — never the page text, never a row COUNT — and after a
      // FRESH LOAD. Three measured defects sit behind that one sentence, each found after fixing the
      // one before it. A text scan read the residue of the robot's own previous attempt and refused
      // real new hires for ever. A row count then passed a SUBSTRING hit as the mailbox itself:
      // `adel.sayed@satopharma.com` answers a search for `el.sayed@satopharma.com`, so El Sayed Rady
      // was refused while Phoenix's record was right. And the reload matters as much as either —
      // only the FIRST search after a page load actually filters, so a second search on the same
      // page answers about the address before it. See `readExistenceFromRows`.
      await page.goto(consoleUrl, { timeout: 60_000, waitUntil: "networkidle2" });
      const reading = await readExistingRow(page, address);
      if ("refusal" in reading) throw new TurbifyJoinerStepError(reading.refusal);
      if (reading.exists) {
        throw new TurbifyJoinerStepError(
          reading.status === "pending"
            ? `${address} already exists in Turbify as PENDING, so the robot did not create it again. `
              + "A Pending mailbox was created but never completed its invitation, so it carries no "
              + "password at all — it needs that invitation finished, not a second create."
            : `${address} already exists in Turbify, so the robot did not create it. Phoenix's record `
              + "disagreed with the console — reconcile before re-running.",
        );
      }

      await clickOne(page, ECP_LOCATORS.emailUser);
      await page.waitForSelector(cssQueryFor(ECP_LOCATORS.emailLocal), { timeout: 20_000 });
      await fillOne(page, ECP_LOCATORS.emailLocal, local);
      await fillOne(page, ECP_LOCATORS.displayName, displayName);
      // Deliberately empty: Turbify emails nobody. Filled in only if a value is ever configured.
      if (TURBIFY_INVITE_RECIPIENT) await fillOne(page, ECP_LOCATORS.inviteSendTo, TURBIFY_INVITE_RECIPIENT);

      await submitOpenForm(page, CREATE_SUBMIT_WORDINGS, "submit button for the new-mailbox form");
      await settle(5_000);

      // 🔴 THE SUBMIT USUALLY WORKED EVEN WHEN THE NEXT LINE FAILS. Turbify's create does NOT raise
      // the "One-time password" dialog a RESET does: it creates the mailbox as PENDING and relies on
      // an invitation. So the robot must say what it actually left behind on the live domain rather
      // than imply nothing happened — two real mailboxes were created and then reported as never
      // created at all, because `Active mailboxes` excludes Pending and a Pending row carries no
      // `Reset password` button for a count to find.
      if (!(await hasHeading(page, ONE_TIME_PASSWORD_DIALOG.heading))) {
        throw new TurbifyJoinerStepError(await describeCreateWithoutPassword(page, address, consoleUrl));
      }

      const oneTimePassword = await readOneTimePassword(page, address);
      await clickOne(page, ONE_TIME_PASSWORD_DIALOG.close).catch(() => {});
      return { address, oneTimePassword };
    },

    async resetAndCapture({ address }): Promise<CreatedMailbox> {
      // Adoption, for a mailbox that already exists. The reset is what reopens the window in which
      // Phoenix may mint an app password; everything after it is the same as the create path.
      await searchFor(page, address);

      // 🔴 ONE ROW CARRYING THIS EXACT ADDRESS, OR NOTHING. Every row in the list carries its own
      // `aria-label="Reset password"`, so a click takes whichever is first in the document — which
      // is this mailbox only if the search actually narrowed to it. Resetting the wrong row here
      // locks a working employee out of their mail. Same rule, same statement of it, as the
      // revocation driver.
      //
      // 🔴 AND IT IS AN IDENTITY CHECK, NOT A COUNT: the console's search is a substring match, so
      // `el.sayed@satopharma.com` returns the single Active row for `adel.sayed@satopharma.com` —
      // one row, the wrong employee, with its own Reset password button. A count called that safe.
      const rows = await page
        .$$eval<ConsoleMailboxRow[]>(MAILBOX_ROW_QUERY, readMailboxRowCells)
        .catch(() => null);
      const ambiguous = rowIdentityRefusal(rows, address, "Adopt");
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

    async generateAppPassword({ address, password }) {
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

      // 🔴 CALIBRATION, off unless PHOENIX_TURBIFY_REPORT_CONTROLS is exactly "true". This is the one
      // moment anything in Phoenix is standing on this page, signed in as a mailbox — which is the
      // only way to see how an EXISTING app password is listed and removed
      // (`APP_PASSWORD_REVOKE_CONTROLS`, still uncalibrated). Reading it here costs no extra sign-in
      // and touches no other mailbox. It CLICKS NOTHING.
      //
      // The page is displaying the password we just minted, so every secret in hand is passed to the
      // redactor and anything secret-shaped is dropped whatever it is. A failure to read is
      // swallowed: a diagnostic must never fail a provisioning run that has otherwise succeeded.
      if (controlReportEnabled()) {
        try {
          const observed = await page.evaluate<ObservedControl[]>(CONTROL_READ_EXPRESSION);
          const report = buildControlReport("app-passwords", observed ?? [], [appPassword, password]);
          logInfo("Turbify control report", {
            labels: {
              controls: report.controls.join(" || "),
              event: "turbify_control_report",
              observed: report.observed,
              page: report.page,
              redacted: report.redacted,
            },
          });
        } catch {
          // Deliberately silent: the mailbox is provisioned and that is what matters.
        }
      }

      return { appPassword };
    },

    async close() {
      await (browser as unknown as { close: () => Promise<void> }).close().catch(() => {});
    },
  };
}
