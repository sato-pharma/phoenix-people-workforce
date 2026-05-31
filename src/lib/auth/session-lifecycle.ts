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
