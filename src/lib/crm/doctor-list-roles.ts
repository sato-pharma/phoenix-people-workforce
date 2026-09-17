/**
 * Reps List — WHICH roles reach the board, and how wide their reach is.
 *
 * Split out of doctor-list-access.ts on 2026-09-03 and kept FREE OF ANY SERVER-ONLY IMPORT, exactly
 * as doctor-coverage-roles.ts is next door and for the same reason: the navigation config and the
 * portal nav-visibility resolver both need the role list, and their module graph reaches client
 * components. doctor-list-access.ts imports `getManagerScope`, which drags the Supabase admin client
 * behind it, so neither of those two callers could ever import the list from there.
 *
 * WHAT THAT COST UNTIL THIS SPLIT. The list was spelled out by hand in three places — the gate, the
 * portal sidebar flag in src/lib/employee-portal/navigation.ts, and the catalog entry in
 * src/config/system-navigation.ts — and tests/reps-list.test.ts existed only to hold the copies in
 * step, its own comment naming the arrangement: "the sidebar row and the gate are two
 * hand-maintained lists". Three copies of a three-role list was survivable; the 2026-09-03 widening
 * takes the portal half to seven, which is where a hand-maintained copy stops being survivable. The
 * two nav callers now import from here, so there is one list and nothing left to drift.
 *
 * This is the SECOND gate, not the only one. Every entry point also asserts `crm_visits:read`
 * through the permission matrix, which is the actual security boundary — a role list is a fast
 * explicit guard, nothing more.
 */

import type { PhoenixRole } from "@/lib/auth/permissions";

/** How wide a role's reach is. `company` sees every rep; the rest resolve against the org tree. */
export type DoctorListScopeBasis = "company" | "line" | "team";

/**
 * Whole-company reach: staff and executive seats with no territory of their own.
 *
 * Marketing Manager and Training Manager joined 2026-09-03 on the owner's instruction to show the
 * rep list, the plans and the KPIs to the marketing and field-support seats. Both are company by
 * the same reasoning that already put SFE Manager here: neither owns a line or supervises a rep, so
 * there is nothing narrower to resolve them to that would not resolve them to nothing at all.
 *
 * None of these four seats supervises a named rep, which is exactly why none of them appears on the
 * Plans tab's list (plan-verification-access.ts) — reading a rep's assigned doctors and signing his
 * plan into the customer's CRM are different authorities, and the two lists live in two files so
 * that granting one can never silently grant the other.
 */
const COMPANY_ROLES = [
  "Super Admin",
  "CEO",
  "National Sales Manager",
  "SFE Manager",
  "Marketing Manager",
  "Training Manager",
] as const;

/**
 * One product line, resolved off the viewer's own employee row.
 *
 * Added 2026-09-03 with the same owner instruction. Deliberately NOT `company`, even though a
 * Product Manager is a staff seat like the four above: `line` is the reach these two already have
 * on the KPIs board (doctor-coverage-roles.ts) and in the Business Review access map, and a seat
 * whose reach changes depending on which screen he opens is a bug that reports itself as confusing
 * data rather than as a permission fault.
 *
 * The line walk itself is NOT reimplemented for this board — `getDoctorListScope` delegates a `line`
 * basis to `getDoctorCoverageScope`, which already carries the multi-line overrides (Ahmed Sharaf
 * covers Pedia and Anti Infective both) and the empty-result handling.
 */
const LINE_ROLES = ["Product Manager", "Group Product Manager"] as const;

/** Own management subtree. The district manager is the seat the owner asked for on 2026-08-28. */
const TEAM_ROLES = ["Regional Manager", "District Manager"] as const;

const BASIS_BY_ROLE = new Map<string, DoctorListScopeBasis>([
  ...COMPANY_ROLES.map((role) => [role, "company"] as const),
  ...LINE_ROLES.map((role) => [role, "line"] as const),
  ...TEAM_ROLES.map((role) => [role, "team"] as const),
]);

/** Every seat with any door onto the board, either shell. */
export const DOCTOR_LIST_ACCESS_ROLES: readonly PhoenixRole[] = Array.from(
  BASIS_BY_ROLE.keys(),
) as unknown as readonly PhoenixRole[];

/**
 * The PORTAL half, for the sidebar flag and the nav catalog entry to mirror.
 *
 * Super Admin, CEO and SFE Manager are excluded because they are admin-mode and land on
 * /admin/reps-list — app/(admin)/layout.tsx redirects a portal-mode viewer out of the admin shell
 * before a page's own gate could run, so an entry naming them here would render a row that
 * redirects. Every other admitted role is portal-mode.
 *
 * Medical Rep is absent from the list above entirely, unlike on KPIs: this board is about the reps
 * who report to you, so a rep would reach it and see nobody. A rep's door is My List, below.
 */
export const DOCTOR_LIST_PORTAL_ROLES: readonly PhoenixRole[] = [
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
  "Training Manager",
  "Regional Manager",
  "District Manager",
] as unknown as readonly PhoenixRole[];

/**
 * My List — the same board, opened on the viewer's OWN list. A separate door, not a widening of
 * the one above.
 *
 * The owner's instruction, 2026-09-16: "show in medical reps accounts the reps-list scoped to
 * everyone scope and call is My List". Every seat reads the board at its own reach, and a rep's
 * reach is the rep alone — so a rep gets their own contact list, under a name that says so, and
 * managers keep Reps List.
 *
 * KEPT OUT OF `BASIS_BY_ROLE` ON PURPOSE. Adding Medical Rep there would admit a rep to Reps List
 * itself (`canAccessDoctorList` is that page's gate) and change the answer for every other caller
 * of `doctorListBasisForRole`, the direct-order venue picker among them. A rep reads one list and
 * picks nobody, so a rep's door is its own page with its own gate, and the manager board's role
 * list stays exactly as reviewed.
 *
 * No server-only import, for the same two callers as the list above: the portal sidebar flag and
 * the nav catalog entry both mirror this list.
 */
export const MY_LIST_PORTAL_ROLES: readonly PhoenixRole[] = ["Medical Rep"] as unknown as readonly PhoenixRole[];

/** Whether this seat's door onto the board is My List. The role-list half only — `crm_visits:read` is still asserted. */
export function canAccessMyList(context: { role: string }): boolean {
  return (MY_LIST_PORTAL_ROLES as readonly string[]).includes(context.role);
}

/** `null` → this role has no access to the reps list at all. */
export function doctorListBasisForRole(role: string): DoctorListScopeBasis | null {
  return BASIS_BY_ROLE.get(role) ?? null;
}

/** Convenience predicate for nav config and page gates. */
export function canAccessDoctorList(context: { role: string; scope?: string }): boolean {
  if (context.scope === "system") return true;
  return BASIS_BY_ROLE.has(context.role);
}
