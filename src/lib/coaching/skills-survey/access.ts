// WHO MAY RATE, READ AND CHANGE THE TEAM COACHING SKILLS SURVEY (owner and Salma Labib, Training
// Manager, 2026-10-31). The permission matrix (`coaching_skills_survey`) is the coarse gate; these are
// the fine ones, and every route and page calls them after `assertPermission`.
//
//   rate      the District Manager (by role, so an acting District Manager counts), for the Medical
//             Reps who report to his seat — never anyone else, never himself
//   read      the District Manager, the Regional Manager and the National Sales Manager for the people
//             in their own chain; the Training Manager, the SFE Manager, the CEO and the Super Admin for
//             the whole company; the person who saved a survey keeps reading it after a team move
//   never     THE PERSON RATED. Salma: the rep must not see it, so the managers rate honestly. Asked
//             first, ahead of every role, so a later "Line Managers rate District Managers" step can
//             never show a District Manager his own survey through his role.
//   settings  the Training Manager and the Super Admin — the target, the weights, the bands, the skills
//
// The old coaching form's `coachingOversightRoles` is deliberately not reused: it also admits the
// Marketing Manager and every company role, and this survey's audience is narrower.
// Pinned by tests/coaching-skills-survey-access.test.ts.

import { normalizeHrId, type AccessContext, type PhoenixRole } from "@/lib/auth/permissions";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { hrIdsMatch } from "@/lib/hr-id";
import {
  isWithinManagerHierarchy,
  reportsToManagerSeat,
  type SeatContinuitySubject,
} from "@/lib/workforce/hierarchy-resolver";

type SurveyViewer = Pick<AccessContext, "hrId" | "role">;

type SurveyPerson = Pick<
  EmployeeDirectoryRow,
  "hrId" | "jobTitle" | "positionTitle" | "managerHrId" | "pendingManagerReplacementForHrId"
>;

/** Read the whole company. */
export const skillsSurveyCompanyReaders: ReadonlySet<PhoenixRole> = new Set<PhoenixRole>([
  "Super Admin",
  "CEO",
  "SFE Manager",
  "Training Manager",
]);

/** Read their own chain. */
export const skillsSurveyChainReaders: ReadonlySet<PhoenixRole> = new Set<PhoenixRole>([
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
]);

export const skillsSurveyRaterRoles: ReadonlySet<PhoenixRole> = new Set<PhoenixRole>(["District Manager"]);

export const skillsSurveySettingsEditors: ReadonlySet<PhoenixRole> = new Set<PhoenixRole>([
  "Super Admin",
  "Training Manager",
]);

/** The people this survey rates today: Medical Reps. The table records the role, for the later steps. */
export function isSkillsSurveyMember(person: Pick<EmployeeDirectoryRow, "jobTitle" | "positionTitle">): boolean {
  if (resolveJobFunctionRole(person.jobTitle) === "Medical Rep") return true;
  if (resolveJobFunctionRole(person.positionTitle) === "Medical Rep") return true;
  const title = `${person.jobTitle ?? ""} ${person.positionTitle ?? ""}`.toLowerCase();
  return title.includes("medical representative") || title.includes("medical rep");
}

export function isSkillsSurveySubject(viewer: SurveyViewer, memberHrId: string | null | undefined): boolean {
  return Boolean(viewer.hrId && memberHrId && hrIdsMatch(viewer.hrId, memberHrId));
}

export function canOpenSkillsSurvey(viewer: SurveyViewer): boolean {
  return skillsSurveyCompanyReaders.has(viewer.role) || skillsSurveyChainReaders.has(viewer.role);
}

export function canEditSkillsSurveySettings(viewer: SurveyViewer): boolean {
  return skillsSurveySettingsEditors.has(viewer.role);
}

export function canRateSkillsSurveys(viewer: SurveyViewer): boolean {
  return skillsSurveyRaterRoles.has(viewer.role) && Boolean(normalizeHrId(viewer.hrId));
}

export function buildSkillsSurveyChainIndex(
  directory: readonly SurveyPerson[],
): ReadonlyMap<string, SeatContinuitySubject> {
  const index = new Map<string, SeatContinuitySubject>();
  for (const person of directory) {
    const key = normalizeHrId(person.hrId);
    if (key) index.set(key, person);
  }
  return index;
}

/** May this viewer rate this person this quarter? */
export function canRateSkillsSurveyMember(viewer: SurveyViewer, member: SurveyPerson): boolean {
  if (isSkillsSurveySubject(viewer, member.hrId)) return false;
  if (!canRateSkillsSurveys(viewer)) return false;
  if (!isSkillsSurveyMember(member)) return false;
  const viewerKey = normalizeHrId(viewer.hrId);
  if (!viewerKey) return false;
  return reportsToManagerSeat({ canonicalize: normalizeHrId, employee: member, viewerCanonicalHrId: viewerKey });
}

/**
 * May this viewer read this person's surveys? `ratedByViewer` is true when the viewer saved the
 * survey in question — a District Manager keeps reading what he wrote after the rep moves team.
 */
export function canReadSkillsSurveyMember(
  viewer: SurveyViewer,
  member: SurveyPerson,
  chainIndex: ReadonlyMap<string, SeatContinuitySubject>,
  ratedByViewer = false,
): boolean {
  if (isSkillsSurveySubject(viewer, member.hrId)) return false;
  if (skillsSurveyCompanyReaders.has(viewer.role)) return true;
  if (!skillsSurveyChainReaders.has(viewer.role)) return false;
  if (ratedByViewer) return true;
  const viewerKey = normalizeHrId(viewer.hrId);
  if (!viewerKey) return false;
  return isWithinManagerHierarchy({
    byCanonicalHrId: chainIndex,
    canonicalize: normalizeHrId,
    employee: member,
    viewerCanonicalHrId: viewerKey,
  });
}
