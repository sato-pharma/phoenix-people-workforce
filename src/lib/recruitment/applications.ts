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
  sendOffer,
  type OfferLifecycleInput,
} from "@/lib/offers/service";
import { assertOfferWorkflowTransition } from "@/lib/employee-lifecycle/workflow";
import type { SendPhoenixEmailAttachment } from "@/lib/email/send-phoenix-email";
import {
  canCastOfferApproval,
  computeRequiredApprovers,
  evaluateChainState,
  getApprovalStep,
  loadApprovalSteps,
  loadLatestApprovalSteps,
  nextApprovalVersion,
  recordApprovalDecision,
  seedApprovalSteps,
  type ApprovalStepRow,
} from "@/lib/offers/approval-chain";
import { resolvePositionApprovalThreshold } from "@/config/offer-approval";
import {
  generateOfferLetter,
  generateSalarySummary,
  nextOfferLetterVersion,
} from "@/lib/recruitment/offer-letters";
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
  benefits?: unknown;
  probationPeriodMonths?: number | null;
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

const defaultSeniorApprovalNetThreshold = 20000;

// Pure: above-band offers require a Super Admin senior sign-off before hire.
export function requiresSeniorApproval(netSalary: number | null, threshold: number): boolean {
  return typeof netSalary === "number" && Number.isFinite(netSalary) && netSalary > threshold;
}

function seniorApprovalNetThreshold(): number {
  const raw = Number(process.env.RECRUITMENT_SENIOR_APPROVAL_NET_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 ? raw : defaultSeniorApprovalNetThreshold;
}

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

// ---------------------------------------------------------------------------
// Offer pipeline (Preparation -> Approval -> Generation -> Sent -> Negotiation).
// Each staged function updates BOTH job_offers.status and the application stage in
// lockstep, asserting both registry transitions. The app-side assertion runs
// BEFORE any side effect so a blocked transition never leaves an orphan offer.
// ---------------------------------------------------------------------------

async function setOfferStatus(offerId: string, status: string, patch: Record<string, unknown> = {}): Promise<void> {
  const supabase = recruitmentDb();
  const { error } = await supabase
    .from("job_offers")
    .update({ status, updated_at: new Date().toISOString(), ...patch })
    .eq("id", offerId);
  if (error) throw error;
}

async function commitApplicationStage(input: {
  id: string;
  fromStage: string;
  toStage: ApplicationStage;
  actionKey: RecruitmentActionKey;
  actorHrId: string | null;
  reason?: string | null;
  details?: Record<string, unknown>;
}): Promise<Application> {
  const supabase = recruitmentDb();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("recruitment_applications")
    .update({ stage: input.toStage, last_stage_changed_at: now, updated_at: now })
    .eq("id", input.id)
    .select("*")
    .single();
  if (error) throw error;
  await writeApplicationEvent({
    applicationId: input.id,
    fromStage: input.fromStage,
    toStage: input.toStage,
    action: input.actionKey,
    actorHrId: input.actorHrId,
    reason: input.reason ?? null,
    details: input.details ?? {},
  });
  return mapApplication(data as ApplicationDbRow);
}

// Step 1 — prepare a draft offer (auto-filled from the requisition; salary computed).
export async function prepareOffer(
  id: string,
  access: AccessContext,
  input: LaunchOfferInput = {},
): Promise<{ application: Application; offerId: string }> {
  const application = await loadApplicationRow(id);
  const requisition = await getRequisition(access, application.requisitionId);
  if (!requisition) throw new Error("Requisition not found.");
  const candidate = await getCandidate(application.candidateId);
  if (!candidate) throw new Error("Candidate not found.");
  if (!candidate.email) throw new Error("Candidate email is required to prepare an offer.");
  if (!requisition.vacancyId) {
    throw new Error("The requisition must wrap an open vacancy before an offer can be prepared.");
  }

  await assertRecruitmentTransition({ actionKey: "app_offer_prepare", role: access.role, status: application.stage });

  const baseSalary =
    numberOrNull(input.baseSalary) ??
    requisition.salaryBandMin ??
    requisition.salaryBandMax ??
    candidate.expectedSalary;
  if (!baseSalary || baseSalary <= 0) {
    throw new Error("Provide a base salary (or set the requisition salary band) to prepare the offer.");
  }

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
    baseSalary,
    fuelAllowance: numberOrNull(input.fuelAllowance),
    extraCostOfLiving: numberOrNull(input.extraCostOfLiving),
    socialInsurance: numberOrNull(input.socialInsurance),
    taxes: numberOrNull(input.taxes),
    compensationLines: input.compensationLines,
    compensationNotes: textOrNull(input.compensationNotes),
    startDate: textOrNull(input.startDate),
    expiresInDays: numberOrNull(input.expiresInDays),
    templateKey: textOrNull(input.templateKey),
    benefits: input.benefits,
    probationPeriodMonths: numberOrNull(input.probationPeriodMonths),
    createdByHrId: access.hrId,
  };

  const result = await createOffer(offerPayload, { role: access.role }, { mode: "draft" });
  const offerId = result.offer.id;

  const supabase = recruitmentDb();
  await supabase.from("job_offers").update({ application_id: id }).eq("id", offerId);
  await supabase.from("recruitment_applications").update({ offer_id: offerId }).eq("id", id);

  const updated = await commitApplicationStage({
    id,
    fromStage: application.stage,
    toStage: "offer_draft",
    actionKey: "app_offer_prepare",
    actorHrId: access.hrId ?? null,
    details: { offerId },
  });
  return { application: updated, offerId };
}

// Step 2 — submit the draft offer for the threshold approval chain.
export async function submitOfferForApproval(id: string, access: AccessContext): Promise<Application> {
  const application = await loadApplicationRow(id);
  if (!application.offerId) throw new Error("This application has no prepared offer to submit.");
  const requisition = await getRequisition(access, application.requisitionId);
  if (!requisition) throw new Error("Requisition not found.");

  await assertRecruitmentTransition({ actionKey: "app_offer_submit_approval", role: access.role, status: application.stage });
  await assertOfferWorkflowTransition({
    access: { role: access.role },
    action: "submit_approval",
    expectedNextStatus: "offer_pending_approval",
    status: "draft",
  });

  const supabase = recruitmentDb();
  const { data: offerRow } = await supabase.from("job_offers").select("net_salary").eq("id", application.offerId).maybeSingle();
  const net = numberOrNull((offerRow as Record<string, unknown> | null)?.net_salary ?? null);
  const threshold = resolvePositionApprovalThreshold({ jobTitle: requisition.jobTitle, salaryBandMax: requisition.salaryBandMax });
  const approvers = computeRequiredApprovers({ netSalary: net, hiringManagerHrId: requisition.hiringManagerHrId, threshold });
  const version = await nextApprovalVersion(application.offerId);
  await seedApprovalSteps({ offerId: application.offerId, applicationId: id, version, approvers });

  await setOfferStatus(application.offerId, "pending_approval");
  return commitApplicationStage({
    id,
    fromStage: application.stage,
    toStage: "offer_pending_approval",
    actionKey: "app_offer_submit_approval",
    actorHrId: access.hrId ?? null,
    details: { approvalVersion: version, requiredApprovers: approvers.length },
  });
}

// The latest approval chain for the workspace checklist (+ a per-step authority flag).
export async function getOfferApprovalChain(
  access: AccessContext,
  id: string,
): Promise<Array<ApprovalStepRow & { canAct: boolean }>> {
  const application = await loadApplicationRow(id);
  if (!application.offerId) return [];
  const steps = await loadLatestApprovalSteps(application.offerId);
  return steps.map((step) => ({ ...step, canAct: step.decision === "pending" && canCastOfferApproval(access, step) }));
}

// Step 3 — record one approver's decision; resolve the chain when complete.
export async function decideOfferApproval(
  id: string,
  access: AccessContext,
  input: { stepId: string; decision: "approved" | "rejected" | "returned"; reason?: string | null },
): Promise<{ application: Application; chainState: "pending" | "approved" | "rejected" | "returned" }> {
  const application = await loadApplicationRow(id);
  if (!application.offerId) throw new Error("This application has no offer under approval.");

  const step = await getApprovalStep(input.stepId);
  if (!step || step.offerId !== application.offerId) throw new Error("Approval step not found for this offer.");
  if (!canCastOfferApproval(access, step)) {
    throw new Error("Forbidden: you are not an approver for this step.");
  }
  if ((input.decision === "rejected" || input.decision === "returned") && !textOrNull(input.reason)) {
    throw new Error("A reason is required to reject or return an offer.");
  }

  await recordApprovalDecision({
    stepId: step.id,
    decision: input.decision,
    decidedBy: access.hrId ?? access.loginId ?? null,
    reason: textOrNull(input.reason),
  });

  const steps = await loadApprovalSteps(application.offerId, step.version);
  const chainState = evaluateChainState(steps);
  const now = new Date().toISOString();

  if (chainState === "approved") {
    await assertOfferWorkflowTransition({ action: "chain_approve", expectedNextStatus: "offer_approved", status: "pending_approval" });
    await assertRecruitmentTransition({ actionKey: "app_offer_approved", role: systemAccessContext.role, status: application.stage });
    await setOfferStatus(application.offerId, "approved", { approved_at: now });
    const updated = await commitApplicationStage({
      id,
      fromStage: application.stage,
      toStage: "offer_approved",
      actionKey: "app_offer_approved",
      actorHrId: access.hrId ?? null,
      details: { approvalVersion: step.version },
    });
    return { application: updated, chainState };
  }

  if (chainState === "rejected") {
    await assertOfferWorkflowTransition({ action: "chain_reject", expectedNextStatus: "offer_approval_rejected", status: "pending_approval" });
    await assertRecruitmentTransition({ actionKey: "app_offer_approval_rejected", role: systemAccessContext.role, status: application.stage });
    await setOfferStatus(application.offerId, "approval_rejected");
    const updated = await commitApplicationStage({
      id,
      fromStage: application.stage,
      toStage: "offer_draft",
      actionKey: "app_offer_approval_rejected",
      actorHrId: access.hrId ?? null,
      reason: textOrNull(input.reason),
      details: { approvalVersion: step.version },
    });
    return { application: updated, chainState };
  }

  if (chainState === "returned") {
    // "returned for edit" — uses the same rejection workflow path to send the offer back
    // to draft so the originator can revise and resubmit. The step-level decision field
    // ("returned") lets the UI distinguish this from a final rejection.
    await assertOfferWorkflowTransition({ action: "chain_reject", expectedNextStatus: "offer_approval_rejected", status: "pending_approval" });
    await assertRecruitmentTransition({ actionKey: "app_offer_approval_rejected", role: systemAccessContext.role, status: application.stage });
    await setOfferStatus(application.offerId, "approval_rejected");
    const updated = await commitApplicationStage({
      id,
      fromStage: application.stage,
      toStage: "offer_draft",
      actionKey: "app_offer_approval_rejected",
      actorHrId: access.hrId ?? null,
      reason: textOrNull(input.reason),
      details: { approvalVersion: step.version, returnedForEdit: true },
    });
    return { application: updated, chainState };
  }

  return { application, chainState };
}

// Step 4 — generate the offer letter + salary summary (shared version V1/V2/V3).
export async function generateOfferDocuments(id: string, access: AccessContext): Promise<{ application: Application; version: number }> {
  const application = await loadApplicationRow(id);
  if (!application.offerId) throw new Error("This application has no approved offer to generate.");

  await assertRecruitmentTransition({ actionKey: "app_offer_generated", role: access.role, status: application.stage });
  await assertOfferWorkflowTransition({ access: { role: access.role }, action: "generate", expectedNextStatus: "offer_generated", status: "approved" });

  const version = await nextOfferLetterVersion(application.offerId);
  await generateOfferLetter(access, application.offerId, { kind: "offer_letter", version });
  await generateSalarySummary(access, application.offerId, version);

  await setOfferStatus(application.offerId, "generated", { generated_at: new Date().toISOString() });
  const updated = await commitApplicationStage({
    id,
    fromStage: application.stage,
    toStage: "offer_generated",
    actionKey: "app_offer_generated",
    actorHrId: access.hrId ?? null,
    details: { documentVersion: version },
  });
  return { application: updated, version };
}

// Step 5 — send the generated offer to the candidate (token + email + tracking).
export async function sendPreparedOffer(
  id: string,
  access: AccessContext,
  attachments?: SendPhoenixEmailAttachment[],
): Promise<{ application: Application; offerId: string }> {
  const application = await loadApplicationRow(id);
  if (!application.offerId) throw new Error("This application has no generated offer to send.");

  await assertRecruitmentTransition({ actionKey: "app_offer_sent", role: access.role, status: application.stage });

  const latestVersion = (await nextOfferLetterVersion(application.offerId)) - 1;
  await sendOffer(application.offerId, {
    access: { role: access.role },
    sentByHrId: access.hrId ?? null,
    sentVersion: latestVersion > 0 ? latestVersion : null,
    attachments,
  });

  const updated = await commitApplicationStage({
    id,
    fromStage: application.stage,
    toStage: "offer_sent",
    actionKey: "app_offer_sent",
    actorHrId: access.hrId ?? null,
    details: { offerId: application.offerId, sentVersion: latestVersion },
  });
  return { application: updated, offerId: application.offerId };
}

// Negotiation loop — re-prepare a negotiating offer back to draft for a new version.
export async function reprepareAfterNegotiation(id: string, access: AccessContext): Promise<{ application: Application; offerId: string }> {
  const application = await loadApplicationRow(id);
  if (!application.offerId) throw new Error("This application has no offer to re-prepare.");

  await assertRecruitmentTransition({ actionKey: "app_offer_prepare", role: access.role, status: application.stage });
  await assertOfferWorkflowTransition({ access: { role: access.role }, action: "renegotiate_prepare", expectedNextStatus: "offer_draft", status: "negotiation_in_progress" });

  await setOfferStatus(application.offerId, "draft");
  const updated = await commitApplicationStage({
    id,
    fromStage: application.stage,
    toStage: "offer_draft",
    actionKey: "app_offer_prepare",
    actorHrId: access.hrId ?? null,
    details: { offerId: application.offerId, renegotiation: true },
  });
  return { application: updated, offerId: application.offerId };
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
    negotiation_in_progress: "app_offer_negotiation",
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
      app_offer_negotiation: "offer_negotiation",
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

// Stage 13 (threshold) — Super Admin senior sign-off for above-band offers.
export async function approveSeniorOffer(id: string, access: AccessContext): Promise<Application> {
  if (access.role !== "Super Admin" && access.scope !== "system") {
    throw new Error("Forbidden: only Super Admin can provide senior offer sign-off.");
  }
  const application = await loadApplicationRow(id);
  await getRequisition(access, application.requisitionId);

  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("recruitment_applications")
    .update({
      senior_approval_status: "approved",
      senior_approved_by: access.hrId ?? access.loginId ?? null,
      senior_approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;

  await writeApplicationEvent({
    applicationId: id,
    fromStage: application.stage,
    toStage: application.stage,
    action: "senior_approval",
    actorHrId: access.hrId ?? null,
  });
  return mapApplication(data as ApplicationDbRow);
}

// Stage 21 — approve the accepted offer (reuses the atomic convert RPC), close
// the requisition, and auto-create the initial probation window. Probation
// creation is non-blocking: a failure never rolls back a completed hire.
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

  // Threshold gate: above-band offers need a Super Admin sign-off first (a
  // Super Admin converting directly satisfies the senior-approval requirement).
  if (application.offerId && access.role !== "Super Admin") {
    const supabaseCheck = recruitmentDb();
    const { data: offerRow } = await supabaseCheck
      .from("job_offers")
      .select("net_salary")
      .eq("id", application.offerId)
      .maybeSingle();
    const net = numberOrNull((offerRow as Record<string, unknown> | null)?.net_salary ?? null);
    if (requiresSeniorApproval(net, seniorApprovalNetThreshold()) && application.seniorApprovalStatus !== "approved") {
      throw new Error("This offer exceeds the approval threshold and requires Super Admin sign-off before hiring.");
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

  // Auto-create the initial probation window (non-blocking: a probation-create
  // failure must never roll back a completed hire — it can be created manually).
  try {
    await createInitialProbationRecord({
      employeeHrId,
      startDate: approval.offer?.startDate ?? null,
      probationMonths: approval.offer?.probationPeriodMonths ?? null,
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
  const { error } = await supabase.from("recruitment_applications").delete().eq("id", id);
  if (error) throw error;
}
