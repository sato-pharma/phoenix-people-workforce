// Weekly Plans — manager-chain visibility for the List page (getEmployeePlansWorkspace,
// listPlanComments, addPlanComment in service.ts).
//
// This is deliberately a SEPARATE module from calendar-service.ts, not an addition to it.
// isPlanItemVisibleToViewer (the Calendar tab's role/line matrix) was hierarchy-based until
// 2026-07-19, when the owner explicitly reverted that in favor of a flat, line/title-based
// model — tests/weekly-plans-hardening.test.ts now bans reintroducing a hierarchy walk into
// that specific file. The List page answers a different question (does my chain-of-command
// reach this plan's owner, at any depth) than the Calendar's curated same-line coordination
// view, so it gets its own, independent check built on the same primitives vacation and
// Employee 360 already use.

import { normalizeHrIdForAccess } from "@/lib/auth/permissions";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { isWithinManagerHierarchy } from "@/lib/workforce/hierarchy-resolver";

function normalizeHrId(value: string | null | undefined): string {
  return normalizeHrIdForAccess(value) ?? "";
}

export type PlanViewerScope = {
  role: string | null;
  hierarchyReportHrIds: ReadonlySet<string>;
};

// Training Manager and HR Advisory already see every plan on the Calendar tab
// (calendar-service.ts) and every employee in the general directory (canSeeEmployee,
// permissions.ts) — this extends that same, already-established company-wide rule to the
// List page too, rather than inventing a third rule for these two roles.
//
// LOWERCASED ROLE NAMES, so neither the PhoenixRole union nor a title-case grep can see them:
// this Set still read "talent acquisition" after that seat was retired on 2026-08-28, typechecked
// clean, and silently returned false for its successor. If a role name changes, this line does not
// move on its own — the test is weekly-plan-visibility.test.ts.
// HR Advisory only: the Planning Calendar follows workforce_insight (hr-functions.ts), and HR
// Operations has no reason to read a rep{"'"}s call plan.
const COMPANY_WIDE_PLAN_VIEWER_ROLES = new Set(["training manager", "hr advisory"]);

/**
 * True when the plan owner sits anywhere in the viewer's downward management chain — direct
 * report, skip-level, or deeper — or the viewer holds standing company-wide plan oversight.
 */
export function isPlanOwnerWithinViewerManagementChain(
  employeeHrId: string | null | undefined,
  viewer: PlanViewerScope,
): boolean {
  if (COMPANY_WIDE_PLAN_VIEWER_ROLES.has(String(viewer.role ?? "").trim().toLowerCase())) return true;
  return viewer.hierarchyReportHrIds.has(normalizeHrId(employeeHrId));
}

/**
 * Precompute a viewer's full downward management chain once per request from an
 * already-loaded directory — no extra query. Seat-continuity aware (see
 * hierarchy-resolver.ts): a report reassigned upward after a manager's resignation, or one
 * still keyed to the departed manager's vacant-seat marker, is still counted.
 */
export function resolvePlanViewerScope(
  access: { hrId: string | null; role: string | null },
  directoryEmployees: readonly EmployeeDirectoryRow[],
): PlanViewerScope {
  const viewerHrId = normalizeHrId(access.hrId);
  const byCanonicalHrId = new Map(
    directoryEmployees.map((row) => [normalizeHrId(row.hrId), row] as const),
  );
  const hierarchyReportHrIds = new Set<string>();
  for (const row of directoryEmployees) {
    if (
      isWithinManagerHierarchy({
        employee: row,
        byCanonicalHrId,
        viewerCanonicalHrId: viewerHrId,
        canonicalize: normalizeHrId,
      })
    ) {
      const rowHrId = normalizeHrId(row.hrId);
      if (rowHrId) hierarchyReportHrIds.add(rowHrId);
    }
  }
  return { role: access.role, hierarchyReportHrIds };
}
