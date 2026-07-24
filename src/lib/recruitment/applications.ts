// Recruitment / ATS — applications service (the pipeline spine).
//
// One application carries the candidate through every stage via
// runApplicationTransition. Hiring is a dedicated function, markApplicationHired
// (Stage 21) — it does not create an offer or an employee record; the employee is
// created through the normal HR "Add Employee" flow first (which also closes the
// matching position vacancy), and this just marks the application hired against
// that employee's HR_ID.

import type { AccessContext } from "@/lib/auth/permissions";
import { hrIdsMatch } from "@/lib/hr-id";
import { createSystemNotification } from "@/lib/notifications/system";
import { createInitialProbationRecord } from "@/lib/probation/provisioning";
import {
  assertRecruitmentTransition,
  mapApplication,
  mapCandidate,
  newApplicationCode,
  numberOrNull,
  recruitmentDb,
  textOrNull,
  writeApplicationEvent,
  type ApplicationDbRow,
  type CandidateDbRow,
} from "@/lib/recruitment/db";
import { assertCanDeleteRecruitment, canSeeApplication } from "@/lib/recruitment/access";
import {
  createCandidate,
  getCandidate,
} from "@/lib/recruitment/candidates";
import {
  getRequisition,
  listRequisitions,
  markRequisitionFilled,
} from "@/lib/recruitment/requisitions";
import {
  isTerminalApplicationStage,
  type Application,
  type ApplicationStage,
  type Candidate,
  type CreateCandidateInput,
  type RecruitmentActionKey,
  type Requisition,
} from "@/lib/recruitment/types";

export type ApplicationWithContext = Application & {
  candidate: Candidate | null;
  requisition: Requisition | null;
};

// Plain stage moves that are a status change + history only (no side effects).
const plainTransitionNextStatus: Partial<Record<RecruitmentActionKey, ApplicationStage>> = {
  app_add: "in_candidate_pool",
  app_to_cv_screen: "cv_screening",
  app_to_phone_screen: "phone_screening",
  app_to_interview_scheduling: "interview_scheduling",
  app_to_hr_interview: "hr_interview",
  app_record_hr_interview: "hiring_manager_interview",
  app_record_hm_interview: "manager_interview_completed",
  app_mgr_completed_to_final: "final_selection",
  app_select: "offer_initiated",
  app_to_pre_boarding: "pre_boarding",
  app_reject: "application_rejected",
  app_withdraw: "application_withdrawn",
  // Rule 5/6 — screening outcomes + holding states + resume paths.
  app_cv_shortlist: "shortlisted",
  app_shortlist_to_scheduling: "interview_scheduling",
  app_hold: "on_hold",
  app_resume_from_hold_to_cv: "cv_screening",
  app_resume_from_hold_to_phone: "phone_screening",
  app_no_response: "no_response",
  app_resume_from_no_response: "phone_screening",
  app_call_back: "call_back",
  app_resume_from_call_back_to_cv: "cv_screening",
  app_resume_from_call_back_to_phone: "phone_screening",
  // Rule 8/9 — interview completion + final selection backup pool.
  app_resume_from_hold_to_hm: "hiring_manager_interview",
  app_to_backup: "backup_candidate",
  app_backup_to_offer: "offer_initiated",
};

async function loadApplicationRow(id: string): Promise<Application> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_applications")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Application not found.");
  return mapApplication(data as ApplicationDbRow);
}

export async function listApplications(access: AccessContext): Promise<ApplicationWithContext[]> {
  const supabase = recruitmentDb();
  const [{ data, error }, requisitions] = await Promise.all([
    supabase.from("ats_applications").select("*").order("created_at", { ascending: false }),
    listRequisitions(access),
  ]);
  if (error) throw error;

  const requisitionsById = new Map(requisitions.map((requisition) => [requisition.id, requisition]));
  const applications = ((data ?? []) as ApplicationDbRow[]).map(mapApplication);
  const visible = applications.filter((application) => canSeeApplication(access, application, requisitionsById));

  const candidateIds = Array.from(new Set(visible.map((application) => application.candidateId)));
  const candidatesById = new Map<string, Candidate>();
  // PostgREST folds every .in() value into the request URL; an unbatched array of a few hundred
  // ids can push the URL past undici's ~16KB header limit and throw "TypeError: fetch failed" /
  // HeadersOverflowError. listApplications is company-wide for HR/admin viewers, so batch.
  for (let i = 0; i < candidateIds.length; i += 100) {
    const batch = candidateIds.slice(i, i + 100);
    const { data: candidateRows, error: candidateError } = await supabase
      .from("ats_candidates")
      .select("*")
      .in("id", batch);
    if (candidateError) throw candidateError;
    for (const row of (candidateRows ?? []) as CandidateDbRow[]) {
      const candidate = mapCandidate(row);
      candidatesById.set(candidate.id, candidate);
    }
  }

  return visible.map((application) => ({
    ...application,
    candidate: candidatesById.get(application.candidateId) ?? null,
    requisition: requisitionsById.get(application.requisitionId) ?? null,
  }));
}

export async function getApplication(
  access: AccessContext,
  id: string,
): Promise<ApplicationWithContext | null> {
  const application = await loadApplicationRow(id).catch(() => null);
  if (!application) return null;
  // Scope check via the requisition (throws Forbidden if out of scope).
  const requisition = await getRequisition(access, application.requisitionId);
  const candidate = await getCandidate(application.candidateId);
  return { ...application, candidate, requisition };
}

export type CreateApplicationInput = {
  requisitionId: string;
  candidateId?: string | null;
  candidate?: CreateCandidateInput | null;
  source?: string | null;
};

export async function createApplication(
  input: CreateApplicationInput,
  access: AccessContext,
): Promise<ApplicationWithContext> {
  const requisition = await getRequisition(access, input.requisitionId);
  if (!requisition) throw new Error("Requisition not found.");

  let candidateId = textOrNull(input.candidateId);
  if (!candidateId) {
    if (!input.candidate) throw new Error("Provide an existing candidate or candidate details.");
    const result = await createCandidate(input.candidate, access);
    candidateId = result.candidate.id;
  }

  const supabase = recruitmentDb();
  const { data: existing, error: existingError } = await supabase
    .from("ats_applications")
    .select("id,stage")
    .eq("requisition_id", input.requisitionId)
    .eq("candidate_id", candidateId);
  if (existingError) throw existingError;
  const hasActive = ((existing ?? []) as ApplicationDbRow[]).some(
    (row) => !isTerminalApplicationStage(String(row.stage ?? "")),
  );
  if (hasActive) {
    throw new Error("This candidate already has an active application for this requisition.");
  }

  const { data, error } = await supabase
    .from("ats_applications")
    .insert({
      application_code: newApplicationCode(),
      requisition_id: input.requisitionId,
      candidate_id: candidateId,
      stage: "application_received",
      source: textOrNull(input.source),
      current_owner_hr_id: requisition.recruitmentOwnerHrId ?? access.hrId ?? null,
      created_by: access.hrId ?? access.loginId ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;

  const application = mapApplication(data as ApplicationDbRow);
  await writeApplicationEvent({
    applicationId: application.id,
    fromStage: null,
    toStage: application.stage,
    action: "application_created",
    actorHrId: access.hrId ?? null,
  });

  // Move straight into the searchable pool (Stage 5).
  await runApplicationTransition(application.id, "app_add", access);

  // Best-effort: let the requisition's hiring manager (e.g. a District Manager) know a
  // candidate has been assigned to their open seat — never blocks the assignment itself.
  if (requisition.hiringManagerHrId && !hrIdsMatch(access.hrId, requisition.hiringManagerHrId)) {
    try {
      const candidate = await getCandidate(candidateId);
      await createSystemNotification({
        actionUrl: "/employee-portals/recruitment-candidates",
        channels: ["in_app", "email"],
        eventType: "candidate_assigned",
        message: `${candidate?.fullName ?? "A candidate"} has been assigned to your ${requisition.jobTitle} position.`,
        module: "recruitment",
        priority: "normal",
        recipientHrId: requisition.hiringManagerHrId,
        title: "New candidate assigned",
      });
    } catch {
      // Notifications are best-effort; the assignment must still succeed.
    }
  }

  const refreshed = await getApplication(access, application.id);
  if (!refreshed) throw new Error("Application could not be reloaded after creation.");
  return refreshed;
}

export async function runApplicationTransition(
  id: string,
  actionKey: RecruitmentActionKey,
  access: AccessContext,
  input: { reason?: string | null } = {},
): Promise<Application> {
  const application = await loadApplicationRow(id);
  // Scope check (throws Forbidden if the requisition is out of scope).
  await getRequisition(access, application.requisitionId);

  const nextStatus = plainTransitionNextStatus[actionKey];
  if (!nextStatus) {
    throw new Error(`${actionKey} is not a plain stage transition.`);
  }

  await assertRecruitmentTransition({
    actionKey,
    role: access.role,
    status: application.stage,
    reason: input.reason,
  });

  const patch: Record<string, unknown> = {
    stage: nextStatus,
    last_stage_changed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (actionKey === "app_reject") patch.rejected_reason = textOrNull(input.reason);
  if (actionKey === "app_select") patch.decision_reason = textOrNull(input.reason);

  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_applications")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;

  const updated = mapApplication(data as ApplicationDbRow);
  await writeApplicationEvent({
    applicationId: id,
    fromStage: application.stage,
    toStage: updated.stage,
    action: actionKey,
    actorHrId: access.hrId ?? null,
    reason: input.reason,
  });

  return updated;
}

// Stage 21 — direct hire. The employee record is created through the normal HR
// "Add Employee" flow first (which also closes the matching position vacancy);
// this just links the application to that employee's HR_ID, closes the
// requisition, and best-effort seeds the initial probation window. Probation
// creation is non-blocking: a failure never rolls back a completed hire.
export async function markApplicationHired(
  id: string,
  access: AccessContext,
  input: { employeeHrId: string; startDate?: string | null; probationMonths?: number | null },
): Promise<{ application: Application; employeeHrId: string }> {
  const employeeHrId = textOrNull(input.employeeHrId);
  if (!employeeHrId) throw new Error("The hired employee's HR_ID is required.");

  const application = await loadApplicationRow(id);
  const requisition = await getRequisition(access, application.requisitionId);
  if (!requisition) throw new Error("Requisition not found.");

  await assertRecruitmentTransition({
    actionKey: "app_hire",
    role: access.role,
    status: application.stage,
  });

  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_applications")
    .update({
      stage: "hired",
      converted_employee_hr_id: employeeHrId,
      last_stage_changed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;

  await writeApplicationEvent({
    applicationId: id,
    fromStage: application.stage,
    toStage: "hired",
    action: "app_hire",
    actorHrId: access.hrId ?? null,
    details: { employeeHrId },
  });

  await markRequisitionFilled(requisition.id, access);

  // Auto-create the initial probation window (non-blocking: a probation-create
  // failure must never roll back a completed hire — it can be created manually).
  try {
    await createInitialProbationRecord({
      employeeHrId,
      startDate: textOrNull(input.startDate),
      probationMonths: numberOrNull(input.probationMonths),
    });
  } catch (probationError) {
    void probationError; // Swallow: the hire is committed; probation setup is secondary.
  }

  return { application: mapApplication(data as ApplicationDbRow), employeeHrId };
}

// Hard-delete an application (admin cleanup; any stage). Database cascades remove
// its events, interviews, onboarding items, and file links. The candidate and
// requisition records are left intact.
export async function deleteApplication(access: AccessContext, id: string): Promise<void> {
  assertCanDeleteRecruitment(access);
  const application = await getApplication(access, id); // scope-checked; null if missing
  if (!application) throw new Error("Application not found.");
  const supabase = recruitmentDb();
  const { error } = await supabase.from("ats_applications").delete().eq("id", id);
  if (error) throw error;
}
