/**
 * Adopting a mailbox that already exists — the remediation for the window the robot missed.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS. Turbify cannot issue an app password centrally; one is minted only from INSIDE a
 * mailbox by whoever holds its password. The joiner robot therefore mints it in the one window where
 * Phoenix legitimately holds that password — the moments after it creates the mailbox. Five people
 * (measured 2026-10-02) already had mailboxes made by hand before the robot existed, so that window
 * closed for them: their mailboxes work, and Phoenix has no access to them at all.
 *
 * The owner's ruling (2026-10-02) is to reset those mailboxes and let the robot take the app password
 * on the way through. This module is the gate for that, and the order is:
 *
 *   1. reset the password in the admin console   — reopens the window; Phoenix holds a password again
 *   2. sign in as the mailbox, set the company password
 *   3. mint the "Phoenix email" app password
 *   4. store both, and close the task
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 THIS LOCKS A WORKING EMPLOYEE OUT OF WEBMAIL, WHICH THE JOINER FLOW NEVER DOES. A new hire has
 * never used their mailbox; these five read theirs every day. The moment the reset lands they cannot
 * sign in to webmail until somebody gives them the new password. So:
 *
 *   - it NEVER runs from the daily sweep. It is an explicit, named, one-off list (`ADOPTION_ALLOW_LIST`
 *     is empty here on purpose — a caller passes the addresses), because a queue-driven version of
 *     this would eventually reset somebody nobody meant to touch.
 *   - it refuses anybody who is not an active employee with an OPEN task and NO app password already
 *     stored. Re-adopting a mailbox Phoenix can already read would lock the person out for nothing.
 *
 * 🔴 AND THE COMPANY PASSWORD BECOMES THEIR REAL PASSWORD. For a new hire that is a handover value
 * they change on day one. For these five it is the live password of a mailbox in daily use, and it is
 * the same string every new hire is given. The mitigation is in the mechanics rather than in advice:
 * an app password SURVIVES a later password change (which is exactly why a reset does not revoke a
 * leaver — see the offboarding rules), so once step 3 has landed the employee can change their
 * password immediately and Phoenix keeps working. Tell them to.
 */

/**
 * Deliberately empty. Adoption acts only on addresses a caller names explicitly; there is no queue
 * that can grow into a reset nobody asked for.
 */
export const ADOPTION_ALLOW_LIST: readonly string[] = [];

export type AdoptionRefusal =
  /** The address was not in the explicit list the caller named. */
  | "not_in_named_list"
  /** No open task — nothing is asking for this mailbox to be adopted. */
  | "no_open_task"
  /** Phoenix already holds an app password: adopting would lock them out for no gain. */
  | "already_has_app_password"
  /** Not an active employee. A leaver's mailbox is the revocation robot's business, not this. */
  | "not_an_active_employee"
  /** The address is not this employee's recorded work email. */
  | "address_not_theirs"
  /** Not a company address. */
  | "not_a_company_address";

export type AdoptionCandidate = {
  hrId: string;
  displayName: string;
  /** The mailbox to adopt. Must match the employee's recorded work email. */
  address: string;
  isActiveEmployee: boolean;
  /** The employee's recorded work email, which the address is checked against. */
  workEmail: string | null;
  /** Whether Phoenix already holds an app password for this mailbox. */
  hasAppPassword: boolean;
  /** Whether a new-hire mailbox task is open for this person. */
  taskOpen: boolean;
};

export type AdoptionVerdict =
  | { allowed: true; address: string }
  | { allowed: false; refusal: AdoptionRefusal; detail: string };

const COMPANY_DOMAIN = "satopharma.com";

function lower(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Whether this mailbox may be adopted, given the explicit list the caller named.
 *
 * `named` is required and is checked FIRST: every other gate is about whether adoption is sensible,
 * but this one is about whether anybody asked for it at all, and it is the gate that keeps a reset
 * from reaching a mailbox by accident.
 */
export function evaluateAdoption(
  candidate: AdoptionCandidate,
  named: readonly string[],
): AdoptionVerdict {
  const address = lower(candidate.address);
  const allowed = new Set(named.map(lower));

  if (!allowed.has(address)) {
    return {
      allowed: false,
      detail: `${address || "(no address)"} was not in the named list, so it is not touched.`,
      refusal: "not_in_named_list",
    };
  }
  if (!address.endsWith(`@${COMPANY_DOMAIN}`)) {
    return {
      allowed: false,
      detail: `${address} is not an @${COMPANY_DOMAIN} address.`,
      refusal: "not_a_company_address",
    };
  }
  if (!candidate.isActiveEmployee) {
    return {
      allowed: false,
      detail: `${candidate.displayName} is not an active employee; a leaver's mailbox is the revocation robot's business.`,
      refusal: "not_an_active_employee",
    };
  }
  if (lower(candidate.workEmail) !== address) {
    return {
      allowed: false,
      detail: `${address} is not ${candidate.displayName}'s recorded work email (${candidate.workEmail ?? "none"}), so the robot will not reset it.`,
      refusal: "address_not_theirs",
    };
  }
  if (candidate.hasAppPassword) {
    return {
      allowed: false,
      detail: `Phoenix already has an app password for ${address}; resetting it would lock ${candidate.displayName} out for nothing.`,
      refusal: "already_has_app_password",
    };
  }
  if (!candidate.taskOpen) {
    return {
      allowed: false,
      detail: `No open new-hire mailbox task for ${candidate.displayName}, so nothing is asking for this.`,
      refusal: "no_open_task",
    };
  }
  return { address, allowed: true };
}

/** The steps, in order. Pinned so a reordering cannot pass quietly. */
export const ADOPTION_STEP_ORDER = [
  "resetPassword",
  "setMailboxPassword",
  "generateAppPassword",
] as const;

/**
 * What the employee has to be told, once their mailbox has been adopted.
 *
 * Returned as data rather than emailed: nothing here sends mail, and the owner hands this over the
 * same way he hands over a new hire's password.
 */
export function adoptionHandoverNote(displayName: string, address: string): string {
  return (
    `${displayName}'s mailbox ${address} has been reset to the company password. They cannot sign in `
    + `to webmail until you give it to them, and they should change it straight away — Phoenix keeps `
    + `working afterwards, because the app password survives a password change.`
  );
}
