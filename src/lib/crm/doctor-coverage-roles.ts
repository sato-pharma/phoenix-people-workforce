/**
 * Doctor Coverage — WHICH roles reach the board, and how wide their reach is.
 *
 * Deliberately split out of doctor-coverage-scope.ts and kept free of any server-only import
 * (no Supabase client, no employee directory). The navigation config and the portal nav-visibility
 * resolver both need the role list, and their module graph reaches client components — importing
 * the scope resolver there would drag the Supabase admin client into a browser bundle.
 *
 * This is the SINGLE list. Before 2026-08-08 the admin page, the portal page, the sidebar config
 * and the portal nav resolver each carried their own copy of "who may see doctor coverage", and
 * none of them scoped the data at all. Anything that needs to know the answer imports it from here.
 */

/** How wide a role's reach is. `company` sees every rep; the rest resolve against the org tree. */
export type DoctorCoverageScopeBasis = "company" | "line" | "team" | "self";

/** Whole-company reach: staff/executive seats with no territory of their own. */
const COMPANY_ROLES = ["Super Admin", "CEO", "SFE Manager", "Marketing Manager"] as const;
/** One product line. Matches the scopes already baked into the S1 Business Review access map for
 * these same three roles, so a viewer's reach does not change between the two modules. */
const LINE_ROLES = ["National Sales Manager", "Product Manager", "Group Product Manager"] as const;
/** Own management subtree — every rep beneath the seat, however many levels down. */
const TEAM_ROLES = ["Regional Manager", "District Manager"] as const;
/** Own panel only. */
const SELF_ROLES = ["Medical Rep"] as const;

const BASIS_BY_ROLE = new Map<string, DoctorCoverageScopeBasis>([
  ...COMPANY_ROLES.map((role) => [role, "company"] as const),
  ...LINE_ROLES.map((role) => [role, "line"] as const),
  ...TEAM_ROLES.map((role) => [role, "team"] as const),
  ...SELF_ROLES.map((role) => [role, "self"] as const),
]);

/** Every role with any access at all. */
export const DOCTOR_COVERAGE_ROLES: readonly string[] = Array.from(BASIS_BY_ROLE.keys());

/**
 * Roles that reach the board through the EMPLOYEE PORTAL rather than the admin shell.
 *
 * Super Admin, CEO and SFE Manager are excluded: they are admin-mode roles and land on
 * /admin/doctor-coverage. Every other role here is portal-mode — app/(admin)/layout.tsx redirects
 * them to /employee-portals before an admin page's gate could run — so this is the list the portal
 * sidebar and bottom-nav must offer.
 */
export const DOCTOR_COVERAGE_PORTAL_ROLES: readonly string[] = [
  ...LINE_ROLES,
  ...TEAM_ROLES,
  ...SELF_ROLES,
  "Marketing Manager",
];

/** `null` → this role has no access to doctor coverage at all. */
export function doctorCoverageScopeBasisForRole(role: string): DoctorCoverageScopeBasis | null {
  return BASIS_BY_ROLE.get(role) ?? null;
}

/** Convenience predicate for nav config and page gates. */
export function canSeeDoctorCoverage(role: string): boolean {
  return BASIS_BY_ROLE.has(role);
}
