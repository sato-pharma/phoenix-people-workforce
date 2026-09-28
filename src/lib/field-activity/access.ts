/**
 * Field Activity — who reaches the module, whose days they may open, and which panels they see.
 *
 * THE SCOPE IS BORROWED, NOT REWRITTEN. `getDoctorCoverageScope` already answers "which reps may
 * this viewer see" from the ORG TREE — a subtree walk for a District or Regional Manager, the line
 * for a National Sales or Product Manager, company for the staff seats — and it is already tuned to
 * the owner's rulings, including the NSM who sees only his own line. Writing a second answer here
 * would be a second thing to keep in step with his next ruling, and the two would disagree quietly.
 * This module therefore resolves the same scope and applies it with the same `isAgentInScope`.
 *
 * 🔴 THE MEDICAL REP IS NOT HERE, AND THAT IS THE POINT. `doctorCoverageScopeBasisForRole` gives a
 * Medical Rep a `self` basis, which would hand him this report about himself — his own route drawn
 * on a map, his own logging lag, his own time on territory. Phoenix CRM golden rule #1 is that the
 * rep's app is BLIND: every signal that judges how he works is readable by the Super Admin and the
 * SFE Manager, and he is never shown that he is being measured. The owner said the same thing again
 * on 2026-09-26 about the place-versus-actual report — DM, SFE, NSM and Super Admin, NOT the rep.
 * So this module keeps its OWN role list, and a rep who reaches the route is refused like anybody
 * else without the grant.
 *
 * THE SENSITIVE PANELS ARE GATED SEPARATELY. A day page can carry an outstation claim (money) and a
 * fingerprint punch (attendance). Neither is field activity, and a viewer who may see where someone
 * went is not automatically a viewer who may see what he was paid or when he badged in. Each panel
 * is therefore gated on the viewer's OWN existing grant for that thing — `expenses` and
 * `attendance` — rather than on this module's grant. A District Manager who approves his reps'
 * trips keeps seeing them; a seat that never sees money never starts seeing it here.
 */

import { canAccess, type AccessContext, type PhoenixRole } from "@/lib/auth/permissions";
import { isAgentInScope, type DoctorCoverageScope } from "@/lib/crm/doctor-coverage-roles";
import { getDoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";
import { canonicalHrIdKey } from "@/lib/hr-id";

/**
 * The roles that reach this module at all.
 *
 * Deliberately the audience the owner named on 2026-09-28 — "dms and rm and nsm and sfe" — plus the
 * Super Admin and the CEO, who see every module, and the line seats (Product and Group Product
 * Manager) who run double visits with those same reps and are the reason the first report was asked
 * for. Marketing Manager and Training Manager are NOT here: they hold the double-visit board because
 * they need the counts, and this report is a person's whole day rather than a count.
 */
export const FIELD_ACTIVITY_ROLES = [
  "Super Admin",
  "CEO",
  "SFE Manager",
  "National Sales Manager",
  "Regional Manager",
  "District Manager",
  "Product Manager",
  "Group Product Manager",
] as const satisfies readonly PhoenixRole[];

export function isFieldActivityRole(role: PhoenixRole | null | undefined): boolean {
  return FIELD_ACTIVITY_ROLES.some((allowed) => allowed === role);
}

export type FieldActivityPanels = {
  /** The outstation claim block. Gated on the viewer's own `expenses` grant. */
  expenses: boolean;
  /** The fingerprint punch block. Gated on the viewer's own `attendance` grant. */
  attendance: boolean;
  /** The approved-leave block. Gated on the viewer's own `leave` grant. */
  leave: boolean;
};

export type FieldActivityAccess = {
  role: PhoenixRole;
  viewerHrId: string | null;
  scope: DoctorCoverageScope;
  panels: FieldActivityPanels;
};

/**
 * Resolve everything the routes need in one place, so no route decides any of it for itself.
 *
 * Returns `null` when the viewer has no business here at all — the routes turn that into a 403
 * without leaking whether the person asked about exists.
 */
export async function resolveFieldActivityAccess(access: AccessContext): Promise<FieldActivityAccess | null> {
  if (!isFieldActivityRole(access.role)) return null;
  if (!(await canAccess(access, "double_visit_analytics", "read"))) return null;

  const scope = await getDoctorCoverageScope(access);
  if (scope.kind === "none") return null;

  const [expenses, attendance, leave] = await Promise.all([
    canAccess(access, "expenses", "read"),
    canAccess(access, "attendance", "read"),
    canAccess(access, "leave", "read"),
  ]);

  return {
    role: access.role,
    viewerHrId: access.hrId ?? null,
    scope,
    panels: { attendance, expenses, leave },
  };
}

/**
 * May this viewer open this person's days?
 *
 * A viewer may always open his OWN record — a manager looking at the double visits he himself was
 * on is looking at his own work, and `isAgentInScope` would otherwise refuse him because the scope
 * lists the people BENEATH him and never himself (scope runs downward only).
 */
export function canOpenSubject(access: FieldActivityAccess, subjectHrId: string | null | undefined): boolean {
  const key = canonicalHrIdKey(subjectHrId ?? null);
  if (!key) return false;
  if (access.viewerHrId && canonicalHrIdKey(access.viewerHrId) === key) return true;
  return isAgentInScope(access.scope, subjectHrId ?? null);
}
