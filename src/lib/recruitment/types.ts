// Recruitment / ATS module — shared domain types and canonical status sets.
//
// The status/stage/action constants below are the single source of truth shared
// by the service layer, the DB CHECK constraints, and the workflow-registry seed.
// Keep them in sync with:
//   supabase/_migrations_archive/pre-baseline-2026-07-11/20260605014225_recruitment_phase1_schema.sql
//   supabase/_migrations_archive/pre-baseline-2026-07-11/20260605014350_recruitment_workflow_registry_module.sql

export const RECRUITMENT_MODULE_KEY = "recruitment" as const;

export const requisitionStatuses = [
  "req_draft",
  "req_open",
  "req_published",
  "req_on_hold",
  "req_filled",
  "req_closed",
  "req_cancelled",
] as const;
export type RequisitionStatus = (typeof requisitionStatuses)[number];

export const applicationStages = [
  "application_received",
  "in_candidate_pool",
  "cv_screening",
  "phone_screening",
  "interview_scheduling",
  "hr_interview",
  "hiring_manager_interview",
  "final_selection",
  "offer_initiated",
  "offer_sent",
  "offer_accepted",
  "offer_declined",
  "offer_expired",
  "pre_boarding",
  "hired",
  "application_rejected",
  "application_withdrawn",
  // Rule 5/6 — screening states (all non-terminal).
  "shortlisted",
  "on_hold",
  "no_response",
  "call_back",
  // Rule 8/9 — interview completion + final selection states (non-terminal).
  "manager_interview_completed",
  "backup_candidate",
  // Offer pipeline — preparation → approval → generation → negotiation (all non-terminal).
  "offer_draft",
  "offer_pending_approval",
  "offer_approved",
  "offer_generated",
  "offer_negotiation",
] as const;
export type ApplicationStage = (typeof applicationStages)[number];

// Stages where the application is finished; excluded from the one-active guard.
export const terminalApplicationStages = [
  "offer_declined",
  "offer_expired",
  "hired",
  "application_rejected",
  "application_withdrawn",
] as const;
export type TerminalApplicationStage = (typeof terminalApplicationStages)[number];

export const recruitmentActionKeys = [
  "req_open",
  "req_publish",
  "req_hold",
  "req_resume",
  "req_fill",
  "req_close",
  "req_cancel",
  "app_add",
  "app_to_cv_screen",
  "app_to_phone_screen",
  "app_to_interview_scheduling",
  "app_to_hr_interview",
  "app_record_hr_interview",
  "app_record_hm_interview",
  "app_select",
  "app_offer_sent",
  "app_offer_accepted",
  "app_offer_declined",
  "app_offer_expired",
  "app_to_pre_boarding",
  "app_hire",
  "app_reject",
  "app_withdraw",
  // Rule 5 — CV screening outcomes
  "app_cv_shortlist",
  "app_shortlist_to_scheduling",
  // Rule 5/6 — holding states + resume paths
  "app_hold",
  "app_resume_from_hold_to_cv",
  "app_resume_from_hold_to_phone",
  "app_no_response",
  "app_resume_from_no_response",
  "app_call_back",
  "app_resume_from_call_back_to_cv",
  "app_resume_from_call_back_to_phone",
  // Rule 8 — hiring-manager interview completion + hold resume
  "app_mgr_completed_to_final",
  "app_resume_from_hold_to_hm",
  // Rule 9 — final selection backup pool
  "app_to_backup",
  "app_backup_to_offer",
  // Offer pipeline — staged preparation / approval / generation / negotiation.
  "app_offer_prepare",
  "app_offer_submit_approval",
  "app_offer_approved",
  "app_offer_approval_rejected",
  "app_offer_generated",
  "app_offer_negotiation",
] as const;
export type RecruitmentActionKey = (typeof recruitmentActionKeys)[number];

export const headcountTypes = ["replacement", "expansion"] as const;
export type HeadcountType = (typeof headcountTypes)[number];

export const requisitionPriorities = ["low", "normal", "high", "urgent"] as const;
export type RequisitionPriority = (typeof requisitionPriorities)[number];

export const interviewTypes = ["phone", "hr", "hiring_manager", "cv"] as const;
export type InterviewType = (typeof interviewTypes)[number];

// Rule 5/6 — screening outcomes that drive the pipeline from the screening forms.
export const cvScreeningOutcomes = ["shortlisted", "need_phone_screening", "on_hold", "rejected"] as const;
export type CvScreeningOutcome = (typeof cvScreeningOutcomes)[number];
export const phoneScreeningOutcomes = ["passed", "failed", "no_response", "call_back"] as const;
export type PhoneScreeningOutcome = (typeof phoneScreeningOutcomes)[number];

// Rule 4 — candidate-level status (free text; defaults to "Candidate Created").
export const DEFAULT_CANDIDATE_STATUS = "Candidate Created";

export function isTerminalApplicationStage(stage: string): boolean {
  return (terminalApplicationStages as readonly string[]).includes(stage);
}

// ---------------------------------------------------------------------------
// Domain shapes (camelCase) returned by the service layer.
// ---------------------------------------------------------------------------

export type Requisition = {
  id: string;
  requisitionCode: string;
  vacancyId: number | null;
  departmentId: number | null;
  lineId: number | null;
  areaId: number | null;
  teamId: number | null;
  positionId: number | null;
  jobTitle: string;
  hiringManagerHrId: string | null;
  hiringManagerName: string | null;
  recruitmentOwnerHrId: string | null;
  recruitmentOwnerName: string | null;
  grade: string | null;
  salaryBandMin: number | null;
  salaryBandMax: number | null;
  headcountType: HeadcountType;
  replacementForHrId: string | null;
  headcount: number;
  priority: RequisitionPriority;
  recruitmentDeadline: string | null;
  status: RequisitionStatus;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Candidate = {
  id: string;
  fullName: string;
  status: string;
  nationalId: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  governorate: string | null;
  currentEmployer: string | null;
  yearsExperience: number | null;
  expectedSalary: number | null;
  noticePeriod: string | null;
  source: string | null;
  cvReferenceName: string | null;
  cvExternalUrl: string | null;
  notes: string | null;
  faculty: string | null;
  university: string | null;
  hasPriorWorkExperience: boolean | null;
  hasMedicalRepExperience: boolean | null;
  medicalRepEmployer: string | null;
  medicalRepExperienceFrom: string | null;
  medicalRepExperienceTo: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Application = {
  id: string;
  applicationCode: string;
  requisitionId: string;
  candidateId: string;
  stage: ApplicationStage;
  source: string | null;
  offerId: string | null;
  convertedEmployeeHrId: string | null;
  currentOwnerHrId: string | null;
  decisionReason: string | null;
  rejectedReason: string | null;
  seniorApprovalStatus: string | null;
  lastStageChangedAt: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ApplicationEvent = {
  id: string;
  applicationId: string;
  fromStage: string | null;
  toStage: string | null;
  action: string;
  actorHrId: string | null;
  reason: string | null;
  details: Record<string, unknown>;
  createdAt: string;
};

export type Interview = {
  id: string;
  applicationId: string;
  interviewType: InterviewType;
  interviewerHrId: string | null;
  scheduledAt: string | null;
  location: string | null;
  meetingLink: string | null;
  outcome: string | null;
  score: Record<string, unknown>;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RecruitmentFile = {
  id: string;
  candidateId: string | null;
  applicationId: string | null;
  kind: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  driveFileId: string | null;
  externalUrl: string | null;
  uploadedByHrId: string | null;
  createdAt: string;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Service inputs.
// ---------------------------------------------------------------------------

export type CreateRequisitionInput = {
  vacancyId?: number | null;
  jobTitle?: string | null;
  hiringManagerHrId?: string | null;
  recruitmentOwnerHrId?: string | null;
  grade?: string | null;
  salaryBandMin?: number | null;
  salaryBandMax?: number | null;
  headcountType?: HeadcountType | null;
  headcount?: number | null;
  priority?: RequisitionPriority | null;
  recruitmentDeadline?: string | null;
  notes?: string | null;
};

export type CreateCandidateInput = {
  fullName: string;
  nationalId?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  governorate?: string | null;
  currentEmployer?: string | null;
  yearsExperience?: number | null;
  expectedSalary?: number | null;
  noticePeriod?: string | null;
  source?: string | null;
  cvReferenceName?: string | null;
  cvExternalUrl?: string | null;
  notes?: string | null;
  faculty?: string | null;
  university?: string | null;
  hasPriorWorkExperience?: boolean | null;
  hasMedicalRepExperience?: boolean | null;
  medicalRepEmployer?: string | null;
  medicalRepExperienceFrom?: string | null;
  medicalRepExperienceTo?: string | null;
};

// Partial edit of an existing candidate — an omitted key leaves that column
// untouched; an explicit `null` clears it. Used by the CV-extraction review UI.
export type UpdateCandidateInput = Partial<CreateCandidateInput>;

// The Medical Rep CV-extraction field set (phase 1 — one position type only,
// per the "avoid over-engineering" instruction; a second position gets its own
// field set + migration when it's actually needed, not a generic schema now).
export const cvExtractableCandidateFields = [
  "fullName",
  "email",
  "phone",
  "address",
  "governorate",
  "hasPriorWorkExperience",
  "hasMedicalRepExperience",
  "medicalRepEmployer",
  "medicalRepExperienceFrom",
  "medicalRepExperienceTo",
  "faculty",
  "university",
] as const;
export type CvExtractableCandidateField = (typeof cvExtractableCandidateFields)[number];
