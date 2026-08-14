// Recruitment / ATS — service-layer scope helpers.
//
// Route handlers already gate the resource/action via assertPermission. These
// helpers add row-level scoping so hiring-manager roles only see/act on the
// requisitions they own, while Super Admin / Talent Acquisition / CEO see everything.
// Candidate PII is gated separately (the `candidates` resource) at the route.
//
// District Manager relies on the exact hrIdsMatch check below (their own requisitions
// only). Regional Manager and National Sales Manager additionally get org-scoped
// visibility — HIERARCHY for RM, LINE for NSM — resolved once per request via
// resolveHiringManagerScopeHrIds() and threaded through as an optional allow-list.

import { hrIdsMatch, type AccessContext, type PhoenixRole } from "@/lib/auth/permissions";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { isWithinManagerHierarchy, sameWorkforceLine } from "@/lib/workforce/hierarchy-resolver";
import type { Application, InterviewType, Requisition } from "@/lib/recruitment/types";

/**
 * The interview_type a hiring-manager-family round is recorded under, derived from the
 * caller's own role (never the request body) — District Manager stays "hiring_manager"
 * (unchanged, this is the pre-existing behavior other code/tests key off of), Regional
 * Manager/National Sales Manager/CEO get their own dedicated types so each role's round
 * is attributed correctly and stays editable only by that same role.
 */
export function hiringManagerInterviewType(role: PhoenixRole): InterviewType {
  if (role === "Regional Manager") return "rm_interview";
  if (role === "National Sales Manager") return "nsm_interview";
  if (role === "CEO") return "ceo_interview";
  return "hiring_manager";
}

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

// Read-only CV-extraction accuracy dashboard — same authority as the rest of the pipeline
// (Super Admin / Talent Acquisition), not the broader recruitmentGlobalReadRoles (CEO doesn't
// need per-field AI accuracy stats).
export function canViewCvExtractionAnalytics(access: Pick<AccessContext, "role" | "scope">): boolean {
  return access.scope === "system" || recruitmentManageRoles.includes(access.role);
}

// The CV-extraction review queue (src/lib/recruitment/cv-review-queue.ts). Same role set as the
// analytics dashboard today, but deliberately its OWN helper rather than reusing
// canViewCvExtractionAnalytics: this capability WRITES (a saved review patches the candidate and
// records applied_fields), so the two must be able to diverge without one silently widening the
// other. The page gate is UX; PATCH /api/recruitment/candidates/[id] still enforces
// candidates:update server-side on every save.
export function canReviewCvExtractions(access: Pick<AccessContext, "role" | "scope">): boolean {
  return access.scope === "system" || recruitmentManageRoles.includes(access.role);
}

// The per-field include/exclude switch (src/lib/recruitment/cv-field-settings.ts). Super Admin and
// Talent Acquisition, per the owner's ruling 2026-08-14 — TA decides what is worth reading off a
// CV, so this is her setting, not an administrative one.
//
// Its own helper for the same reason canReviewCvExtractions is: this one is CONFIGURATION, not
// data. Switching a field off means no CV is ever read for it again, and the resulting gap is
// invisible after the fact — nothing marks a candidate as "we stopped asking". If that ever needs
// to be narrower than reviewing, it must be able to narrow without dragging the queue with it.
// The page gate is UX; PATCH /api/recruitment/cv-field-settings asserts recruitment:update
// server-side before any write.
export function canManageCvFieldSettings(access: Pick<AccessContext, "role" | "scope">): boolean {
  return access.scope === "system" || recruitmentManageRoles.includes(access.role);
}

// Roles whose hiring-manager visibility extends beyond their own requisitions to an
// org-scoped set (resolved via resolveHiringManagerScopeHrIds). Every other role
// (District Manager included) stays on the exact hrIdsMatch check only.
const orgScopedHiringManagerRoles: readonly PhoenixRole[] = ["Regional Manager", "National Sales Manager"];

/**
 * Org-scoped hiring-manager HR_IDs for Regional Manager (HIERARCHY — their full downward
 * management chain) and National Sales Manager (LINE — everyone on their line). Returns
 * null for roles that don't get org-scoped visibility (canSeeRequisition falls back to
 * exact hrIdsMatch in that case) and for company-wide roles (no filtering needed).
 * Resolve ONCE per request/list call and pass the result through — the directory load
 * is TTL-cached, but there's no reason to re-derive the set per row.
 */
export async function resolveHiringManagerScopeHrIds(access: AccessContext): Promise<ReadonlySet<string> | null> {
  if (canSeeAllRecruitment(access)) return null;
  if (!orgScopedHiringManagerRoles.includes(access.role)) return null;

  const viewerKey = canonicalHrIdKey(access.hrId);
  if (!viewerKey) return new Set();

  const directory = await getEmployeeDirectory();
  const byCanonicalHrId = new Map(
    directory.employees
      .map((employee) => [canonicalHrIdKey(employee.hrId), employee] as const)
      .filter((entry): entry is [string, (typeof directory.employees)[number]] => entry[0] !== null),
  );

  const allowed = new Set<string>();
  const viewer = byCanonicalHrId.get(viewerKey);

  if (access.role === "Regional Manager") {
    for (const employee of directory.employees) {
      if (isWithinManagerHierarchy({ employee, byCanonicalHrId, viewerCanonicalHrId: viewerKey, canonicalize: canonicalHrIdKey })) {
        const key = canonicalHrIdKey(employee.hrId);
        if (key) allowed.add(key);
      }
    }
    return allowed;
  }

  // National Sales Manager — LINE scope. Fails closed (empty set) when the viewer's
  // own line can't be resolved, matching the sales-module LINE-scope precedent.
  if (viewer && (viewer.lineId != null || viewer.lineName)) {
    for (const employee of directory.employees) {
      if (sameWorkforceLine(viewer, employee)) {
        const key = canonicalHrIdKey(employee.hrId);
        if (key) allowed.add(key);
      }
    }
  }
  return allowed;
}

export function canSeeRequisition(
  access: AccessContext,
  requisition: Requisition,
  scopeHrIds?: ReadonlySet<string> | null,
): boolean {
  if (canSeeAllRecruitment(access)) return true;
  if (
    hrIdsMatch(access.hrId, requisition.hiringManagerHrId) ||
    hrIdsMatch(access.hrId, requisition.recruitmentOwnerHrId)
  ) {
    return true;
  }
  if (!scopeHrIds) return false;
  const managerKey = canonicalHrIdKey(requisition.hiringManagerHrId);
  const ownerKey = canonicalHrIdKey(requisition.recruitmentOwnerHrId);
  return Boolean((managerKey && scopeHrIds.has(managerKey)) || (ownerKey && scopeHrIds.has(ownerKey)));
}

export function filterRequisitionsForAccess(
  access: AccessContext,
  requisitions: readonly Requisition[],
  scopeHrIds?: ReadonlySet<string> | null,
): Requisition[] {
  if (canSeeAllRecruitment(access)) return [...requisitions];
  return requisitions.filter((requisition) => canSeeRequisition(access, requisition, scopeHrIds));
}

export function canSeeApplication(
  access: AccessContext,
  application: Application,
  requisitionsById: Map<string, Requisition>,
  scopeHrIds?: ReadonlySet<string> | null,
): boolean {
  if (canSeeAllRecruitment(access)) return true;
  const requisition = requisitionsById.get(application.requisitionId);
  return requisition ? canSeeRequisition(access, requisition, scopeHrIds) : false;
}

export function assertCanSeeRequisition(
  access: AccessContext,
  requisition: Requisition,
  scopeHrIds?: ReadonlySet<string> | null,
): void {
  if (!canSeeRequisition(access, requisition, scopeHrIds)) {
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
