// Recruitment / ATS — service-layer scope helpers.
//
// Route handlers already gate the resource/action via assertPermission. These
// helpers add row-level scoping so hiring-manager roles only see/act on the
// requisitions they own, while Super Admin / Talent Acquisition / CEO see everything.
// Candidate PII is gated separately (the `candidates` resource) at the route.

import { hrIdsMatch, type AccessContext, type PhoenixRole } from "@/lib/auth/permissions";
import type { Application, Requisition } from "@/lib/recruitment/types";

// Roles that manage the pipeline end to end.
export const recruitmentManageRoles: readonly PhoenixRole[] = ["Super Admin", "Talent Acquisition"];
// Roles that may read every requisition/application (managers see only their own).
export const recruitmentGlobalReadRoles: readonly PhoenixRole[] = [
  "Super Admin",
  "Talent Acquisition",
  "CEO",
];

export function canSeeAllRecruitment(access: AccessContext): boolean {
  return access.scope === "system" || recruitmentGlobalReadRoles.includes(access.role);
}

export function canSeeRequisition(access: AccessContext, requisition: Requisition): boolean {
  if (canSeeAllRecruitment(access)) return true;
  return (
    hrIdsMatch(access.hrId, requisition.hiringManagerHrId) ||
    hrIdsMatch(access.hrId, requisition.recruitmentOwnerHrId)
  );
}

export function filterRequisitionsForAccess(
  access: AccessContext,
  requisitions: readonly Requisition[],
): Requisition[] {
  if (canSeeAllRecruitment(access)) return [...requisitions];
  return requisitions.filter((requisition) => canSeeRequisition(access, requisition));
}

export function canSeeApplication(
  access: AccessContext,
  application: Application,
  requisitionsById: Map<string, Requisition>,
): boolean {
  if (canSeeAllRecruitment(access)) return true;
  const requisition = requisitionsById.get(application.requisitionId);
  return requisition ? canSeeRequisition(access, requisition) : false;
}

export function assertCanSeeRequisition(access: AccessContext, requisition: Requisition): void {
  if (!canSeeRequisition(access, requisition)) {
    throw new Error("Forbidden: requisition is outside your recruitment scope.");
  }
}

// Hard delete is Super Admin only (server-side enforcement; the UI hides the
// button for everyone else). System context is allowed for internal/admin tasks.
export function assertCanDeleteRecruitment(access: AccessContext): void {
  if (access.role !== "Super Admin" && access.scope !== "system") {
    throw new Error("Forbidden: only Super Admin can delete recruitment records.");
  }
}
