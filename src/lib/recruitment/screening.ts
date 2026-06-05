// Recruitment / ATS — CV / phone / hiring-manager screening orchestration
// (Rules 5, 6 & 8).
//
// A screening or interview result is recorded as a recruitment_interviews row
// (reusing the scorecard machinery), then the chosen outcome drives a pipeline
// transition. Phone screening also confirms a few candidate fields (current
// employer, expected salary, notice period) onto the candidate record.

import type { AccessContext } from "@/lib/auth/permissions";
import { getApplication, runApplicationTransition } from "@/lib/recruitment/applications";
import { createInterview } from "@/lib/recruitment/interviews";
import { numberOrNull, recruitmentDb, textOrNull } from "@/lib/recruitment/db";
import { normalizeScorecard } from "@/lib/recruitment/scorecards";
import {
  type CvScreeningOutcome,
  type InterviewType,
  type PhoneScreeningOutcome,
  type RecruitmentActionKey,
} from "@/lib/recruitment/types";

export type ScreeningStage = "cv" | "phone" | "hm";

export type RecordScreeningInput = {
  outcome: string;
  score?: Record<string, unknown> | null;
  notes?: string | null;
  reason?: string | null;
  // Phone confirm-fields — update the candidate record when provided.
  currentEmployer?: string | null;
  expectedSalary?: number | null;
  noticePeriod?: string | null;
};

const cvOutcomeAction: Record<CvScreeningOutcome, RecruitmentActionKey> = {
  shortlisted: "app_cv_shortlist",
  need_phone_screening: "app_to_phone_screen",
  on_hold: "app_hold",
  rejected: "app_reject",
};

const phoneOutcomeAction: Record<PhoneScreeningOutcome, RecruitmentActionKey> = {
  passed: "app_to_interview_scheduling",
  failed: "app_reject",
  no_response: "app_no_response",
  call_back: "app_call_back",
};

// Rule 8 — hiring-manager interview decision.
const hmOutcomeAction: Record<string, RecruitmentActionKey> = {
  recommended: "app_record_hm_interview",
  rejected: "app_reject",
  hold: "app_hold",
};

const interviewTypeForStage: Record<ScreeningStage, InterviewType> = {
  cv: "cv",
  phone: "phone",
  hm: "hiring_manager",
};

export async function recordScreeningOutcome(
  access: AccessContext,
  applicationId: string,
  stage: ScreeningStage,
  input: RecordScreeningInput,
): Promise<void> {
  const application = await getApplication(access, applicationId); // scope check (throws if out of scope)
  if (!application) throw new Error("Application not found.");

  const action =
    stage === "cv"
      ? cvOutcomeAction[input.outcome as CvScreeningOutcome]
      : stage === "phone"
        ? phoneOutcomeAction[input.outcome as PhoneScreeningOutcome]
        : hmOutcomeAction[input.outcome];
  if (!action) throw new Error("Invalid screening outcome.");

  const interviewType = interviewTypeForStage[stage];

  // 1. Persist the screening scorecard (reuses the interviews table + scorecard normalize).
  await createInterview(access, applicationId, {
    interviewType,
    outcome: input.outcome,
    score: input.score ? normalizeScorecard(interviewType, input.score) : {},
    notes: input.notes ?? null,
  });

  // 2. Phone screening confirms candidate fields — write them onto the candidate.
  if (stage === "phone") {
    const patch: Record<string, unknown> = {};
    if (input.currentEmployer !== undefined) patch.current_employer = textOrNull(input.currentEmployer);
    if (input.expectedSalary !== undefined) patch.expected_salary = numberOrNull(input.expectedSalary);
    if (input.noticePeriod !== undefined) patch.notice_period = textOrNull(input.noticePeriod);
    if (Object.keys(patch).length > 0) {
      patch.updated_at = new Date().toISOString();
      await recruitmentDb().from("recruitment_candidates").update(patch).eq("id", application.candidateId);
    }
  }

  // 3. Drive the pipeline (registry-validated; reason enforced for reject/hold).
  await runApplicationTransition(applicationId, action, access, { reason: input.reason });
}
