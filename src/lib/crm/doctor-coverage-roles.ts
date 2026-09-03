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

import { canonicalHrIdKey } from "@/lib/hr-id";

/** How wide a role's reach is. `company` sees every rep; the rest resolve against the org tree. */
export type DoctorCoverageScopeBasis = "company" | "line" | "team" | "self";

/**
 * A resolved viewer scope. RESOLVED by doctor-coverage-scope.ts, which is server-only; declared
 * HERE, with {@link isAgentInScope}, because applying a scope is pure and the boards that apply one
 * must not drag the Supabase admin client along with it.
 *
 * That is the same rule this file's header states for the role list, and it is not theoretical:
 * crm/reps-plans.ts is imported by a "use client" component, so a VALUE import of the resolver from
 * there would put the admin client in a browser bundle. The type alone is erased at compile time;
 * this function is not.
 */
export type DoctorCoverageScope =
  | { kind: "company"; basis: "company"; label: string }
  /** Explicit allow-list of `agent_hr_id`s. Never empty — an empty resolution returns `none`. */
  | { kind: "agents"; basis: Exclude<DoctorCoverageScopeBasis, "company">; agentHrIds: string[]; label: string }
  | { kind: "none"; reason: string };

/**
 * Whether one rep is inside a viewer's reach. THE scope check — every board that resolves a
 * `DoctorCoverageScope` applies it through this function rather than writing the comparison itself.
 *
 * FAILS CLOSED on a missing hr id. A row whose identity did not resolve cannot be PROVEN to belong
 * to this manager's team, and the two mistakes do not cost the same: hiding a rep from his own
 * manager is a visible gap he reports within the day, while showing him somebody else's rep is a
 * silent confidentiality breach nobody notices at all.
 *
 * BOTH sides go through `canonicalHrIdKey`, which is idempotent — so it is safe on a caller whose
 * rows are already canonical and correct on one whose rows are raw. Production hr ids are MIXED
 * CASE and a case-sensitive comparison under-returns silently rather than erroring: one `.eq` once
 * hid 28% of reps' own orders, and a row matching nobody reads here as "this rep is not on your
 * team", which is the most convincing possible way to be wrong. Writing `.trim().toLowerCase()`
 * inline would be this comparison MINUS the legacy alias table (`aaa` -> `aa`), so a renamed seat
 * would drop out of its own manager's scope — tests/hrid-normalizer-ratchet.test.ts exists to catch
 * exactly that, and it has caught it before.
 */
export function isAgentInScope(scope: DoctorCoverageScope, agentHrId: string | null | undefined): boolean {
  if (scope.kind === "company") return true;
  if (scope.kind === "none") return false;
  const key = canonicalHrIdKey(agentHrId ?? null);
  if (!key) return false;
  return scope.agentHrIds.some((allowed) => canonicalHrIdKey(allowed) === key);
}

/**
 * Whole-company reach: staff/executive seats with no territory of their own.
 *
 * Training Manager joined 2026-09-03, with the owner's instruction to show the rep list, the plans
 * and the KPIs to the marketing and field-support seats. He is a COMPANY seat for the same reason
 * SFE Manager and Marketing Manager are, and the reason is not a preference: he owns no line and
 * supervises no rep, so there is no subtree to walk and — unlike a Product Manager — no line on his
 * employee row to scope by. A `line` basis would resolve him to `none` and render an empty board,
 * which reads as "these reps did nothing" rather than as a missing grant.
 */
const COMPANY_ROLES = ["Super Admin", "CEO", "SFE Manager", "Marketing Manager", "Training Manager"] as const;
/** One product line. Matches the scopes already baked into the Business Review access map for
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
  // The two company seats that are nonetheless PORTAL-mode. Spelled out rather than spread from
  // COMPANY_ROLES because that list also holds Super Admin, CEO and SFE Manager, all three of which
  // are admin-mode — spreading it would offer a portal row to seats this resolver never runs for.
  "Marketing Manager",
  "Training Manager",
];

/** `null` → this role has no access to doctor coverage at all. */
export function doctorCoverageScopeBasisForRole(role: string): DoctorCoverageScopeBasis | null {
  return BASIS_BY_ROLE.get(role) ?? null;
}

/** Convenience predicate for nav config and page gates. */
export function canSeeDoctorCoverage(role: string): boolean {
  return BASIS_BY_ROLE.has(role);
}
