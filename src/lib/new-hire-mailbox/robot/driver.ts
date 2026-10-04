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
  close: () => Promise<void>;
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
    async close() { calls.push("close"); },
  };
}

/** The order every real run must follow. Pinned by the tests so a reordering cannot pass quietly. */
export const JOINER_STEP_ORDER = ["createMailbox", "setMailboxPassword", "generateAppPassword"] as const;
