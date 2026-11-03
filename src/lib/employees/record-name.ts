/**
 * The two names a persisted `employee_name` snapshot deals in — one definition of each.
 *
 *   - WRITE: `employeeRecordName` is what a new row stamps: the record's full name, the
 *     audit-snapshot and payroll-feeding name. Unchanged.
 *   - READ: `employeeShownName` is what every screen and email prints for a row already written:
 *     the display name (owner, 2026-11-03, reversing his 2026-09-21 "align the decided-by name to
 *     the record name too"). Contracts, payslips, payroll sheets and workbooks that feed payroll,
 *     government forms and salary letters keep the legal full name.
 *
 * Why this is its own module rather than a private helper in one domain: outstation and the
 * approvals hub render the same kind of snapshot, and two copies of a naming rule once showed one
 * person under two names on one day. This module is the one copy.
 *
 * Nothing here writes. The stored column stays raw — it remains the audit trail of what was true
 * at submit time — and the resolution happens at render, which is what makes a corrected employee
 * record reach rows written before the correction.
 */

import { canonicalHrIdKey } from "@/lib/hr-id";

/** The shape both the employee directory and a directory row satisfy. */
export type EmployeeRecordNameSource = {
  displayName?: string | null;
  fullName?: string | null;
  hrId: string;
};

function text(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * WRITE SIDE: the employee record's own name, as a new row stamps it.
 *
 * `fullName` first, never `displayName`. It falls through to `displayName` and then the HR id only
 * so a record with a blank full name still yields something a human can read; it never yields an
 * empty string.
 */
export function employeeRecordName(employee: EmployeeRecordNameSource): string {
  return text(employee.fullName) || text(employee.displayName) || employee.hrId;
}

/**
 * READ SIDE: the name a screen or an email prints for this person (owner, 2026-11-03).
 *
 * `displayName` first, then `fullName`, then the HR id, so it never yields an empty string. Never
 * stamp this onto a row, and never print it on a legal or payroll document.
 */
export function employeeShownName(employee: EmployeeRecordNameSource): string {
  return text(employee.displayName) || text(employee.fullName) || employee.hrId;
}

/**
 * The name to SHOW for one row that was already written, given the name resolved for its HR id
 * (or nothing, when the directory could not answer for it). Readers pass `employeeShownName`.
 *
 * Every fallback here lands on the stored name, deliberately:
 *
 *   - the row carries no HR id — an imported row with only a name on it keeps that name;
 *   - the HR id is not in the directory — including an id that no longer exists at all;
 *   - the record resolved to its own HR id, meaning it has no usable name of its own, and the
 *     stored string is the better thing to put on a screen than a code.
 *
 * A rename failing to reach an old row is cosmetic. A queue that renders a blank, or a bare code,
 * where a name belongs is not — so the stored snapshot is always the floor, never an empty string.
 */
export function resolveEmployeeRecordName(
  recordName: string | null | undefined,
  hrId: string | null | undefined,
  storedName: string,
): string {
  const key = canonicalHrIdKey(hrId);
  if (!key) return storedName;
  const live = text(recordName);
  if (!live) return storedName;
  if (canonicalHrIdKey(live) === key) return storedName || live;
  return live;
}
