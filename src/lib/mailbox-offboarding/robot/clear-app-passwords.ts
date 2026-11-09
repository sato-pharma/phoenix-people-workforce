/**
 * Clearing a leaver's app passwords — closing the half-revoked hole.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE HOLE. A Turbify app password SURVIVES a password change. So resetting a leaver's password
 * blocks webmail and any NEW device, and changes nothing about the phone and the Outlook already
 * sitting on their desk: those keep syncing mail with the app password they were given. The register
 * is honest about it — `isHalfRevoked` is exactly this state, and `mailbox_offboarding_tasks` has
 * carried `app_passwords_cleared_at` since it was built, as a HUMAN attestation that somebody went
 * and did it by hand.
 *
 * WHY THE ROBOT COULD NOT DO IT BEFORE, AND WHAT CHANGED. The admin console has no control that
 * clears app passwords — that was confirmed against the live console on 2026-09-24 and it is still
 * true. App passwords live in the MAILBOX OWNER's own account security pages, which an admin cannot
 * reach. The conclusion drawn at the time was that the robot therefore could not clear them and that
 * only `deleteMailbox` could close the door.
 *
 * 🔴 WHAT CHANGED IS THAT THE ROBOT NO LONGER HAS TO BE AN ADMIN — IT CAN BECOME THE USER. The joiner
 * robot already signs in AS a mailbox and is built to reach `Manage App Passwords` and mint one
 * (`APP_PASSWORD_PAGE` — 🔴 NOT proven: as of 2026-10-03 no run has ever got past the mailbox
 * sign-in, so nothing in Phoenix has stood on that page). The same page lists the existing ones.
 * And the admin
 * console's own Reset password hands back a one-time password for ANY mailbox, whatever the employee
 * had changed theirs to — so Phoenix does not need a stored secret and does not need the mailbox to
 * be one it provisioned. Reset, sign in, delete them all.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 THE PASSWORD THIS SETS IS KEPT BY NOBODY, DELIBERATELY. The step needs a working password for
 * one browser session and must not leave one behind: a stored password to a leaver's mailbox is a
 * standing way back in. So it sets a random throwaway, uses it, and discards it — it is never
 * sealed, never written to a row, never logged and never returned. After the step nobody can sign in
 * to that mailbox at all, which is the point.
 *
 * 🔴 AND THIS IS GATED ON THE PERSON HAVING ACTUALLY LEFT. Clearing app passwords disconnects the
 * phone in somebody's pocket. Run a day early and you cut off a working employee mid-handover, with
 * Phoenix's own access to their mailbox going with it. `still_employed` and
 * `before_last_working_date` are the two gates that matter most here, and they refuse rather than
 * warn.
 *
 * A failure part-way through is SAFE but must still be reported: the mailbox ends up reset with its
 * app passwords intact, which is the half-revoked state it was already in. Nothing is made worse and
 * nothing may be recorded as cleared.
 */

import { randomInt } from "node:crypto";

/**
 * 🔴 FALSE until the list-and-delete controls have been READ OFF THE LIVE PAGE.
 *
 * 🔴 AND THE SENTENCE THAT USED TO SIT HERE WAS FALSE: it said `APP_PASSWORD_PAGE` proves the page
 * is reachable and that `Generate` works “because the joiner presses it in production”. The joiner has
 * NEVER reached that page — every run so far died at the mailbox sign-in — and its own first wording
 * (“Manage your account”) turned out not to be Turbify’s. So nothing downstream may be read as
 * proven, and nothing has ever observed how an EXISTING app password is listed or removed: those
 * wordings below are placeholders. Flipping this without replacing them would have
 * the robot clicking a guess inside a live mailbox's security settings.
 */
export const APP_PASSWORD_CLEAR_CALIBRATED = false;

/**
 * The controls this step needs and nobody has seen yet.
 *
 * Kept beside the gates rather than in `src/lib/turbify/locators.ts` on purpose: that file is the
 * vocabulary of CONFIRMED on-screen text, and putting unobserved guesses in it would make every
 * entry there untrustworthy.
 */
export const APP_PASSWORD_REVOKE_CONTROLS = {
  /** The list of app passwords already issued for this mailbox. */
  existingList: { label: "<the list of existing app passwords — unobserved>", selector: "__UNCALIBRATED__" },
  /** The control that removes one entry. */
  removeOne: { label: "<the remove/revoke control on an entry — unobserved>", selector: "__UNCALIBRATED__" },
  /** Whatever confirms the removal. */
  removeConfirm: { label: "<the removal confirm control — unobserved>", selector: "__UNCALIBRATED__" },
  /** How the page reads once none are left, which is the only honest proof of success. */
  emptyState: { label: "<the page showing no app passwords — unobserved>", selector: "__UNCALIBRATED__" },
} as const;

/** Every placeholder that must be replaced before the flag above may be flipped. */
export function uncalibratedRevokeControls(): string[] {
  return Object.entries(APP_PASSWORD_REVOKE_CONTROLS)
    .filter(([, control]) => control.selector.includes("__UNCALIBRATED__"))
    .map(([name]) => name);
}

/**
 * The reason a flip would be refused, or null when the controls are all real.
 *
 * Read at the point of use so a half-done calibration fails with the names of what is still missing,
 * rather than by clicking `__UNCALIBRATED__` inside somebody's mailbox.
 */
export function appPasswordClearCalibrationRefusal(): string | null {
  if (!APP_PASSWORD_CLEAR_CALIBRATED) {
    return (
      "Clearing app passwords is not calibrated: the controls that list and remove an existing app "
      + "password have never been read off the live page. The step refuses rather than guess inside a "
      + "mailbox's security settings. Until then a leaver's phone and Outlook stay connected after a "
      + "reset — which is the half-revoked state the register already reports."
    );
  }
  const missing = uncalibratedRevokeControls();
  if (missing.length > 0) {
    return `Clearing app passwords is marked calibrated but these controls are still placeholders: ${missing.join(", ")}.`;
  }
  return null;
}

export type AppPasswordClearRefusal =
  /** Not a company address. */
  | "not_a_company_address"
  /** No open offboarding task — nothing is asking for this mailbox to be shut. */
  | "no_open_task"
  /** Already recorded as cleared; running again would reset a password for nothing. */
  | "already_cleared"
  /** 🔴 The person is still an active employee. Clearing would cut off somebody who is working. */
  | "still_employed"
  /** 🔴 Their last working day has not arrived yet in Cairo. */
  | "before_last_working_date"
  /** No last working date recorded, so "have they left?" cannot be answered. */
  | "no_last_working_date";

export type AppPasswordClearCandidate = {
  hrId: string;
  displayName: string;
  address: string;
  /** Whether an offboarding task is open for this person. */
  taskOpen: boolean;
  /** Set once somebody (or this step) has cleared them. */
  appPasswordsClearedAt: string | null;
  /** From `isActiveLifecycleStatus` — the same predicate every other scope uses. */
  isActiveEmployee: boolean;
  /** `YYYY-MM-DD`, as the register holds it. */
  lastWorkingDate: string | null;
};

export type AppPasswordClearVerdict =
  | { allowed: true; address: string }
  | { allowed: false; refusal: AppPasswordClearRefusal; detail: string };

const COMPANY_DOMAIN = "satopharma.com";

function lower(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Whether this leaver's app passwords may be cleared, as of `today` in Cairo (`YYYY-MM-DD`).
 *
 * `today` is passed in rather than read here so the date gates are provable without freezing a
 * clock — the two gates that stop a working employee being cut off are the ones most worth a test.
 */
export function evaluateAppPasswordClear(
  candidate: AppPasswordClearCandidate,
  today: string,
): AppPasswordClearVerdict {
  const address = lower(candidate.address);

  if (!address.endsWith(`@${COMPANY_DOMAIN}`)) {
    return {
      allowed: false,
      detail: `${address || "(no address)"} is not an @${COMPANY_DOMAIN} address.`,
      refusal: "not_a_company_address",
    };
  }
  if (!candidate.taskOpen) {
    return {
      allowed: false,
      detail: `No open mailbox revocation task for ${candidate.displayName}, so nothing is asking for this.`,
      refusal: "no_open_task",
    };
  }
  if (candidate.appPasswordsClearedAt !== null) {
    return {
      allowed: false,
      detail: `${address} is already recorded as cleared, so there is nothing to do.`,
      refusal: "already_cleared",
    };
  }
  // 🔴 The two that protect a working person. Both refuse; neither warns.
  if (candidate.isActiveEmployee) {
    return {
      allowed: false,
      detail: `${candidate.displayName} is still an active employee. Clearing app passwords would disconnect the phone they are using today.`,
      refusal: "still_employed",
    };
  }
  const last = lower(candidate.lastWorkingDate);
  if (!last) {
    return {
      allowed: false,
      detail: `${candidate.displayName} has no last working date recorded, so the robot cannot tell whether they have left.`,
      refusal: "no_last_working_date",
    };
  }
  if (last > lower(today)) {
    return {
      allowed: false,
      detail: `${candidate.displayName}'s last working day is ${last}, which has not arrived yet (today is ${today}).`,
      refusal: "before_last_working_date",
    };
  }
  return { address, allowed: true };
}

/**
 * The steps, in order. Pinned so a reordering cannot pass quietly.
 *
 * The reset comes FIRST and is what makes this work on any mailbox: it hands back a one-time
 * password regardless of what the employee had set, so no stored secret is needed.
 */
export const APP_PASSWORD_CLEAR_STEP_ORDER = [
  "resetAndCapture",
  "setThrowawayPassword",
  "clearAppPasswords",
] as const;

/** A live credential's characters come from the crypto source, never Math.random. */
function cryptoRandom(): number {
  return randomInt(0x1000000) / 0x1000000;
}

/**
 * A strong password for one browser session, kept by nobody.
 *
 * Built to satisfy the same character rules the company pattern does, so the mailbox accepts it, and
 * deliberately NOT returned to any caller that stores things — `runAppPasswordClear` holds it in a
 * local and lets it go.
 */
export function throwawayPassword(random: () => number = cryptoRandom): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lowerChars = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%^&*";
  const pick = (set: string) => set[Math.floor(random() * set.length)];
  // One of each class first, so the result cannot fail the mailbox's own complexity rule.
  const required = [pick(upper), pick(lowerChars), pick(digits), pick(symbols)];
  const pool = upper + lowerChars + digits + symbols;
  const rest = Array.from({ length: 20 }, () => pick(pool));
  return [...required, ...rest].join("");
}

/**
 * What the owner is told once a leaver's app passwords are gone.
 *
 * Returned as data rather than emailed — nothing here sends mail.
 */
export function appPasswordClearNote(displayName: string, address: string, removed: number): string {
  return (
    `${displayName}'s mailbox ${address} is now fully revoked: the password was reset and `
    + `${removed === 1 ? "1 app password was" : `${removed} app passwords were`} removed from inside it, `
    + `so the phone and Outlook they had configured no longer sync. Nobody holds a password to this `
    + `mailbox — not the leaver, and not Phoenix.`
  );
}
