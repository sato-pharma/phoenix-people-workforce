import type { PhoenixRole } from "@/lib/auth/permissions";

export type EmployeeAccessRoleInput = {
  jobTitle?: string | null;
  positionTitle?: string | null;
};

/**
 * Initial access role for an auto-provisioned employee account.
 *
 * GOVERNANCE — a job title is descriptive only and is NEVER a general permission
 * source. Everything outside the closed allowlist below still starts at the
 * least-privilege "Employee" role and must be elevated explicitly on
 * `app_auth_users` by an authorized admin.
 *
 * The allowlist is the "business-rule-approved explicit mapping" this function was
 * always designed to host (owner-approved 2026-08-10). Leaving the field force
 * unmapped was silently crippling every new hire: six accounts (PD-0004, PD-0006,
 * PD-0008, PD-0009, PD-0010, CN-0005) sat on the Employee role for weeks — up to
 * three months — because nobody remembered the manual elevation step. A District
 * Sales Manager stuck on Employee loses Team, Organogram, Early Birds, Weekly
 * Plans, Direct Orders and, worst of all, leave approval for his own reps.
 *
 * Three bounds make this safe:
 *
 *  1. CLOSED MAP, NO FALLBACK. Do NOT delegate to `resolveJobFunctionRole` or
 *     `normalizeRole` here — both resolve any canonical role string, and real
 *     `employees.job_title` values in production include "Ceo", "Sfe Manager" and
 *     "Talent Acquisition". Routing those through a parser would turn typed text
 *     into a privilege grant. Anything unlisted returns "Employee".
 *  2. NO PRIVILEGE WIDENING. Both mapped roles are privilege rank 100
 *     (`getRolePrivilegeRank`), identical to Employee, so this cannot widen what
 *     `assertActorMayManageUser` already lets a Talent Acquisition actor (rank 150)
 *     create. The rank boundary that blocks Super Admin / CEO / Finance Manager
 *     targets is untouched.
 *  3. FIELD FORCE ONLY. Regional Sales Manager and National Sales Manager are
 *     deliberately NOT mapped: HIERARCHY and LINE scope reach far beyond one team,
 *     and with 1 and 3 active holders they are rare enough to assign by hand.
 *
 * Adding a key here grants that role to anyone whose title matches, so a new entry
 * needs the same owner approval this one had.
 */
const INITIAL_ACCESS_ROLE_BY_TITLE: Record<string, PhoenixRole> = {
  "medical representative": "Medical Rep",
  "medical rep": "Medical Rep",
  "district sales manager": "District Manager",
  "district manager": "District Manager",
  dsm: "District Manager",
};

function normalizeTitle(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function resolveEmployeeAccessRole(employee: EmployeeAccessRoleInput): PhoenixRole {
  for (const title of [employee.jobTitle, employee.positionTitle]) {
    const normalized = normalizeTitle(title);
    if (!normalized) continue;
    const mapped = INITIAL_ACCESS_ROLE_BY_TITLE[normalized];
    if (mapped) return mapped;
  }

  // Least privilege for every other title, including senior-sounding ones.
  return "Employee";
}
