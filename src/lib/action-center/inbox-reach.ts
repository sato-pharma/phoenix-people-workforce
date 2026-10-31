import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";

/**
 * The seats whose "Other Approvals" inbox can NEVER hold an item — so the 30 s badge poll can answer
 * 0 for them without reading a single row (2026-10-23, every page change under 1 second).
 *
 * WHY. countAwaitingMyActionItems reads two heavy sources for every poll of every open tab — the
 * whole resignations dashboard (the directory, every employee_resignations row, the payroll
 * candidates, the historical leavers, a people lookup and the device register) and the whole
 * contract-renewal dashboard (the directory again, every contract, every open renewal request) —
 * and production, 2026-10-23, measured the batched badge at about 1.6 s a call. For most of the
 * company that work could not change the answer, and this is the proof, step by step. (Since 31 Oct 2026
 * the count reads two light loaders instead of the dashboards — listVisibleResignationStatuses and
 * listVisibleContractRenewalWorkflows, each scoping a viewer line for line as its dashboard does — so
 * the proof holds unchanged, and the early zero still saves the directory and both table reads.)
 *
 *   1. Both sources scope a reader who is not a COMPANY reader (isCompanyResignationReader /
 *      isCompanyContractReader: scope system or company, or Super Admin, CEO, HR Operations,
 *      HR Administration) through canSeeEmployee (resignations) and canSeeHrScopedRecord
 *      (contracts).
 *   2. For every role listed below, at every scope it can hold, both of those return true ONLY when
 *      the record's employee is the viewer — hrIdsMatch(viewer, employee). None of these roles is
 *      Training Manager, HR Operations or HR Administration (company-wide people view), none can see
 *      a direct report (District Manager, Manager, Regional Manager, National Sales Manager), and
 *      none is District Manager or Manager (the manager match in canSeeHrScopedRecord).
 *   3. Every item those records become carries the record's own employee id (mapResignationItem,
 *      mapContractRenewalItem, and residualInboxEntries for the count), which matches the viewer's by the same hrIdsMatch — an equivalence
 *      (canonical-key equality, or equality after the same symbol strip), so it carries across.
 *   4. survivesAwaitingInbox drops every item whose employee is the viewer. Nothing is left.
 *   5. The third source, outstation, is read only for the admin audience of a seat that may approve
 *      in the outstation workspace, and it has left this inbox for a mailbox of its own
 *      (OTHER_APPROVALS_MOVED_OUT). The caller still requires it to be off before trusting this.
 *
 * AN ALLOW-LIST ON PURPOSE. A role added later, or one of these widened, fails toward the full read
 * — the true count, merely slow — never toward a zero over a waiting request. The retired HR Advisory
 * seat is left out for the same reason: dormant, unproven, and nobody holds it.
 * tests/badge-counts-viewer-cache.test.ts probes canSeeEmployee and canSeeHrScopedRecord for every
 * role here and pins the two company-reader predicates, so a widening goes red there first.
 */
export const SELF_ONLY_OTHER_APPROVALS_ROLES: ReadonlySet<PhoenixRole> = new Set<PhoenixRole>([
  "Employee",
  "Medical Rep",
  "Product Manager",
  "Group Product Manager",
  "SFE Manager",
  "Marketing Manager",
  "Financial Advisor",
  "HR Resourcing",
]);

/**
 * True when no request in the "Other Approvals" sources can ever be counted for this viewer, so
 * reading them would only prove a zero. A guest or a no-scope context sees nothing anywhere; a
 * system or company scope is never short-circuited, whatever the role.
 */
export function otherApprovalsInboxIsAlwaysEmptyFor(access: Pick<AccessContext, "role" | "scope" | "source">): boolean {
  if (access.source === "guest" || access.scope === "none") return true;
  if (access.scope === "system" || access.scope === "company") return false;
  return SELF_ONLY_OTHER_APPROVALS_ROLES.has(access.role);
}
