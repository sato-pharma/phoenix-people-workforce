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
 * TRUE since 13 Nov 2026 (audit step REC-052): all four list-and-delete controls below were READ OFF
 * THE LIVE PAGE by the rehearsal on Phoenix's own invite inbox, 4 Oct 2026 19:23 Cairo (audit row
 * 350b7480-a532-46eb-a4e9-5e98b523685d). That run minted one app password, captured the page before,
 * listed, between Remove and its confirm, and after; pressed Delete; and ended with the page empty
 * and nothing outstanding. Each control is its attribute-only path from that reading
 * (docs/mailbox-robot-calibration.md, "Calibrated from the live rehearsal").
 *
 * 🔴 WHAT THIS DOES NOT SWITCH ON. It lifts the refusal and nothing more: `runAppPasswordClear` still
 * needs a live console driver and a caller, and neither exists yet. A leaver's app passwords are
 * cleared by hand until they do, and the register's "App passwords live" list is what tracks them.
 */
export const APP_PASSWORD_CLEAR_CALIBRATED = true;

export type AppPasswordRevokeControl = { readonly label: string; readonly selector: string };

/**
 * The controls this step needs, as read off the live App Passwords page (4 Oct 2026, 19:23 Cairo).
 *
 * Kept beside the gates rather than in `src/lib/turbify/locators.ts`: they are the paths of ONE
 * reading of ONE page, and the step must still prove each one on the page it is driving.
 * `existingList` and `emptyState` are the same container — "a path, not a wording" calibrates
 * them: the list is that container with Remove controls under it, the empty state is that container
 * with none (the page then reads "You haven’t added any apps yet."). The container's position among
 * its siblings moved between stages, so no `nth-of-type` is kept for it. On that page one mailbox
 * listed one app password at a time: the page read one Remove both before and after the mint.
 */
export const APP_PASSWORD_REVOKE_CONTROLS = {
  /** The list of app passwords already issued for this mailbox (a region named "Generated passwords"). */
  existingList: { label: "Generated passwords", selector: "div.flex-1.overflow-y-auto > div.overflow-y-auto.inset-0" },
  /** The control that removes one entry. */
  removeOne: { label: "Remove", selector: "div.flex-1.overflow-y-auto > div.flex.items-center > button.turbify-btn.turbify-btn-error" },
  /** What confirms the removal — exists only between pressing Remove and answering it, beside Cancel. */
  removeConfirm: { label: "Delete", selector: "div.flex.flex-col > div.flex.items-center > button.turbify-btn.turbify-btn-primary" },
  /** How the page reads once none are left, which is the only honest proof of success. */
  emptyState: { label: "You haven’t added any apps yet.", selector: "div.flex-1.overflow-y-auto > div.overflow-y-auto.inset-0" },
} as const satisfies Record<string, AppPasswordRevokeControl>;

type RevokeControls = Readonly<Record<string, AppPasswordRevokeControl>>;

/** Every control that is still a placeholder — none, once calibrated; the flag may not be true while any is. */
export function uncalibratedRevokeControls(controls: RevokeControls = APP_PASSWORD_REVOKE_CONTROLS): string[] {
  return Object.entries(controls)
    .filter(([, control]) => control.selector.includes("__UNCALIBRATED__"))
    .map(([name]) => name);
}

/**
 * The reason a live pass would be refused, or null when the flag is true and the controls are all real.
 *
 * Read at the point of use so a half-done calibration fails with the names of what is still missing,
 * rather than by clicking `__UNCALIBRATED__` inside somebody's mailbox. Its arguments exist so the
 * tests can hold the uncalibrated case; every caller reads the defaults.
 */
export function appPasswordClearCalibrationRefusal(
  calibrated: boolean = APP_PASSWORD_CLEAR_CALIBRATED,
  controls: RevokeControls = APP_PASSWORD_REVOKE_CONTROLS,
): string | null {
  if (!calibrated) {
    return (
      "Clearing app passwords is not calibrated: the controls that list and remove an existing app "
      + "password have never been read off the live page. The step refuses rather than guess inside a "
      + "mailbox's security settings. Until then a leaver's phone and Outlook stay connected after a "
      + "reset — which is the half-revoked state the register already reports."
    );
  }
  const missing = uncalibratedRevokeControls(controls);
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
