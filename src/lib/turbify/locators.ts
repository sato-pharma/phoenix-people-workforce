/**
 * How the robot finds controls in the Turbify Email Control Panel.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT A LIST OF CSS PATHS. The first attempt at a Turbify robot
 * carried a map of CSS selectors that had to be captured by performing each action once and reading
 * the resulting DOM. That forced a human to create, reset and delete a real mailbox before a single
 * line could run, and it left the robot permanently brittle: Turbify's panel is a Tailwind app whose
 * class names are generated (`div.fixed.z-[9999]`, `button.cursor-pointer.border-0`), so a captured
 * path breaks on any restyle, and it breaks SILENTLY — the click finds nothing, the step reports
 * nothing, and the register fills with successes for mailboxes nobody touched.
 *
 * Read on the live panel on 2026-10-02, every control the robot needs carries a STABLE SEMANTIC
 * handle instead:
 *
 *   - the row actions are `aria-label`led — "Reset password", "Edit", "More actions", "Add alias"
 *   - the new-mailbox form fields have real `name` attributes — emailLocal, displayName, inviteSendTo
 *   - the menu items and primary buttons are identified by their own visible text — "Delete",
 *     "Transfer account", "Email user"
 *
 * Those are the things Turbify cannot change without changing what the page SAYS, which is a far
 * stronger contract than a class name. So the robot locates by accessible name, form name, or
 * visible text, and this module is the single place that vocabulary lives.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE FAIL-CLOSED RULE. Every locator here is REQUIRED to resolve. A driver using them must throw
 * when one does not match rather than skip the step, because the failure this module exists to
 * prevent is a run that quietly does nothing and is indistinguishable from a run with no work to do.
 * `missingControl()` builds that error with the handle that was looked for, so the message names the
 * thing to go and look at.
 */

/** How a control is identified on the page. No CSS paths — see the header. */
export type LocatorKind =
  /** The control's accessible name, i.e. its `aria-label`. */
  | "aria"
  /** A form field's `name` attribute. */
  | "name"
  /** The control's own visible text, matched exactly after trimming. */
  | "text"
  /** A field's placeholder, used only where nothing else identifies it. */
  | "placeholder";

export type Locator = {
  kind: LocatorKind;
  /** The value to match: the aria-label, the field name, the visible text, or the placeholder. */
  value: string;
  /** Which element types may satisfy it, so a stray match on another tag cannot pass. */
  tags: readonly string[];
  /** What this control is for, in the words a person reading a failure would want. */
  purpose: string;
};

function aria(value: string, purpose: string, tags: readonly string[] = ["button"]): Locator {
  return { kind: "aria", purpose, tags, value };
}
function named(value: string, purpose: string): Locator {
  return { kind: "name", purpose, tags: ["input", "select", "textarea"], value };
}
function text(value: string, purpose: string, tags: readonly string[] = ["button"]): Locator {
  return { kind: "text", purpose, tags, value };
}

/**
 * The controls the robot needs, all read from the live panel on 2026-10-02.
 *
 * `searchBox` is the one placeholder-matched entry: the field carries no label, no name and no id,
 * and its placeholder is the only thing identifying it.
 */
export const ECP_LOCATORS = {
  /** Filter the account list down to one address before touching any row action. */
  searchBox: { kind: "placeholder", purpose: "the account-list search field", tags: ["input"], value: "Search users..." } as Locator,

  // ── row actions, inside the <tr> for the searched address ────────────────────────────────────
  /** Resets immediately — there is NO confirmation step. Success is the one-time-password dialog. */
  resetPassword: aria("Reset password", "the row's Reset password button"),
  /** Opens the row menu that holds Delete. */
  moreActions: aria("More actions", "the row's More actions menu button"),
  /** Inside the More actions menu. Permanent: no restore, no backup. */
  deleteUser: text("Delete", "the Delete item in the More actions menu"),

  // ── creating a mailbox ───────────────────────────────────────────────────────────────────────
  /** Opens the new-mailbox form. */
  emailUser: text("Email user", "the Email user button that opens the new-mailbox form"),
  /** The part before the @ — Turbify appends the domain itself. */
  emailLocal: named("emailLocal", "the new mailbox's local part"),
  /** The name shown on outgoing mail. */
  displayName: named("displayName", "the new mailbox's display name"),
  /** Where Turbify sends its invite. Never an employee's address — see the driver. */
  inviteSendTo: named("inviteSendTo", "the address Turbify sends its invite to"),
} as const;

/**
 * The one-time password dialog, which BOTH a reset and a creation produce.
 *
 * Confirmed for the reset path on 2026-09-24: one click resets and this dialog opens, headed
 * "One-time password", showing the account, the password behind a Show toggle, and Send invite /
 * Print / Close modal. The robot reads the password out of it and closes it without sending or
 * printing, because a leaver needs no invite and a new hire's credential goes to Phoenix, not to a
 * mailbox nobody is reading yet.
 *
 * 🔴 The dialog is matched by its HEADING, not by a container path, and the robot must find the
 * heading before it reads anything: a password scraped from a page that is not this dialog is the
 * one error that would be stored and trusted.
 */
export const ONE_TIME_PASSWORD_DIALOG = {
  /** The heading that proves the dialog is open and the action succeeded. */
  heading: "One-time password",
  /** Reveals the password, which renders masked. */
  reveal: aria("Show", "the Show toggle that reveals the one-time password", ["button"]),
  /** Dismisses the dialog without informing anybody. */
  close: aria("Close modal", "the dialog's close button"),
  /** Never pressed. Listed so a driver change that reaches for one is obviously wrong. */
  neverPress: ["Send invite", "Print"] as readonly string[],
} as const;

/**
 * Inside a mailbox, where an app password is generated.
 *
 * Turbify cannot issue an app password centrally — only the mailbox's own account pages can, which
 * is why the robot signs in AS the new mailbox while it still holds the one-time password.
 *
 * 🔴 THESE WERE DESCRIBED AS "TURBIFY'S OWN WORDINGS" AND THEY WERE NOT. They came from the
 * checklist HR followed by hand (`NEW_HIRE_MAILBOX_STEPS`), and the first one — "Manage your
 * account" — does not exist: Turbify's documented path starts at **Account info**. They are matched
 * as visible text, are the one group never read from a live page, and a miss is a hard failure that
 * reports the wording it wanted AND the page it was on. The driver presses `APP_PASSWORD_WORDINGS`
 * below rather than these single values, so a wrong first guess is survivable.
 */
export const APP_PASSWORD_PAGE = {
  manageAccount: text("Account info", "the link to the mailbox's own account pages", ["a", "button"]),
  manageAppPasswords: text("Manage App Passwords", "the App Passwords section", ["a", "button"]),
  generate: text("Generate", "the button that mints a new app password"),
  /** The name the password is given, so offboarding can find and delete it later. */
  passwordName: "Phoenix email",
} as const;

/**
 * The same three steps as ORDERED CANDIDATE LISTS, which is how the driver presses them.
 *
 * 🔴 `manageAccount` READ "Manage your account" UNTIL 2026-10-03, AND THAT IS NOT TURBIFY'S WORDING.
 * Turbify's documented path is **Account info → Manage App Passwords**, corroborated by two
 * independent write-ups of Business Mail read the same day. So the FIRST step would have missed while
 * the second was right all along — the worst shape there is: one wrong wording in the middle of a
 * correct chain, failing with a message about the wrong thing.
 *
 * 🔴 THESE ARE STILL NOT MEASURED, and a wording off a web page is NOT a measurement — it is a
 * better-ordered guess. That is only safe because every one fails CLOSED: a list matching nothing
 * refuses and prints the page it was looking at (`describePage` in the joiner), so the first click
 * that reaches here settles all three at once rather than pressing something unknown inside a live
 * mailbox's security settings. Documented wording first, the old guesses kept behind it.
 */
export const APP_PASSWORD_WORDINGS = {
  accountInfo: [
    "Account info", "Account Info", "Account information", "Manage your account", "Account settings", "Account Security",
  ],
  appPasswords: ["Manage App Passwords", "Manage app passwords", "App Passwords", "App passwords"],
  generate: ["Generate", "Generate app password", "Generate password", "Create app password"],
} as const;

/** A human-readable description of a locator, for an error a person has to act on. */
export function describeLocator(locator: Locator): string {
  const where = locator.tags.join("/");
  switch (locator.kind) {
    case "aria": return `${where} with aria-label "${locator.value}" (${locator.purpose})`;
    case "name": return `${where} with name="${locator.value}" (${locator.purpose})`;
    case "text": return `${where} reading "${locator.value}" (${locator.purpose})`;
    case "placeholder": return `${where} with placeholder "${locator.value}" (${locator.purpose})`;
  }
}

export class TurbifyControlMissingError extends Error {
  readonly locator: Locator;
  constructor(locator: Locator) {
    super(
      `The Turbify panel has no ${describeLocator(locator)}. The robot stopped rather than guess: `
      + "either the panel changed its wording, or the page it was on was not the one expected.",
    );
    this.name = "TurbifyControlMissingError";
    this.locator = locator;
  }
}

/** Build the fail-closed error for a control that did not resolve. */
export function missingControl(locator: Locator): TurbifyControlMissingError {
  return new TurbifyControlMissingError(locator);
}
