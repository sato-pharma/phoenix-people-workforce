/**
 * Which active logins are allowed to carry no HR_ID, and why each one is.
 *
 * `app_auth_users.hr_id` is a foreign key onto `employees.hr_id`, so a login can only ever name a
 * real person. `admin-HR` is the platform's own break-glass Super Admin: it is not a person,
 * production holds no `employees` row for it, and the standing rule is that one must never be
 * created — a synthetic employee injected into a live payroll and headcount platform is a worse
 * defect than the null. The null is that account's correct terminal state, not an unfixed gap,
 * which is why `scripts/repo-doctor.mjs` already carries the same login in its
 * AUTH_ORPHAN_ALLOWLIST.
 *
 * This lives apart from the check that uses it so it can be pinned by a test without dragging the
 * Supabase client into a deliberately database-free test file.
 */
const LOGINS_WITHOUT_AN_EMPLOYEE_ROW = new Map<string, string>([
  ["admin-hr", "the break-glass Super Admin, which has no employees row by standing rule"],
]);

export type ExplainedLogin = { login: string; reason: string };

/**
 * Split the HR_ID-less logins into the ones that are accounted for and the ones that are not.
 *
 * Deliberately an allowlist rather than a blanket "stop counting nulls": a SECOND login appearing
 * without an HR_ID is precisely the thing worth paging on, and it would be invisible if the check
 * ignored the whole class. The matching is case-insensitive on purpose, and that is the part worth
 * pinning — the live login is spelled `admin-HR`, so an exact-match allowlist would let the very
 * account it names breach every night while still reading, in source, as though it were handled.
 */
export function partitionLoginsWithoutEmployeeRow(logins: readonly string[]): {
  explained: ExplainedLogin[];
  unexplained: string[];
} {
  const explained: ExplainedLogin[] = [];
  const unexplained: string[] = [];
  for (const login of logins) {
    const reason = LOGINS_WITHOUT_AN_EMPLOYEE_ROW.get(login.trim().toLowerCase());
    if (reason) explained.push({ login, reason });
    else unexplained.push(login);
  }
  return { explained, unexplained };
}
