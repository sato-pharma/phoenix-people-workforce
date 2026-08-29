// Recruitment / ATS — shared data-access helpers, row mappers, code generation,
// the workflow-registry transition guard, and append-only event logging.

import type { PhoenixRole } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { assertWorkflowRegistryTransition } from "@/lib/workflow-registry/service";
import {
  DEFAULT_CANDIDATE_STATUS,
  RECRUITMENT_MODULE_KEY,
  type Application,
  type ApplicationEvent,
  type ApplicationStage,
  type Candidate,
  type CandidateStatusEvent,
  type HeadcountType,
  type Interview,
  type InterviewType,
  type RecruitmentActionKey,
  type RecruitmentFile,
  type Requisition,
  type RequisitionPriority,
  type RequisitionStatus,
} from "@/lib/recruitment/types";

export function recruitmentDb() {
  return getSupabaseAdmin();
}

// ---------------------------------------------------------------------------
// Small value coercers (DB rows are loosely typed via the REST client).
// ---------------------------------------------------------------------------

export function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function boolOrNull(value: unknown): boolean | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "1"].includes(normalized)) return true;
    if (["false", "no", "0"].includes(normalized)) return false;
    return null;
  }
  return Boolean(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------
// Code generation (impure; uniqueness backstopped by the DB unique constraint).
// ---------------------------------------------------------------------------

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export function newRequisitionCode(): string {
  return `REQ-${new Date().getFullYear()}-${randomSuffix()}`;
}

export function newApplicationCode(): string {
  return `APP-${new Date().getFullYear()}-${randomSuffix()}`;
}

// ---------------------------------------------------------------------------
// DB row shapes (snake_case) and mappers to the camelCase domain types.
// ---------------------------------------------------------------------------

export type RequisitionDbRow = Record<string, unknown>;
export type CandidateDbRow = Record<string, unknown>;
export type ApplicationDbRow = Record<string, unknown>;
export type InterviewDbRow = Record<string, unknown>;
export type RecruitmentFileDbRow = Record<string, unknown>;
export type ApplicationEventDbRow = Record<string, unknown>;
export type CandidateStatusEventDbRow = Record<string, unknown>;

export function mapRequisition(row: RequisitionDbRow): Requisition {
  return {
    id: String(row.id),
    requisitionCode: String(row.requisition_code ?? ""),
    vacancyId: numberOrNull(row.vacancy_id),
    departmentId: numberOrNull(row.department_id),
    lineId: numberOrNull(row.line_id),
    areaId: numberOrNull(row.area_id),
    teamId: numberOrNull(row.team_id),
    positionId: numberOrNull(row.position_id),
    jobTitle: String(row.job_title ?? ""),
    hiringManagerHrId: textOrNull(row.hiring_manager_hr_id),
    hiringManagerName: null,
    recruitmentOwnerHrId: textOrNull(row.recruitment_owner_hr_id),
    recruitmentOwnerName: null,
    grade: textOrNull(row.grade),
    salaryBandMin: numberOrNull(row.salary_band_min),
    salaryBandMax: numberOrNull(row.salary_band_max),
    headcountType: (textOrNull(row.headcount_type) ?? "replacement") as HeadcountType,
    replacementForHrId: textOrNull(row.replacement_for_hr_id),
    headcount: numberOrNull(row.headcount) ?? 1,
    priority: (textOrNull(row.priority) ?? "normal") as RequisitionPriority,
    recruitmentDeadline: textOrNull(row.recruitment_deadline),
    status: (textOrNull(row.status) ?? "req_draft") as RequisitionStatus,
    notes: textOrNull(row.notes),
    createdBy: textOrNull(row.created_by),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

export function mapCandidate(row: CandidateDbRow): Candidate {
  return {
    id: String(row.id),
    fullName: String(row.full_name ?? ""),
    status: textOrNull(row.status) ?? DEFAULT_CANDIDATE_STATUS,
    // Kept RAW, not normalized. A legacy free-text value still on a row is shown verbatim by
    // candidateStatusLabel; normalizing here would silently rewrite what a human typed into one of
    // five codes, and the whole point of the note is that the reason survives.
    statusNote: textOrNull(row.status_note),
    statusChangedAt: textOrNull(row.status_changed_at),
    statusChangedByHrId: textOrNull(row.status_changed_by_hr_id),
    nationalId: textOrNull(row.national_id),
    email: textOrNull(row.email),
    phone: textOrNull(row.phone),
    whatsapp: textOrNull(row.whatsapp),
    linkedinUrl: textOrNull(row.linkedin_url),
    nationality: textOrNull(row.nationality),
    // date_of_birth is a `date` column; the REST client hands it back as a "YYYY-MM-DD" string, so
    // it maps like any other text field (same as medical_rep_experience_from/to below).
    dateOfBirth: textOrNull(row.date_of_birth),
    placeOfBirth: textOrNull(row.place_of_birth),
    gender: textOrNull(row.gender),
    maritalStatus: textOrNull(row.marital_status),
    militaryStatus: textOrNull(row.military_status),
    address: textOrNull(row.address),
    governorate: textOrNull(row.governorate),
    preferredRegionCode: textOrNull(row.preferred_region_code),
    preferredRegionName: textOrNull(row.preferred_region_name),
    preferredAreaName: textOrNull(row.preferred_area_name),
    preferencesDeclaredAt: textOrNull(row.preferences_declared_at),
    currentJobTitle: textOrNull(row.current_job_title),
    appliedForJobTitle: textOrNull(row.applied_for_job_title),
    appliedForEvidence: textOrNull(row.applied_for_evidence),
    professionalSummary: textOrNull(row.professional_summary),
    currentEmployer: textOrNull(row.current_employer),
    currentRoleResponsibilities: textOrNull(row.current_role_responsibilities),
    yearsExperience: numberOrNull(row.years_experience),
    expectedSalary: numberOrNull(row.expected_salary),
    noticePeriod: textOrNull(row.notice_period),
    source: textOrNull(row.source),
    cvReferenceName: textOrNull(row.cv_reference_name),
    cvExternalUrl: textOrNull(row.cv_external_url),
    notes: textOrNull(row.notes),
    faculty: textOrNull(row.faculty),
    university: textOrNull(row.university),
    degree: textOrNull(row.degree),
    graduationYear: numberOrNull(row.graduation_year),
    grade: textOrNull(row.grade),
    hasPriorWorkExperience: boolOrNull(row.has_prior_work_experience),
    hasMedicalRepExperience: boolOrNull(row.has_medical_rep_experience),
    medicalRepEmployer: textOrNull(row.medical_rep_employer),
    medicalRepExperienceFrom: textOrNull(row.medical_rep_experience_from),
    medicalRepExperienceTo: textOrNull(row.medical_rep_experience_to),
    positionSpecificFields:
      row.position_specific_fields && typeof row.position_specific_fields === "object"
        ? (row.position_specific_fields as Record<string, unknown>)
        : {},
    // Present only when the identifying half of the stamp is there. The write path sets every
    // stamp column in ONE update, so a partial stamp cannot normally exist — but reading it
    // defensively means the worst case is "never sent" rather than a send attributed to nobody at
    // no time.
    //
    // The seat columns are read separately and stay nullable, because the identity of a send does
    // NOT depend on them: rows written before 2026-08-27 carry a name and no title, and a send
    // whose manager could not be resolved carries an HR_ID and nothing else. Requiring the seat
    // here would turn every one of those into "never sent", which is a lie about the one thing
    // this stamp exists to record.
    managerNotified:
      textOrNull(row.manager_notified_hr_id) && textOrNull(row.manager_notified_at)
        ? {
            areaName: textOrNull(row.manager_notified_area),
            hrId: String(row.manager_notified_hr_id),
            jobTitle: textOrNull(row.manager_notified_job_title),
            name: textOrNull(row.manager_notified_name) ?? String(row.manager_notified_hr_id),
            regionName: textOrNull(row.manager_notified_region),
            sentAt: String(row.manager_notified_at),
          }
        : null,
    // The position the candidate was sent FOR — a different thing from the manager's own seat
    // above, and the one the manager's folders are built on. Present whenever ANY part of it was
    // recorded: a free-typed position has no vacancy id, and a vacancy picked before the line was
    // known would still name an area and a title. Requiring all of them would silently unfile a
    // candidate the recruiter did file. Absent entirely — every part null — reads as null, which is
    // what every send made before 2026-08-28 genuinely is.
    sentFor:
      textOrNull(row.sent_for_job_title) || textOrNull(row.sent_for_area) || textOrNull(row.sent_for_line)
        ? {
            areaName: textOrNull(row.sent_for_area),
            jobTitle: textOrNull(row.sent_for_job_title),
            lineName: textOrNull(row.sent_for_line),
            regionName: textOrNull(row.sent_for_region),
            // numberOrNull, not a bare Number(): `Number(null)` is 0, not NaN, so a hand-rolled
            // finiteness check would turn an absent id into vacancy 0 — a real-looking foreign key
            // pointing at nothing.
            vacancyId: numberOrNull(row.sent_for_vacancy_id),
          }
        : null,
    createdBy: textOrNull(row.created_by),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

export function mapApplication(row: ApplicationDbRow): Application {
  return {
    id: String(row.id),
    applicationCode: String(row.application_code ?? ""),
    requisitionId: String(row.requisition_id),
    candidateId: String(row.candidate_id),
    stage: (textOrNull(row.stage) ?? "application_received") as ApplicationStage,
    source: textOrNull(row.source),
    offerId: textOrNull(row.offer_id),
    convertedEmployeeHrId: textOrNull(row.converted_employee_hr_id),
    currentOwnerHrId: textOrNull(row.current_owner_hr_id),
    decisionReason: textOrNull(row.decision_reason),
    rejectedReason: textOrNull(row.rejected_reason),
    seniorApprovalStatus: textOrNull(row.senior_approval_status),
    lastStageChangedAt: String(row.last_stage_changed_at ?? row.updated_at ?? ""),
    createdBy: textOrNull(row.created_by),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

export function mapInterview(row: InterviewDbRow): Interview {
  return {
    id: String(row.id),
    applicationId: String(row.application_id),
    interviewType: (textOrNull(row.interview_type) ?? "hr") as InterviewType,
    interviewerHrId: textOrNull(row.interviewer_hr_id),
    scheduledAt: textOrNull(row.scheduled_at),
    location: textOrNull(row.location),
    meetingLink: textOrNull(row.meeting_link),
    outcome: textOrNull(row.outcome),
    score: asRecord(row.score),
    notes: textOrNull(row.notes),
    createdBy: textOrNull(row.created_by),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

export function mapRecruitmentFile(row: RecruitmentFileDbRow): RecruitmentFile {
  return {
    id: String(row.id),
    candidateId: textOrNull(row.candidate_id),
    applicationId: textOrNull(row.application_id),
    kind: String(row.kind ?? "cv"),
    fileName: String(row.file_name ?? ""),
    mimeType: textOrNull(row.mime_type),
    sizeBytes: numberOrNull(row.size_bytes),
    driveFileId: textOrNull(row.drive_file_id),
    externalUrl: textOrNull(row.external_url),
    uploadedByHrId: textOrNull(row.uploaded_by_hr_id),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

export function mapApplicationEvent(row: ApplicationEventDbRow): ApplicationEvent {
  return {
    id: String(row.id),
    applicationId: String(row.application_id),
    fromStage: textOrNull(row.from_stage),
    toStage: textOrNull(row.to_stage),
    action: String(row.action ?? ""),
    actorHrId: textOrNull(row.actor_hr_id),
    reason: textOrNull(row.reason),
    details: asRecord(row.details),
    createdAt: String(row.created_at ?? ""),
  };
}

export function mapCandidateStatusEvent(row: CandidateStatusEventDbRow): CandidateStatusEvent {
  return {
    id: String(row.id),
    candidateId: String(row.candidate_id),
    fromStatus: textOrNull(row.from_status),
    toStatus: String(row.to_status ?? ""),
    note: textOrNull(row.note),
    actorHrId: textOrNull(row.actor_hr_id),
    createdAt: String(row.created_at ?? ""),
  };
}

// ---------------------------------------------------------------------------
// Workflow-registry transition guard (role + status + required-reason).
// ---------------------------------------------------------------------------

export async function assertRecruitmentTransition(input: {
  actionKey: RecruitmentActionKey;
  role: PhoenixRole;
  status: string;
  reason?: string | null;
}) {
  const result = await assertWorkflowRegistryTransition({
    actionKey: input.actionKey,
    moduleKey: RECRUITMENT_MODULE_KEY,
    role: input.role,
    status: input.status,
  });
  if (result.action?.requiresReason && !textOrNull(input.reason)) {
    throw new Error(`A reason is required for ${input.actionKey}.`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Append-only application history.
// ---------------------------------------------------------------------------

export async function writeApplicationEvent(input: {
  applicationId: string;
  fromStage: string | null;
  toStage: string | null;
  action: string;
  actorHrId: string | null;
  reason?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  const supabase = recruitmentDb();
  await supabase.from("ats_application_events").insert({
    application_id: input.applicationId,
    from_stage: input.fromStage,
    to_stage: input.toStage,
    action: input.action,
    actor_hr_id: input.actorHrId,
    reason: textOrNull(input.reason),
    details: input.details ?? {},
  });
}
