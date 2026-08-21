// Recruitment / ATS — the offer service.
//
// Storage and side effects for the offer chain. The chain itself is not defined here: it lives in
// workflow_registry_modules and is enforced by assertRecruitmentTransition, which also carries the
// rule that only a Super Admin may approve. Every function below moves the application's stage
// through that guard and writes the matching ats_application_events row, so the audit trail is the
// existing one and there is no second history to reconcile.
//
// ats_applications.stage is the offer's status. This table holds the terms and the trail only.

import type { AccessContext } from "@/lib/auth/permissions";
import {
  assertRecruitmentTransition,
  mapApplication,
  numberOrNull,
  recruitmentDb,
  textOrNull,
  writeApplicationEvent,
  type ApplicationDbRow,
} from "@/lib/recruitment/db";
import {
  actionForOfferResponse,
  canSendOffer,
  missingOfferTerms,
  offerSendBlockReason,
  prepareActionForStage,
  type OfferResponse,
} from "@/lib/recruitment/offer-rules";
import { getRequisition } from "@/lib/recruitment/requisitions";
import type { Application, ApplicationStage, RecruitmentActionKey } from "@/lib/recruitment/types";

export type Offer = {
  id: string;
  applicationId: string;
  jobTitle: string | null;
  monthlyGross: number | null;
  startDate: string | null;
  notes: string | null;
  createdByHrId: string | null;
  submittedForApprovalAt: string | null;
  submittedByHrId: string | null;
  approvedAt: string | null;
  approvedByHrId: string | null;
  approvalRejectedAt: string | null;
  approvalRejectionReason: string | null;
  sentAt: string | null;
  sentByHrId: string | null;
  respondedAt: string | null;
  response: OfferResponse | null;
  createdAt: string;
  updatedAt: string;
};

type OfferDbRow = {
  id: string;
  application_id: string;
  job_title: string | null;
  monthly_gross: number | string | null;
  start_date: string | null;
  notes: string | null;
  created_by_hr_id: string | null;
  submitted_for_approval_at: string | null;
  submitted_by_hr_id: string | null;
  approved_at: string | null;
  approved_by_hr_id: string | null;
  approval_rejected_at: string | null;
  approval_rejection_reason: string | null;
  sent_at: string | null;
  sent_by_hr_id: string | null;
  responded_at: string | null;
  response: string | null;
  created_at: string;
  updated_at: string;
};

export function mapOffer(row: OfferDbRow): Offer {
  return {
    id: row.id,
    applicationId: row.application_id,
    jobTitle: row.job_title,
    // numeric(12,2) arrives from PostgREST as a string. Left raw it would fail every
    // missingOfferTerms check and make a complete offer look incomplete.
    monthlyGross: numberOrNull(row.monthly_gross),
    startDate: row.start_date,
    notes: row.notes,
    createdByHrId: row.created_by_hr_id,
    submittedForApprovalAt: row.submitted_for_approval_at,
    submittedByHrId: row.submitted_by_hr_id,
    approvedAt: row.approved_at,
    approvedByHrId: row.approved_by_hr_id,
    approvalRejectedAt: row.approval_rejected_at,
    approvalRejectionReason: row.approval_rejection_reason,
    sentAt: row.sent_at,
    sentByHrId: row.sent_by_hr_id,
    respondedAt: row.responded_at,
    response: (row.response as OfferResponse | null) ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Load the application and confirm the caller may act on its requisition. Same two steps
 * runApplicationTransition takes, for the same reason: the stage guard checks the ACTION, not
 * whether this user is allowed near this requisition at all.
 */
async function loadApplicationInScope(applicationId: string, access: AccessContext): Promise<Application> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_applications")
    .select("*")
    .eq("id", applicationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Application not found.");
  const application = mapApplication(data as ApplicationDbRow);
  await getRequisition(access, application.requisitionId);
  return application;
}

export async function getOffer(applicationId: string): Promise<Offer | null> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_offers")
    .select("*")
    .eq("application_id", applicationId)
    .maybeSingle();
  if (error) throw error;
  return data ? mapOffer(data as OfferDbRow) : null;
}

async function writeOffer(applicationId: string, patch: Record<string, unknown>): Promise<Offer> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_offers")
    .upsert(
      { application_id: applicationId, ...patch, updated_at: new Date().toISOString() },
      { onConflict: "application_id" },
    )
    .select("*")
    .single();
  if (error) throw error;
  return mapOffer(data as OfferDbRow);
}

/**
 * Save the terms. From offer_initiated or offer_negotiation this also runs app_offer_prepare and
 * moves the application to offer_draft; while already in offer_draft it only updates the terms,
 * because editing a draft is not a transition.
 *
 * Re-preparing after a negotiation overwrites the figures in place. The superseded ones go into
 * the event details below, which is why this table needs no version column.
 */
export async function saveOfferDraft(
  applicationId: string,
  access: AccessContext,
  input: {
    jobTitle?: string | null;
    monthlyGross?: number | string | null;
    startDate?: string | null;
    notes?: string | null;
  },
): Promise<{ offer: Offer; stage: ApplicationStage }> {
  const application = await loadApplicationInScope(applicationId, access);
  const existing = await getOffer(applicationId);

  const prepareAction = prepareActionForStage(application.stage);
  if (prepareAction) {
    await assertRecruitmentTransition({
      actionKey: prepareAction,
      role: access.role,
      status: application.stage,
    });
  } else if (application.stage !== "offer_draft") {
    throw new Error(
      `An offer can only be prepared once the candidate is selected — this application is at ${application.stage}.`,
    );
  }

  const offer = await writeOffer(applicationId, {
    job_title: textOrNull(input.jobTitle),
    monthly_gross: numberOrNull(input.monthlyGross),
    start_date: textOrNull(input.startDate),
    notes: textOrNull(input.notes),
    created_by_hr_id: existing?.createdByHrId ?? access.hrId ?? null,
    // Editing the terms voids any previous verdict. Leaving it would show "approved" beside
    // figures nobody has looked at.
    submitted_for_approval_at: null,
    submitted_by_hr_id: null,
    approved_at: null,
    approved_by_hr_id: null,
  });

  if (!prepareAction) return { offer, stage: application.stage };

  const stage = await moveStage(applicationId, application.stage, "offer_draft", prepareAction, access, {
    details: {
      jobTitle: offer.jobTitle,
      monthlyGross: offer.monthlyGross,
      startDate: offer.startDate,
      // What the terms were before this edit — the whole reason no version column is needed.
      previousTerms: existing
        ? { jobTitle: existing.jobTitle, monthlyGross: existing.monthlyGross, startDate: existing.startDate }
        : null,
    },
  });

  return { offer, stage };
}

/** offer_draft -> offer_pending_approval. Refuses while any of the three terms is missing. */
export async function submitOfferForApproval(
  applicationId: string,
  access: AccessContext,
): Promise<{ offer: Offer; stage: ApplicationStage }> {
  const application = await loadApplicationInScope(applicationId, access);
  const offer = await getOffer(applicationId);
  if (!offer) throw new Error("There is no offer on this application yet — prepare one first.");

  const missing = missingOfferTerms(offer);
  if (missing.length > 0) {
    throw new Error(`The offer cannot go for approval yet — it is missing its ${missing.join(", ")}.`);
  }

  await assertRecruitmentTransition({
    actionKey: "app_offer_submit_approval",
    role: access.role,
    status: application.stage,
  });

  const saved = await writeOffer(applicationId, {
    submitted_for_approval_at: new Date().toISOString(),
    submitted_by_hr_id: access.hrId ?? null,
    approval_rejected_at: null,
    approval_rejection_reason: null,
  });

  const stage = await moveStage(
    applicationId,
    application.stage,
    "offer_pending_approval",
    "app_offer_submit_approval",
    access,
    { details: { jobTitle: saved.jobTitle, monthlyGross: saved.monthlyGross, startDate: saved.startDate } },
  );

  return { offer: saved, stage };
}

/**
 * Approve, or send it back to draft.
 *
 * Both actions are Super-Admin-only in the workflow registry, so a Talent Acquisition user who
 * reaches this gets the registry's own refusal. That check is deliberately not duplicated here —
 * one place decides who may approve, and it is the same place that decides it for every module.
 */
export async function decideOfferApproval(
  applicationId: string,
  access: AccessContext,
  input: { approved: boolean; reason?: string | null },
): Promise<{ offer: Offer; stage: ApplicationStage }> {
  const application = await loadApplicationInScope(applicationId, access);
  const offer = await getOffer(applicationId);
  if (!offer) throw new Error("There is no offer on this application to decide.");

  const actionKey: RecruitmentActionKey = input.approved ? "app_offer_approved" : "app_offer_approval_rejected";
  await assertRecruitmentTransition({ actionKey, role: access.role, status: application.stage });

  const now = new Date().toISOString();
  const saved = input.approved
    ? await writeOffer(applicationId, {
        approved_at: now,
        approved_by_hr_id: access.hrId ?? null,
        approval_rejected_at: null,
        approval_rejection_reason: null,
      })
    : await writeOffer(applicationId, {
        approved_at: null,
        approved_by_hr_id: null,
        approval_rejected_at: now,
        approval_rejection_reason: textOrNull(input.reason),
        // Back to a draft: it must be submitted again rather than sit in a half-approved state.
        submitted_for_approval_at: null,
        submitted_by_hr_id: null,
      });

  const stage = await moveStage(
    applicationId,
    application.stage,
    input.approved ? "offer_approved" : "offer_draft",
    actionKey,
    access,
    { reason: input.reason, details: { monthlyGross: saved.monthlyGross } },
  );

  return { offer: saved, stage };
}

/**
 * Record that the offer went to the candidate.
 *
 * The approval gate is HERE, not in the registry. The registry lists app_offer_sent as reachable
 * from offer_initiated as well as offer_generated — a path straight past approval. The owner's
 * rule is one approval before anything is sent, so an unapproved offer is refused whatever stage
 * the application happens to be in.
 *
 * Nothing is emailed. The letter goes out however letters go out today; this records that it went.
 */
export async function markOfferSent(
  applicationId: string,
  access: AccessContext,
): Promise<{ offer: Offer; stage: ApplicationStage }> {
  const application = await loadApplicationInScope(applicationId, access);
  const offer = await getOffer(applicationId);

  if (!canSendOffer(offer)) {
    throw new Error(offerSendBlockReason(offer) ?? "This offer cannot be sent yet.");
  }

  // The registry routes offer_approved -> offer_generated -> offer_sent, so an approved offer
  // cannot go straight out. offer_generated means "the letter exists", which is a step the
  // recruiter really takes but not a separate decision — so it runs here rather than as a button
  // that would generate nothing. Both transitions are guarded and both are written to the history,
  // so the trail still reads as the registry describes it.
  let currentStage: ApplicationStage = application.stage;
  if (currentStage === "offer_approved") {
    await assertRecruitmentTransition({
      actionKey: "app_offer_generated",
      role: access.role,
      status: currentStage,
    });
    currentStage = await moveStage(applicationId, currentStage, "offer_generated", "app_offer_generated", access, {
      details: { offerLetterPreparedWith: "sending the offer" },
    });
  }

  await assertRecruitmentTransition({
    actionKey: "app_offer_sent",
    role: access.role,
    status: currentStage,
  });

  const saved = await writeOffer(applicationId, {
    sent_at: new Date().toISOString(),
    sent_by_hr_id: access.hrId ?? null,
  });

  const stage = await moveStage(applicationId, currentStage, "offer_sent", "app_offer_sent", access, {
    details: { jobTitle: saved.jobTitle, monthlyGross: saved.monthlyGross, startDate: saved.startDate },
  });

  return { offer: saved, stage };
}

/** What the candidate said: accepted, declined, or the offer lapsed. */
export async function recordOfferResponse(
  applicationId: string,
  access: AccessContext,
  input: { response: OfferResponse; reason?: string | null },
): Promise<{ offer: Offer; stage: ApplicationStage }> {
  const application = await loadApplicationInScope(applicationId, access);
  const offer = await getOffer(applicationId);
  if (!offer) throw new Error("There is no offer on this application to answer.");
  if (!offer.sentAt) throw new Error("This offer has not been sent yet, so there is nothing to answer.");

  const actionKey = actionForOfferResponse(input.response);
  await assertRecruitmentTransition({
    actionKey,
    role: access.role,
    status: application.stage,
    reason: input.reason,
  });

  const saved = await writeOffer(applicationId, {
    responded_at: new Date().toISOString(),
    response: input.response,
  });

  const nextStage: ApplicationStage =
    input.response === "accepted"
      ? "offer_accepted"
      : input.response === "declined"
        ? "offer_declined"
        : "offer_expired";

  const stage = await moveStage(applicationId, application.stage, nextStage, actionKey, access, {
    reason: input.reason,
    details: { response: input.response },
  });

  return { offer: saved, stage };
}

/**
 * Move the application's stage and write the event. Private and shared, so every offer action
 * writes the same shape of history and the stage update never drifts from the audit row.
 */
async function moveStage(
  applicationId: string,
  fromStage: ApplicationStage,
  toStage: ApplicationStage,
  actionKey: RecruitmentActionKey,
  access: AccessContext,
  extra: { reason?: string | null; details?: Record<string, unknown> } = {},
): Promise<ApplicationStage> {
  const supabase = recruitmentDb();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("ats_applications")
    .update({ stage: toStage, last_stage_changed_at: now, updated_at: now })
    .eq("id", applicationId);
  if (error) throw error;

  await writeApplicationEvent({
    applicationId,
    fromStage,
    toStage,
    action: actionKey,
    actorHrId: access.hrId ?? null,
    reason: extra.reason ?? null,
    details: extra.details,
  });

  return toStage;
}
