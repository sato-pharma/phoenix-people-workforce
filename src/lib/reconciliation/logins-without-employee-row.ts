/**
 * Which active logins are allowed to carry no HR_ID, and why each one is.
 *
 * `app_auth_users.hr_id` is a foreign key onto `employees.hr_id`, so a login can only ever name a
 * real person. Two classes of account correctly hold no HR_ID at all, and both are terminal states
 * rather than unfixed gaps:
 *
 *   1. `admin-HR`, the platform's own break-glass Super Admin. It is not a person, production holds
 *      no `employees` row for it, and the standing rule is that one must never be created — a
 *      synthetic employee injected into a live payroll and headcount platform is a worse defect
 *      than the null. `scripts/repo-doctor.mjs` already carries the same login in its
 *      AUTH_ORPHAN_ALLOWLIST.
 *   2. Every TEST ACCOUNT (`is_test_persona = true`). By design a test account has its own
 *      `TEST-…` login and NO `hr_id` of its own — `test_persona_of_hr_id` names the employee it
 *      mirrors instead — precisely so that no lookup of a real person's account by HR id can ever
 *      land on it (src/lib/auth/test-persona.ts). It is told things in the test world on purpose
 *      (src/lib/auth/test-persona-directory.ts), and those deliveries belong to the test login, not
 *      to a person. Measured on production 15 Oct 2026: all 17 HR_ID-less active logins besides
 *      `admin-HR` were test accounts, every one of them mirroring somebody, and the nightly check
 *      had been reporting them as a breach every morning at 04:40 since 30 Aug 2026 — 43 alerts to
 *      the owner's Telegram for a condition that is the design.
 *
 * This lives apart from the check that uses it so it can be pinned by a test without dragging the
 * Supabase client into a deliberately database-free test file.
 */

import { normalizeTestAccountLoginId } from "@/lib/auth/test-persona";

const LOGINS_WITHOUT_AN_EMPLOYEE_ROW = new Map<string, string>([
  ["admin-hr", "the break-glass Super Admin, which has no employees row by standing rule"],
]);

/** One active login that carries no HR_ID, as the check reads it out of `app_auth_users`. */
export type LoginWithoutEmployeeRow = {
  login: string;
  /** `app_auth_users.is_test_persona` — the authoritative marker, never inferred from the name. */
  isTestPersona?: boolean | null;
};

export type ExplainedLogin = { login: string; reason: string };

/**
 * Split the HR_ID-less logins into the ones that are accounted for and the ones that are not.
 *
 * Deliberately narrow rather than a blanket "stop counting nulls": a login appearing without an
 * HR_ID outside these two classes is precisely the thing worth paging on, and it would be invisible
 * if the check ignored the whole class. Two things are worth pinning, because each one would make
 * this file read, in source, as though it were handling something it was not:
 *
 *   - The name matching is case-insensitive. The live login is spelled `admin-HR`, so an exact-match
 *     allowlist would let the very account it names breach every night.
 *   - A test account is explained only when the flag AND the login agree. `is_test_persona` set on
 *     something that is not a valid `TEST-…` login stays UNEXPLAINED — fail-closed, so flipping that
 *     column on a real person's account cannot buy silence from this check.
 */
export function partitionLoginsWithoutEmployeeRow(logins: readonly LoginWithoutEmployeeRow[]): {
  explained: ExplainedLogin[];
  unexplained: string[];
} {
  const explained: ExplainedLogin[] = [];
  const unexplained: string[] = [];
  for (const entry of logins) {
    const login = entry.login;
    const named = LOGINS_WITHOUT_AN_EMPLOYEE_ROW.get(login.trim().toLowerCase());
    if (named) {
      explained.push({ login, reason: named });
      continue;
    }
    if (entry.isTestPersona === true && normalizeTestAccountLoginId(login)) {
      explained.push({
        login,
        reason: "a test account, which carries no HR_ID by design and mirrors a real employee instead",
      });
      continue;
    }
    unexplained.push(login);
  }
  return { explained, unexplained };
}
