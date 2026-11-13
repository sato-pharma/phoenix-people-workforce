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
  /**
   * Opens the row's Edit form. Pressed ONLY by the read-only Edit-form capture
   * (`captureMailboxEditForm`), which reads the form and leaves it without saving.
   */
  editUser: aria("Edit", "the row's Edit button"),

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
 * The per-mailbox Edit form, as far as the read-only capture may touch it (13 Nov 2026).
 *
 * The capture exists to answer one question about a leaver's mailbox: does Edit hold an on/off,
 * status or access switch that would cut the leaver off, the way an app password reset does not? It
 * opens the form, reads it, and LEAVES WITHOUT SAVING. So the only controls it may ever press after
 * Edit are the ones that close a form without keeping anything — tried in this order, then Escape.
 *
 * 🔴 `neverPress` IS THE LIST A CHANGE TO THE CAPTURE MUST NEVER REACH FOR. It is not consulted by the
 * driver (the driver never names those words at all); `tests/mailbox-edit-form-capture.test.ts`
 * checks the leave list against it and the driver's own source against every word in it.
 */
export const MAILBOX_EDIT_FORM = {
  /** How long the form is given to appear after Edit is pressed. */
  waitMs: 10_000,
  /** Closing controls, most specific first. Each one closes a form without keeping any change. */
  leave: [
    aria("Close modal", "the Edit form's Close modal button"),
    text("Cancel", "the Edit form's Cancel button"),
    text("Close", "the Edit form's Close button"),
  ] as readonly Locator[],
  neverPress: ["Save", "Update", "Apply", "Submit", "Delete", "Reset", "Transfer"] as readonly string[],
} as const;

/**
 * Inside a mailbox, where an app password is generated.
 *
 * Turbify cannot issue an app password centrally — only the mailbox's own account pages can, which
 * is why the robot signs in AS the new mailbox while it still holds the one-time password.
 *
 * 🔴 CORRECTED 2026-10-03 AGAINST TURBIFY'S OWN HELP (article SLN29264, "Manage app passwords",
 * updated 2026-07-24). An earlier note here said "Manage your account" **does not exist** and that
 * the path "starts at Account info". That was wrong, and wrong in the way that matters: it demoted
 * the correct wording on the strength of a URL. Turbify's documented steps are
 *
 *   profile icon (top-right) → **"Manage your account"** → under Security & Privacy,
 *   **"Manage App Passwords"** → pick the app from a **dropdown** → **"Generate"**
 *
 * and "Account info" is real but is the MOBILE DEEP LINK, `https://mail.turbify.com/accountinfo`,
 * not a link's text. Both appear below, in the documented order.
 *
 * 🔴 THE DRIVER NO LONGER DEPENDS ON PRESSING THE FIRST TWO. The profile icon is revealed by a
 * HOVER — the one shape `clickOneOf` cannot produce — so `turbify-joiner.ts` navigates straight to
 * `ACCOUNT_INFO_URL` and keeps these as the fallback for a page that lands somewhere else. A miss is
 * still a hard failure that reports the wording it wanted AND the page it was on.
 */
export const APP_PASSWORD_PAGE = {
  manageAccount: text("Manage your account", "the link to the mailbox's own account pages", ["a", "button"]),
  manageAppPasswords: text("Manage App Passwords", "the App Passwords section", ["a", "button"]),
  generate: text("Generate", "the button that mints a new app password"),
  /** The name the password is given, so offboarding can find and delete it later. */
  passwordName: "Phoenix email",
} as const;

/**
 * The same three steps as ORDERED CANDIDATE LISTS, which is how the driver presses them.
 *
 * 🔴 THE ORDER WAS WRONG TWICE, IN OPPOSITE DIRECTIONS, AND TURBIFY'S OWN ARTICLE SETTLED IT.
 * `manageAccount` read "Manage your account" until 2026-10-03, when a session replaced it with
 * "Account info" and recorded that the first wording "does not exist". Reading SLN29264 the same day
 * showed the original was right all along: the link reads **"Manage your account"**, and "Account
 * info" is the mobile deep-link path. Corroboration by "two independent write-ups" is what produced
 * the wrong answer — neither was Turbify, and both were describing the URL.
 *
 * 🔴 THE FIRST STEP IS NO LONGER PRESSED AT ALL, which is the real fix: it is a HOVER-revealed
 * profile menu, and `clickOneOf` presses, so it could never have been reached by any wording. The
 * driver navigates to `ACCOUNT_INFO_URL` instead and these remain the fallback.
 *
 * 🔴 THE GUESSES FAIL CLOSED, AND THAT IS WHAT SETTLED `appPasswords` ON 2026-10-04. A list matching
 * nothing refuses and prints the page it was looking at (`describePage` in the joiner), so the first
 * click that reached here handed back the real wording instead of pressing something unknown inside
 * a live mailbox's security settings. Every other list below is still a well-sourced guess.
 */
export const APP_PASSWORD_WORDINGS = {
  accountInfo: [
    "Manage your account", "Account info", "Account Info", "Account information", "Account settings", "Account Security",
  ],
  /**
   * 🔴 THE FIRST ENTRY IS MEASURED, AND IT IS THE GLUE AGAIN. On `mail.turbify.com/accountinfo`
   * ("Update User Profile") the button's own text reads `APP Password Manage App Passwords` — the
   * section HEADING is inside the button, run straight into its label, so none of the four guesses
   * below could ever equal it. `matchesLocator` compares text EXACTLY and never as a substring (on
   * purpose: a substring match on "App Passwords" would also catch a heading), so the real wording
   * has to be listed, not approximated.
   *
   * This is the same `textContent` concatenation that made a console row parse as
   * `Abd-Elnaimahmed.mohamed@satopharma.com` and a dialog token as
   * `hr.mailbox@satopharma.comone-time` — met a THIRD time, now in a button. The sibling control on
   * that page has the identical shape (`Account Password Change Password`), so expect
   * `<heading> <label>` for anything else read off this panel.
   *
   * The four guesses stay BELOW it rather than being deleted: they cost one failed match each and
   * they are what will still work if Turbify ever drops the heading out of the button.
   */
  appPasswords: [
    "APP Password Manage App Passwords",
    "Manage App Passwords", "Manage app passwords", "App Passwords", "App passwords",
  ],
  generate: ["Generate", "Generate app password", "Generate password", "Create app password"],
  /**
   * 🔴 THE STEP THE ROBOT DID NOT KNOW EXISTED. Turbify: "From the dropdown menu, select the
   * appropriate app… If you do not see your application, select Other, then enter the application's
   * name." Phoenix will never be in that list, so the answer is always Other plus a name. Pressing
   * Generate with nothing selected is how this step would have failed even with the rest correct.
   */
  otherApp: ["Other", "Others", "Other app", "Other application"],
  /**
   * The control that removes one issued app password. MEASURED — `button: Remove`, read off the
   * live page on 2026-10-04 beside `Generate`.
   *
   * 🔴 MEASURED AS PRESENT, NOT MEASURED AS PER-ENTRY. The page showed `Remove` while listing no
   * entries at all, so whether it belongs to a row or to the panel is still unknown. The rehearsal
   * answers that, and the path captured beside it is what will say which.
   */
  removeAppPassword: ["Remove", "Delete", "Revoke", "Remove app password"],
  /**
   * Whatever answers the removal.
   *
   * 🔴 EVERY ONE OF THESE IS A GUESS, and saying so is the point. Nothing has ever seen this
   * control, because it exists only in the moment after Remove is pressed — which is exactly why
   * the read-only capture could never fill `removeConfirm`. The list fails closed like every other
   * one here, so a wrong guess costs a printed page rather than a wrong click inside a live
   * mailbox's security settings. Replacing this with the measured wording and its path is the
   * rehearsal's entire purpose.
   */
  removeConfirm: ["Remove", "Delete", "Confirm", "Yes", "OK", "Yes, remove"],
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
