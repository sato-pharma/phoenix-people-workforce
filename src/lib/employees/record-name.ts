/**
 * The employee RECORD name — one definition, for every screen that renders a persisted
 * `employee_name` snapshot back to a human.
 *
 * `EmployeeDirectoryRow.displayName` is nickname-first by design, and its own type comment says
 * where each name belongs: displayName for live UI, `fullName` for "legal/payroll documents,
 * persisted workflow audit snapshots, and identity-matching logic". A workflow row's stored
 * `employee_name` is exactly the third of those — an audit snapshot — so the name it is WRITTEN
 * with and the name it is READ BACK with are both the record's full name.
 *
 * Why this is its own module rather than a private helper in one domain: the rule was discovered
 * in outstation (PR #4135 fixed the write side, #4136 the read side) but it is not an outstation
 * fact. The approvals hub renders the same kind of snapshot for leave, excuses and weekly plans,
 * and resolved it to `displayName` — so one outstation request read as the record name on the
 * outstation queue and as a nickname in the hub, for the same person on the same day. Two copies
 * of a naming rule is how that gap opened; this module is the one copy.
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
 * The employee record's own name.
 *
 * `fullName` first, never `displayName`. It falls through to `displayName` and then the HR id only
 * so a record with a blank full name still yields something a human can read; it never yields an
 * empty string.
 */
export function employeeRecordName(employee: EmployeeRecordNameSource): string {
  return text(employee.fullName) || text(employee.displayName) || employee.hrId;
}

/**
 * The name to SHOW for one row that was already written, given the record name resolved for its
 * HR id (or nothing, when the directory could not answer for it).
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
