/**
 * What the joiner robot needs a Turbify console to be able to do, and in what order.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE ORDER IS THE SAFETY PROPERTY, so it is stated here rather than left to a runner to remember:
 *
 *   1. `createMailbox`      — the mailbox exists, and Turbify shows a ONE-TIME password. No invite
 *                             is sent: the invite field is left empty (`TURBIFY_INVITE_RECIPIENT`).
 *   2. `setMailboxPassword` — sign in AS the new mailbox with that one-time password and change it to
 *                             the company pattern, which is what the owner hands to the new joiner.
 *   3. `generateAppPassword`— still inside that mailbox, mint the app password named "Phoenix email".
 *                             Turbify cannot issue one centrally, so this is the ONLY window in
 *                             which Phoenix can get one without asking the employee.
 *
 * 🔴 STEP 3 CANNOT BE RETRIED LATER. Once the mailbox is handed over and the employee changes the
 * password, nobody but them can mint an app password again. So a run that completes 1 and 2 but
 * fails 3 has produced a working mailbox with no Phoenix access, and that state must be REPORTED
 * rather than recorded as success — `connected` in the register means all three steps landed.
 *
 * 🔴 AND STEP 1 IS THE IRREVERSIBLE ONE for a different reason: it consumes a mailbox seat and
 * creates a live account. Everything that can be checked must be checked BEFORE it — which is why
 * `evaluateProvisionSafety` runs against the register and the employee record, not against the
 * console, and why a missing company password refuses before the driver is ever built.
 */

import type { RobotStepResult } from "@/lib/mailbox-offboarding/robot/driver";

export type CreatedMailbox = {
  /** The full address, as Turbify recorded it. */
  address: string;
  /**
   * The one-time password Turbify generated, read from the "One-time password" dialog.
   *
   * Held only long enough to sign in and replace it in step 2. Never logged, never stored, never
   * shown to anybody: the value a human is given is the company pattern, not this.
   */
  oneTimePassword: string;
};

export type JoinerConsoleDriver = {
  /** Sign in as the Turbify administrator. Throws unless the account list is actually reached. */
  signIn: () => Promise<void>;
  /**
   * Create the mailbox and return its one-time password.
   *
   * Refuses rather than proceeding if the address already appears in the list — the register's
   * `address_taken` gate is checked against Phoenix's own data, and this is the same question asked
   * of the console itself, which is the only place that knows the truth.
   */
  createMailbox: (input: { local: string; displayName: string }) => Promise<CreatedMailbox>;
  /**
   * Reset an EXISTING mailbox's password and return the one-time password Turbify shows.
   *
   * This is the adoption path (`adopt.ts`), for the five mailboxes made by hand before the robot
   * existed: it reopens the window in which Phoenix may mint an app password. Everything after it is
   * identical to the create path — set the company password, then mint.
   *
   * 🔴 Unlike `createMailbox`, this acts on a mailbox somebody USES. It locks them out of webmail
   * until a human hands them the new password, so it must only ever be reached through
   * `evaluateAdoption` with an explicitly named address.
   */
  resetAndCapture: (input: { address: string }) => Promise<CreatedMailbox>;
  /** Sign in as the mailbox and replace its password with the company pattern. */
  setMailboxPassword: (input: { address: string; oneTimePassword: string; newPassword: string }) => Promise<RobotStepResult>;
  /** Mint the "Phoenix email" app password inside the mailbox, and return it. */
  generateAppPassword: (input: { address: string; password: string }) => Promise<{ appPassword: string }>;
  /**
   * READ the app-passwords page and report its controls, changing nothing.
   *
   * 🔴 NOT part of `JOINER_STEP_ORDER`, and deliberately outside it: this is a calibration read, not
   * a provisioning step, and a test fails if it is ever wired into the sweep or the adoption
   * sequence. It signs in with a password Phoenix already holds — so it resets nothing, mints
   * nothing, and leaves no one-time password outstanding — and the four
   * `APP_PASSWORD_REVOKE_CONTROLS` placeholders in the offboarding robot are what it exists to
   * replace. `reached: false` carries `why` and the page, because "the mailbox opened its setup
   * screen" is an ANSWER (its password is a one-time one) and not a control to hunt for.
   */
  describeAppPasswords: (input: { address: string; password: string }) => Promise<AppPasswordPageReading>;
  /**
   * Mint one app password, read the page at every stage, then remove it again.
   *
   * 🔴 THE ONLY WAY `removeConfirm` CAN EVER BE SEEN. The other three placeholders are readable off
   * a page that merely HAS app passwords; the confirm exists only in the moment between pressing
   * Remove and answering it. No amount of reading an untouched page produces it — which is why the
   * read-only capture filled three of four and then stopped, and why re-running it would not have
   * helped however many times it was tried.
   *
   * 🔴 HARD-SCOPED TO THE INVITE INBOX, AND NOT BY CONVENTION — the implementation refuses any
   * other address before it opens a browser. This mints a real credential on a real mailbox and
   * then destroys it, so the one mailbox it may do that to is Phoenix's own, which holds nobody's
   * mail. An address parameter that could name an employee is one typo away from cutting off the
   * phone of somebody still working.
   *
   * Not in `JOINER_STEP_ORDER`, and a test fails if it is ever wired into the sweep.
   */
  rehearseAppPasswordRemoval: (input: { address: string; password: string }) => Promise<AppPasswordRehearsal>;
  /**
   * Sign in as the administrator, open ONE mailbox row's Edit form, read every control on it, and
   * leave WITHOUT SAVING (13 Nov 2026).
   *
   * 🔴 A READ, AND NOTHING BUT A READ. It types into nothing but the account-list search, presses
   * nothing but Edit and a control that closes the form (`MAILBOX_EDIT_FORM.leave`, then Escape), and
   * reports a text field's LENGTH, never its value. It exists to answer whether the console's Edit
   * form holds an on/off, status or access switch that would cut a leaver off — because a password
   * reset does not, and clearing app passwords from inside the mailbox is blocked by Yahoo's terms.
   *
   * The row is chosen by IDENTITY (`rowIdentityRefusal`), never by a count. Not in
   * `JOINER_STEP_ORDER` and never named by a sweep: its only caller is the Super-Admin route
   * `POST /api/mailbox-offboarding/edit-form-controls`, and only for a leaver on the register.
   */
  captureMailboxEditForm: (input: { address: string }) => Promise<MailboxEditFormReading>;
  close: () => Promise<void>;
};

/**
 * One control on the mailbox Edit form, in terms that cannot carry what it holds.
 *
 * 🔴 `filled` IS A LENGTH AND ONLY FOR A TEXT-LIKE FIELD — never the value, which is the rule every
 * read in this module keeps (`FieldState.filled`). A select's `selected` and `options` are the
 * VISIBLE option labels, which is what a person would read off the screen.
 */
export type MailboxEditFormField = {
  /** `input`, `select`, `textarea`, or the tag of an ARIA switch / checkbox / radio. */
  tag: string;
  /** The input type, `select`, `textarea`, or the ARIA role (`switch`, `checkbox`, `radio`, `combobox`). */
  type: string;
  /** The `name` attribute, else the `id`. Empty when the control has neither. */
  name: string;
  /** What the form calls it: `label[for]`, `aria-label`, `aria-labelledby`, a wrapping label, `title`, placeholder. */
  label: string;
  /** Not rendered (zero client rects). Reported so a hidden field is never mistaken for a visible one. */
  hidden: boolean;
  /** Ticked / on for a checkbox, radio or switch; `null` for anything else. */
  checked: boolean | null;
  /** The visible label of the chosen option of a select; `null` for anything else. */
  selected: string | null;
  /** A select's option labels, or every label in a radio's group. Empty for anything else. */
  options: string[];
  disabled: boolean;
  required: boolean;
  /** `value.length` for a text-like field; `null` for every other kind. NEVER the value. */
  filled: number | null;
};

/** What the read-only Edit-form capture comes back with. Never a field's value. */
export type MailboxEditFormReading = {
  address: string;
  /** False when the form was never read — then `why` says what stopped it and what was on screen. */
  reached: boolean;
  /** `dialog` when Edit opened a dialog; `page` when none appeared and the whole page was read. */
  scope: "dialog" | "page" | null;
  /** Whether the form's own text names this address, compared as whole tokens. Null when not read. */
  namesAddress: boolean | null;
  headings: string[];
  /** The form's own button wordings, as read. None of them was pressed except the one in `leftWith`. */
  buttons: string[];
  fields: MailboxEditFormField[];
  /** The page's controls through `buildControlReport` (redaction-first), as the app-password capture reports them. */
  controls: string[];
  observed: number;
  redacted: number;
  /** The control (or `Escape`) that closed the form. Null when nothing needed closing or nothing worked. */
  leftWith: string | null;
  /** Re-read after leaving: true when no dialog remains. Null when no dialog ever opened. */
  closed: boolean | null;
  why: string | null;
};

/**
 * What a mint-read-remove rehearsal comes back with: four readings and what actually happened.
 *
 * Each stage is a full `AppPasswordPageReading`, so the calibration survives a run that stops
 * early — a rehearsal that minted but could not remove still carries the list and the remove
 * control, which is three of the four placeholders.
 */
export type AppPasswordRehearsal = {
  /** The page before anything was minted — the empty state, if the mailbox had none. */
  before: AppPasswordPageReading;
  /** After minting. The entry row and its remove control are visible here, and nowhere else. */
  listed: AppPasswordPageReading;
  /** After pressing Remove and BEFORE answering it. The one place the confirm control exists. */
  confirming: AppPasswordPageReading;
  /** After the removal was answered. Should read like `before` again. */
  after: AppPasswordPageReading;
  minted: boolean;
  removed: boolean;
  /**
   * 🔴 TRUE WHEN A MINTED APP PASSWORD IS STILL LIVE ON THE MAILBOX AND A HUMAN MUST REMOVE IT.
   *
   * The whole point of saying this loudly: a rehearsal that mints and then cannot press an
   * unknown confirm has left a working credential behind. Reporting "removed: false" alone would
   * be read as "nothing happened", which is the opposite of the truth.
   */
  outstanding: boolean;
  why: string | null;
};

/** What a read-only capture of the app-passwords page comes back with. Never a credential. */
export type AppPasswordPageReading = {
  /** One line per control that survived redaction, as `buildControlReport` ordered them. */
  controls: string[];
  /** How many were read BEFORE redaction, so a silent drop is visible rather than inferred. */
  observed: number;
  /** False when the page was never reached — then `why` says what was on screen instead. */
  reached: boolean;
  /** How many controls were dropped because nothing printable survived redaction. */
  redacted: number;
  /** Why the page was not reached, with the page it was on. Null on a reading that landed. */
  why: string | null;
};

/**
 * A driver that walks the whole sequence and touches nothing.
 *
 * This is what a dry run uses, and what the runner's tests drive. The fake values are obviously
 * fake — a test that accidentally asserts against a real-looking password would be the kind of green
 * that means nothing.
 */
export function createDryRunJoinerDriver(domain = "satopharma.com"): JoinerConsoleDriver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async signIn() { calls.push("signIn"); },
    async createMailbox({ displayName, local }) {
      calls.push(`createMailbox:${local}`);
      void displayName;
      return { address: `${local}@${domain}`, oneTimePassword: "DRY-RUN-ONE-TIME" };
    },
    async resetAndCapture({ address }) {
      calls.push(`resetAndCapture:${address}`);
      return { address, oneTimePassword: "DRY-RUN-ONE-TIME" };
    },
    async setMailboxPassword({ address }) {
      calls.push(`setMailboxPassword:${address}`);
      return "done";
    },
    async generateAppPassword({ address }) {
      calls.push(`generateAppPassword:${address}`);
      return { appPassword: "DRY-RUN-APP-PASSWORD" };
    },
    async describeAppPasswords({ address }) {
      calls.push(`describeAppPasswords:${address}`);
      // `reached: false` on a dry run, because a dry run reached nothing — returning a plausible
      // control list here is exactly the shape of green that means nothing.
      return {
        controls: [],
        observed: 0,
        reached: false,
        redacted: 0,
        why: `Dry run: ${address} was never opened, so no control was read.`,
      };
    },
    async rehearseAppPasswordRemoval({ address }) {
      calls.push(`rehearseAppPasswordRemoval:${address}`);
      const nothing = (stage: string): AppPasswordPageReading => ({
        controls: [],
        observed: 0,
        reached: false,
        redacted: 0,
        why: `Dry run: ${address} was never opened, so ${stage} was never read.`,
      });
      // 🔴 `minted` AND `outstanding` ARE BOTH FALSE, and that pair is the honest dry-run answer:
      // nothing was created, so nothing is outstanding. A dry run that reported `minted: true`
      // would make the one field that means "a live credential is loose" untrustworthy.
      return {
        after: nothing("the page after removal"),
        before: nothing("the page before minting"),
        confirming: nothing("the confirm step"),
        listed: nothing("the page after minting"),
        minted: false,
        outstanding: false,
        removed: false,
        why: `Dry run: no app password was minted on ${address} and nothing was removed.`,
      };
    },
    async captureMailboxEditForm({ address }) {
      calls.push(`captureMailboxEditForm:${address}`);
      // `reached: false` for the same reason as `describeAppPasswords` above: nothing was opened.
      return {
        address,
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
        why: `Dry run: the Edit form of ${address} was never opened, so no control was read.`,
      };
    },
    async close() { calls.push("close"); },
  };
}

/** The order every real run must follow. Pinned by the tests so a reordering cannot pass quietly. */
export const JOINER_STEP_ORDER = ["createMailbox", "setMailboxPassword", "generateAppPassword"] as const;
