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
 * PROVEN in the owner's own Chrome, signed out (2026-10-03) — BOTH login pages read in one sitting:
 *   - `login.turbify.com/login` renders `input[type="email"]` + `input[type="password"]` and ONE
 *     `button[type="submit"]` reading "Log in to My Account"
 *   - `mail.turbify.com/login` ("Bizmail Login") renders `input#email[name="email"][type="text"]`,
 *     `input#password[name="password"]`, an unnamed checkbox that is "Keep me logged in.", and ONE
 *     `button[type="submit"]` reading "Login to Business Mail"
 *   - so BOTH are ONE-STEP forms — there is no "Next" page, and there never was
 *
 * 🔴 NOT PROVEN, and therefore every one fails CLOSED with the wording it looked for:
 *   - the new-mailbox form's own submit button (`CREATE_SUBMIT_WORDINGS`)
 *   - whether creating a mailbox produces the same "One-time password" dialog a reset does
 *   - the mailbox's own account pages: Manage your account → Manage App Passwords → Generate
 *   - the label on the "Set up your mailbox password" page's checkbox, which is why nothing here
 *     ticks it: a consent box is the owner's click, never the robot's
 *
 * 🔴 AND SINCE 2026-10-03 EVERY REFUSAL ON THAT PATH CARRIES THE PAGE IT WAS LOOKING AT
 * (`describePage`). Each earlier calibration cost the owner a click that reported only which
 * selector was missing, so one click bought one guess — and this step's proof was wrong three times
 * in a row that way. A refusal that prints the headings, the inputs and the button wordings turns
 * the next click into the measurement instead.
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

import type {
  AppPasswordPageReading,
  AppPasswordRehearsal,
  CreatedMailbox,
  JoinerConsoleDriver,
  MailboxEditFormField,
  MailboxEditFormReading,
} from "./driver";
import { TURBIFY_INVITE_RECIPIENT } from "./initial-password";
import type { InvitationReading } from "./invitation";
import {
  APP_PASSWORD_PAGE,
  APP_PASSWORD_WORDINGS,
  ECP_LOCATORS,
  MAILBOX_EDIT_FORM,
  ONE_TIME_PASSWORD_DIALOG,
  type Locator,
} from "@/lib/turbify/locators";
import {
  cssQueryFor,
  dialogNamesAddress,
  MAILBOX_ROW_QUERY,
  pickAppPassword,
  pickOneTimePassword,
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
/**
 * Where a mailbox signs in to its own account, as opposed to the admin panel.
 *
 * 🔴 DIRECT, AND NOT THROUGH `login.turbify.com?.done=…`. That round-trip was the previous value and
 * it is not something a selector can be calibrated against, because by the time this step runs the
 * browser is ALREADY HOLDING THE ADMINISTRATOR'S SESSION — and `login.turbify.com/login` with a live
 * session renders no form at all, it forwards to `.done`. Which page the mailbox sign-in landed on
 * therefore depended on a cookie set three steps earlier.
 *
 * Read in the owner's own Chrome, signed out, 2026-10-03 — this URL is a ONE-STEP form:
 *
 *   url     : https://mail.turbify.com/login      title: Bizmail Login
 *   heading : "Business Mail Login"
 *   inputs  : input#email[name="email"][type="text"]        ← and ZERO input[type="email"]
 *             input#password[name="password"][type="password"]
 *             input[type="checkbox"]  — the "Keep me logged in." toggle, and nothing ticks it
 *   submit  : button[type="submit"] reading "Login to Business Mail"
 *
 * Both fields sit on the same page, so there is no "Next" to press, and the mailbox signs in inside
 * its OWN browser context (`openMailboxPage`) where no admin cookie can forward it anywhere.
 */
export const MAILBOX_LOGIN_URL = "https://mail.turbify.com/login";

/**
 * The mailbox's own account pages, as a DIRECT URL.
 *
 * 🔴 TURBIFY PUBLISHES THIS, AND IT REPLACES TWO BLIND CLICKS. Their App Passwords article (SLN29264)
 * says to "Click your profile icon on the top-right", then "Click Manage your account" — and the
 * companion password article describes that first step as "Mouse over your name's initial on the
 * top-right". A HOVER-revealed menu is the one shape `clickOneOf` cannot work: it presses, it never
 * hovers. The same article gives the destination outright — "Mobile users: Go to this link instead:
 * https://mail.turbify.com/accountinfo" — so the robot navigates there and the menu never matters.
 */
export const ACCOUNT_INFO_URL = "https://mail.turbify.com/accountinfo";
/**
 * The submit control on either login page — the sanity check `submitOpenForm` holds the one
 * `button[type="submit"]` against, never a wording it searches BY.
 *
 * Both were read off the live pages on 2026-10-03: the admin page's reads "Log in to My Account",
 * the Bizmail page's "Login to Business Mail". Each page carries exactly one submit button.
 */
export const LOGIN_SUBMIT_WORDINGS = [
  "Login to Business Mail",
  "Log in to My Account",
  "Login",
  "Log in",
  "Sign in",
  "Next",
] as const;
/**
 * The email field on EITHER Turbify login page.
 *
 * Measured in the production container 2026-10-03: the admin page renders `input[type="email"]`,
 * the Bizmail page renders `input#email[name="email"][type="text"]` and **zero** `type="email"`
 * inputs. Exported so a test can assert the union, rather than a session re-deriving it from a
 * page that is no longer in front of anyone.
 */
export const MAILBOX_EMAIL_FIELD = 'input[type="email"], input[name="email"]';
/**
 * 🔴 NO URL CAN TELL A GOOD MAILBOX SIGN-IN FROM A REFUSED ONE. Measured in the production
 * container 2026-10-03, signing in with a one-time password captured in the same run:
 *
 *   url      : https://mail.turbify.com/login      ← IDENTICAL to the form it came from
 *   title    : Bizmail Login                       ← identical too
 *   heading  : "Set up your mailbox password"
 *   inputs   : ["password:password","password:confirmPassword","checkbox:-"]
 *   buttons  : ["Generate mailbox password", …]
 *
 * Turbify serves the forced password-setup page at the SAME URL and under the same title. So the
 * first proof here (`!url.includes("login.turbify.com")`) accepted a refusal, and its replacement
 * (`url` no longer matching `/login`) rejected a SUCCESS — two wrong answers from the same mistake
 * of asking the address bar. What actually differs is the FORM: the setup page has no address field
 * at all, and a refused login still asks for one.
 */
const CONFIRM_PASSWORD_FIELD = 'input[name="confirmPassword"]';
/** The password box — on either login page, and on the setup form. */
const PASSWORD_FIELD = 'input[type="password"]';
/** The account list. Reloaded before each existence check, because only the first search filters. */
const consoleUrl = `https://ecp.turbify.com/${COMPANY_MAIL_DOMAIN}`;

/** Whether a url is ON the admin console's host — the parsed hostname, never a substring of the url. */
export function isConsoleHost(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === "ecp.turbify.com";
  } catch {
    return false;
  }
}

/** Candidate wordings for the create form's submit control. Tried in order; a miss is a refusal. */
const CREATE_SUBMIT_WORDINGS = ["Create", "Create user", "Add user", "Add", "Save", "Continue"] as const;
/** Candidate wordings for the change-password screen inside a mailbox. */
/**
 * The submit control on the mailbox's password-setup screen.
 *
 * 🔴 `"Generate mailbox password"` is FIRST because it is the one wording actually read off the live
 * page (production container, 2026-10-03) — and not one of the four guesses that preceded it matched
 * it, so this step would have failed the moment the sign-in above started working. The others are
 * kept behind it as fallbacks for the change-password screen inside an established mailbox, which
 * is a different page and has not been read yet.
 *
 * Despite the wording, this button SUBMITS the two fields the robot has already filled; it does not
 * mint a password of its own.
 */
export const CHANGE_PASSWORD_WORDINGS = [
  "Generate mailbox password",
  "Change password",
  "Update password",
  "Save password",
  "Save",
] as const;

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
  /** Puppeteer's keyboard. Optional so a fake page need not carry one; used only to press Escape. */
  keyboard?: { press: (key: string) => Promise<void> };
  /**
   * Puppeteer's page events. Optional so a fake page need not carry them; used only to WATCH the
   * network answers to the sign-in press (`watchSignInExchanges`), never to change a request.
   */
  on?: (event: string, listener: (payload: unknown) => void) => unknown;
  off?: (event: string, listener: (payload: unknown) => void) => unknown;
};

export class TurbifyJoinerStepError extends Error {
  /**
   * True ONLY for the one condition that is EXPECTED and self-explanatory: the mailbox already exists
   * in Turbify, so the create path cannot — and must not — run. It is not a console failure (the
   * robot read the console correctly and declined) and it does not self-resolve on a sweep: a Super
   * Admin finishes it on the New Hire Mailboxes card, because adoption and the invitation never run
   * on a schedule. The runner logs this at INFO rather than ERROR, the same treatment the outstation
   * auto-release gives its expected "awaiting a decision" skip (#5453) — the task stays OPEN and
   * surfaced on the card, so the daily ERROR it used to persist to app_error_events was pure
   * duplication that buried genuinely-new failures. Every OTHER throw here is a real problem.
   */
  readonly alreadyExists: boolean;
  constructor(message: string, options: { alreadyExists?: boolean } = {}) {
    super(message);
    this.name = "TurbifyJoinerStepError";
    this.alreadyExists = options.alreadyExists === true;
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
  await act(page, locator, (handle) => deliverClick(handle, locator.purpose));
}

/**
 * The hit-tested click itself, on a handle that has already been resolved to exactly one control.
 *
 * Split out of `clickResolved` unchanged (13 Nov 2026) so the Edit-form capture can check WHICH ROW
 * its one Edit button sits in before pressing it, and still press it through this one path rather
 * than a second copy of it — the module's rule is that a second copy is where the next defect lives.
 */
async function deliverClick(handle: Handle, purpose: string): Promise<void> {
  const hit = await handle
    .evaluate<HitTest>(readHitTest)
    .catch(() => ({ isTopmost: true, obstruction: null }) as HitTest);
  const delivery = decideClickDelivery(hit, purpose);
  if (delivery.via === "coordinates") {
    await handle.click();
    return;
  }
  logInfo("Turbify click delivered on the node because something was covering the control", {
    labels: { event: "turbify_click_obstructed", purpose, reason: delivery.reason },
  });
  await handle.evaluate<void>(clickNode);
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

async function clickOneOf(
  page: ConsolePage,
  wordings: readonly string[],
  purpose: string,
  // 🔴 A LINK IS NOT A BUTTON. The mailbox's own account pages reach `Account info` through an `<a>`,
  // and a list restricted to `button` would have missed every candidate and blamed the wording.
  tags: readonly string[] = ["button"],
): Promise<void> {
  for (const wording of wordings) {
    const locator: Locator = { kind: "text", purpose, tags, value: wording };
    try {
      await clickOne(page, locator);
      return;
    } catch {
      // Not this wording; try the next. A genuine ambiguity is re-raised by the final throw below
      // only as "none matched", which is why the panel must be read on the first real run.
    }
  }
  // The purpose is written with its article ("the App Passwords section") because that is how it
  // reads inside `describeLocator`'s parentheses — so this sentence drops it, or the refusal the
  // owner actually reads says "No the App Passwords section was found". And it names the TAGS it
  // searched: the app-password steps accept a link, and a refusal claiming it looked for a button
  // sends the next reader to check the wrong thing.
  const subject = purpose.replace(/^(?:the|a|an) /i, "");
  throw new TurbifyJoinerStepError(
    `No ${subject} was found on the Turbify page. The robot stopped rather than guess. `
    + `It looked for a ${tags.join(" or ")} reading one of: ${wordings.join(", ")}. `
    + "Read the panel and add the real wording.",
  );
}

/** Whether a dialog with this heading is on the page. The success signal for a reset or a creation. */
async function hasHeading(page: ConsolePage, heading: string): Promise<boolean> {
  // In-page code is a real function, never a string built from a value; the match runs here.
  return page
    .evaluate<string>(() => document.body?.innerText || "")
    .then((text) => text.toLowerCase().includes(heading.toLowerCase()))
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
  /**
   * Why the invitation could not be read, when a reader was attached and tried.
   *
   * 🔴 THE TWO CASES MUST NOT SHARE A SENTENCE. "this half of the flow is not calibrated yet" was
   * true while nothing read the invitation and is a lie once something does — and the owner acts on
   * this sentence. With a refusal in hand the message says the invitation WAS looked for and what
   * stopped it, which is a different job for a different person: a mailbox to connect, or a wording
   * of Turbify's to re-read.
   */
  invitationRefusal?: string | null,
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

  // The mailbox's state comes FIRST in both wordings. It is the one fact that decides what anybody
  // does next, and burying it behind an explanation is how "was created" got read as "failed".
  const head =
    `Turbify did not show the "${ONE_TIME_PASSWORD_DIALOG.heading}" dialog after saving the form for `
    + `${address}, so the robot holds no password for it. The mailbox ${landed}. `;
  const why = invitationRefusal
    ? "Turbify's create path hands the password over through its invitation, and that invitation "
      + `could not be read: ${invitationRefusal}`
    : "Turbify's create path hands the password over through its invitation rather than through that "
      + "dialog, and this driver was built with no way to read the invite inbox";
  return head + why + (controls.length > 0 ? `. The view it left behind offered: ${controls}` : ".");
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long a sign-in is given to land, in two parts.
 *
 * 🔴 A FIXED SIX SECONDS WAS THE WHOLE WAIT UNTIL 2026-11-12, and at 08:15 that morning it was not
 * enough. Every daily sweep from 3 October to 11 November signed the administrator in on it, and on
 * 12 November the page was still on `login.turbify.com/login` six seconds after a delivered click:
 * both fields filled (23 and 11 characters), the form valid, no message on the page, no captcha
 * widget in it. Nothing in the robot had changed since 3 November. A slow answer from Turbify is the
 * reading that fits all of that, and a fixed wait cannot tell slow from refused.
 *
 * The six seconds stay as the FLOOR — every sign-in that passed before still waits exactly as long
 * before the first proof is read, so a page caught mid-navigation (the password box gone, the next
 * page not drawn yet) cannot be mistaken for "past the form". After it the proof is re-read every
 * second until the CEILING, and only then is the run refused. Pinned by
 * `tests/new-hire-mailbox-robot.test.ts`.
 */
export const SIGN_IN_MINIMUM_WAIT_MS = 6_000;
export const SIGN_IN_LANDING_TIMEOUT_MS = 30_000;
const SIGN_IN_POLL_MS = 1_000;

export type SignInLanding = "landed" | "two_step" | "still_on_form";

/**
 * Wait for a submitted sign-in to land: the proof holds, Turbify asks for two-step, or the ceiling
 * passes. Two-step is read FIRST on every look, so a verification page is never waited out.
 */
export async function waitForSignInLanding(
  url: () => string,
  proof: () => Promise<boolean>,
  options: {
    minimumMs?: number;
    timeoutMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<unknown>;
    now?: () => number;
  } = {},
): Promise<SignInLanding> {
  const sleep = options.sleep ?? settle;
  const now = options.now ?? Date.now;
  const minimum = options.minimumMs ?? SIGN_IN_MINIMUM_WAIT_MS;
  const ceiling = Math.max(minimum, options.timeoutMs ?? SIGN_IN_LANDING_TIMEOUT_MS);
  const poll = Math.max(1, options.pollMs ?? SIGN_IN_POLL_MS);
  const started = now();
  await sleep(minimum);
  for (;;) {
    if (url().includes("/tfavalidate")) return "two_step";
    if (await proof().catch(() => false)) return "landed";
    if (now() - started >= ceiling) return "still_on_form";
    await sleep(poll);
  }
}

/**
 * Installed on the login page BEFORE the submit — a real function, never a string (module rule).
 * It keeps the text of every message the page shows afterwards, because a toast can come and go
 * inside the wait. Read 2026-11-12 in Turbify's own login-page code: a submit with its captcha
 * shown and unticked answers with a pop-up error and nothing else, and a description
 * read at the end of the wait sees an empty page. Text only, capped, and run through
 * `withoutSecrets` before it is printed — the page never writes a credential as text, and if it ever
 * did, the redaction is the second wall.
 */
export function recordSignInNotices(): boolean {
  const kept: string[] = [];
  (window as unknown as { __phoenixSignInNotices?: string[] }).__phoenixSignInNotices = kept;
  const looksLikeNotice = (element: Element) => {
    const role = (element.getAttribute("role") || "").toLowerCase();
    const live = (element.getAttribute("aria-live") || "").toLowerCase();
    const cls = String((element as HTMLElement).className || "").toLowerCase();
    return role === "alert" || role === "status" || live === "assertive" || live === "polite"
      || /toast|notif|snack|alert|error|message/.test(cls);
  };
  const take = (element: Element) => {
    const text = ((element as HTMLElement).innerText || element.textContent || "").replace(/\s+/g, " ").trim();
    if (text.length > 0 && text.length <= 300 && kept.indexOf(text) === -1 && kept.length < 6) kept.push(text);
  };
  try {
    new MutationObserver((changes) => {
      for (const change of changes) {
        const node = change.target;
        const target = node && node.nodeType === 1 ? (node as Element) : node ? node.parentElement : null;
        if (target && looksLikeNotice(target)) take(target);
        for (const added of Array.from(change.addedNodes || [])) {
          if (added.nodeType !== 1) continue;
          const element = added as Element;
          if (looksLikeNotice(element)) take(element);
          for (const inner of Array.from(element.querySelectorAll("[role=alert],[role=status],[aria-live]"))) take(inner);
        }
      }
    }).observe(document.documentElement, { characterData: true, childList: true, subtree: true });
  } catch {
    // An observer that cannot start costs only the notices; the sign-in itself is unaffected.
  }
  return true;
}

/** What the login page showed that explains a sign-in that did not land. */
export type SignInBlockers = {
  /** A reCAPTCHA (or other "I'm not a robot") widget is on the page. */
  captcha: boolean;
  /** Messages the page showed after the submit, in order — including ones already gone. */
  notices: string[];
  /**
   * Hidden bot checks the page LOADS: the host of each script or frame from a known bot-check
   * provider, never its query (a site key or token can ride there). An invisible check draws no
   * widget, so `captcha` cannot see it; this can (14 Nov 2026, the second silent stall).
   */
  botChecks?: string[];
  /** What the page itself reads from `navigator.webdriver`: true means it can tell it is automated. */
  webdriver?: boolean | null;
  /** The network answers to the press, from `watchSignInExchanges`. Filled outside the page. */
  exchanges?: SignInExchange[];
};

/**
 * The bot-check providers a login page may load invisibly, as `host` or `host/path-prefix`.
 * `readSignInBlockersInPage` carries its own copy, because it runs INSIDE the page where module
 * constants do not exist; the test holds the two lists equal.
 */
export const BOT_CHECK_SOURCES = [
  "recaptcha.net",
  "www.google.com/recaptcha",
  "www.gstatic.com/recaptcha",
  "hcaptcha.com",
  "arkoselabs.com",
  "funcaptcha.com",
  "challenges.cloudflare.com",
  "perimeterx.net",
  "px-cdn.net",
  "px-cloud.net",
  "datadome.co",
  "captcha-delivery.com",
  "kasada.io",
] as const;

export function readSignInBlockersInPage(): SignInBlockers {
  const captcha = Boolean(document.querySelector(
    'iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[title*="captcha" i],textarea[name="g-recaptcha-response"],.g-recaptcha,[data-sitekey]',
  ));
  const kept = (window as unknown as { __phoenixSignInNotices?: unknown }).__phoenixSignInNotices;
  const notices = Array.isArray(kept) ? kept.slice(0, 6).map(String) : [];
  const known = [
    "recaptcha.net", "www.google.com/recaptcha", "www.gstatic.com/recaptcha", "hcaptcha.com", "arkoselabs.com",
    "funcaptcha.com", "challenges.cloudflare.com", "perimeterx.net", "px-cdn.net", "px-cloud.net", "datadome.co",
    "captcha-delivery.com", "kasada.io",
  ];
  const botChecks: string[] = [];
  const sources = typeof document.querySelectorAll === "function"
    ? Array.from(document.querySelectorAll("script[src],iframe[src]")).map((element) => String(element.getAttribute("src") || ""))
    : [];
  for (const source of sources) {
    let host = "";
    let where = "";
    try {
      const parsed = new URL(source, "https://login.turbify.com/");
      host = parsed.host.toLowerCase();
      where = `${host}${parsed.pathname.toLowerCase()}`;
    } catch {
      continue;
    }
    for (const entry of known) {
      const matched = entry.includes("/")
        ? where.startsWith(entry)
        : host === entry || host.endsWith(`.${entry}`);
      if (matched && botChecks.indexOf(entry) === -1) botChecks.push(entry);
    }
  }
  const nav = (typeof navigator === "undefined" ? null : navigator) as { webdriver?: unknown } | null;
  const webdriver = nav && typeof nav.webdriver === "boolean" ? nav.webdriver : null;
  return { botChecks, captcha, notices, webdriver };
}

async function readSignInBlockers(page: ConsolePage): Promise<SignInBlockers> {
  const read = await page.evaluate<SignInBlockers>(readSignInBlockersInPage).catch(() => null);
  return {
    botChecks: Array.isArray(read?.botChecks) ? read.botChecks.map(String).slice(0, 8) : [],
    captcha: Boolean(read?.captcha),
    notices: Array.isArray(read?.notices) ? read.notices.map(String) : [],
    webdriver: typeof read?.webdriver === "boolean" ? read.webdriver : null,
  };
}

/**
 * One network answer seen after the sign-in press: the method, the HOST and PATH, and the status (or
 * why the request failed). 🔴 NEVER a query, a fragment, a header or a body: a sign-in's query and
 * body are exactly where a credential or a token rides. The printed line still passes through
 * `withoutSecrets` as a second wall.
 */
export type SignInExchange = { failed: string | null; method: string; status: number | null; target: string };

/** `host/path` of a request, or null for anything that is not http(s). Query and fragment dropped. */
export function exchangeTarget(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return `${parsed.host}${parsed.pathname}`.slice(0, 160);
  } catch {
    return null;
  }
}

/** Static files say nothing about a refusal; documents, calls and anything that is not a GET do. */
export function isTellingExchange(method: string, resourceType: string): boolean {
  if (method.toUpperCase() !== "GET") return true;
  return resourceType === "document" || resourceType === "xhr" || resourceType === "fetch";
}

type WatchedRequest = {
  failure?: () => { errorText?: string } | null;
  method?: () => string;
  resourceType?: () => string;
  url?: () => string;
};
type WatchedResponse = { request?: () => WatchedRequest; status?: () => number; url?: () => string };

/**
 * Watch the network answers to the sign-in press, READ-ONLY: it listens, it never intercepts, holds or
 * changes a request. Installed just before the press and stopped when the wait ends. A page with no
 * events (a fake) records nothing.
 *
 * WHY (14 Nov 2026): the second silent stall in three days. The form was valid, the press delivered,
 * no message, no captcha widget, the page still on the login form 30 seconds later, and a hand
 * sign-in did not clear it. What Turbify answered to the press is the one fact that separates slow,
 * refused and never sent, and nothing recorded it.
 */
export function watchSignInExchanges(page: ConsolePage, limit = 12): { stop: () => SignInExchange[] } {
  const seen: SignInExchange[] = [];
  const keep = (entry: SignInExchange) => {
    if (seen.length < limit) seen.push(entry);
  };
  const onResponse = (payload: unknown) => {
    try {
      const response = payload as WatchedResponse;
      const request = response.request?.();
      const method = String(request?.method?.() ?? "GET");
      if (!isTellingExchange(method, String(request?.resourceType?.() ?? ""))) return;
      const target = exchangeTarget(String(response.url?.() ?? ""));
      if (!target) return;
      keep({ failed: null, method, status: Number(response.status?.() ?? 0) || null, target });
    } catch {
      // A reading that cannot be taken costs only that line.
    }
  };
  const onFailed = (payload: unknown) => {
    try {
      const request = payload as WatchedRequest;
      const method = String(request.method?.() ?? "GET");
      if (!isTellingExchange(method, String(request.resourceType?.() ?? ""))) return;
      const target = exchangeTarget(String(request.url?.() ?? ""));
      if (!target) return;
      keep({ failed: String(request.failure?.()?.errorText ?? "failed").slice(0, 80), method, status: null, target });
    } catch {
      // As above.
    }
  };
  page.on?.("response", onResponse);
  page.on?.("requestfailed", onFailed);
  return {
    stop: () => {
      page.off?.("response", onResponse);
      page.off?.("requestfailed", onFailed);
      return seen.slice();
    },
  };
}

/**
 * The refusal for a sign-in that never landed, in the words someone has to act on.
 *
 * 🔴 A CAPTCHA IS NAMED AND NEVER ANSWERED. The robot does not solve, skip or route around one; it
 * stops and says so, because the only honest fix is a person signing in to Turbify by hand once so
 * Turbify trusts the login again.
 */
export function describeSignInStall(
  who: string,
  waitedMs: number,
  blockers: SignInBlockers,
  page: string,
  secrets: readonly string[],
): string {
  const seconds = Math.round(waitedMs / 1000);
  const notices = blockers.notices.map((notice) => withoutSecrets(notice, secrets)).filter((notice) => notice.length > 0);
  const said = notices.length > 0 ? ` Turbify showed [${notices.join(" | ")}] after the sign-in was pressed.` : "";
  const measured = describeSignInMeasurement(blockers, secrets);
  if (blockers.captcha) {
    return `Turbify showed ${who}'s sign-in a captcha ("I'm not a robot"), and the robot never answers one, `
      + `so it stopped.${said} A person signing in to Turbify by hand once with the same login usually makes `
      + `Turbify trust it again; the next daily sweep then tries by itself.${measured} The page it was on — ${page}`;
  }
  return `Signed in as ${who} but the expected page never appeared within ${seconds} seconds, so the robot `
    + `stopped rather than act on an unknown page.${said}${measured} The page it was on — ${page}`;
}

/** The measured half of a stall: the network answers to the press and the hidden checks on the page. */
export function describeSignInMeasurement(blockers: SignInBlockers, secrets: readonly string[]): string {
  const parts: string[] = [];
  if (blockers.exchanges !== undefined) {
    const lines = blockers.exchanges.map((entry) => withoutSecrets(
      `${entry.method} ${entry.target} -> ${entry.failed ? `failed (${entry.failed})` : String(entry.status ?? "no status")}`,
      secrets,
    ));
    parts.push(lines.length > 0
      ? ` After the press the page made ${lines.length} request(s): [${lines.join(" | ")}].`
      : " After the press the page made no request at all, so the press never reached Turbify.");
  }
  if (blockers.botChecks !== undefined) {
    parts.push(blockers.botChecks.length > 0
      ? ` The login page loads a hidden bot check from [${blockers.botChecks.join(" | ")}].`
      : " The login page loads no known hidden bot check.");
  }
  if (blockers.webdriver === true) parts.push(" The page can tell the browser is automated (navigator.webdriver is true).");
  return parts.join("");
}

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

  // 🔴 READ THE DIALOG, NOT THE PAGE, AND NEVER SCORE BY LENGTH. The read this replaced took the
  // longest non-whitespace line in `document.body`, which is the mailbox ADDRESS — the dialog is
  // required to name it, and the account list behind the modal offers longer ones still. The robot
  // typed that address into the password box, Turbify refused it, and the failure surfaced three
  // steps later as "the expected page never appeared". `pickOneTimePassword` cannot return an
  // address; it is a pure function so the whole rule is pinned in the unit suite rather than being
  // re-learned one of the owner's clicks at a time. `innerText` keeps the line breaks that
  // `textContent` glues away (see `dialogNamesAddress`).
  const revealed = await page.evaluate<string>(`(() => {
    const dialog = document.querySelector(".modal-container");
    const scope = dialog || document.body;
    if (!scope) return "";
    return scope.innerText || scope.textContent || "";
  })()`).catch(() => "");

  const reading = pickOneTimePassword(revealed, address);
  if ("refusal" in reading) {
    throw new TurbifyJoinerStepError(
      `The "${ONE_TIME_PASSWORD_DIALOG.heading}" dialog for ${address} was open but ${reading.refusal} `
      + "The robot stopped rather than continue with a credential it could not identify.",
    );
  }
  return reading.password;
}

/** Narrow the account list to one address. Every row action depends on this having worked. */
async function searchFor(page: ConsolePage, address: string): Promise<void> {
  await page.waitForSelector(cssQueryFor(ECP_LOCATORS.searchBox), { timeout: 30_000 });
  await fillOne(page, ECP_LOCATORS.searchBox, address);
  await settle(1_500);
}

/**
 * Type into a field found by CSS, CLEARING it first.
 *
 * `fillOne` does this for a `Locator`, which resolves by wording. A login field is identified by its
 * type instead, so it needs the same clear-then-type without going through the resolver — and it
 * needs it for the same reason: `type()` appends, and this driver reuses pages.
 */
async function fillField(page: ConsolePage, selector: string, value: string): Promise<void> {
  const handles = await page.$$(selector);
  const handle = handles[0];
  if (!handle) {
    throw new TurbifyJoinerStepError(
      `No field matching ${selector} was on the page, so nothing was typed and the robot stopped.`,
    );
  }
  await handle.evaluate<void>(clearField).catch(() => {});
  await handle.type(value, { delay: 15 });
}

/**
 * One control's state, as the FORM sees it — the layer that decides whether a submit does anything.
 *
 * 🔴 A LENGTH, NEVER A VALUE. `filled` is `value.length`, which is enough to separate the two
 * readings that matter — "the confirm box is empty" from "both boxes hold the same thing" — and
 * cannot carry a credential out of the container the way `.value` would.
 */
export type FieldState = {
  /** `true`/`false` for a checkbox or radio, `null` for everything else. */
  checked: boolean | null;
  disabled: boolean;
  /** `value.length`. NEVER the value — see above. */
  filled: number;
  /**
   * 🔴 THE THING NOBODY HAS EVER READ. The setup page carries one unnamed checkbox, and since nothing
   * may tick it — a consent box is the owner's click — the whole run can stop there while the refusal
   * says only `checkbox:-`. Read from `label[for]`, `aria-label`, `aria-labelledby`, a wrapping
   * `<label>`, `title`, then the parent's text, in that order of trustworthiness.
   */
  label: string;
  /**
   * The control's own tag with its attributes, `value` stripped, and **only for a checkbox or
   * radio**. Where every link in the label chain is empty, `id`, `class` and `name` are what say
   * whether this is the form's own box or the cookie banner's. Never emitted for a value-bearing
   * input: `outerHTML` on a password field would carry the password.
   */
  markup: string;
  name: string;
  /**
   * The nearest ancestor with any text, up to six hops — filled in only for an unlabelled box.
   * Measured 2026-10-03: the setup form's checkbox had an empty label chain *including* its
   * parent's text, so the wording, if there is one, is further up than the parent.
   */
  near: string;
  required: boolean;
  type: string;
  /**
   * Which constraint the browser reports unsatisfied — `valueMissing`, `tooShort`, `customError` —
   * with its own `validationMessage` where there is one. Empty when the field is valid. This is what
   * separates "Turbify refused the password" from "the form never submitted".
   */
  why: string;
};

/** What a page looked like, in the only terms that cannot carry a credential. */
export type PageShape = {
  buttons: string[];
  /**
   * Every control's state, with `formValid` for the enclosing form.
   *
   * 🔴 THIS EXISTS BECAUSE THE PREVIOUS REFUSAL PROMISED IT AND DID NOT DELIVER IT. `setMailboxPassword`
   * states in its own comment that if the form does not move, "the refusal below prints the checkbox
   * for him to act on". What the owner received on 2026-10-03 was `checkbox:-` — a dash. He was told
   * to act on a control whose label, required flag and ticked state were all withheld, which left
   * three different causes indistinguishable: a required consent box, an empty confirm field, or a
   * submit that never landed. **A refusal that cannot be acted on is what this driver keeps paying
   * for in the owner's clicks** — and promising a detail in a comment is not the same as emitting it.
   */
  controls: FieldState[];
  /**
   * 🔴 THE PAGE'S OWN ERROR TEXT, which is the only authority on a rule Turbify did not publish
   * unambiguously. Their help says a mailbox password needs "no repeated characters" without saying
   * whether that means consecutively or anywhere, and guessing would refuse an adoption Turbify
   * would have accepted. So the robot reads what the FORM says instead of ruling on it.
   *
   * 🔴 IT ALSO CATCHES NON-ERRORS, AND THAT MUST NOT BE "FIXED" BY NARROWING IT. A strength meter is
   * commonly an `aria-live` region, so `Very Strong` arrives here — and on 2026-10-03 that reading is
   * what PROVED the password had satisfied the page's own validator, which ruled the password out and
   * moved the search to the form. Restricting this to `[role=alert]` would have thrown that away.
   */
  errors: string[];
  /** `form.checkValidity()` for the form the controls belong to; `null` when there is no form. */
  formValid: boolean | null;
  headings: string[];
  inputs: string[];
  title: string;
  url: string;
};

/**
 * Strip the secrets this run is holding out of a line of diagnostic.
 *
 * 🔴 DELIBERATELY NOT `redactLabel`. That one also drops every space-free token of twelve characters
 * or more, which is the right rule for a control's NAME and exactly the wrong one here: it would
 * redact `https://mail.turbify.com/login`, `password:confirmPassword` and the mailbox address — the
 * three things a page description exists to show. What `describePage` reads cannot contain a
 * credential by construction (attribute names and types, never `.value`; the path, never the query),
 * so the known secrets are removed by exact match and nothing further is guessed at.
 */
/** What a removed secret is replaced with. Named, because the loop below must skip past it. */
const REDACTED = "[redacted]";

export function withoutSecrets(raw: string, secrets: readonly string[]): string {
  let value = String(raw ?? "");
  for (const secret of secrets) {
    const needle = String(secret ?? "").trim();
    // Under four characters a match is as likely to be coincidence as a leak, and replacing it would
    // corrupt the description while protecting nothing.
    if (needle.length < 4) continue;
    let index = value.toLowerCase().indexOf(needle.toLowerCase());
    while (index !== -1) {
      value = `${value.slice(0, index)}${REDACTED}${value.slice(index + needle.length)}`;
      // 🔴 RESUME AFTER THE MARKER, NEVER FROM 0. Searching from the start again is an INFINITE LOOP
      // for any secret that is a substring of the marker — "redact" becomes "[redacted]", which
      // contains "redact", for ever. The passwords here would not trigger it, but a redactor that
      // hangs would hang a provisioning run with no output at all, which is the exact failure shape
      // that cost four of the owner's clicks today. The loop now strictly advances.
      index = value.toLowerCase().indexOf(needle.toLowerCase(), index + REDACTED.length);
    }
  }
  return value;
}

/** Turn a page reading into one line a person can act on. */
export function describeShape(shape: PageShape | null, secrets: readonly string[]): string {
  if (!shape) return "the page could not be read at all.";
  const clean = (value: string) => withoutSecrets(value, secrets);
  const parts = [
    `url ${clean(shape.url)}`,
    `title "${clean(shape.title)}"`,
    `headings [${shape.headings.map(clean).join(" | ")}]`,
    `inputs [${shape.inputs.map(clean).join(", ")}]`,
    `buttons [${shape.buttons.map(clean).join(" | ")}]`,
  ];
  // The form's own verdict, which is the layer a "still on screen" failure actually lives in. A
  // control is only worth a line when it carries something actionable — a required flag, an
  // unsatisfied constraint, a label nobody has read, or a length that shows a box is empty.
  const controls = (shape.controls ?? []).map((field) => describeField(field, clean)).filter((line) => line.length > 0);
  if (controls.length > 0) parts.push(`controls [${controls.join(" | ")}]`);
  if (shape.formValid === false) parts.push("the form reports itself INVALID");
  else if (shape.formValid === true) parts.push("the form reports itself valid, so the submit is not being refused by validation");
  // Last, and only when there is one, so it is the thing the eye lands on. This is what turns "the
  // form is still on screen" into "Turbify said why".
  const errors = (shape.errors ?? []).map(clean).filter((line) => line.length > 0);
  if (errors.length > 0) parts.push(`the page says [${errors.join(" | ")}]`);
  return parts.join("; ");
}

/**
 * One control, in the words someone has to act on.
 *
 * 🔴 `filled` IS PRINTED AS A LENGTH AND THE VALUE IS NEVER AVAILABLE HERE. `empty` and `filled=14`
 * are the two readings that separate an unfilled confirm box from a matching pair, and neither can
 * leak a password. A hidden field with nothing interesting about it prints nothing at all, so the
 * line stays short enough to read at 4am.
 */
export function describeField(field: FieldState, clean: (value: string) => string): string {
  const name = clean(`${field.type}:${field.name || "-"}`);
  const notes: string[] = [];
  if (field.required) notes.push("REQUIRED");
  if (field.disabled) notes.push("disabled");
  if (field.checked === true) notes.push("ticked");
  if (field.checked === false) notes.push("UNTICKED");
  if (field.type !== "checkbox" && field.type !== "radio" && field.type !== "hidden") {
    notes.push(field.filled === 0 ? "EMPTY" : `filled=${field.filled}`);
  }
  // The label matters most for the control nobody has identified, so it is quoted rather than
  // folded into the notes — and capped, because a parent's text can be the whole page.
  if (field.label.length > 0) notes.push(`"${clean(field.label).slice(0, 160)}"`);
  // 🔴 ONLY WHEN THE LABEL CHAIN CAME BACK EMPTY, so a labelled control stays one short line. For
  // the one box nothing may tick, these two are what identify it when there is no label anywhere:
  // the attributes say whether it belongs to the form or to the cookie banner, and the nearest
  // ancestor with text says what it is asking. Both capped; `markup` never carries a value.
  if (field.label.length === 0) {
    if (field.near.length > 0) notes.push(`near:"${clean(field.near).slice(0, 160)}"`);
    if (field.markup.length > 0) notes.push(`markup:${clean(field.markup).slice(0, 160)}`);
  }
  if (field.why.length > 0) notes.push(`INVALID(${clean(field.why).slice(0, 120)})`);
  if (notes.length === 0) return "";
  return `${name} ${notes.join(" ")}`;
}

/**
 * Read the page the robot is standing on, well enough that one refusal replaces a probe.
 *
 * 🔴 THE POINT OF THIS IS THAT A REFUSAL IS A MEASUREMENT. Every calibration in this driver so far
 * cost the owner a click that reported only which selector was missing — never what was actually on
 * screen — so each click bought one guess. A refusal carrying the headings, the inputs (hidden ones
 * marked, because a leftover hidden input is one of the things that fools an absence test) and the
 * button wordings buys the answer instead.
 *
 * It reads NO field values and drops the query string, so a one-time password cannot ride out in the
 * url; what is left goes through `withoutSecrets` on top of that.
 */
/**
 * Choose the app the password is for, which Turbify requires BEFORE Generate does anything.
 *
 * Their step 5: "From the dropdown menu, select the appropriate app… If you do not see your
 * application, select Other, then enter the application's name." Phoenix will never be in that list,
 * so the answer is always **Other** plus a name — and the name is what offboarding later looks for
 * when it revokes the password, which is why it comes from one constant.
 *
 * Returns true when a dropdown was found and set. The caller tolerates false: the control has still
 * never been seen, and refusing on its absence would block a step that may not need it.
 *
 * 🔴 The option is chosen by its TEXT, not its index, and the change event is dispatched by hand —
 * setting `.value` on a React-controlled `<select>` updates the DOM and tells the app nothing, which
 * is the same class of silent no-op as a click that lands on a cookie banner.
 */
export async function selectAppForPassword(page: ConsolePage, name: string): Promise<boolean> {
  const chosen = await page
    .evaluate<boolean>(`(() => {
      const wanted = ["other", "others", "other app", "other application"];
      const selects = Array.from(document.querySelectorAll("select"))
        .filter((element) => element.getClientRects().length > 0);
      for (const select of selects) {
        const options = Array.from(select.options || []);
        const match = options.find((option) => {
          const label = (option.textContent || "").replace(/\\s+/g, " ").trim().toLowerCase();
          return wanted.indexOf(label) !== -1;
        }) || options.find((option) => {
          const label = (option.textContent || "").replace(/\\s+/g, " ").trim().toLowerCase();
          return label.indexOf("other") !== -1;
        });
        if (!match) continue;
        select.value = match.value;
        // A controlled component only learns about this from the events, never from the assignment.
        select.dispatchEvent(new Event("input", { bubbles: true }));
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      return false;
    })()`)
    .catch(() => false);
  if (!chosen) return false;

  await settle(800);
  // Choosing "Other" reveals a name field. Filled when it appears; its absence is not a failure,
  // because a list that already held a usable entry needs no name typed into it.
  const named = await page
    .$$('input[type="text"]:not([name="email"]), input[name*="name" i], input[placeholder*="name" i]')
    .catch(() => [] as Handle[]);
  const field = named[0];
  if (field) {
    await field.evaluate<void>(clearField).catch(() => {});
    await field.type(name, { delay: 15 }).catch(() => {});
  }
  return true;
}

export async function describePage(page: ConsolePage, secrets: readonly string[]): Promise<string> {
  const shape = await page
    .evaluate<PageShape>(() => {
      const seen = (element: Element) => element.getClientRects().length > 0;
      const words = (element: Element) =>
        ((element as HTMLElement).innerText || element.textContent || "").replace(/\s+/g, " ").trim();
      return {
        buttons: Array.from(document.querySelectorAll("button,input[type=submit]"))
          .filter(seen)
          .map((element) => words(element) || element.getAttribute("aria-label") || "")
          .filter((label) => label.length > 0)
          .slice(0, 12),
        // 🔴 WHAT THE PAGE SAYS WENT WRONG. A password Turbify rejects leaves the form on screen,
        // which every proof in this driver reads as "the page never changed" — a true statement that
        // explains nothing. The form's own message is the only thing that names the real rule, and
        // for the repeated-character rule it is the only authority there is. Read by role and by the
        // error-ish class names, never by position; values are still never read.
        errors: Array.from(
          document.querySelectorAll('[role=alert],[aria-live=assertive],[aria-live=polite],.error,[class*="error"],[class*="Error"],[class*="invalid"]'),
        )
          .filter(seen)
          .map(words)
          .filter((label) => label.length > 0 && label.length <= 300)
          .filter((label, index, all) => all.indexOf(label) === index)
          .slice(0, 4),
        headings: Array.from(document.querySelectorAll("h1,h2,h3,legend"))
          .filter(seen)
          .map(words)
          .filter((label) => label.length > 0)
          .slice(0, 6),
        // The form's own view of each control: required, ticked, how MANY characters it holds, which
        // constraint it fails, and — for the unnamed checkbox — what it actually says. No `.value`.
        controls: Array.from(document.querySelectorAll("input,select,textarea"))
          .slice(0, 14)
          .map((element) => {
            const field = element as HTMLInputElement;
            const box = field.type === "checkbox" || field.type === "radio";
            const labelled = field.getAttribute("aria-labelledby");
            const label =
              (field.id ? words(document.querySelector(`label[for="${field.id}"]`) ?? field) : "")
              || field.getAttribute("aria-label")
              || (labelled ? words(document.getElementById(labelled) ?? field) : "")
              || words(field.closest("label") ?? field)
              || field.title
              // Last resort, and capped hard: a parent's text can be the entire page, but for a bare
              // checkbox with no label of its own it is the only place the wording lives.
              || words(field.parentElement ?? field).slice(0, 200);
            const v = field.validity;
            const flags = [
              "valueMissing", "typeMismatch", "patternMismatch", "tooLong", "tooShort",
              "rangeUnderflow", "rangeOverflow", "stepMismatch", "badInput", "customError",
            ];
            const failed = v && !v.valid ? (flags.find((flag) => Boolean((v as unknown as Record<string, boolean>)[flag])) ?? "invalid") : "";
            const message = v && !v.valid ? (field.validationMessage || "").replace(/\s+/g, " ").trim() : "";
            // 🔴 FOR A BOX WITH NO LABEL AT ALL, AND ONLY FOR A BOX. Measured 2026-10-03 at
            // 23:10:35 on production: the setup form's checkbox came back `checkbox:- UNTICKED`
            // with every link in the label chain empty — INCLUDING the parent's text — so the one
            // control the run turns on could not be identified even with the chain in place. Two
            // things identify it where a label cannot: its own attributes, and the nearest ancestor
            // that has any text.
            //
            // 🔴 NEITHER IS EMITTED FOR A VALUE-BEARING INPUT, and `value` is stripped regardless.
            // `outerHTML` on a password field would carry the password itself, which is the one
            // thing that may never appear in a refusal, a log or an audit row.
            const markup = box
              ? field.outerHTML.replace(/\svalue\s*=\s*("[^"]*"|'[^']*'|\S+)/gi, "").slice(0, 200)
              : "";
            let near = "";
            if (box && (label || "").trim() === "") {
              let hop: HTMLElement | null = field.parentElement;
              for (let up = 0; up < 6 && hop !== null && near === ""; up += 1) {
                near = words(hop).slice(0, 200);
                hop = hop.parentElement;
              }
            }
            return {
              checked: box ? field.checked : null,
              disabled: Boolean(field.disabled),
              filled: typeof field.value === "string" ? field.value.length : 0,
              label: (label || "").replace(/\s+/g, " ").trim(),
              markup: markup.replace(/\s+/g, " ").trim(),
              name: field.name || field.id || "",
              near: near.replace(/\s+/g, " ").trim(),
              required: Boolean(field.required),
              type: field.type || field.tagName.toLowerCase(),
              why: failed === "" ? "" : message === "" ? failed : `${failed}: ${message}`,
            };
          }),
        // 🔴 `checkValidity()` DOES NOT SUBMIT and changes no value — it only asks. It can make the
        // page render its own messages, which lands in `errors` above and is the point.
        formValid: (() => {
          const form = document.querySelector("form");
          if (!form) return null;
          try { return form.checkValidity(); } catch { return null; }
        })(),
        // `type:name` only — never `.value`, which is where a credential would be.
        inputs: Array.from(document.querySelectorAll("input"))
          .map((element) => {
            const field = element as HTMLInputElement;
            return `${field.type}:${field.name || field.id || "-"}${seen(field) ? "" : " (hidden)"}`;
          })
          .slice(0, 12),
        title: document.title || "",
        // Path only: a query string is where a one-time password would travel.
        url: `${location.origin}${location.pathname}`,
      };
    })
    .catch(() => null);
  return describeShape(shape, secrets);
}

// ─── The mailbox Edit form, read and left without saving (13 Nov 2026) ──────────────────────────
//
// WHY THIS EXISTS. A leaver's password reset leaves their app passwords working, and clearing those
// from inside the mailbox is blocked for good: after a reset the mailbox's setup page's submit IS the
// acceptance of Yahoo's terms, which no automation may give. The console's own row offers Add alias,
// Reset password, Edit and More actions (Reset password, Edit, Transfer account, Delete) — no
// suspend. The one place left to look for an on/off, status or access switch is INSIDE Edit, and
// nobody has read it. These four functions are how the capture reads it without changing it.
//
// 🔴 IN-PAGE CODE IS A REAL FUNCTION, NEVER A STRING (module rule): each `...InPage` function below is
// handed to `evaluate` as itself, closes over nothing, and is unit-tested against a fake page.

/** What the in-page reader hands back, before `shapeMailboxEditForm` cleans it. */
export type RawMailboxEditForm = {
  scope: "dialog" | "page";
  /** The scope's own text, used ONLY to ask whether it names the address. Never returned to a caller. */
  scopeText: string;
  headings: string[];
  buttons: string[];
  fields: MailboxEditFormField[];
};

/** Is a dialog on screen? The proof that Edit opened something, and later that leaving closed it. */
export function readEditDialogOpenInPage(): boolean {
  return Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], .modal-container'))
    .some((element) => element.getClientRects().length > 0);
}

/**
 * The text of the table row an element sits in, cell by cell — so the capture can prove its one Edit
 * button belongs to the row that carries the leaver's address, and not to a substring neighbour's.
 * Each cell is read on its own, because a row's whole `textContent` glues the name onto the address.
 */
export function readOwningRowCellsInPage(element: Element): string[] {
  const row = element.closest("tr, [role=row]");
  if (!row) return [];
  return Array.from(row.querySelectorAll("td, th, [role=cell], [role=gridcell]"))
    .map((cell) => (cell.textContent || "").trim());
}

/**
 * Read the open Edit form: every control's KIND and STATE, its headings and its button wordings.
 *
 * 🔴 NO VALUE LEAVES THIS FUNCTION. A text field reports `value.length`; a box reports ticked or not;
 * a select reports its option LABELS and which one is chosen — what a person reads off the screen.
 * Nothing is pressed, focused, typed or dispatched here: it only looks.
 *
 * Scoped to the topmost visible dialog, so the account list behind it is not read as part of the
 * form. When Edit opened no dialog at all the whole page is read and `scope` says so.
 */
export function readMailboxEditFormInPage(): RawMailboxEditForm {
  const seen = (element: Element) => element.getClientRects().length > 0;
  const words = (element: Element | null) =>
    element ? (((element as HTMLElement).innerText || element.textContent || "").replace(/\s+/g, " ").trim()) : "";
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], .modal-container'))
    .filter(seen);
  const dialog = dialogs.length > 0 ? dialogs[dialogs.length - 1] : null;
  const scope: Element = dialog || document.body;

  const notText = ["checkbox", "radio", "hidden", "submit", "button", "reset", "file", "image", "range", "color"];
  const fields = Array.from(
    scope.querySelectorAll('input, select, textarea, [role="switch"], [role="checkbox"], [role="radio"], [role="combobox"]'),
  )
    .slice(0, 40)
    .map((element) => {
      const field = element as HTMLInputElement;
      const list = element as HTMLSelectElement;
      const tag = (element.tagName || "").toLowerCase();
      const role = element.getAttribute("role") || "";
      const type = tag === "input"
        ? String(field.type || "text").toLowerCase()
        : tag === "select" || tag === "textarea" ? tag : role || tag;
      const id = element.getAttribute("id") || "";
      const labelledBy = element.getAttribute("aria-labelledby") || "";
      const label =
        (id && /^[A-Za-z][\w:.-]*$/.test(id) ? words(document.querySelector(`label[for="${id}"]`)) : "")
        || element.getAttribute("aria-label")
        || (labelledBy ? words(document.getElementById(labelledBy)) : "")
        || words(element.closest("label"))
        || element.getAttribute("title")
        || element.getAttribute("placeholder")
        // Last resort, capped: the nearest text is the only wording an unlabelled toggle has.
        || words(element.parentElement).slice(0, 80);
      const box = (tag === "input" && (type === "checkbox" || type === "radio"))
        || role === "switch" || role === "checkbox" || role === "radio";
      const checked = !box
        ? null
        : tag === "input" ? Boolean(field.checked) : element.getAttribute("aria-checked") === "true";
      const options = tag === "select"
        ? Array.from(list.options || []).map((option) => words(option)).slice(0, 30)
        : [];
      const chosen = tag === "select" && list.selectedIndex >= 0 && list.options
        ? words(list.options[list.selectedIndex] || null)
        : null;
      const textLike = tag === "textarea" || (tag === "input" && notText.indexOf(type) === -1);
      return {
        checked,
        disabled: Boolean(field.disabled) || element.getAttribute("aria-disabled") === "true",
        // 🔴 A LENGTH, NEVER THE VALUE.
        filled: textLike ? (typeof field.value === "string" ? field.value.length : 0) : null,
        hidden: !seen(element),
        label: String(label || "").replace(/\s+/g, " ").trim(),
        name: element.getAttribute("name") || id,
        options,
        required: Boolean(field.required) || element.getAttribute("aria-required") === "true",
        selected: chosen,
        tag,
        type,
      };
    });

  return {
    // Visible labels only; an `input[type=submit]` is named by its aria-label here, never its value.
    buttons: Array.from(scope.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]'))
      .filter(seen)
      .map((element) => words(element) || element.getAttribute("aria-label") || "")
      .filter((label) => label.length > 0)
      .slice(0, 20),
    fields,
    headings: Array.from(scope.querySelectorAll('h1, h2, h3, h4, legend, [role="heading"]'))
      .filter(seen)
      .map((element) => words(element))
      .filter((label) => label.length > 0)
      .slice(0, 10),
    scope: dialog ? "dialog" : "page",
    scopeText: String(scope.textContent || "").slice(0, 4000),
  };
}

/** The longest any label in the Edit-form answer may be. Cut, never ellipsised (owner rule). */
const EDIT_FORM_LABEL_MAX = 120;

/**
 * Clean the raw reading into the answer: secrets removed, the scope's text dropped, radios grouped.
 *
 * 🔴 `scopeText` IS USED FOR ONE BOOLEAN AND THEN DISCARDED — it is the form's prose, and the answer
 * carries no prose that was not a label. The address check is `dialogNamesAddress` (whole tokens),
 * because `adel.sayed@` contains `el.sayed@`.
 */
export function shapeMailboxEditForm(
  raw: RawMailboxEditForm | null,
  address: string,
  secrets: readonly string[],
): Pick<MailboxEditFormReading, "buttons" | "fields" | "headings" | "namesAddress" | "scope"> {
  if (!raw) return { buttons: [], fields: [], headings: [], namesAddress: null, scope: null };
  const clean = (value: unknown) =>
    withoutSecrets(String(value ?? ""), secrets).replace(/\s+/g, " ").trim().slice(0, EDIT_FORM_LABEL_MAX);
  const fields = (Array.isArray(raw.fields) ? raw.fields : []).map((field): MailboxEditFormField => ({
    checked: typeof field.checked === "boolean" ? field.checked : null,
    disabled: Boolean(field.disabled),
    filled: typeof field.filled === "number" ? field.filled : null,
    hidden: Boolean(field.hidden),
    label: clean(field.label),
    name: clean(field.name),
    options: (Array.isArray(field.options) ? field.options : []).map(clean).filter((label) => label.length > 0),
    required: Boolean(field.required),
    selected: typeof field.selected === "string" ? clean(field.selected) : null,
    tag: clean(field.tag),
    type: clean(field.type),
  }));
  // A radio's choices are its group's labels, which is what "the options" of a radio group means.
  for (const field of fields) {
    if (field.type !== "radio" || field.name.length === 0) continue;
    field.options = fields
      .filter((other) => other.type === "radio" && other.name === field.name)
      .map((other) => other.label)
      .filter((label) => label.length > 0);
  }
  return {
    buttons: (Array.isArray(raw.buttons) ? raw.buttons : []).map(clean).filter((label) => label.length > 0),
    fields,
    headings: (Array.isArray(raw.headings) ? raw.headings : []).map(clean).filter((label) => label.length > 0),
    namesAddress: dialogNamesAddress(raw.scopeText, address),
    scope: raw.scope === "dialog" || raw.scope === "page" ? raw.scope : null,
  };
}

/**
 * Close the Edit form WITHOUT KEEPING ANYTHING, and say whether it actually closed.
 *
 * 🔴 THE ONLY CONTROLS THIS MAY PRESS ARE `MAILBOX_EDIT_FORM.leave` — Close modal, Cancel, Close — and
 * then the Escape key. Each is resolved exactly (`resolveOne`: one match, exact wording) and pressed
 * through the hit-tested path; an ambiguous or missing one is skipped, never guessed at. After each
 * press the dialog is re-read, so "closed" is an observation and not an assumption.
 */
async function closeEditFormKeepingNothing(page: ConsolePage): Promise<{ closed: boolean | null; leftWith: string | null }> {
  const isOpen = () => page.evaluate<boolean>(readEditDialogOpenInPage).catch(() => true);
  if (!(await isOpen())) return { closed: null, leftWith: null };
  for (const control of MAILBOX_EDIT_FORM.leave) {
    try {
      await clickResolved(page, control);
    } catch {
      continue;
    }
    await settle(1_000);
    if (!(await isOpen())) return { closed: true, leftWith: control.value };
  }
  await page.keyboard?.press("Escape").catch(() => {});
  await settle(1_000);
  const closed = !(await isOpen());
  return { closed, leftWith: closed ? "Escape" : null };
}

/**
 * What the driver needs from outside the browser.
 *
 * 🔴 `readInvitation` IS WHAT MAKES A CREATE FINISHABLE AT ALL, and it is optional only so the
 * driver stays constructible without a mailbox. Turbify's create does not raise the "One-time
 * password" dialog a reset does — it emails the credential — so without this the create path can
 * only report the PENDING mailbox it left behind. `sweep-deps.ts` attaches the real one;
 * `invite-inbox-reader.ts` is what it polls.
 */
export type JoinerDriverPorts = {
  /** The invitation for one address, or a refusal that says why it could not be read. */
  readInvitation?: (address: string) => Promise<InvitationReading>;
};

export async function createTurbifyJoinerDriver(
  credentials: {
    username: string;
    password: string;
  },
  ports: JoinerDriverPorts = {},
): Promise<JoinerConsoleDriver> {
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

  /**
   * The mailbox's own browser context — its own cookie jar, its own blank page.
   *
   * 🔴 A MAILBOX MUST NOT SIGN IN ON THE ADMINISTRATOR'S PAGE. By the time `setMailboxPassword`
   * runs, the admin session has been live since step one, and a Turbify login URL with a live
   * session does not render a form at all — it forwards to `.done`. So which page the mailbox
   * sign-in landed on depended on a cookie set three steps earlier, which is not something a
   * selector can be calibrated against. On top of that, `type()` APPENDS (see `clearField`) and the
   * admin page has already been typed into, so a re-entered field submits two values joined — and a
   * login answers that by simply refusing, with nothing on screen to say why.
   *
   * An isolated context removes both at once: the Bizmail form is the only thing it can land on.
   */
  let mailboxContext: { close: () => Promise<void>; newPage: () => Promise<unknown> } | null = null;
  let mailboxPage: ConsolePage | null = null;

  async function openMailboxPage(): Promise<ConsolePage> {
    if (mailboxPage) return mailboxPage;
    const withContexts = browser as unknown as {
      createBrowserContext?: () => Promise<{ close: () => Promise<void>; newPage: () => Promise<unknown> }>;
      createIncognitoBrowserContext?: () => Promise<{ close: () => Promise<void>; newPage: () => Promise<unknown> }>;
      newPage: () => Promise<unknown>;
    };
    const create = withContexts.createBrowserContext ?? withContexts.createIncognitoBrowserContext;
    if (create) {
      mailboxContext = await create.call(withContexts);
      mailboxPage = (await mailboxContext.newPage()) as ConsolePage;
    } else {
      // A puppeteer with no browser contexts: a second page still beats reusing the admin's, because
      // the fields are at least empty. The cookie jar is shared, so this is the weaker path.
      mailboxPage = (await withContexts.newPage()) as ConsolePage;
    }
    await mailboxPage.setViewport({ ...CONSOLE_VIEWPORT }).catch(() => {});
    return mailboxPage;
  }

  async function signInAs(
    target: ConsolePage,
    url: string,
    username: string,
    password: string,
    proof: () => Promise<boolean>,
    who: string,
    secrets: readonly string[],
  ) {
    await target.goto(url, { waitUntil: "networkidle2", timeout: 60_000 });
    // 🔴 THERE ARE TWO DIFFERENT TURBIFY LOGIN PAGES AND THEIR EMAIL FIELDS DO NOT SHARE A SELECTOR.
    // Measured in the production container 2026-10-03, both pages read in the same run:
    //
    //   login.turbify.com  ("Turbify Login Page")   input[type="email"]   → 1 match
    //   mail.turbify.com   ("Bizmail Login")        input[type="email"]   → 0 matches
    //                                               input#email[name="email"][type="text"]
    //
    // `MAILBOX_EMAIL_FIELD` matches both shapes; neither page carries the other's field, so the
    // union cannot pick up the wrong input. Pinned by `tests/new-hire-mailbox-robot.test.ts`.
    await target.waitForSelector(MAILBOX_EMAIL_FIELD, { timeout: 45_000 });
    // 🔴 CLEARED BEFORE TYPING, both fields. `type()` appends, and this step can run on a page that
    // has been used — see `clearField` for the 54-character two-addresses-joined measurement.
    await fillField(target, MAILBOX_EMAIL_FIELD, username);
    const hasPassword = (await target.$$(PASSWORD_FIELD)).length > 0;
    if (!hasPassword) {
      // A two-step login. NEITHER Turbify page is one (both carry the password box on the same page,
      // read 2026-10-03), so this branch is dead today and kept only so a change to that is survived
      // rather than mistaken for bad credentials.
      await submitOpenForm(target, LOGIN_SUBMIT_WORDINGS, `continue button on the sign-in page for ${who}`).catch(() => {});
      await target.waitForSelector(PASSWORD_FIELD, { timeout: 20_000 }).catch(() => {});
    }
    await fillField(target, PASSWORD_FIELD, password);
    // 🔴 THE SUBMIT GOES THROUGH THE HIT-TESTED PATH NOW, like every other click in this driver. Until
    // 2026-10-03 it was a bare `page.click('button[type="submit"]')` — the one control in the whole
    // file still delivered blind — and a blind click is exactly what Turbify's fixed cookie banner ate
    // on 2026-10-02 (`click-delivery.ts`, incident one). The failure it produces is the cruel one: the
    // form is simply still there afterwards, which every downstream check reads as "refused".
    // Before the press, so a message that comes and goes during the wait is still on record.
    await target.evaluate(recordSignInNotices).catch(() => {});
    // Read-only, and installed just before the press so every answer to it is seen: see
    // `watchSignInExchanges` for the 14 Nov 2026 stall that a hand sign-in did not clear.
    const exchanges = watchSignInExchanges(target);
    let answered: SignInExchange[] = [];
    let landing: SignInLanding;
    try {
      await submitOpenForm(target, LOGIN_SUBMIT_WORDINGS, `sign-in button for ${who}`);
      // A floor of six seconds, then the proof re-read every second up to thirty — see
      // `SIGN_IN_MINIMUM_WAIT_MS` for the 2026-11-12 morning a fixed six was not enough.
      landing = await waitForSignInLanding(() => target.url(), proof);
    } finally {
      // Stopped on every path, so a listener never outlives the sign-in it was watching.
      answered = exchanges.stop();
    }
    // 🔴 Two-step verification must stay OFF on the accounts the robot uses: Turbify only sends the
    // code to a phone or an email, so there is nothing a server can answer. Fail loudly, never stall.
    if (landing === "two_step") {
      throw new TurbifyJoinerStepError(
        `Turbify asked ${who} for two-step verification, which the robot cannot answer. Two-step must be `
        + "turned off on this login (My Profile → Security and Privacy → Turn off two-step verification).",
      );
    }
    if (landing === "still_on_form") {
      // 🔴 THE REFUSAL CARRIES THE PAGE IT WAS LOOKING AT. This one proof has now been wrong three
      // times — twice reading the address bar, once reading the absence of a field — and each wrong
      // answer cost the owner a click that told nobody anything. Whatever page this turns out to be,
      // it is described here, so the next click produces a measurement instead of another guess —
      // and since 2026-11-12 it also says whether a captcha stood in the way and what the page
      // flashed after the press, which a description read at the end of the wait cannot see.
      const blockers: SignInBlockers = { ...(await readSignInBlockers(target)), exchanges: answered };
      throw new TurbifyJoinerStepError(
        describeSignInStall(who, SIGN_IN_LANDING_TIMEOUT_MS, blockers, await describePage(target, secrets), secrets),
      );
    }
  }

  /** The administrator's sign-in, shared by `signIn` and the Edit-form capture so there is one copy. */
  async function signInAsAdministrator() {
    await signInAs(
      page,
      LOGIN_URL,
      credentials.username,
      credentials.password,
      // The HOST, never a substring: LOGIN_URL itself carries `ecp.turbify.com` in its `.done` query.
      async () => isConsoleHost(page.url()),
      "the administrator",
      [credentials.password],
    );
  }

  return {
    async signIn() {
      await signInAsAdministrator();
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
        // 🔴 `alreadyExists` MARKS THIS AS THE EXPECTED SKIP, NOT A CONSOLE FAILURE. The robot read
        // the console and found the mailbox already there, so creating it again is wrong — the task
        // stays open on the New Hire Mailboxes card for a Super Admin to finish by adoption or by
        // completing the invitation, neither of which runs on a sweep. The runner logs it at INFO on
        // the strength of this flag, so the daily sweep stops writing the same row to
        // app_error_events (see the flag's own note, and #5453 for the identical outstation pattern).
        throw new TurbifyJoinerStepError(
          reading.status === "pending"
            ? `${address} already exists in Turbify as PENDING, so the robot did not create it again. `
              + "A Pending mailbox was created but never completed its invitation, so it carries no "
              + "password at all — it needs that invitation finished, not a second create."
            : `${address} already exists in Turbify, so the robot did not create it. Phoenix's record `
              + "disagreed with the console — reconcile before re-running.",
          { alreadyExists: true },
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

      // 🔴 THE SUBMIT USUALLY WORKED EVEN WHEN THERE IS NO DIALOG. Turbify's create does NOT raise
      // the "One-time password" dialog a RESET does: it creates the mailbox as PENDING and emails
      // the credential to the invite recipient filled in above. So the absence of the dialog is the
      // NORMAL create, not a failure — and the robot must say what it actually left behind on the
      // live domain rather than imply nothing happened. Two real mailboxes were created and then
      // reported as never created at all, because `Active mailboxes` excludes Pending and a Pending
      // row carries no `Reset password` button for a count to find.
      //
      // 🔴 THE DIALOG STILL WINS WHERE IT EXISTS. It is immediate and needs no mailbox read, so the
      // invitation is the fallback and not the first choice — if Turbify ever shows the dialog on a
      // create, that password is used and nothing is read from any inbox.
      if (!(await hasHeading(page, ONE_TIME_PASSWORD_DIALOG.heading))) {
        if (!ports.readInvitation) {
          throw new TurbifyJoinerStepError(await describeCreateWithoutPassword(page, address, consoleUrl));
        }
        // Reading the inbox does not navigate this page, so the post-save view — and the control
        // report `describeCreateWithoutPassword` takes off it — survives the wait intact.
        const invitation = await ports.readInvitation(address);
        if ("credentials" in invitation) {
          // 🔴 THE INVITATION IS ITSELF THE PROOF THE MAILBOX EXISTS. Turbify sends one only for a
          // mailbox it created, and `readInvitation` matched this address by identity, so there is
          // nothing left to confirm by re-reading the row — and re-reading it would cost a
          // navigation that throws away the only view that could explain a later failure.
          //
          // The temp password takes the one-time password's place exactly: both are one-use, both
          // are spent by signing in as the mailbox and setting the company password in step 2.
          return { address, oneTimePassword: invitation.credentials.tempPassword };
        }
        throw new TurbifyJoinerStepError(
          await describeCreateWithoutPassword(page, address, consoleUrl, invitation.refusal),
        );
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
      const mailbox = await openMailboxPage();
      const secrets = [oneTimePassword, newPassword, credentials.password];
      // 🔴 THE PROOF IS POSITIVE NOW: it names the page it found rather than the thing it did not.
      // Three wrong answers came out of asking indirectly — `!url.includes("login.turbify.com")`
      // accepted a refusal, the `/login` path test rejected a SUCCESS, and the absence of an address
      // field rejected one too. An absence has a dozen causes (a leftover hidden input, a form that
      // never submitted because something covered the button, a redirect part-way); the setup form's
      // own confirm field has exactly one.
      const onSetupPage = async () => (await mailbox.$$(CONFIRM_PASSWORD_FIELD)).length > 0;
      // Signed in somewhere that is not a login form: no VISIBLE address box. Visibility matters —
      // `$$` finds hidden inputs, and a hidden `name="email"` left in the DOM reads as a login form.
      const pastTheLoginForm = async () =>
        (await mailbox
          .$$eval<number>(MAILBOX_EMAIL_FIELD, (elements) =>
            elements.filter((element) => element.getClientRects().length > 0).length,
          )
          .catch(() => 1)) === 0;
      await signInAs(
        mailbox,
        MAILBOX_LOGIN_URL,
        address,
        oneTimePassword,
        async () => (await onSetupPage()) || (await pastTheLoginForm()),
        address,
        secrets,
      );
      // Turbify forces a setup screen on a one-time password — measured as two password fields,
      // `password` and `confirmPassword`. Where that screen is absent the account pages carry the
      // change instead, so the confirm field is a positive signal and not a requirement.
      if (!(await onSetupPage()) && (await mailbox.$$(PASSWORD_FIELD)).length === 0) {
        await clickOneOf(mailbox, APP_PASSWORD_WORDINGS.accountInfo, "the mailbox's account pages", ["a", "button"]);
        await settle(3_000);
      }
      const fields = await mailbox.$$(PASSWORD_FIELD);
      if (fields.length === 0) {
        throw new TurbifyJoinerStepError(
          `No password field was found while setting the password for ${address}. The mailbox exists on `
          + `its one-time password; the robot stopped. The page it was on — ${await describePage(mailbox, secrets)}`,
        );
      }
      // Every password box on a change form takes the new value: Turbify asks for it twice, and the
      // current one is already satisfied by having just signed in with it. Cleared first, because
      // `type()` appends and a pre-filled box would submit the value twice over.
      for (const field of fields) {
        await field.evaluate<void>(clearField).catch(() => {});
        await field.type(newPassword, { delay: 15 });
      }
      // 🔴 PROVE THE TYPING LANDED BEFORE PRESSING ANYTHING, because the alternative is a form that
      // stays on screen for a reason the refusal then has to guess at. `type()` APPENDS and
      // `clearField` fails silently by design, so the two failures worth separating are a box that
      // took nothing and a pair that disagree — and both are invisible from the outside. Lengths
      // only: the values are never read, and a length cannot carry a password out of the container.
      const typed = await mailbox
        .$$eval<number[]>(PASSWORD_FIELD, (elements) =>
          elements.map((element) => ((element as HTMLInputElement).value ?? "").length),
        )
        .catch(() => [] as number[]);
      const expected = newPassword.length;
      if (typed.length > 0 && typed.some((length) => length !== expected)) {
        throw new TurbifyJoinerStepError(
          `The password boxes for ${address} did not take the value as typed — ${typed.length} box(es) `
          + `hold ${typed.join(", ")} characters where every one should hold ${expected}. Nothing was `
          + "submitted. A box holding 0 never received the keystrokes; one holding more than expected "
          + `is \`type()\` appending onto text that was already there. The page it was on — ${await describePage(mailbox, secrets)}`,
        );
      }
      // 🔴 NOTHING HERE TICKS THE SETUP PAGE'S CHECKBOX, and as of 2026-10-04 that is no longer a
      // precaution about an unread label — THE LABEL HAS BEEN READ, AND IT IS YAHOO'S TERMS OF
      // SERVICE. The control reader returned it verbatim from the live page:
      //
      //     near: "By continuing, you agree that Turbify will create a profile, and for use of
      //            Business Mail service. You agree to Yahoo's Terms of Service and Privacy Policies."
      //     markup: <input aria-hidden="true" tabindex="-1" type="checkbox"
      //             style="position: absolute; pointer-events: none; opacity: 0; margin: 0px;
      //             transform: translateX(-100%);">
      //
      // Three things follow, and they settle this step permanently rather than calibrating it:
      //
      // 1. **It is a consent to a third party's terms**, so it is the owner's to give. That was the
      //    standing assumption; it is now a measurement.
      // 2. **The box cannot be ticked by anything, including him.** `pointer-events: none`,
      //    `opacity: 0`, `aria-hidden`, `tabindex="-1"` — it is a visually-hidden value carrier
      //    behind a custom control, not a target. So "tick the box" was never advice that could be
      //    followed, and the old refusal below gave it anyway.
      // 3. **The consent is "By CONTINUING", not by ticking** — which means the SUBMIT ITSELF is the
      //    acceptance. There is therefore no version of this step that an automation may complete:
      //    the thing being automated is the agreement. It is also NOT `required`, and the form
      //    reports itself valid, so the box was never what held the submit back either.
      //
      // The form is still submitted as it stands, because Phoenix may legitimately try, and the
      // refusal below now says the mailbox's password was NOT changed, that re-running cannot help,
      // and what the four manual clicks are. Account: `docs/mailbox-robot-calibration.md`.
      //
      // 🔴 THAT LAST CLAUSE WAS NOT TRUE UNTIL 2026-10-03, AND IT COST A CLICK. The refusal printed
      // `checkbox:-` and nothing else: no label, no required flag, no ticked state. The owner was
      // directed at a control and then denied every fact about it, leaving a required consent box, an
      // unfilled confirm field and a submit that never landed indistinguishable. `PageShape.controls`
      // now carries all three readings. **A promise in a comment is not an emitted diagnostic** —
      // when a comment says the refusal will show something, check that the refusal shows it.
      //
      // `submitOpenForm` is tried first because identifying the submit by `type="submit"` is what
      // stopped this driver pressing "Add alias"; `clickOneOf` remains the fallback for a setup page
      // whose control is a plain `button`, which has not been read either way.
      await submitOpenForm(mailbox, CHANGE_PASSWORD_WORDINGS, "save button on the change-password screen")
        .catch(() => clickOneOf(mailbox, CHANGE_PASSWORD_WORDINGS, "save button on the change-password screen"));
      await settle(4_000);
      if (await onSetupPage()) {
        throw new TurbifyJoinerStepError(
          `The password form for ${address} was filled and submitted but is still on screen, so its `
          + `password was NOT changed and the one-time password is still outstanding. Both password `
          + `boxes held ${expected} characters, so the typing landed, and the form reports itself `
          + "valid — nothing is being refused by validation.\n\n"
          + "🔴 THIS PAGE IS WHERE THE ROBOT STOPS BY DESIGN, AND NOT BECAUSE ANYTHING IS BROKEN. Its "
          + "own words are \"By continuing, you agree that Turbify will create a profile, and for use "
          + "of Business Mail service. You agree to Yahoo's Terms of Service and Privacy Policies\" — so "
          + "pressing the button IS the act of accepting Yahoo's terms for this mailbox, and that is "
          + "the owner's to give, never an automation's. Re-running this will not get past it.\n\n"
          + "Finish it by hand, once per mailbox, in about four clicks: open "
          + "https://mail.turbify.com/login, sign in as this mailbox with the password Phoenix holds "
          + "for it, enter the company password twice on the \"Set up your mailbox password\" screen, "
          + "and press \"Generate mailbox password\". Then take the app password inside the mailbox and "
          + `connect it on the Mailbox Monitor page. The page it was on — ${await describePage(mailbox, secrets)}`,
        );
      }
      return "done";
    },

    async generateAppPassword({ address, password }) {
      // 🔴 THE MAILBOX'S OWN PAGE, not the admin's. This step is only reachable while signed in as
      // the mailbox, and since 2026-10-03 that sign-in happens in an isolated context — so reading
      // `page` here would be reading the administrator's console.
      const mailbox = await openMailboxPage();
      const secrets = [password, credentials.password];
      // 🔴 THE PATH IS NOW TURBIFY'S OWN, READ FROM THEIR HELP (article SLN29264, "Manage app
      // passwords", updated 2026-07-24) rather than assembled from the checklist HR followed by
      // hand. Their steps, in order:
      //
      //   1. Sign in to your business email account.                    ← already done, above
      //   2. Click your profile icon on the top-right.
      //      "Mobile users: Go to this link instead:
      //       https://mail.turbify.com/accountinfo"                     ← USE THIS, see below
      //   3. Click "Manage your account".
      //   4. In the top-left under Security & Privacy, click "Manage App Passwords".
      //   5. From the dropdown menu, select the appropriate app.
      //      "If you do not see your application, select Other, then enter the application's name."
      //   6. Click "Generate".
      //
      // 🔴 STEPS 2 AND 3 ARE REPLACED BY A DIRECT NAVIGATION, which is the single biggest reason this
      // step had no chance before: step 2 is a HOVER-revealed profile menu ("Mouse over your name's
      // initial on the top-right", as the password article puts it), and `clickOneOf` presses things,
      // it does not hover. Turbify publishes the destination as a plain URL for mobile users, so the
      // robot goes straight there and two blind clicks disappear.
      //
      // 🔴 AND "Manage your account" IS REAL — a note in this repo claimed it "does not exist", on
      // the strength of Turbify documenting "Account info" elsewhere. Both are real: the mobile
      // deep-link is `/accountinfo`, and the link on the desktop page reads "Manage your account".
      // It stays in `APP_PASSWORD_WORDINGS.accountInfo` as the fallback for a page that lands
      // somewhere other than the deep link.
      const reading = async () => describePage(mailbox, secrets);
      const named = async (step: string, error: unknown) =>
        new TurbifyJoinerStepError(
          `${error instanceof Error ? error.message : String(error)} (${step}, for ${address}) `
          + `The page it was on — ${await reading()}`,
        );
      const LINK_OR_BUTTON = ["a", "button"] as const;
      // The documented deep link. Tolerated on failure — the click fallback below covers a page that
      // did not navigate, and a refusal here would be refusing before trying the thing that works.
      await mailbox.goto(ACCOUNT_INFO_URL, { waitUntil: "networkidle2", timeout: 60_000 }).catch(() => {});
      await settle(2_500);
      // Only needed when the deep link did not land on the account pages. Tolerated for the same
      // reason it always was: on a page already showing App Passwords there is nothing to open.
      await clickOneOf(mailbox, APP_PASSWORD_WORDINGS.accountInfo, "the mailbox's account pages", LINK_OR_BUTTON)
        .catch(() => {});
      await settle(2_000);
      await clickOneOf(mailbox, APP_PASSWORD_WORDINGS.appPasswords, "the App Passwords section", LINK_OR_BUTTON)
        .catch(async (error) => {
          throw await named("opening the App Passwords section", error);
        });
      await settle(2_500);

      // 🔴 THE STEP THE ROBOT DID NOT KNOW EXISTED. Turbify's step 5: "From the dropdown menu, select
      // the appropriate app… If you do not see your application, select Other, then enter the
      // application's name." Phoenix is not in their list, so the answer is always **Other** plus a
      // name — and pressing Generate with nothing chosen is how this step would have failed even once
      // the three wordings were right.
      //
      // Tolerated rather than required, because the dropdown has still not been SEEN: on a page that
      // mints without one, a refusal here would block a step that was about to work. If it is there
      // and this fails to set it, Generate's own failure carries the page, errors included.
      await selectAppForPassword(mailbox, APP_PASSWORD_PAGE.passwordName).catch(() => {});
      await settle(1_000);

      await clickOneOf(mailbox, APP_PASSWORD_WORDINGS.generate, "the button that mints a new app password", LINK_OR_BUTTON)
        .catch(async (error) => {
          throw await named("pressing the button that mints an app password", error);
        });
      await settle(3_500);

      // 🔴 THE SECOND COPY OF THE LENGTH-SCORED READ. This took "the longest space-free line of 12
      // characters or more" from the whole body — and this page is signed in AS the mailbox, so the
      // longest such line is the ADDRESS (25 characters) against an app password of about 16. It
      // would have failed, or stored the address as Phoenix's credential. `pickAppPassword` cannot
      // return an address, allows the all-lowercase shape a real app password has, and refuses with
      // a count when something unlisted survives.
      const shown = await mailbox.evaluate<string>(`(() => {
        const scope = document.body;
        if (!scope) return "";
        return scope.innerText || scope.textContent || "";
      })()`).catch(() => "");

      const minted = pickAppPassword(shown, address);
      if ("refusal" in minted) {
        throw new TurbifyJoinerStepError(
          `No app password could be read after pressing ${APP_PASSWORD_WORDINGS.generate.join(" / ")} for ${address} `
          + `— ${minted.refusal} `
          + "The mailbox is usable but Phoenix has no access to it, so this run is reported, not recorded as connected. "
          + `The page it was on — ${await reading()}`,
        );
      }
      const appPassword = minted.password;

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
          const observed = await mailbox.evaluate<ObservedControl[]>(CONTROL_READ_EXPRESSION);
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

    /**
     * READ the app-passwords page and report its controls. Clicks nothing that changes anything.
     *
     * 🔴 WHY THIS EXISTS AS ITS OWN STEP. `APP_PASSWORD_REVOKE_CONTROLS` in
     * `mailbox-offboarding/robot/clear-app-passwords.ts` holds four `__UNCALIBRATED__` placeholders —
     * the list, the remove control, its confirm, and the empty state — and until they are real text
     * `APP_PASSWORD_CLEAR_CALIBRATED` cannot honestly be flipped, so a leaver's phone keeps syncing
     * after a password reset. The only way to see them is to stand on that page signed in AS a
     * mailbox, and nothing in Phoenix could: `generateAppPassword` reads the controls (above) but
     * only AFTER minting, and it is reachable only through a flow that RESETS the mailbox first —
     * which lands on the `Set up your mailbox password` screen, whose submit is Yahoo's own
     * terms-of-service acceptance and therefore never an automation's to give.
     *
     * 🔴 SO THIS STEP SIGNS IN WITH A PASSWORD PHOENIX ALREADY HOLDS AND RESETS NOTHING. That is the
     * whole difference: a mailbox already past its first sign-in opens straight into its account
     * pages, and the page can be read without touching anybody's mail.
     *
     * What it will NOT do, and what the tests pin:
     *   · no `resetAndCapture`, so no password is rotated and no one-time password is left outstanding
     *   · no `selectAppForPassword` and no `generate` press, so no app password is minted
     *   · nothing from `APP_PASSWORD_REVOKE_CONTROLS` is clicked — reading them is the point
     *
     * The only clicks are NAVIGATION — `Manage your account`, then `Manage App Passwords` — which is
     * unavoidable: a page cannot be read without being reached. Both are tolerated on failure and
     * the refusal carries the page it was on, so a wrong wording reports itself instead of guessing.
     */
    async describeAppPasswords({ address, password }) {
      const mailbox = await openMailboxPage();
      const secrets = [password, credentials.password];
      const reading = async () => describePage(mailbox, secrets);

      // Both probes are lifted verbatim from `setMailboxPassword`, where the comment explains why
      // each is POSITIVE: three indirect tests gave three wrong answers about whether a sign-in had
      // worked. `$$` finds hidden inputs, so visibility is what makes the second one mean anything.
      const onSetupPage = async () => (await mailbox.$$(CONFIRM_PASSWORD_FIELD)).length > 0;
      const pastTheLoginForm = async () =>
        (await mailbox
          .$$eval<number>(MAILBOX_EMAIL_FIELD, (elements) =>
            elements.filter((element) => element.getClientRects().length > 0).length,
          )
          .catch(() => 1)) === 0;

      await signInAs(
        mailbox,
        MAILBOX_LOGIN_URL,
        address,
        password,
        async () => (await onSetupPage()) || (await pastTheLoginForm()),
        address,
        secrets,
      );

      // 🔴 THE SETUP SCREEN HERE IS AN ANSWER, NOT A FAILURE TO RETRY. It means the password Phoenix
      // holds is a one-time one — the mailbox has never completed a first sign-in, or a later reset
      // rotated it — so this mailbox cannot be read until a human completes those four clicks. Say
      // that, rather than reporting a missing control on a page the robot never reached.
      if (await onSetupPage()) {
        return {
          controls: [],
          observed: 0,
          reached: false,
          redacted: 0,
          why:
            `${address} opened the "Set up your mailbox password" screen instead of its account pages, `
            + "so the password Phoenix holds for it is a one-time password and the mailbox has never "
            + "completed a first sign-in. Nothing was clicked and nothing was changed. The app-password "
            + "page sits behind that screen, whose submit IS the acceptance of Yahoo's terms, so it "
            + "needs the four manual clicks once before anything can be captured here. "
            + `The page it was on — ${await reading()}`,
        };
      }

      await mailbox.goto(ACCOUNT_INFO_URL, { waitUntil: "networkidle2", timeout: 60_000 }).catch(() => {});
      await settle(2_500);
      await clickOneOf(mailbox, APP_PASSWORD_WORDINGS.accountInfo, "the mailbox's account pages", ["a", "button"])
        .catch(() => {});
      await settle(2_000);
      try {
        await clickOneOf(mailbox, APP_PASSWORD_WORDINGS.appPasswords, "the App Passwords section", ["a", "button"]);
      } catch (error) {
        return {
          controls: [],
          observed: 0,
          reached: false,
          redacted: 0,
          why:
            `The App Passwords section could not be opened for ${address}: `
            + `${error instanceof Error ? error.message : String(error)}. Nothing was clicked beyond `
            + `navigation and nothing was changed. The page it was on — ${await reading()}`,
        };
      }
      await settle(2_500);

      // Every secret in hand goes to the redactor. This page LISTS credentials by nature, so the
      // shape rule in `buildControlReport` is the load-bearing guard and the exact matches are the
      // belt: a control whose label is secret-shaped is dropped whatever it is.
      const observed = await mailbox
        .evaluate<ObservedControl[]>(CONTROL_READ_EXPRESSION)
        .catch(() => [] as ObservedControl[]);
      const report = buildControlReport(`app-passwords (read-only capture) for ${address}`, observed ?? [], secrets);
      logInfo("Turbify control report", {
        labels: {
          controls: report.controls.join(" || "),
          event: "turbify_control_report",
          observed: report.observed,
          page: report.page,
          redacted: report.redacted,
        },
      });
      return {
        controls: report.controls,
        observed: report.observed,
        reached: true,
        redacted: report.redacted,
        why: null,
      };
    },

    /**
     * Open ONE mailbox row's Edit form, read every control on it, and leave without keeping anything.
     *
     * 🔴 WHAT IT MAY TOUCH, IN FULL: the administrator sign-in (`signInAsAdministrator`, the same one
     * `signIn` uses), the account-list search (cleared, then typed — `searchFor`), the row's Edit
     * button, and then only `closeEditFormKeepingNothing`'s closing controls or Escape. It types
     * nothing into the form, and the answer carries a text field's LENGTH, never its value.
     *
     * 🔴 THE ROW IS PROVED BY IDENTITY TWICE. `rowIdentityRefusal` requires exactly one row whose OWN
     * address cell equals the address — the search is a substring match, so `el.sayed@` also returns
     * `adel.sayed@` — and the Edit press goes through `act`, which requires exactly ONE Edit button on
     * the filtered page, AND checks that button's own row carries the address before pressing it.
     */
    async captureMailboxEditForm({ address }) {
      const wanted = String(address ?? "").trim().toLowerCase();
      const secrets = [credentials.password];
      const notRead = (why: string): MailboxEditFormReading => ({
        address: wanted,
        buttons: [],
        closed: null,
        controls: [],
        fields: [],
        headings: [],
        leftWith: null,
        namesAddress: null,
        observed: 0,
        reached: false,
        redacted: 0,
        scope: null,
        why,
      });
      if (!wanted.includes("@")) return notRead("No mailbox address was given, so nothing was opened.");

      await signInAsAdministrator();
      // A FRESH LOAD before the search: only the first search after a load actually filters.
      await page.goto(consoleUrl, { timeout: 60_000, waitUntil: "networkidle2" });
      await searchFor(page, wanted);
      const rows = await page
        .$$eval<ConsoleMailboxRow[]>(MAILBOX_ROW_QUERY, readMailboxRowCells)
        .catch(() => null);
      const refusal = rowIdentityRefusal(rows, wanted, "Read the Edit form of");
      if (refusal) return notRead(refusal);

      try {
        await act(page, ECP_LOCATORS.editUser, async (handle) => {
          const cells = await handle.evaluate<string[]>(readOwningRowCellsInPage).catch(() => [] as string[]);
          if (!cells.some((cell) => cell.trim().toLowerCase() === wanted)) {
            throw new TurbifyJoinerStepError(
              `the one Edit button on the filtered page does not sit in the row that carries ${wanted}, `
              + "so it was not pressed",
            );
          }
          await deliverClick(handle, ECP_LOCATORS.editUser.purpose);
        });
      } catch (error) {
        return notRead(
          `The Edit form of ${wanted} was not opened: ${error instanceof Error ? error.message : String(error)}. `
          + `Nothing was changed. The page it was on — ${await describePage(page, secrets)}`,
        );
      }

      // Positive wait for the form: a dialog on screen, polled, up to the ceiling.
      let opened = false;
      for (let waited = 0; waited < MAILBOX_EDIT_FORM.waitMs && !opened; waited += 500) {
        await settle(500);
        opened = await page.evaluate<boolean>(readEditDialogOpenInPage).catch(() => false);
      }

      // Read BEFORE leaving — the form exists only while it is open.
      const raw = await page.evaluate<RawMailboxEditForm>(readMailboxEditFormInPage).catch(() => null);
      const observed = await page
        .evaluate<ObservedControl[]>(CONTROL_READ_EXPRESSION)
        .catch(() => [] as ObservedControl[]);
      const report = buildControlReport(`the Edit form (read-only capture) for ${wanted}`, observed ?? [], secrets);
      const shaped = shapeMailboxEditForm(raw, wanted, secrets);

      const left = await closeEditFormKeepingNothing(page);

      const notes: string[] = [];
      if (!raw) notes.push("The page could not be read after Edit was pressed.");
      if (!opened) {
        notes.push(
          `No dialog appeared within ${Math.round(MAILBOX_EDIT_FORM.waitMs / 1000)} seconds of pressing Edit, `
          + "so the whole page was read instead.",
        );
      }
      if (shaped.namesAddress === false) {
        notes.push(`The form's own text does not name ${wanted}, so what was read may not be this mailbox's form.`);
      }
      if (left.closed === false) {
        notes.push(
          "The form was still open after Close modal, Cancel, Close and Escape. Nothing was typed into it, and "
          + "the browser was closed without keeping anything.",
        );
      }
      logInfo("Turbify mailbox Edit form read", {
        labels: {
          closed: String(left.closed),
          event: "turbify_edit_form_capture",
          fields: shaped.fields.length,
          leftWith: left.leftWith ?? "none",
          observed: report.observed,
          scope: shaped.scope ?? "none",
        },
      });
      return {
        address: wanted,
        ...shaped,
        closed: left.closed,
        controls: report.controls,
        leftWith: left.leftWith,
        observed: report.observed,
        reached: raw !== null,
        redacted: report.redacted,
        why: notes.length > 0 ? notes.join(" ") : null,
      };
    },

    /**
     * Mint one app password, read the page at every stage, then remove it.
     *
     * 🔴 THIS IS THE ONE STEP IN THIS FILE THAT CREATES A LIVE CREDENTIAL IN ORDER TO LOOK AT IT.
     * `removeConfirm` exists only between pressing Remove and answering it, so no reading of an
     * untouched page can ever produce it — the 2026-10-04 capture filled three of four and stopped
     * there, and re-running it would have stopped there every time.
     *
     * 🔴 THE ADDRESS GUARD IS THE FIRST STATEMENT, BEFORE A BROWSER EXISTS. Phoenix's own invite
     * inbox holds nobody's mail; every other mailbox belongs to a person whose phone would stop
     * syncing. A guard placed after the sign-in would still be correct and would still be wrong —
     * by then the run has committed to a mailbox, and the refusal costs a live session.
     *
     * Every stage is captured even when a later one fails, because a rehearsal that minted but
     * could not remove still carries the list and the remove control — three of the four — and
     * throwing that away to report a failure would waste the credential it spent.
     */
    async rehearseAppPasswordRemoval({ address, password }) {
      if (address.trim().toLowerCase() !== TURBIFY_INVITE_RECIPIENT.toLowerCase()) {
        throw new TurbifyJoinerStepError(
          `The app-password rehearsal refuses ${address}. It mints a real app password and then `
          + `removes it, so it runs on ${TURBIFY_INVITE_RECIPIENT} — Phoenix's own invite inbox, which `
          + "holds nobody's mail — and on no other mailbox. Nothing was opened and nothing was changed.",
        );
      }

      const mailbox = await openMailboxPage();
      // The minted password joins this list the moment it exists, so every reading AFTER the mint
      // is redacted against it by exact match and not only by shape.
      const secrets = [password, credentials.password];
      const reading = async () => describePage(mailbox, secrets);
      const LINK_OR_BUTTON = ["a", "button"] as const;

      const capture = async (): Promise<AppPasswordPageReading> => {
        const observed = await mailbox
          .evaluate<ObservedControl[]>(CONTROL_READ_EXPRESSION)
          .catch(() => [] as ObservedControl[]);
        const report = buildControlReport(`app-password rehearsal for ${address}`, observed ?? [], secrets);
        return {
          controls: report.controls,
          observed: report.observed,
          reached: true,
          redacted: report.redacted,
          why: null,
        };
      };
      const unreached = (why: string): AppPasswordPageReading =>
        ({ controls: [], observed: 0, reached: false, redacted: 0, why });

      const onSetupPage = async () => (await mailbox.$$(CONFIRM_PASSWORD_FIELD)).length > 0;
      const pastTheLoginForm = async () =>
        (await mailbox
          .$$eval<number>(MAILBOX_EMAIL_FIELD, (elements) =>
            elements.filter((element) => element.getClientRects().length > 0).length,
          )
          .catch(() => 1)) === 0;

      await signInAs(
        mailbox,
        MAILBOX_LOGIN_URL,
        address,
        password,
        async () => (await onSetupPage()) || (await pastTheLoginForm()),
        address,
        secrets,
      );

      const stopped = async (why: string): Promise<AppPasswordRehearsal> => ({
        after: unreached(why),
        before: unreached(why),
        confirming: unreached(why),
        listed: unreached(why),
        minted: false,
        outstanding: false,
        removed: false,
        why,
      });

      if (await onSetupPage()) {
        return stopped(
          `${address} opened the "Set up your mailbox password" screen, so the password Phoenix holds `
          + "for it is a one-time password and it has never completed a first sign-in. Nothing was "
          + `minted and nothing was changed. The page it was on — ${await reading()}`,
        );
      }

      await mailbox.goto(ACCOUNT_INFO_URL, { waitUntil: "networkidle2", timeout: 60_000 }).catch(() => {});
      await settle(2_500);
      await clickOneOf(mailbox, APP_PASSWORD_WORDINGS.accountInfo, "the mailbox's account pages", LINK_OR_BUTTON)
        .catch(() => {});
      await settle(2_000);
      try {
        await clickOneOf(mailbox, APP_PASSWORD_WORDINGS.appPasswords, "the App Passwords section", LINK_OR_BUTTON);
      } catch (error) {
        return stopped(
          `The App Passwords section could not be opened for ${address}: `
          + `${error instanceof Error ? error.message : String(error)}. Nothing was minted and nothing `
          + `was changed. The page it was on — ${await reading()}`,
        );
      }
      await settle(2_500);

      const before = await capture();

      // ── Mint ──────────────────────────────────────────────────────────────────────────────────
      // Turbify's own step 5: pick an app, and Phoenix is not in their list, so it is always Other
      // plus a name. Tolerated rather than required for the same reason `generateAppPassword`
      // tolerates it — on a page already showing the form there may be nothing to choose.
      await selectAppForPassword(mailbox, "Phoenix").catch(() => false);
      await settle(1_000);
      try {
        await clickOneOf(mailbox, APP_PASSWORD_WORDINGS.generate, "the button that mints a new app password", ["button"]);
      } catch (error) {
        return {
          after: unreached("nothing was minted, so there was nothing to remove"),
          before,
          confirming: unreached("nothing was minted, so no confirm was reached"),
          listed: unreached("nothing was minted"),
          minted: false,
          // Nothing was created, so nothing is loose. This is the benign failure.
          outstanding: false,
          removed: false,
          why:
            `Generate could not be pressed for ${address}: `
            + `${error instanceof Error ? error.message : String(error)}. No app password was minted, `
            + `so none is outstanding. The page it was on — ${await reading()}`,
        };
      }
      await settle(3_000);

      // 🔴 FROM HERE A LIVE CREDENTIAL EXISTS. Read it only to REDACT it: `pickAppPassword` is how
      // the provisioning path reads the minted value, and feeding it into `secrets` is what stops
      // it reaching the report, the audit row and the log. It is never returned and never stored.
      //
      // 🔴 RAW BODY TEXT, AND NOT `describePage`, WHICH WOULD HAVE MADE THIS UNABLE TO WORK.
      // `describePage` redacts — and one of the things it drops is anything secret-shaped, which is
      // precisely the minted password. Reading the value out of a redacted description can never
      // find it, and the "could not be read" that followed would have been the redactor doing its
      // job. The first draft of this function did exactly that.
      const shownAfterMint = await mailbox.evaluate<string>(`(() => {
        const scope = document.body;
        if (!scope) return "";
        return scope.innerText || scope.textContent || "";
      })()`).catch(() => "");
      const minted = pickAppPassword(shownAfterMint, address);
      // 🔴 AN UNREADABLE VALUE IS NOT A REASON TO STOP. The credential already exists, so returning
      // here would leave it live on the mailbox — the one outcome this whole function is built to
      // avoid. Carry on to the removal, and keep a refusal out of the redactor's list rather than
      // pushing its sentence in as though it were a password.
      const mintedValue = "refusal" in minted ? null : minted.password;
      if (mintedValue) secrets.push(mintedValue);

      const listed = await capture();

      // ── Remove ────────────────────────────────────────────────────────────────────────────────
      try {
        await clickOneOf(mailbox, APP_PASSWORD_WORDINGS.removeAppPassword, "the control that removes an app password", ["a", "button"]);
      } catch (error) {
        return {
          after: unreached("the removal was never started"),
          before,
          confirming: unreached("the removal was never started"),
          listed,
          minted: true,
          // 🔴 THE CASE THIS FLAG EXISTS FOR.
          outstanding: true,
          removed: false,
          why:
            `An app password WAS minted on ${address} and the control to remove it could not be `
            + `pressed: ${error instanceof Error ? error.message : String(error)}. 🔴 A WORKING APP `
            + "PASSWORD IS NOW LIVE ON THAT MAILBOX and must be removed by hand. The reading above "
            + `still carries the list and its controls. The page it was on — ${await reading()}`,
        };
      }
      await settle(2_000);

      // The confirm step, captured BEFORE it is answered — this reading is the whole reason the
      // rehearsal mints anything at all.
      const confirming = await capture();

      try {
        await clickOneOf(mailbox, APP_PASSWORD_WORDINGS.removeConfirm, "the control that confirms the removal", ["a", "button"]);
      } catch (error) {
        return {
          after: unreached("the removal was never confirmed"),
          before,
          confirming,
          listed,
          minted: true,
          outstanding: true,
          removed: false,
          why:
            `An app password WAS minted on ${address}, Remove was pressed, and nothing matched the `
            + `confirm: ${error instanceof Error ? error.message : String(error)}. 🔴 A WORKING APP `
            + "PASSWORD IS PROBABLY STILL LIVE ON THAT MAILBOX — check it by hand. This is the "
            + "expected outcome of the FIRST rehearsal, because no wording for this control has ever "
            + `been seen; the confirm reading above is what replaces the guesses. The page — ${await reading()}`,
        };
      }
      await settle(2_500);

      const after = await capture();
      return { after, before, confirming, listed, minted: true, outstanding: false, removed: true, why: null };
    },

    async close() {
      // The mailbox's isolated context goes first, so its cookie jar is disposed even if the browser
      // itself resists closing.
      await mailboxContext?.close().catch(() => {});
      await (browser as unknown as { close: () => Promise<void> }).close().catch(() => {});
    },
  };
}
