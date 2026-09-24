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
 * The most mailboxes one run may touch.
 *
 * A cap is the difference between a bug that damages five mailboxes and one that damages every
 * mailbox the company has. Five clears the current backlog of 13 in three runs while keeping the
 * blast radius of an unnoticed defect small enough to undo by hand.
 */
export const ROBOT_DEFAULT_MAX_PER_RUN = 5;

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
  | "address_held_by_more_than_one_person";

export type RobotSafetyVerdict =
  | { allowed: true }
  | { allowed: false; refusal: RobotRefusal; detail: string };

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
