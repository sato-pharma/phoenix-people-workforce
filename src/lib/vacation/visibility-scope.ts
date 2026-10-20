import type { AccessContext } from "@/lib/auth/permissions";

/**
 * Who a viewer's leave-module Vacation Report (/leave-management/vacation-report, its export and
 * canSeeVacation's fallback) covers. Lifted out of service.ts on 2026-10-20 so it is testable on
 * its own; the cases are unchanged except HR Operations.
 *
 * HR Operations reads the whole company (owner ruling 2026-08-29, recorded at scopeForRole in
 * src/lib/auth/permissions.ts: she "maintains leave balances" for everybody). That ruling moved
 * her role scope and her company vacation report, but this switch is a second, parallel scope
 * system and was never updated, so it fell to SELF — her own rail row opened a report holding only
 * herself, and every "On vacation today" link on her landing page opened it empty (found by the
 * 2026-10-20 role-coverage sweep: "every single role that is applicable to appear in a module").
 * Reading only: approving or editing a request is gated separately and does not move.
 */
export type VacationVisibilityScope = "SELF" | "TEAM" | "HIERARCHY" | "LINE" | "COMPANY";

export function isAllVacationVisibilityAccess(access: Pick<AccessContext, "role" | "scope">) {
  return access.scope === "system" || access.role === "Super Admin";
}

export function getVacationVisibilityScope(access: Pick<AccessContext, "role" | "scope">): VacationVisibilityScope {
  if (isAllVacationVisibilityAccess(access)) return "COMPANY";

  switch (access.role) {
    case "CEO":
    case "SFE Manager":
    case "HR Operations":
      return "COMPANY";
    case "National Sales Manager":
    case "Product Manager":
    case "Group Product Manager":
    case "Marketing Manager":
    case "Training Manager":
      return "LINE";
    case "Regional Manager":
      return "HIERARCHY";
    case "District Manager":
    case "Manager":
    // Finance Manager narrowed from COMPANY to TEAM 2026-08-10 (owner): he was seeing every
    // employee's vacation report company-wide — names, hire dates, balances, managers, across
    // Sales/Marketing/SFE/Executive/HR — when his actual remit is himself plus the 3 head-office
    // staff who report to him (OF-0001, A-1, A-4; see the "Finance Manager" block in permissions.ts
    // and reportsToManagerSeat below). TEAM is the same direct-reports-only scope District
    // Manager/Manager already use; his approvals were never affected by this (they bind to an
    // assigned pending approval step, not this scope), only the Vacation Report/export and
    // canSeeVacation's fallback were over-broad.
    case "Finance Manager":
      return "TEAM";
    default:
      return "SELF";
  }
}
