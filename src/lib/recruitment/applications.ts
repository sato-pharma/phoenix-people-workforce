// Recruitment / ATS — applications service (the pipeline spine).
//
// One application carries the candidate through every stage. Simple stage moves
// go through runApplicationTransition; the three that touch the existing offer
// engine have dedicated functions:
//   - launchOfferFromApplication  -> reuses createOffer (Stages 12/15)
//   - reconcileOfferStatuses      -> mirrors candidate decision (Stage 16)
//   - approveAndConvert           -> reuses approveAcceptedOffer (Stage 21)
// The offer engine is NOT modified; we only link to it (application_id/offer_id).

import {
  systemAccessContext,
  type AccessContext,
} from "@/lib/auth/permissions";
import {
  approveAcceptedOffer,
  createOffer,
  type OfferLifecycleInput,
} from "@/lib/offers/service";
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
import { canSeeApplication } from "@/lib/recruitment/access";
import {
  createCandidate,
  getCandidate,
} from "@/lib/recruitment/candidates";
import {
  getRequisition,
  listRequisitions,
  markRequisitionFilled,
} from "@/lib/recruitment/requisitions";
import { areRequiredDocumentsApproved, ensureOnboardingChecklist } from "@/lib/recruitment/onboarding";
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

export type LaunchOfferInput = {
  baseSalary?: number | null;
  startDate?: string | null;
  expiresInDays?: number | null;
  fuelAllowance?: number | null;
  extraCostOfLiving?: number | null;
  socialInsurance?: number | null;
  taxes?: number | null;
  salaryAmount?: number | null;
  compensationLines?: unknown;
  compensationNotes?: string | null;
  templateKey?: string | null;
};

// Plain stage moves that are a status change + history only (no side effects).
const plainTransitionNextStatus: Partial<Record<RecruitmentActionKey, ApplicationStage>> = {
  app_add: "in_candidate_pool",
  app_to_cv_screen: "cv_screening",
  app_to_phone_screen: "phone_screening",
  app_to_interview_scheduling: "interview_scheduling",
  app_to_hr_interview: "hr_interview",
  app_record_hr_interview: "hiring_manager_interview",
  app_record_hm_interview: "final_selection",
  app_select: "offer_initiated",
  app_to_pre_boarding: "pre_boarding",
  app_reject: "application_rejected",
  app_withdraw: "application_withdrawn",
};

async function loadApplicationRow(id: string): Promise<Application> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("recruitment_applications")
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
    supabase.from("recruitment_applications").select("*").order("created_at", { ascending: false }),
    listRequisitions(access),
  ]);
  if (error) throw error;

  const requisitionsById = new Map(requisitions.map((requisition) => [requisition.id, requisition]));
  const applications = ((data ?? []) as ApplicationDbRow[]).map(mapApplication);
  const visible = applications.filter((application) => canSeeApplication(access, application, requisitionsById));

  const candidateIds = Array.from(new Set(visible.map((application) => application.candidateId)));
  const candidatesById = new Map<string, Candidate>();
  if (candidateIds.length > 0) {
    const { data: candidateRows, error: candidateError } = await supabase
      .from("recruitment_candidates")
      .select("*")
      .in("id", candidateIds);
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
    .from("recruitment_applications")
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
    .from("recruitment_applications")
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
    .from("recruitment_applications")
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

  // Entering pre-boarding seeds the document + joining checklist (stages 17-20).
  if (actionKey === "app_to_pre_boarding") {
    await ensureOnboardingChecklist(id);
  }
  return updated;
}

// Stage 12/15 — launch an offer through the existing offer engine and link it.
export async function launchOfferFromApplication(
  id: string,
  access: AccessContext,
  offerInput: LaunchOfferInput,
): Promise<{ application: Application; offerId: string }> {
  const application = await loadApplicationRow(id);
  const requisition = await getRequisition(access, application.requisitionId);
  if (!requisition) throw new Error("Requisition not found.");
  const candidate = await getCandidate(application.candidateId);
  if (!candidate) throw new Error("Candidate not found.");
  if (!candidate.email) throw new Error("Candidate email is required to send an offer.");
  if (!requisition.vacancyId) {
    throw new Error("The requisition must wrap an open vacancy before an offer can be sent.");
  }

  await assertRecruitmentTransition({
    actionKey: "app_offer_sent",
    role: access.role,
    status: application.stage,
  });

  const offerPayload: OfferLifecycleInput = {
    candidateName: candidate.fullName,
    candidateEmail: candidate.email,
    candidatePhone: candidate.phone,
    jobTitle: requisition.jobTitle || "Job Offer",
    departmentId: requisition.departmentId,
    lineId: requisition.lineId,
    areaId: requisition.areaId,
    positionId: requisition.positionId,
    managerHrId: requisition.hiringManagerHrId,
    vacancyId: requisition.vacancyId,
    baseSalary: numberOrNull(offerInput.baseSalary),
    salaryAmount: numberOrNull(offerInput.salaryAmount),
    fuelAllowance: numberOrNull(offerInput.fuelAllowance),
    extraCostOfLiving: numberOrNull(offerInput.extraCostOfLiving),
    socialInsurance: numberOrNull(offerInput.socialInsurance),
    taxes: numberOrNull(offerInput.taxes),
    compensationLines: offerInput.compensationLines,
    compensationNotes: textOrNull(offerInput.compensationNotes),
    startDate: textOrNull(offerInput.startDate),
    expiresInDays: numberOrNull(offerInput.expiresInDays),
    templateKey: textOrNull(offerInput.templateKey),
    createdByHrId: access.hrId,
  };

  const result = await createOffer(offerPayload, { role: access.role });
  const offerId = result.offer.id;

  const supabase = recruitmentDb();
  // Reciprocal soft link on the offer row (no offer-engine code touched).
  await supabase.from("job_offers").update({ application_id: id }).eq("id", offerId);

  const { data, error } = await supabase
    .from("recruitment_applications")
    .update({
      offer_id: offerId,
      stage: "offer_sent",
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
    toStage: "offer_sent",
    action: "app_offer_sent",
    actorHrId: access.hrId ?? null,
    details: { offerId },
  });

  return { application: mapApplication(data as ApplicationDbRow), offerId };
}

// Stage 16 — mirror the candidate's decision (made via the offer token pages)
// onto linked applications. Runs under a system context (bookkeeping, not a user
// action). Returns the number of applications advanced.
export async function reconcileOfferStatuses(): Promise<number> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("recruitment_applications")
    .select("id,offer_id,stage")
    .eq("stage", "offer_sent")
    .not("offer_id", "is", null);
  if (error) throw error;

  const rows = (data ?? []) as ApplicationDbRow[];
  if (rows.length === 0) return 0;

  const offerIds = rows.map((row) => String(row.offer_id));
  const { data: offers, error: offerError } = await supabase
    .from("job_offers")
    .select("id,status")
    .in("id", offerIds);
  if (offerError) throw offerError;
  const offerStatusById = new Map(
    ((offers ?? []) as Array<{ id: string; status: string }>).map((offer) => [String(offer.id), offer.status]),
  );

  const actionByOfferStatus: Record<string, RecruitmentActionKey> = {
    accepted: "app_offer_accepted",
    hired: "app_offer_accepted",
    rejected: "app_offer_declined",
    expired: "app_offer_expired",
  };

  let advanced = 0;
  for (const row of rows) {
    const offerStatus = offerStatusById.get(String(row.offer_id));
    const actionKey = offerStatus ? actionByOfferStatus[offerStatus] : undefined;
    if (!actionKey) continue;

    const nextStatusByAction: Record<string, ApplicationStage> = {
      app_offer_accepted: "offer_accepted",
      app_offer_declined: "offer_declined",
      app_offer_expired: "offer_expired",
    };
    const nextStage = nextStatusByAction[actionKey];

    await assertRecruitmentTransition({
      actionKey,
      role: systemAccessContext.role,
      status: "offer_sent",
    });
    await supabase
      .from("recruitment_applications")
      .update({
        stage: nextStage,
        last_stage_changed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    await writeApplicationEvent({
      applicationId: String(row.id),
      fromStage: "offer_sent",
      toStage: nextStage,
      action: actionKey,
      actorHrId: null,
      details: { offerStatus, source: "reconcile" },
    });
    advanced += 1;
  }

  return advanced;
}

// Stage 21 — approve the accepted offer (reuses the atomic convert RPC) and
// close the requisition. Probation is intentionally NOT created here: the
// probation window is derived from hire_date elsewhere, and the manager
// evaluation is created later by a probation administrator (see plan §5c).
export async function approveAndConvert(
  id: string,
  access: AccessContext,
  input: { manualHrId?: string | null } = {},
): Promise<{ application: Application; employeeHrId: string }> {
  const application = await loadApplicationRow(id);
  const requisition = await getRequisition(access, application.requisitionId);
  if (!requisition) throw new Error("Requisition not found.");
  if (!application.offerId) throw new Error("This application has no linked offer to approve.");

  await assertRecruitmentTransition({
    actionKey: "app_hire",
    role: access.role,
    status: application.stage,
  });

  // Onboarding gate: if the candidate went through pre-boarding, every required
  // document must be approved/waived before the hire is allowed (stage 18).
  if (application.stage === "pre_boarding") {
    const documentsApproved = await areRequiredDocumentsApproved(application.id);
    if (!documentsApproved) {
      throw new Error("All required onboarding documents must be approved before hiring.");
    }
  }

  const approval = await approveAcceptedOffer(
    application.offerId,
    access.hrId ?? null,
    textOrNull(input.manualHrId),
    { role: access.role },
  );
  const employeeHrId = approval.employeeHrId;

  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("recruitment_applications")
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
    details: { employeeHrId, offerId: application.offerId },
  });

  await markRequisitionFilled(requisition.id, access);

  return { application: mapApplication(data as ApplicationDbRow), employeeHrId };
}
