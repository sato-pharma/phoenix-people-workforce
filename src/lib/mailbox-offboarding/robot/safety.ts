/**
 * The Turbify revocation robot — the gates that decide whether a mailbox may be touched at all.
 *
 * Everything here is PURE. No I/O, no clock reads beyond the one passed in, no Supabase. That is
 * deliberate: this file is the only thing standing between an automated browser and 173 live
 * company mailboxes, so every rule in it runs for real in tests/mailbox-offboarding-robot.test.ts
 * rather than being reasoned about.
 *
 * WHY GATES AT ALL, when the register already decided who is a leaver. Because the register's
 * decision is a SNAPSHOT taken when the task opened, and three known facts in this system can make
 * that snapshot wrong by the time a robot acts on it:
 *
 *   1. `last_working_date` is a COPY, not an observation — the exit form writes one typed date into
 *      all four date columns. A typo there is invisible and the register believes it.
 *   2. A resigned person's CRM slot and address are legitimately REUSED for a new hire. An address
 *      that belonged to a leaver last month can belong to a working employee today.
 *   3. A resignation can be reversed. The employee record is the live truth; the task row is not.
 *
 * A human in the control panel catches all three by recognising the name. A robot recognises
 * nothing, so it gets these gates instead.
 *
 * THE ORDER IS NOT ARBITRARY. `evaluateRevocationSafety` returns the FIRST failure, and the cheap
 * identity checks come before the expensive directory ones so a misconfigured run fails on the
 * kill switch rather than after reading the whole employee master.
 */

import { isCompanyAddress } from "@/lib/new-hire-mailbox/address";
import type { MailboxOffboardingTask } from "@/lib/mailbox-offboarding/types";

/**
 * The actor every robot write is recorded under.
 *
 * Lives in this pure module (not the runner) because two gates depend on it: the delete phase only
 * completes a pipeline the ROBOT started — it refuses to auto-delete a mailbox a PERSON reset,
 * because a person who reset a password may be managing that mailbox by hand (forwarding, a
 * retention hold) and a robot must not finish a decision it did not start.
 *
 * `system:` prefixed like the register's other automated actors (`system:resignation`,
 * `system:mailbox-sweep`), so the existing name-resolution renders it as itself rather than
 * pretending a person did it.
 */
export const ROBOT_ACTOR = "system:turbify-robot" as const;

/**
 * The employment statuses that still mean "this person has left".
 *
 * Kept identical to the register's own LEAVER_STATUSES rather than imported from it, because these
 * two lists answer different questions and must be free to diverge: the register asks "should a
 * task exist?", this asks "may a robot act?". If they ever need to differ, the safer one is here.
 */
export const ROBOT_LEAVER_STATUSES = ["resigned", "terminated"] as const;

/**
 * How many whole days must have passed since the last working date before the robot will act.
 *
 * One day, not zero. A same-day revocation is exactly the shape a mistyped date produces, and the
 * cost of waiting one more day on a genuine leaver is small next to locking a working employee out
 * of their email. The daily sweep still alerts the whole time, so nothing goes quiet.
 */
export const ROBOT_MIN_DAYS_OVERDUE = 1;

/**
 * How many whole days must pass AFTER the robot reset the password before it will delete the
 * mailbox. The grace window the owner asked for: reset now, delete after N days.
 *
 * 🔴 THE CLOCK STARTS AT THE RESET, NOT AT THE LAST WORKING DATE. A task can sit un-reset for
 * months (the register found 52 leavers on day one), so measuring the grace from the last working
 * date would let the robot reset a long-idle mailbox and delete it the same week — no real window
 * for a person to intervene. Measuring from the reset guarantees the full N days between the door
 * closing and the mailbox being destroyed, whatever the backlog.
 *
 * A delete is PERMANENT — Turbify offers no undo and this company keeps no mail backup — so the
 * window is generous and configurable per run. Thirty days is long enough that a wrongly-reset
 * working employee, or a leaver who comes back, is noticed and the reset undone before anything is
 * lost.
 */
export const ROBOT_MIN_DAYS_BEFORE_DELETE = 30;

/**
 * The most mailboxes one run may RESET.
 *
 * A cap is the difference between a bug that damages five mailboxes and one that damages every
 * mailbox the company has. Five clears the current backlog of 13 in three runs while keeping the
 * blast radius of an unnoticed defect small enough to undo by hand.
 */
export const ROBOT_DEFAULT_MAX_PER_RUN = 5;

/**
 * The most mailboxes one run may DELETE — stricter than the reset cap, and deliberately so.
 *
 * A reset is reversible; a delete is not. If a calibration error ever pointed the delete flow at
 * the wrong row, this is the number that decides whether it destroys two mailboxes or twenty before
 * anyone looks. Two per run, plus the 30-day grace and the per-task gates, means a bad delete is
 * both rare and small.
 */
export const ROBOT_DEFAULT_MAX_DELETES_PER_RUN = 2;

/** Why a task was refused. The runner reports these verbatim — they are read by a person. */
export type RobotRefusal =
  | "robot_disabled"
  | "already_revoked"
  | "no_mailbox"
  | "not_a_company_address"
  | "employee_not_found"
  | "employee_not_a_leaver"
  | "no_last_working_date"
  | "too_recent"
  | "address_belongs_to_an_active_employee"
  | "address_held_by_more_than_one_person"
  // The two below are NORMAL skips, not alarms: they mean "not the robot's to finish, or not yet".
  | "reset_not_by_robot"
  | "awaiting_delete_grace";

export type RobotSafetyVerdict =
  | { allowed: true }
  | { allowed: false; refusal: RobotRefusal; detail: string };

/** The two things the robot can do to a mailbox. Everything else is a person's decision. */
export type RobotAction = "reset" | "delete";

/**
 * What the robot should do with one task this run.
 *
 * `action` is the step that is DUE, or null with the reason it is not. A null with
 * `reset_not_by_robot` or `awaiting_delete_grace` is a quiet, expected skip — the runner does not
 * alarm on those; any other refusal is a real block a person should read.
 */
export type RobotActionDecision =
  | { action: RobotAction }
  | { action: null; refusal: RobotRefusal; detail: string };

/**
 * The live facts about one person, re-read at run time. Never the task row's snapshot.
 *
 * `workEmail` is the address currently on the EMPLOYEE record, which is not necessarily the address
 * on the task — and where they disagree, that disagreement is itself a reason to refuse.
 */
export type RobotEmployeeFacts = {
  hrId: string;
  displayName: string;
  employmentStatus: string | null;
  workEmail: string | null;
  isActive: boolean;
};

export type RobotSafetyInput = {
  /** Every employee, active and not — the only way to see an address that was recycled. */
  directory: RobotEmployeeFacts[];
  enabled: boolean;
  task: MailboxOffboardingTask;
  /** Cairo date-only ISO, passed in so the rule is testable without mocking a clock. */
  todayIso: string;
};

function lower(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function isLeaverStatus(status: string | null): boolean {
  const value = lower(status);
  return (ROBOT_LEAVER_STATUSES as readonly string[]).includes(value);
}

/**
 * Whole days from `fromIso` to `toIso`, both date-only. Negative when `fromIso` is in the future.
 *
 * Date-only arithmetic on purpose: a timestamp would drag Cairo/UTC into a rule whose whole job is
 * to be obvious, and `last_working_date` is a date the moment it is typed.
 */
export function wholeDaysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return Number.NaN;
  return Math.floor((to - from) / 86_400_000);
}

/**
 * May the robot revoke this mailbox?
 *
 * Returns the FIRST failing gate, so the caller reports one comprehensible reason rather than a
 * list. Every refusal is safe to repeat: nothing here mutates, and a task refused today is simply
 * looked at again tomorrow.
 */
export function evaluateRevocationSafety(input: RobotSafetyInput): RobotSafetyVerdict {
  const { directory, enabled, task, todayIso } = input;

  // G1 — the kill switch. Checked first so a disabled robot never reads anything.
  if (!enabled) {
    return { allowed: false, refusal: "robot_disabled", detail: "The revocation robot is switched off." };
  }

  // G2 — the register has already closed this row. `not_applicable` is a human's written decision
  // and a robot must never reopen or re-act on one.
  if (task.status === "revoked" || task.status === "not_applicable") {
    return {
      allowed: false,
      refusal: "already_revoked",
      detail: `This mailbox is already recorded as ${task.status.replace("_", " ")}.`,
    };
  }

  // G3 — there must be an address, and it must be one Turbify actually hosts for this company.
  // Without this the driver could be pointed at any string the register happens to hold.
  const address = lower(task.workEmail);
  if (!address) {
    return { allowed: false, refusal: "no_mailbox", detail: "This task carries no mailbox address." };
  }
  if (!isCompanyAddress(address)) {
    return {
      allowed: false,
      refusal: "not_a_company_address",
      detail: `${address} is not a company mailbox, so the robot will not touch it.`,
    };
  }

  // G4 — the person must still exist on the employee master. A task whose employee has been deleted
  // is a data question for a person, not something to act on.
  const employee = directory.find((row) => lower(row.hrId) === lower(task.employeeHrId));
  if (!employee) {
    return {
      allowed: false,
      refusal: "employee_not_found",
      detail: `${task.employeeName} is no longer on the employee master.`,
    };
  }

  // G5 — THE LIVE STATUS, not the snapshot. A reversed resignation lands here, and this is the gate
  // that catches it. Read from the employee record every run; the task row is never trusted for it.
  if (!isLeaverStatus(employee.employmentStatus)) {
    return {
      allowed: false,
      refusal: "employee_not_a_leaver",
      detail: `${employee.displayName} is currently ${employee.employmentStatus ?? "unknown"} on the employee master, not a leaver.`,
    };
  }

  // G6 — the date must have passed, by a margin. See ROBOT_MIN_DAYS_OVERDUE for why not zero.
  if (!task.lastWorkingDate) {
    return {
      allowed: false,
      refusal: "no_last_working_date",
      detail: `${employee.displayName} has no last working date recorded.`,
    };
  }
  const daysSince = wholeDaysBetween(task.lastWorkingDate, todayIso);
  if (!Number.isFinite(daysSince) || daysSince < ROBOT_MIN_DAYS_OVERDUE) {
    return {
      allowed: false,
      refusal: "too_recent",
      detail: `${employee.displayName}'s last working date is ${task.lastWorkingDate}; the robot waits ${ROBOT_MIN_DAYS_OVERDUE} full day after it.`,
    };
  }

  // G7 — THE GATE THAT MATTERS MOST. A resigned person's address is legitimately reused for a new
  // hire in this company, so an address on a leaver's task can belong to somebody who is working
  // today. Revoking it would lock a working employee out of their email with no warning.
  //
  // Checked against ACTIVE holders other than this person: the leaver holding their own address is
  // the normal case and must not refuse.
  const activeHolder = directory.find(
    (row) => row.isActive && lower(row.workEmail) === address && lower(row.hrId) !== lower(employee.hrId),
  );
  if (activeHolder) {
    return {
      allowed: false,
      refusal: "address_belongs_to_an_active_employee",
      detail: `${address} is the work email of ${activeHolder.displayName}, who is still active. The robot will not touch it.`,
    };
  }

  // G8 — and if two records hold the address at all, a person decides which is which. This is
  // narrower than G7 on purpose: G7 catches the dangerous case, this catches the ambiguous one.
  const holders = directory.filter((row) => lower(row.workEmail) === address);
  if (holders.length > 1) {
    return {
      allowed: false,
      refusal: "address_held_by_more_than_one_person",
      detail: `${address} appears on ${holders.length} employee records, so a person should decide this one.`,
    };
  }

  return { allowed: true };
}

/** The date-only part of a timestamp ISO, for day arithmetic. Empty string when unparseable. */
function dateOnly(iso: string | null): string {
  if (!iso) return "";
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(iso.trim());
  return match ? match[1] : "";
}

/**
 * Decide the ONE thing the robot should do to this task this run: reset, delete, or nothing.
 *
 * Layered on top of `evaluateRevocationSafety` so the base gates run FIRST and identically for both
 * phases — the address, the live leaver status, the recycled-address check all re-run before a
 * delete, because in the 30 days since the reset the address could have been handed to a new hire.
 * A delete that skipped those gates would destroy a working employee's mailbox.
 *
 * The phase, once the base gates pass:
 *   - password not yet reset            → RESET is due.
 *   - reset, but not BY the robot        → skip (`reset_not_by_robot`). A person reset it; a person
 *                                          finishes it. The robot never completes a human's pipeline.
 *   - reset by the robot, grace not up   → skip (`awaiting_delete_grace`). Normal waiting.
 *   - reset by the robot, grace elapsed  → DELETE is due.
 */
export function decideRobotAction(
  input: RobotSafetyInput,
  options: { minDaysBeforeDelete?: number } = {},
): RobotActionDecision {
  const base = evaluateRevocationSafety(input);
  if (!base.allowed) return { action: null, refusal: base.refusal, detail: base.detail };

  const { task, todayIso } = input;

  // Phase 1 — the password has never been reset. Reset it now.
  if (!task.passwordResetAt) return { action: "reset" };

  // The password IS reset. The only thing left the robot may do is delete, and only to its own work.
  if (task.passwordResetBy !== ROBOT_ACTOR) {
    return {
      action: null,
      refusal: "reset_not_by_robot",
      detail: `${task.employeeName}'s password was reset by ${task.passwordResetByName ?? task.passwordResetBy ?? "a person"}, not the robot, so the robot leaves the disposition to them.`,
    };
  }

  const minDaysBeforeDelete = Number.isFinite(options.minDaysBeforeDelete)
    ? Math.max(0, Math.floor(options.minDaysBeforeDelete as number))
    : ROBOT_MIN_DAYS_BEFORE_DELETE;
  const resetDate = dateOnly(task.passwordResetAt);
  const daysSinceReset = wholeDaysBetween(resetDate, todayIso);
  if (!Number.isFinite(daysSinceReset) || daysSinceReset < minDaysBeforeDelete) {
    return {
      action: null,
      refusal: "awaiting_delete_grace",
      detail: `${task.employeeName}'s mailbox was reset on ${resetDate || "an unknown date"}; the robot deletes it ${minDaysBeforeDelete} days after the reset.`,
    };
  }

  return { action: "delete" };
}

/**
 * Apply the per-run cap to an already-filtered list.
 *
 * Separate from the gates because it is a property of the RUN, not of any one task — folding it
 * into `evaluateRevocationSafety` would make that function order-dependent and much harder to test.
 */
export function capForRun<T>(eligible: T[], maxPerRun: number): { run: T[]; deferred: T[] } {
  const limit = Number.isFinite(maxPerRun) && maxPerRun > 0 ? Math.floor(maxPerRun) : 0;
  return { run: eligible.slice(0, limit), deferred: eligible.slice(limit) };
}
