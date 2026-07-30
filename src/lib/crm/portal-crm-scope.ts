// ─────────────────────────────────────────────────────────────────────────────
// Portal CRM scope — resolves ONE viewer to the set of agents whose CRM rows they may see.
//
// Owner requirement 2026-07-30: District Manager, Medical Rep and National Sales Manager each get the
// full CRM Master grid at a portal URL, scoped to their own people. Regional Manager is included on
// my recommendation (flagged in the PR): the RM already holds `crm_visits:read` and already has a
// subtree scope in every other CRM-adjacent surface (DV Report, DV Planner, Territory Drilldown,
// probation), and the NSM above them sees their districts' rows either way — excluding the middle
// rung would be the anomaly. Removing them is one entry in PORTAL_CRM_ROLES.
//
// The subtree walk is NOT reimplemented here. resolveDoubleVisitAccessScope already does exactly this
// job for the same four roles, and has already been fixed once for a real RM leak (label expansion
// pulled in cross-line reps and reps in uncovered regions). Reusing it means the two surfaces cannot
// disagree about "who reports to me".
// ─────────────────────────────────────────────────────────────────────────────

import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import { canonicalHrIdKey, normalizeHrIdForAccess } from "@/lib/hr-id";
import { resolveDoubleVisitAccessScope } from "@/lib/double-visit-analytics/service";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { crmScopeNothing, type CrmViewerScope } from "@/lib/crm/viewer-scope";

/**
 * Roles that reach /employee-portals/crm.
 *
 * Deliberately excludes the Head-Office "Manager" rung: it has no field reps, so the bound would
 * resolve to just itself and render an empty grid — a dead tab. Also excludes every company-wide
 * role (CEO, Super Admin, SFE Manager, Training Manager, Marketing Manager): they belong on
 * /admin/crm, and admitting them here would route company-wide access through the scoped path.
 */
export const PORTAL_CRM_ROLES = [
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
] as const satisfies readonly PhoenixRole[];

const portalCrmRoleSet = new Set<PhoenixRole>(PORTAL_CRM_ROLES);

export function isPortalCrmRole(role: PhoenixRole | string | null | undefined): boolean {
  return portalCrmRoleSet.has(String(role ?? "").trim() as PhoenixRole);
}

/** Client-safe projection of the scope (no Sets) for the page header chip. */
export type PortalCrmScopeView = {
  role: string;
  scopeSummary: string;
  agentCount: number;
};

export function toPortalCrmScopeView(scope: CrmViewerScope, role: string): PortalCrmScopeView {
  if (scope.kind === "company") return { role, scopeSummary: "Company-wide", agentCount: 0 };
  const agentCount = scope.hrIds.length;
  const summary =
    role === "Medical Rep"
      ? "Your own visits"
      : role === "District Manager"
        ? `Your district · ${agentCount} team member(s)`
        : role === "Regional Manager"
          ? `Your region · ${agentCount} team member(s)`
          : `Your line · ${agentCount} team member(s)`;
  return { role, scopeSummary: agentCount === 0 ? "No team resolved" : summary, agentCount };
}

/**
 * Resolve the caller's CRM row bound.
 *
 * FAILS CLOSED in every uncertain case:
 *  - a role that is not a portal CRM role -> nothing
 *  - a viewer we cannot locate in the directory -> nothing
 *  - a directory read failure -> nothing (the throw propagates; the page renders its error state)
 *  - resolveDoubleVisitAccessScope answering `{all:true}` -> nothing, NOT company-wide. None of the
 *    four portal roles can produce that today, but if a future edit adds one of them to that
 *    function's company-wide list, this path must not silently widen CRM.
 */
export async function resolvePortalCrmScope(access: AccessContext): Promise<CrmViewerScope> {
  if (!isPortalCrmRole(access.role)) return crmScopeNothing();

  const directory = await getEmployeeDirectory();
  const employees = directory.employees;
  const dvScope = resolveDoubleVisitAccessScope(access, employees);
  if (dvScope.all) return crmScopeNothing();

  // dvScope.allowedHrIds holds NORMALIZED keys. The CRM query needs the RAW employees.hr_id values
  // (applyMasterFilters -> expandHrIdFilterValues handles casing), so map keys back to real ids.
  const allowedKeys = dvScope.allowedHrIds;
  const hrIds: string[] = [];
  const keys = new Set<string>();
  const lineNames = new Set<string>();
  for (const employee of employees) {
    const key = normalizeHrIdForAccess(employee.hrId);
    if (!key || !allowedKeys.has(key)) continue;
    if (!employee.hrId) continue;
    hrIds.push(employee.hrId);
    const canonical = canonicalHrIdKey(employee.hrId);
    if (canonical) keys.add(canonical);
    const lineName = String(employee.lineName ?? "").trim();
    if (lineName) lineNames.add(lineName);
  }

  return {
    kind: "hr-ids",
    hrIds,
    keys,
    lineNames: lineNames.size > 0 ? Array.from(lineNames) : [],
  };
}
