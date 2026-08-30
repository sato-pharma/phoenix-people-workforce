/**
 * Read-time session lifecycle governance.
 *
 * `app_auth_users.is_active` is the primary session gate, but it can drift from
 * `employees.employment_status` — e.g. a termination applied via CSV import or a
 * contract non-renewal that updates the employee record without deactivating the
 * login. Session resolution therefore cross-checks the linked employee's lifecycle
 * status so a resigned/terminated/non-renewed person cannot keep a valid session
 * while `is_active` is stale. This module holds the PURE decision so it is fully
 * unit-testable without the env-bound Supabase/Next request machinery.
 *
 * No mutation happens here — this is read-time enforcement only.
 */

/**
 * Employee lifecycle statuses that still grant access. Mirrors
 * `activeLifecycleStatuses` in src/lib/employees/employee-directory.ts (the
 * canonical definition); kept as a tiny local copy so the auth hot path does not
 * import the full employee-directory module graph.
 */
export const ACTIVE_EMPLOYMENT_STATUSES = new Set(["active", "on_leave"]);

/**
 * PostgREST literal form of ACTIVE_EMPLOYMENT_STATUSES, for query filters that need a
 * literal rather than a JS predicate (supabase-js .in()/.or(), or raw PostgREST query
 * strings). Derived from the same Set so the two can never drift.
 */
export const ACTIVE_EMPLOYMENT_STATUSES_IN_LIST = `(${Array.from(ACTIVE_EMPLOYMENT_STATUSES).join(",")})`;
// => "(active,on_leave)"

/**
 * Employee lifecycle statuses that mean SOMEBODY LEFT THIS COMPANY.
 *
 * NOT the complement of ACTIVE_EMPLOYMENT_STATUSES, and that is the whole point of writing it out.
 * `isTerminalEmploymentStatus` answers "may this person hold a session", so it is true for
 * `historical_payroll_record` and `system_placeholder` as well — 17 rows on production
 * 2026-08-30 that are ledger artefacts and payroll placeholders, not people with a last working
 * day. A screen that prints a departure document has to tell the two apart: a Form 6 filed for a
 * placeholder is a form the insurance office rejects.
 *
 * Kept HERE rather than in the one module that needs it, because the last time a screen wrote its
 * own employment-status list the two screens disagreed by 46 people (owner decision 2026-08-24, see
 * tests/hiring-employee-scope.test.ts). One vocabulary, named once.
 */
export const DEPARTED_EMPLOYMENT_STATUSES = new Set(["resigned", "terminated", "not_renewed"]);

/** PostgREST literal form of DEPARTED_EMPLOYMENT_STATUSES. Derived, so the two cannot drift. */
export const DEPARTED_EMPLOYMENT_STATUSES_IN_LIST = `(${Array.from(DEPARTED_EMPLOYMENT_STATUSES).join(",")})`;
// => "(resigned,terminated,not_renewed)"

/** True when the employee record says this person has left. See the set above for why not `!active`. */
export function hasDepartedEmployment(value: string | null | undefined): boolean {
  return DEPARTED_EMPLOYMENT_STATUSES.has(String(value ?? "").trim().toLowerCase());
}

/**
 * True when a linked employee record carries a TERMINAL lifecycle status
 * (resigned / terminated / inactive / not_renewed / anything outside the active
 * set). An unset/empty status is treated as active (NOT terminal) so legacy rows
 * with no status, and accounts not linked to an employee row, are never newly
 * locked out — this rule can only ever tighten access for confirmed-terminal
 * employees, never broaden a denial into active/unknown users.
 */
export function isTerminalEmploymentStatus(value: string | null | undefined): boolean {
  const status = String(value ?? "").trim().toLowerCase();
  if (!status) return false;
  return !ACTIVE_EMPLOYMENT_STATUSES.has(status);
}

/** Outcome of the read-time employee lifecycle gate. */
export type SessionLifecycleGate =
  | { allowed: true }
  | { allowed: false; reason: "employee_terminal" | "employee_lookup_failed"; employmentStatus?: string };

/**
 * Pure decision for the read-time lifecycle gate. Fail-CLOSED on an unexpected
 * lookup error (governance must not silently allow when it cannot verify the
 * linked employee), but allow the intentionally-supported cases:
 *   - `lookupFailed` (DB/query error) -> DENY (`employee_lookup_failed`)
 *   - terminal status                 -> DENY (`employee_terminal`)
 *   - active / on_leave / unset status -> ALLOW
 *
 * "Employee row not found" is represented by the caller passing `lookupFailed:
 * false` with a null/empty status (an unlinked/system account is allowed); a real
 * query error must be passed as `lookupFailed: true`.
 */
export function evaluateEmployeeLifecycleGate(input: {
  lookupFailed: boolean;
  employmentStatus: string | null | undefined;
}): SessionLifecycleGate {
  if (input.lookupFailed) {
    return { allowed: false, reason: "employee_lookup_failed" };
  }
  if (isTerminalEmploymentStatus(input.employmentStatus)) {
    return {
      allowed: false,
      reason: "employee_terminal",
      employmentStatus: String(input.employmentStatus).trim(),
    };
  }
  return { allowed: true };
}
