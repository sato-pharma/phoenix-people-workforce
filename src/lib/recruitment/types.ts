// Recruitment / ATS module — shared domain types and canonical status sets.
//
// The status/stage/action constants below are the single source of truth shared
// by the service layer, the DB CHECK constraints, and the workflow-registry seed.
// Keep them in sync with:
//   supabase/_migrations_archive/pre-baseline-2026-07-11/20260605014225_recruitment_phase1_schema.sql
//   supabase/_migrations_archive/pre-baseline-2026-07-11/20260605014350_recruitment_workflow_registry_module.sql

import type { CandidateAppliedFor } from "@/lib/recruitment/applied-for";
// Type-only, so the cycle with candidate-folder.ts (which imports `Candidate` from here) is erased
// at compile time and never reaches the bundle — same shape as the applied-for import above.
import type { CandidateFolderKind } from "@/lib/recruitment/candidate-folder";
import type { CandidateUnconfirmedCvFacts } from "@/lib/recruitment/candidate-screening-facts";

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

export const interviewTypes = ["phone", "hr", "hiring_manager", "cv", "rm_interview", "nsm_interview", "ceo_interview"] as const;
export type InterviewType = (typeof interviewTypes)[number];

// Rule 5/6 — screening outcomes that drive the pipeline from the screening forms.
export const cvScreeningOutcomes = ["shortlisted", "need_phone_screening", "on_hold", "rejected"] as const;
export type CvScreeningOutcome = (typeof cvScreeningOutcomes)[number];
export const phoneScreeningOutcomes = ["passed", "failed", "no_response", "call_back"] as const;
export type PhoneScreeningOutcome = (typeof phoneScreeningOutcomes)[number];

// Rule 4 — candidate-level status. No longer free text: the vocabulary, the labels and the
// legacy-value mapping all live in candidate-status.ts, and are re-exported here so the many
// existing importers of this module keep resolving it from one place.
export {
  CANDIDATE_STATUS_NOTE_MAX_LENGTH,
  candidateStatuses,
  candidateStatusLabel,
  candidateStatusLabels,
  DEFAULT_CANDIDATE_STATUS,
  isCandidateStatus,
  isUnreviewedCandidateStatus,
  normalizeCandidateStatus,
  type CandidateStatus,
} from "@/lib/recruitment/candidate-status";

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

/**
 * The position a candidate was sent FOR, frozen at the moment of the send.
 *
 * Named here rather than written inline on Candidate because four other places have to agree on its
 * shape — the picker that produces it, the route that validates it, the write path that stamps it,
 * and the grouping that folds it into folders. A shape repeated in four places is a shape that
 * drifts in three of them.
 */
export type SentForPosition = {
  /** The open vacancy this came from, when one was picked. Null for a free-typed position. */
  vacancyId: number | null;
  jobTitle: string | null;
  areaName: string | null;
  lineName: string | null;
  regionName: string | null;
};

export type Candidate = {
  id: string;
  fullName: string;
  status: string;
  // Why the status is what it is, and who last set it. The fixed vocabulary makes the column
  // countable and filterable; the note keeps the one thing a list of five codes can never hold —
  // "not an Egyptian national", "asked for double the band", "call back after Ramadan".
  statusNote: string | null;
  statusChangedAt: string | null;
  statusChangedByHrId: string | null;
  nationalId: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  linkedinUrl: string | null;
  nationality: string | null;
  // Date columns surface as "YYYY-MM-DD" strings through the REST client, exactly like the
  // medicalRepExperience* pair below — they are never Date objects at this layer.
  dateOfBirth: string | null;
  placeOfBirth: string | null;
  gender: string | null;
  maritalStatus: string | null;
  militaryStatus: string | null;
  address: string | null;
  governorate: string | null;
  // What the applicant answered on WhatsApp when asked where they want to WORK — a different
  // question from `governorate` above, which is where their CV says they LIVE. Written by the
  // apply flow only, so null for everyone who arrived before it existed or never replied.
  // A tapped region is a `candidateRegionCodes` value; a typed one lands in the name field.
  preferredRegionCode: string | null;
  preferredRegionName: string | null;
  preferredAreaName: string | null;
  preferencesDeclaredAt: string | null;
  // The candidate's OWN current/most recent job title as written on their CV — never the vacancy
  // they applied to. This is the field that makes CV extraction work for any job title.
  currentJobTitle: string | null;
  // The job they are asking us FOR, and the words that prove it. Read from the covering message
  // (email subject/body, WhatsApp text) far more often than from the CV, which is why the two are
  // separate fields: the title is what gets filtered on, the evidence is what lets a recruiter
  // overrule it without opening the mail.
  appliedForJobTitle: string | null;
  appliedForEvidence: string | null;
  professionalSummary: string | null;
  currentEmployer: string | null;
  currentRoleResponsibilities: string | null;
  yearsExperience: number | null;
  expectedSalary: number | null;
  noticePeriod: string | null;
  source: string | null;
  cvReferenceName: string | null;
  cvExternalUrl: string | null;
  notes: string | null;
  faculty: string | null;
  // What the applicant answered when the apply flow asked what they studied — a TAPPED discipline
  // or free text they typed. Distinct from `faculty` above, which the CV extractor read off the
  // document: this one is the applicant's own answer, so it outranks the CV when the two disagree.
  // Null for everyone who arrived before the question existed, which is most of the archive.
  declaredBackground: string | null;
  // An ADMIN's answer on whether this graduate is in the five field-force disciplines, written only
  // after a person opened the CV. It outranks both of the fields above, in both directions, and
  // null — which is where every row starts — means nobody has been asked. background-review.ts.
  backgroundConfirmedOutcome: string | null;
  backgroundConfirmedAt: string | null;
  backgroundConfirmedByHrId: string | null;
  university: string | null;
  degree: string | null;
  graduationYear: number | null;
  grade: string | null;
  hasPriorWorkExperience: boolean | null;
  hasMedicalRepExperience: boolean | null;
  medicalRepEmployer: string | null;
  medicalRepExperienceFrom: string | null;
  medicalRepExperienceTo: string | null;
  // The repeating CV blocks — workHistory, educationHistory, certifications, skills, languages —
  // keyed by the `storage: "jsonb"` field keys in src/lib/recruitment/cv-field-schemas.ts. They
  // live here rather than in columns because they are variable-length arrays; every scalar
  // extraction field has its own column above.
  positionSpecificFields: Record<string, unknown>;
  // Answers to the Super-Admin-defined extra questions the WhatsApp bot asks after the fixed six
  // (whatsapp-screening-questions.ts), keyed by question_key. A DIFFERENT thing from
  // positionSpecificFields above — that is CV-extraction data, this is chatbot-collected screening
  // data — never conflate the two.
  screeningExtraAnswers: Record<string, string>;
  /**
   * The last time this candidate was pushed straight to a manager, with NO requisition in between.
   * Null means nobody has been told — which, before 2026-08-15, was true of 214 of the 221 people
   * in the pool, because a push required inventing a position first.
   *
   * The manager's name is the one stored AT THE TIME of the send rather than joined on render, so
   * the history keeps saying what the recruiter actually saw even after a rename or a leaver. The
   * seat — job title, area, region — is frozen the same way and for the same reason, and exists so
   * a recruiter's "sent to" list groups by the manager it actually went to instead of reading as
   * one flat column of names. Null on the parts a send predating 2026-08-27 could not resolve.
   */
  managerNotified: {
    hrId: string;
    name: string;
    sentAt: string;
    jobTitle: string | null;
    areaName: string | null;
    regionName: string | null;
  } | null;
  /**
   * The POSITION this candidate was sent for — "Nasr City · Medical Representative · Pedia".
   *
   * A different thing from `managerNotified` above, which is the manager's OWN seat. One manager
   * holds several open vacancies (measured 2026-08-28: Ahmed Mohamed Nagy is named on five, across
   * four areas), so grouping a manager's inbox by the manager produces one pile, and grouping it by
   * this produces the folder-per-vacancy the owner asked for.
   *
   * `vacancyId` is set when the recruiter picked an open seat from the organogram and null when
   * they typed the position instead — both are valid, and the text is what the folder is keyed on
   * either way. See position-folder.ts. Null on every send made before 2026-08-28, which is honest:
   * no position was recorded, and none is invented.
   */
  sentFor: SentForPosition | null;
  /**
   * The CV shelf — where a good-but-not-needed-now CV was filed, and by whom.
   *
   * Null for everyone in the live pool, which is nearly everybody. Non-null is the single authority
   * for "hidden from the main page": the pool, the CV database and the screening queue all ask
   * `isFiledCandidate` and none of them re-derives it. See candidate-folder.ts for the three shelves
   * and why filing is deliberately NOT a status.
   *
   * `key` means whatever `kind` says it means — an area name, a region CODE, or a job title.
   */
  folder: {
    kind: CandidateFolderKind;
    key: string;
    filedAt: string;
    filedByHrId: string | null;
  } | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  // Where this candidate's CV came from (email subject, or first WhatsApp messages), derived from
  // their most recent inbound-intake event. Undefined for a manually-added candidate, or when the
  // list wasn't asked to load it. See src/lib/recruitment/candidate-source-context.ts.
  sourceContext?: CandidateSourceContext;
  // Advisory "might be the same applicant as another candidate" flag — a soft match on phone-tail
  // or normalized name (e.g. the same person applied via both email and WhatsApp). NEVER an
  // auto-merge: the exact-key identity rule stays authoritative; this just points Talent
  // Acquisition at a record worth eyeballing. Populated by listCandidates; see findDuplicateFlags.
  possibleDuplicate?: { candidateId: string; reason: "name" | "phone_tail" } | null;
  // The job this person is asking us for, resolved from every piece of evidence on the record
  // rather than from `appliedForJobTitle` alone — which is filled on 15 of 555 production rows.
  // Populated by listCandidates; see src/lib/recruitment/applied-for.ts for the ladder and why it
  // is ordered the way it is. Carries the source so a derived answer is never shown as a stated one.
  appliedFor?: CandidateAppliedFor | null;
  // TRUE only when the most recent CV read judged this file explicitly NOT to be a CV — the answer
  // the model gives on the same call as the extraction, stored since #2271. Twenty-three "WhatsApp
  // Import" rows in production are photographs of ICDL certificates, training diplomas and Saudi
  // experience letters; the read correctly returned every field null and the pool showed an empty
  // row with no reason, so the same file was re-read three times at full vision price.
  //
  // Absent means "no judgement on record", NOT "it is a CV": every row written before #2271 has a
  // NULL verdict, and so does any read that never reached the model. Gate on `notACv === true`.
  // Populated by listCandidates only — the write paths that call getCandidate have no use for it
  // and should not pay for the extra query. The profile panel reads the verdict straight off its
  // own StoredCvExtraction.isCv instead, which is fresher than any copy carried on the row.
  notACv?: boolean;
  // What the CV reader answered but was NOT confident enough to write into the columns above —
  // 250 values across the pool, every one of them `confidence: "low"`, which is exactly why
  // selectAutoApplyFields declined them and exactly why they must never be merged into the columns
  // themselves. Carried separately so the screening surfaces can show a hedged answer AS hedged
  // instead of showing a blank cell. Populated by listCandidates; see
  // src/lib/recruitment/candidate-screening-facts.ts.
  cvUnconfirmed?: CandidateUnconfirmedCvFacts | null;
};

export type CandidateSourceContext = {
  channel: "email" | "whatsapp" | null;
  shortLabel: string | null;
  detailLines: string[];
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

// One line of a candidate's decision history. Append-only: the note on the candidate row is
// overwritten by the next decision, so without this table "why did we reject them in July" is a
// question the module could not answer once anything else happened to the record.
export type CandidateStatusEvent = {
  id: string;
  candidateId: string;
  fromStatus: string | null;
  toStatus: string;
  note: string | null;
  actorHrId: string | null;
  createdAt: string;
};

/**
 * Ceiling on a manager's comment, matching the CHECK constraint in
 * 20260830223000_candidate_manager_comments.sql.
 *
 * It lives in this module, not beside the service, because the textarea that enforces it is a client
 * component — and candidate-comments.ts reaches for the service-role database client, which must
 * never be pulled into a browser bundle by an innocent-looking import of a number.
 */
export const CANDIDATE_COMMENT_MAX_LENGTH = 2000;

// What a manager said about a CV pushed to somebody in their team. Not a decision and not a status
// change — see the note on ats_candidate_comments for why it does not live in the status history.
// The author's name and title are as at the moment of writing, because HR_IDs are reused when a
// seat is refilled and resolving them later would attribute one manager's words to their successor.
export type CandidateComment = {
  id: string;
  candidateId: string;
  authorHrId: string | null;
  authorName: string | null;
  authorJobTitle: string | null;
  body: string;
  createdAt: string;
};

/**
 * Just enough about a stored file for a card to offer View CV / Download.
 *
 * Deliberately NOT `RecruitmentFile`: that type belongs to the service layer, and this crosses into
 * a client component. Four fields, all of them safe to render — no storage path, no provider id.
 */
export type TeamCandidateFile = {
  id: string;
  fileName: string;
  kind: string;
  mimeType: string | null;
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

// One active position from the `positions` catalogue, offered in the requisition create form's
// Position dropdown. `title` is stored as-is (some are awkwardly cased, e.g. "Ceo", "Qppv") and is
// shown verbatim — never re-cased.
export type PositionCatalogueOption = { id: number; title: string };

export type CreateRequisitionInput = {
  vacancyId?: number | null;
  // A catalogue position picked in the create form. It tags the requisition with a real position_id
  // even when no organogram seat (vacancy) sits behind it; it does NOT create or modify any seat.
  positionId?: number | null;
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
  whatsapp?: string | null;
  linkedinUrl?: string | null;
  nationality?: string | null;
  dateOfBirth?: string | null;
  placeOfBirth?: string | null;
  gender?: string | null;
  maritalStatus?: string | null;
  militaryStatus?: string | null;
  address?: string | null;
  governorate?: string | null;
  currentJobTitle?: string | null;
  appliedForJobTitle?: string | null;
  appliedForEvidence?: string | null;
  professionalSummary?: string | null;
  currentEmployer?: string | null;
  currentRoleResponsibilities?: string | null;
  yearsExperience?: number | null;
  expectedSalary?: number | null;
  noticePeriod?: string | null;
  source?: string | null;
  cvReferenceName?: string | null;
  cvExternalUrl?: string | null;
  notes?: string | null;
  faculty?: string | null;
  university?: string | null;
  degree?: string | null;
  graduationYear?: number | null;
  grade?: string | null;
  hasPriorWorkExperience?: boolean | null;
  hasMedicalRepExperience?: boolean | null;
  medicalRepEmployer?: string | null;
  medicalRepExperienceFrom?: string | null;
  medicalRepExperienceTo?: string | null;
  positionSpecificFields?: Record<string, unknown> | null;
};

// Partial edit of an existing candidate — an omitted key leaves that column
// untouched; an explicit `null` clears it. Used by the CV-extraction review UI.
export type UpdateCandidateInput = Partial<CreateCandidateInput>;
