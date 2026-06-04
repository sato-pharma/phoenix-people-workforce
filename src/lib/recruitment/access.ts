// Recruitment / ATS — service-layer scope helpers.
//
// Route handlers already gate the resource/action via assertPermission. These
// helpers add row-level scoping so hiring-manager roles only see/act on the
// requisitions they own, while Super Admin / HR Specialist / CEO see everything.
// Candidate PII is gated separately (the `candidates` resource) at the route.

import { canonicalHrIdKey } from "@/lib/hr-id";
import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import type { Application, Requisition } from "@/lib/recruitment/types";

// Roles that manage the pipeline end to end.
export const recruitmentManageRoles: readonly PhoenixRole[] = ["Super Admin", "HR Specialist"];
// Roles that may read every requisition/application (managers see only their own).
export const recruitmentGlobalReadRoles: readonly PhoenixRole[] = [
  "Super Admin",
  "HR Specialist",
  "CEO",
];

function sameHrId(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = canonicalHrIdKey(a);
  const right = canonicalHrIdKey(b);
  return Boolean(left && right && left === right);
}

export function canSeeAllRecruitment(access: AccessContext): boolean {
  return access.scope === "system" || recruitmentGlobalReadRoles.includes(access.role);
}

export function canSeeRequisition(access: AccessContext, requisition: Requisition): boolean {
  if (canSeeAllRecruitment(access)) return true;
  return (
    sameHrId(access.hrId, requisition.hiringManagerHrId) ||
    sameHrId(access.hrId, requisition.recruitmentOwnerHrId)
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
