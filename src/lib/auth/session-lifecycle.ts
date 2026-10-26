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

import { SESSION_VERIFICATION_UNAVAILABLE_DIGEST } from "@/lib/auth/session-unavailable-digest";

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

/**
 * Date-only `YYYY-MM-DD`, or null when the value is absent or not a date. A full ISO instant is
 * accepted by taking its date half, so a caller handing over a timestamp does not silently fall
 * through to "no grace". Compared lexicographically by the caller — correct for this format, and
 * it keeps this module free of Date parsing and its timezone traps.
 */
const DATE_ONLY_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
function normalizeDateOnly(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const candidate = raw.slice(0, 10);
  return DATE_ONLY_PATTERN.test(candidate) ? candidate : null;
}

/**
 * True when a departure has actually TAKEN EFFECT — the person's last working day has passed.
 *
 * WHY THIS EXISTS (2026-09-03). Access used to be revoked the moment an exit was FILED rather than
 * on the day the person actually left, and that is wrong in both directions:
 *   - Filed EARLY. A-16's exit was filed 2026-08-28 for a 2026-08-31 last working day, so her
 *     status flipped three days before she left. She was locked out on 2026-08-30 while still
 *     employed, and it presented as a PASSWORD problem: two failed logins, then a reset link, a
 *     password reset, a setup link and a password setup inside three minutes — none of which could
 *     ever have helped, because the block was her employment status.
 *   - Filed LATE. PD-0006 left 2026-08-20 but his exit was not filed until 2026-08-28, so he
 *     signed in legitimately on 2026-08-27 and created two junk venue rows in production.
 *
 * The LATE case cannot be closed in code — nothing can act on a departure it has not been told
 * about. This closes the EARLY case, and makes the revocation correctly DATED in both.
 *
 * STRICTLY AFTER, deliberately. The grace holds only while the last working day is still in the
 * future, so a departure dated TODAY revokes access at once and a same-day termination is not
 * widened by this. `app_auth_users.is_active = false` remains the immediate kill switch and
 * overrides all of this — it is checked before any of it.
 *
 * The grace applies ONLY to the three DEPARTED statuses, i.e. a real person serving out notice.
 * `historical_payroll_record` and `system_placeholder` are ledger artefacts with no last working
 * day (see DEPARTED_EMPLOYMENT_STATUSES above) and stay revoked unconditionally, as does any other
 * non-active status such as `inactive`.
 *
 * A missing or unparseable last working day means NO grace, which is exactly the pre-2026-09-03
 * behaviour. So this can only ever restore access to someone the company's own record still says
 * is working, and never widens it on missing data.
 */
export function isEmploymentAccessRevoked(input: {
  employmentStatus: string | null | undefined;
  lastWorkingDate?: string | null;
  todayCairo?: string | null;
}): boolean {
  if (!isTerminalEmploymentStatus(input.employmentStatus)) return false;
  if (!hasDepartedEmployment(input.employmentStatus)) return true;
  const lastWorkingDate = normalizeDateOnly(input.lastWorkingDate);
  const today = normalizeDateOnly(input.todayCairo);
  if (!lastWorkingDate || !today) return true;
  return lastWorkingDate <= today;
}

/** Outcome of the read-time employee lifecycle gate. */
export type SessionLifecycleGate =
  | { allowed: true }
  | { allowed: false; reason: "employee_terminal" | "employee_lookup_failed"; employmentStatus?: string };

/**
 * The gate could not REACH the database, so it cannot say whether the linked employee is still
 * active. That is an infrastructure failure, NOT a governance verdict, and the two must never be
 * answered the same way: a verdict ends the session, an outage leaves it exactly as it was.
 *
 * Why this exists. `employee_lookup_failed` used to carry the same `allowed: false` a resigned
 * employee gets, so `resolveSessionState` returned null, the heartbeat read that as "session
 * expired", cleared all three auth cookies and answered 401 — and the client signs out on a 401
 * alone. One Supabase blip therefore signed out everyone who was working, and since the heartbeat
 * repeats about once a minute, signing back in only bought them the next minute. Measured on
 * 2026-10-10: the hosted Supabase endpoint answered Cloudflare 521/525 between 11:03 and 11:17
 * Cairo, 10 people hit errors, 9 sessions were created then abandoned inside 5 seconds, one Medical
 * Representative signed in 3 times in 3 minutes and another managed 8 in 3.
 *
 * Keeping the session through an outage grants no extra reach: every page and API read goes through
 * the same database, so while it is unreachable a session that ought to have ended can do nothing
 * with it. Exposure is bounded by one heartbeat interval; the alternative was a platform-wide
 * logout. A `employee_terminal` verdict is unchanged and still ends the session immediately.
 */
export class SessionVerificationUnavailableError extends Error {
  // The only part of this error a production browser receives: a page render that throws it shows
  // the route boundary a calm "could not confirm your sign-in, retrying" state instead of a crash
  // card. See session-unavailable-digest.ts.
  readonly digest = SESSION_VERIFICATION_UNAVAILABLE_DIGEST;

  constructor(options: { cause?: unknown } = {}) {
    super("Session verification is temporarily unavailable.");
    this.name = "SessionVerificationUnavailableError";
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export function isSessionVerificationUnavailable(error: unknown) {
  return error instanceof SessionVerificationUnavailableError;
}

/**
 * How a caller must answer the lifecycle gate. The whole point is that `reject` and `unavailable`
 * are DIFFERENT answers: `reject` ends the session, `unavailable` keeps it and asks the caller to
 * retry. Collapsing the two is the defect this function exists to make impossible to reintroduce —
 * pinned by `tests/session-unavailable-keeps-session.test.ts`.
 */
export type SessionGateOutcome = "allow" | "reject" | "unavailable";

export function sessionGateOutcome(gate: SessionLifecycleGate): SessionGateOutcome {
  if (gate.allowed) return "allow";
  // Could not reach the database — no verdict was ever reached, so there is nothing to reject.
  if (gate.reason === "employee_lookup_failed") return "unavailable";
  return "reject";
}

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
  // Both OPTIONAL so every pre-existing caller keeps its exact behaviour: with no date there is no
  // grace, which is the block this gate has always applied. Supplying them is what lets a departure
  // filed in advance stop locking out someone who is still working.
  lastWorkingDate?: string | null;
  todayCairo?: string | null;
}): SessionLifecycleGate {
  if (input.lookupFailed) {
    return { allowed: false, reason: "employee_lookup_failed" };
  }
  if (isEmploymentAccessRevoked(input)) {
    return {
      allowed: false,
      reason: "employee_terminal",
      employmentStatus: String(input.employmentStatus).trim(),
    };
  }
  return { allowed: true };
}
