/**
 * Whether the robot may create a mailbox for a new hire, and for whom.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT GOES WRONG IF THIS IS WEAK. Creating a mailbox is not as violent as deleting one, but each
 * gate below is a way this system is already known to produce a wrong answer, and three of them end
 * with a real person's mail going to the wrong place:
 *
 *   - `employees` rows are edited constantly and a save path has blanked fields before, so a queue
 *     row can name somebody who has since RESIGNED. Provisioning them hands a live mailbox to a
 *     person who has left (gate: an inactive employee is refused).
 *   - An address is derived from a NAME, and two employees legitimately share one. Creating the
 *     second `ahmed.mohamed@` would either collide or, worse, be handed to the wrong Ahmed, who then
 *     receives the first one's mail (gate: an address claimed by anyone else is refused).
 *   - An employee may already hold a company address that HR typed by hand. A second mailbox splits
 *     their mail silently in two, and nothing in the app would show it (gate: an existing, different
 *     company work email is refused to a human).
 *   - A hire can be entered months ahead and then never start. A mailbox created now is a live
 *     account nobody is watching (gate: not more than `ROBOT_MAX_DAYS_BEFORE_HIRE` early).
 *
 * The robot NEVER provisions on its own initiative: an open task row, opened by the app's own
 * new-hire flow, is gate one. Nothing else in this module can be reached without it.
 */

/** The actor recorded against everything the robot does, so a human's work is never confused with it. */
export const ROBOT_ACTOR = "system:turbify-joiner-robot" as const;

/** Never more than this many mailboxes in one run. A runaway creates accounts, which cost seats. */
export const ROBOT_DEFAULT_MAX_CREATES_PER_RUN = 3;

/**
 * Never more than this many hires looked up in the console in one run, whatever they turn out to be.
 *
 * A hire whose mailbox ALREADY EXISTS in Turbify no longer takes a create slot (see the runner), so
 * the create cap alone no longer bounds how long a run spends in the console. Each lookup is a page
 * load of ~6 seconds, read-only; this ceiling keeps a queue full of existing mailboxes from turning
 * one sweep into minutes of browsing. It is far above the real queue (10 hires on 2026-11-12).
 */
export const ROBOT_MAX_CONSOLE_LOOKUPS_PER_RUN = 15;

/** A per-run limit as a whole, non-negative number — anything unusable is zero, never unlimited. */
export function normalizeRunLimit(max: number): number {
  return Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
}

/** How early, in days, a mailbox may be created before the hire date. */
export const ROBOT_MAX_DAYS_BEFORE_HIRE = 14;

/** The only domain the robot will ever create an address in. */
export const COMPANY_MAIL_DOMAIN = "satopharma.com";

export type ProvisionRefusal =
  /** No open task — the app's new-hire flow has not asked for this mailbox. */
  | "no_open_task"
  /** The task is already finished. A quiet skip, not a problem. */
  | "already_connected"
  /** The task was marked as not needing a mailbox. A quiet skip. */
  | "marked_not_needed"
  /** The person is not an active employee any more. */
  | "not_an_active_employee"
  /** No address to create, or one that is not a well-formed company address. */
  | "not_a_company_address"
  /** The address belongs to, or is claimed by, somebody else. */
  | "address_taken"
  /** The employee already holds a different company address. A human decides. */
  | "work_email_already_set"
  /** The hire date is further off than the robot provisions for. */
  | "too_early_before_hire";

/** The refusals that are ordinary emptiness rather than something to look at. */
const QUIET: readonly ProvisionRefusal[] = ["already_connected", "marked_not_needed", "too_early_before_hire"];

export function isQuietRefusal(refusal: ProvisionRefusal): boolean {
  return QUIET.includes(refusal);
}

export type ProvisionEmployeeFacts = {
  hrId: string;
  displayName: string;
  /** From the employee's lifecycle status, resolved by the caller — never guessed here. */
  isActiveEmployee: boolean;
  /** `YYYY-MM-DD`, or null when never recorded. */
  hireDate: string | null;
  /** Whatever the employee record currently shows, which may be a personal address or null. */
  workEmail: string | null;
};

export type ProvisionTaskFacts = {
  status: "pending" | "connected" | "not_needed";
  /** The address Phoenix proposed or HR typed. Null when there was nothing to build one from. */
  emailAddress: string | null;
};

export type ProvisionSafetyInput = {
  employee: ProvisionEmployeeFacts;
  task: ProvisionTaskFacts;
  /**
   * The display name of anyone else already holding or claiming this address — another employee,
   * another open task, or an existing Turbify mailbox. Null when it is genuinely free.
   */
  addressHeldBy: string | null;
  /** Today, `YYYY-MM-DD`, injected so this is testable and never reads a clock itself. */
  today: string;
};

export type ProvisionVerdict =
  | { allowed: true; address: string }
  | { allowed: false; refusal: ProvisionRefusal; detail: string };

function dateOnly(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function wholeDaysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** Whether an address is one the robot may create: our domain, and a sane local part. */
export function isCreatableCompanyAddress(address: string | null | undefined): boolean {
  const text = String(address ?? "").trim().toLowerCase();
  if (!text.endsWith(`@${COMPANY_MAIL_DOMAIN}`)) return false;
  const local = text.slice(0, -(COMPANY_MAIL_DOMAIN.length + 1));
  // Letters, digits, dot, hyphen and underscore, starting and ending with a letter or digit. A local
  // part Turbify would reject, or one built from an empty name, must fail HERE rather than halfway
  // through a console form.
  return /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(local);
}

/**
 * The gates, in the order a refusal is most worth knowing.
 *
 * Returns the normalised address on success so the caller never re-derives it and the two cannot
 * drift apart.
 */
export function evaluateProvisionSafety(input: ProvisionSafetyInput): ProvisionVerdict {
  const { addressHeldBy, employee, task, today } = input;

  // G1 — the app asked for it. The robot has no standing of its own.
  if (task.status === "connected") {
    return { allowed: false, detail: `${employee.displayName}'s mailbox is already connected.`, refusal: "already_connected" };
  }
  if (task.status === "not_needed") {
    return { allowed: false, detail: `${employee.displayName}'s task says no mailbox is needed.`, refusal: "marked_not_needed" };
  }
  if (task.status !== "pending") {
    return { allowed: false, detail: `${employee.displayName} has no open new-hire mailbox task.`, refusal: "no_open_task" };
  }

  // G2 — they still work here. A resigned person must never be handed a live mailbox.
  if (!employee.isActiveEmployee) {
    return {
      allowed: false,
      detail: `${employee.displayName} is no longer an active employee, so no mailbox is created.`,
      refusal: "not_an_active_employee",
    };
  }

  // G3 — a real company address, or nothing.
  const address = String(task.emailAddress ?? "").trim().toLowerCase();
  if (!isCreatableCompanyAddress(address)) {
    return {
      allowed: false,
      detail: address
        ? `"${address}" is not an address the robot may create (it must be a well-formed @${COMPANY_MAIL_DOMAIN} address).`
        : `${employee.displayName} has no address to create yet.`,
      refusal: "not_a_company_address",
    };
  }

  // G4 — nobody else holds it. This is the gate that stops one person's mail reaching another.
  if (addressHeldBy) {
    return {
      allowed: false,
      detail: `${address} is already held or claimed by ${addressHeldBy}, so the robot will not create it.`,
      refusal: "address_taken",
    };
  }

  // G5 — they do not already have a different company mailbox.
  const existing = String(employee.workEmail ?? "").trim().toLowerCase();
  if (existing && existing !== address && existing.endsWith(`@${COMPANY_MAIL_DOMAIN}`)) {
    return {
      allowed: false,
      detail: `${employee.displayName} already has the company address ${existing}; a second one would split their mail. A person decides this.`,
      refusal: "work_email_already_set",
    };
  }

  // G6 — not absurdly early. A hire with no date recorded is provisioned now, which is the case HR
  // relies on when somebody starts immediately.
  const hire = dateOnly(employee.hireDate);
  if (hire) {
    const daysUntil = wholeDaysBetween(today, hire);
    if (daysUntil > ROBOT_MAX_DAYS_BEFORE_HIRE) {
      return {
        allowed: false,
        detail: `${employee.displayName} starts in ${daysUntil} days; the robot creates a mailbox at most ${ROBOT_MAX_DAYS_BEFORE_HIRE} days ahead.`,
        refusal: "too_early_before_hire",
      };
    }
  }

  return { address, allowed: true };
}

/** Trim a queue to the per-run cap, newest work last so a stable order is provisioned first. */
export function capForRun<T>(queue: readonly T[], max: number = ROBOT_DEFAULT_MAX_CREATES_PER_RUN): T[] {
  return queue.slice(0, normalizeRunLimit(max));
}
