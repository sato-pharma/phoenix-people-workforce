// Recruitment / ATS — shared data-access helpers, row mappers, code generation,
// the workflow-registry transition guard, and append-only event logging.

import type { PhoenixRole } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { assertWorkflowRegistryTransition } from "@/lib/workflow-registry/service";
import {
  RECRUITMENT_MODULE_KEY,
  type Application,
  type ApplicationEvent,
  type ApplicationStage,
  type Candidate,
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
    nationalId: textOrNull(row.national_id),
    email: textOrNull(row.email),
    phone: textOrNull(row.phone),
    governorate: textOrNull(row.governorate),
    currentEmployer: textOrNull(row.current_employer),
    yearsExperience: numberOrNull(row.years_experience),
    expectedSalary: numberOrNull(row.expected_salary),
    noticePeriod: textOrNull(row.notice_period),
    source: textOrNull(row.source),
    cvReferenceName: textOrNull(row.cv_reference_name),
    cvExternalUrl: textOrNull(row.cv_external_url),
    notes: textOrNull(row.notes),
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
  await supabase.from("recruitment_application_events").insert({
    application_id: input.applicationId,
    from_stage: input.fromStage,
    to_stage: input.toStage,
    action: input.action,
    actor_hr_id: input.actorHrId,
    reason: textOrNull(input.reason),
    details: input.details ?? {},
  });
}
