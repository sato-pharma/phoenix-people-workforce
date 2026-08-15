// Recruitment / ATS — applications service (the pipeline spine).
//
// One application carries the candidate through every stage via
// runApplicationTransition. Hiring is a dedicated function, markApplicationHired
// (Stage 21) — it does not create an offer or an employee record; the employee is
// created through the normal HR "Add Employee" flow first (which also closes the
// matching position vacancy), and this just marks the application hired against
// that employee's HR_ID.

import type { AccessContext } from "@/lib/auth/permissions";
import { fetchRowsInBatches } from "@/lib/recruitment/db-batch";
import { hrIdsMatch } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import { createInitialProbationRecord } from "@/lib/probation/provisioning";
import {
  MANAGER_NOTIFIED_ACTION,
  notifyHiringManagerOfCandidate,
  type HiringManagerNotifyResult,
} from "@/lib/recruitment/hiring-manager-notify";
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

/** When this candidate was last pushed to the hiring manager, and who was told. */
export type ManagerNotifiedStamp = {
  managerName: string;
  sentAt: string;
};

export type ApplicationWithContext = Application & {
  candidate: Candidate | null;
  requisition: Requisition | null;
  /**
   * Read back from the manager_notified audit row rather than held in component state, so the
   * confirmation survives a reload and a second recruiter can see the send already happened.
   * Null means nobody has been told — which, before 2026-08-15, was true of 3 of the 5 candidates
   * the module believed it had pushed.
   */
  managerNotified: ManagerNotifiedStamp | null;
};

type ManagerNotifiedEventRow = {
  application_id: string;
  created_at: string;
  details: Record<string, unknown> | null;
};

/**
 * The most recent manager_notified stamp per application.
 *
 * Newest-first and first-wins, so a re-send replaces the earlier stamp instead of showing a stale
 * one. Batched for the same reason every other `.in()` here is (see db-batch.ts). Best-effort: a
 * failure to read the audit trail must never stop the pipeline itself from rendering.
 */
async function loadManagerNotifiedStamps(
  applicationIds: readonly string[],
): Promise<Map<string, ManagerNotifiedStamp>> {
  const stamps = new Map<string, ManagerNotifiedStamp>();
  if (applicationIds.length === 0) return stamps;
  try {
    const supabase = recruitmentDb();
    const rows = await fetchRowsInBatches<ManagerNotifiedEventRow>(applicationIds, (batch) =>
      supabase
        .from("ats_application_events")
        .select("application_id,created_at,details")
        .eq("action", MANAGER_NOTIFIED_ACTION)
        .in("application_id", batch)
        .order("created_at", { ascending: false }),
    );
    for (const row of rows) {
      if (stamps.has(row.application_id)) continue;
      const details = (row.details ?? {}) as { managerName?: unknown; sentAt?: unknown };
      stamps.set(row.application_id, {
        managerName: typeof details.managerName === "string" ? details.managerName : "the hiring manager",
        // created_at is the fallback for a row written before details carried sentAt.
        sentAt: typeof details.sentAt === "string" ? details.sentAt : row.created_at,
      });
    }
  } catch (error) {
    logError("Could not read the hiring-manager notification history", {
      error,
      labels: { event: "manager_notified_history_read_failed" },
    });
  }
  return stamps;
}

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
  // listApplications is company-wide for HR/admin viewers, so the id list is unbounded — batch it
  // (see db-batch.ts for why an unbatched .in() eventually fails, and how).
  const candidateRows = await fetchRowsInBatches<CandidateDbRow>(candidateIds, (batch) =>
    supabase.from("ats_candidates").select("*").in("id", batch),
  );
  for (const row of candidateRows) {
    const candidate = mapCandidate(row);
    candidatesById.set(candidate.id, candidate);
  }

  const notified = await loadManagerNotifiedStamps(visible.map((application) => application.id));

  return visible.map((application) => ({
    ...application,
    candidate: candidatesById.get(application.candidateId) ?? null,
    managerNotified: notified.get(application.id) ?? null,
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
  const notified = await loadManagerNotifiedStamps([application.id]);
  return { ...application, candidate, managerNotified: notified.get(application.id) ?? null, requisition };
}

/**
 * Send (or re-send) this candidate to the requisition's hiring manager, deliberately.
 *
 * Separate from createApplication so the push is something a recruiter DOES rather than a side
 * effect they cannot see, repeat, or confirm. Scope is enforced by getApplication, which resolves
 * the requisition through getRequisition and throws Forbidden when it is out of the caller's reach.
 *
 * Unlike the best-effort call inside createApplication, a failure here THROWS: the person pressed a
 * button and is owed the truth about whether it worked.
 */
export async function sendCandidateToHiringManager(
  access: AccessContext,
  applicationId: string,
): Promise<HiringManagerNotifyResult> {
  const application = await getApplication(access, applicationId);
  if (!application) throw new Error("Application not found.");
  if (!application.requisition) throw new Error("This application has no position attached.");

  return notifyHiringManagerOfCandidate({
    actorHrId: access.hrId ?? null,
    actorIsTheManager: hrIdsMatch(access.hrId, application.requisition.hiringManagerHrId),
    applicationId: application.id,
    candidateName: application.candidate?.fullName ?? "A candidate",
    hiringManagerHrId: application.requisition.hiringManagerHrId,
    jobTitle: application.requisition.jobTitle,
  });
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

  // Tell the requisition's hiring manager (e.g. a District Manager) a candidate is waiting on
  // their seat. Still best-effort — the assignment itself must survive a mail outage — but the
  // failure is now LOGGED rather than discarded. This used to be `catch {}`, and that empty block
  // is why 3 of the 5 assignments ever made in production sent nothing with no trace of why, both
  // of the owner's own attempts among them. The recruiter can re-send from the UI either way.
  try {
    const candidate = await getCandidate(candidateId);
    await notifyHiringManagerOfCandidate({
      actorHrId: access.hrId ?? null,
      actorIsTheManager: hrIdsMatch(access.hrId, requisition.hiringManagerHrId),
      applicationId: application.id,
      candidateName: candidate?.fullName ?? "A candidate",
      hiringManagerHrId: requisition.hiringManagerHrId,
      jobTitle: requisition.jobTitle,
    });
  } catch (notifyError) {
    logError("Hiring-manager notification failed on application create", {
      error: notifyError,
      labels: {
        applicationId: application.id,
        event: "candidate_assigned_notify_failed",
        hiringManagerHrId: requisition.hiringManagerHrId ?? "none",
      },
    });
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
