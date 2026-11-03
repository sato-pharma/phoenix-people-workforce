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

// Roles that manage the pipeline end to end. The Talent Acquisition seat is NOT in this list: it
// also opens Inbound Intake Health and Missing Contact Details, which the owner left out of her seat.
// Her screens read recruitmentWorkRoles below, and her alerts recruitmentAlertRoles.
// HR Advisory left it on 2026-10-08 when the owner moved recruiting off the HR Business Partner, so
// those two screens are the Super Admin's alone.
export const recruitmentManageRoles: readonly PhoenixRole[] = ["Super Admin"];
// The AUDIENCE of the NEW CV alert (inbound/recruitment-notify.ts, `recruitment_inbound_cv`) — the
// managers above plus the Talent Acquisition seat, added 2026-10-08 at the owner's answer in chat:
// "Add her now". Since 2026-10-16 it is the audience of that one alert alone: her notification
// center holds exactly three notices (a new CV, an interview request, an accepted offer), so every
// other recruitment alert reads `recruitmentDeskAlertRoles` below.
export const recruitmentAlertRoles: readonly PhoenixRole[] = [...recruitmentManageRoles, "HR Resourcing"];
// The AUDIENCE of every OTHER recruitment alert — WhatsApp text-only and unreadable CVs, intake
// health, dead letters and spikes, the daily CV digest, stale sends, the triage backlog and CVs
// returned by managers. Without the Talent Acquisition seat (owner, 2026-10-16: "in the ta account
// notification center she should see 1 new cv received, 2 interview requests, 3 accepted job
// offers"). The same list the managers hold, and kept apart from it so a later edit to one cannot
// quietly move the other.
export const recruitmentDeskAlertRoles: readonly PhoenixRole[] = [...recruitmentManageRoles];
// Roles that WORK the pipeline's screens: the managers above plus the Talent Acquisition seat
// (HR Resourcing), opened 2026-10-08 from the owner's own ticks on the access blueprint. A screen
// list only — nothing here sends anybody anything.
const recruitmentWorkRoles: readonly PhoenixRole[] = [...recruitmentManageRoles, "HR Resourcing"];
// Roles that may read every requisition/application (managers see only their own). The Talent
// Acquisition seat reads the whole pool — the owner chose "whole company" for her scope.
export const recruitmentGlobalReadRoles: readonly PhoenixRole[] = [
  "Super Admin",
  "HR Resourcing",
  "CEO",
];

export function canSeeAllRecruitment(access: AccessContext): boolean {
  return access.scope === "system" || recruitmentGlobalReadRoles.includes(access.role);
}

// Inbound Intake Health — the mailbox/queue monitor, and the only page that would say why CVs
// stopped arriving. Same authority as the pipeline's managers (the Super Admin), not the
// broader recruitmentGlobalReadRoles: the CEO does not need plumbing diagnostics. Deliberately NOT
// recruitmentWorkRoles: the owner left Inbound Intake Health out of the Talent Acquisition seat.
//
// This was canViewCvExtractionAnalytics until 2026-08-15, when the accuracy dashboard, the CV
// review queue and the per-field settings page were all removed — the owner used the review queue
// 5 times out of 194 CVs and never changed a single field setting, and the accuracy dashboard
// derived its whole number from those 5 reviews. Intake Health was the one survivor sharing this
// gate, so the helper is now named after it.
export function canViewInboundIntakeHealth(access: Pick<AccessContext, "role" | "scope">): boolean {
  return access.scope === "system" || recruitmentManageRoles.includes(access.role);
}

// WhatsApp outbound replies — the record of what the automated channel actually SAID to a member
// of the public, and to which number.
//
// Deliberately its own helper rather than a second caller of canViewInboundIntakeHealth, which it
// resolves identically to today. The two answer different questions: that one guards counts about
// the plumbing, this one guards message bodies alongside the applicants' phone numbers. Sharing a
// helper would mean a later widening of the diagnostics gate silently widened access to the
// content of conversations with the public — the same reasoning canReviewCandidateContacts is
// separated on, one clause down.
export function canViewWhatsAppOutboundLog(access: Pick<AccessContext, "role" | "scope">): boolean {
  return access.scope === "system" || recruitmentWorkRoles.includes(access.role);
}

// WhatsApp message templates — SENDING one to a candidate.
//
// Same authority as the rest of the pipeline: messaging an applicant in the company's name is
// acting on the pipeline, exactly like sending their CV to a manager. Deliberately its own helper
// rather than a caller of canViewWhatsAppOutboundLog, which it resolves identically to today —
// that one guards READING what was said, this one guards SAYING it, and a later widening of the
// read gate must not quietly hand a wider audience the ability to message the public.
export function canSendWhatsAppTemplate(access: Pick<AccessContext, "role" | "scope">): boolean {
  return access.scope === "system" || recruitmentWorkRoles.includes(access.role);
}

// Job Posts — building, saving and downloading the job-post pictures
// (app/(admin)/recruitment/job-posts). The owner named the audience on 2026-10-15: the Super Admin
// and the Talent Acquisition seat — exactly recruitmentWorkRoles. Its own helper rather than a caller
// of canSendWhatsAppTemplate, which resolves identically today: one guards messaging a candidate, this
// one guards the public advert, and widening either must not quietly widen the other. The nav rows
// for the page name the same two roles, and the API re-checks this on every call.
export function canBuildJobPosts(access: Pick<AccessContext, "role" | "scope">): boolean {
  return access.scope === "system" || recruitmentWorkRoles.includes(access.role);
}

// Sending a job post to the public careers page, and closing a card there. Narrower than building one:
// the Talent Acquisition seat builds and downloads, only the Super Admin presses publish (owner, 2026-11-03).
export function canPublishJobPosts(access: Pick<AccessContext, "role">): boolean {
  return access.role === "Super Admin";
}

// WhatsApp message templates — WRITING, EDITING and DELETING them.
//
// Narrower than sending, on purpose, and narrower than any other gate in this file: the Super Admin
// (the owner himself) or a system context only. A template is the wording every recruiter then
// sends in the company's name, so editing one changes what everybody says, to everybody, from that
// moment on. That is the same reasoning the WhatsApp screening-question wording is gated on
// (admin:update, Super Admin only), and the two must stay aligned — they are the two places where
// one person's typing becomes the company's voice. The write routes assert admin:update, which
// hardBoundaryAllowedActions grants to Super Admin alone, so this and the API admit the same people.
//
// THE ROLE, NOT THE SCOPE, IS WHAT A SIGNED-IN OWNER CARRIES. `scopeForRole` gives a Super Admin
// session "company", exactly as it gives the CEO, the Finance Manager and HR Operations; "system"
// is only ever the synthetic `systemAccessContext`. Until 2026-09-18 this was a scope-only test, so
// the editor was hidden from the one person the API let save — the same defect
// isInterviewCalendarOwner was caught with. Pinned by tests/whatsapp-template-manage-gate.test.ts
// against contexts built by `createAccessContext`, the way a real session builds them.
export function canManageWhatsAppTemplates(access: Pick<AccessContext, "role" | "scope">): boolean {
  return access.scope === "system" || access.role === "Super Admin";
}

// Contact-details review — accepting an email or phone the AI read off a CV onto the candidate.
//
// Same authority as the rest of the pipeline, and deliberately NOT canViewInboundIntakeHealth even
// though the two resolve identically today: this page WRITES to two dedupe-deciding columns, so it
// is gated on who may work the pipeline, not on who may read the plumbing diagnostics. Sharing the
// intake-health helper would make a later widening of that read gate silently widen this write one.
// Deliberately NOT recruitmentWorkRoles: the owner left Missing Contact Details out of the Talent
// Acquisition seat.
export function canReviewCandidateContacts(access: Pick<AccessContext, "role" | "scope">): boolean {
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
