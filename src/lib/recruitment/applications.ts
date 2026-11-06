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
import { fetchAllRows } from "@/lib/supabase/paginated";
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
import { SEAT_HIRE_STAGES } from "@/lib/recruitment/seat-hire-candidates";
import {
  assertOfferAcceptedForHire,
  compareHireTermsToOffer,
  describeHireTermMismatches,
  type HireTermMismatch,
  type HiredEmployeeTerms,
} from "@/lib/recruitment/hire-offer-guard";
import { getOffer } from "@/lib/recruitment/offers";
import { listJobPostChannels } from "@/lib/recruitment/outreach/job-post-channels";
import { isValidChannelCode, normalizeChannelCode } from "@/lib/recruitment/outreach/channel-code";
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
  // The one offer action that carries no terms and no approval with it: the candidate has come
  // back asking for different numbers. Everything else in the offer chain writes to ats_offers as
  // well as the stage, so it goes through src/lib/recruitment/offers.ts instead of this map.
  app_offer_negotiation: "offer_negotiation",
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

/**
 * The applications an OPEN SEAT could be filled from — the narrow read behind the Add Employee
 * candidate picker.
 *
 * It exists because `listApplications` below loads EVERY application, every one of their
 * candidates and every requisition, and the picker then throws away all but a handful at the
 * three hireable stages. Correct, but a whole pipeline's worth of database work to fill one
 * dropdown on a form that is opened many times a day.
 *
 * VISIBILITY IS IDENTICAL, and that is the part to be careful about: the same scoped
 * `listRequisitions`, the same `canSeeApplication` against the same map. The stage filter and
 * the converted-null filter are the ONLY differences, and both narrow — this can never show a
 * viewer an application `listApplications` would have hidden. The candidate read is narrowed to
 * the columns the picker prints rather than `*`, and still batched (see db-batch.ts for why an
 * unbatched .in() eventually fails).
 */
export async function listSeatHireApplications(
  access: AccessContext,
): Promise<ApplicationWithContext[]> {
  const supabase = recruitmentDb();
  // Every matching application, paged to a short page by the unique `id`: a picker read from the
  // first response's worth would stop offering a hireable person with no sign that one is missing.
  const [data, requisitions] = await Promise.all([
    fetchAllRows<ApplicationDbRow>(
      () =>
        supabase
          .from("ats_applications")
          .select("*")
          .in("stage", [...SEAT_HIRE_STAGES])
          // Already an employee: the recruitment hub stops offering one at this point and so must
          // the picker, or the same person is hired twice into two seats.
          .is("converted_employee_hr_id", null)
          .order("created_at", { ascending: false }),
      "id",
    ),
    listRequisitions(access),
  ]);

  const requisitionsById = new Map(requisitions.map((requisition) => [requisition.id, requisition]));
  const visible = data
    .map(mapApplication)
    .filter((application) => canSeeApplication(access, application, requisitionsById));

  const candidateIds = Array.from(new Set(visible.map((application) => application.candidateId)));
  const candidatesById = new Map<string, Candidate>();
  const candidateRows = await fetchRowsInBatches<CandidateDbRow>(candidateIds, (batch) =>
    supabase.from("ats_candidates").select("*").in("id", batch),
  );
  for (const row of candidateRows) {
    const candidate = mapCandidate(row);
    candidatesById.set(candidate.id, candidate);
  }

  return visible.map((application) => ({
    ...application,
    candidate: candidatesById.get(application.candidateId) ?? null,
    managerNotified: null,
    requisition: requisitionsById.get(application.requisitionId) ?? null,
  }));
}

export async function listApplications(access: AccessContext): Promise<ApplicationWithContext[]> {
  const supabase = recruitmentDb();
  // Every application, paged to a short page by the unique `id`: this is the company-wide list, and
  // the scope check below can only hide rows it was given, never ones a response cap dropped.
  const [data, requisitions] = await Promise.all([
    fetchAllRows<ApplicationDbRow>(
      () => supabase.from("ats_applications").select("*").order("created_at", { ascending: false }),
      "id",
    ),
    listRequisitions(access),
  ]);

  const requisitionsById = new Map(requisitions.map((requisition) => [requisition.id, requisition]));
  const applications = data.map(mapApplication);
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

/**
 * Look up the employee this hire is being linked to, for the terms comparison only.
 *
 * HR ids are mixed case — 178 of 179 in production — so a plain .eq on whatever the
 * caller typed silently matches nothing, and "no employee found" would be
 * indistinguishable from "the terms are fine". Hence ilike, with LIKE metacharacters
 * escaped so an id containing one can never widen into a pattern. Anything other than
 * exactly one match returns null, which the comparison REPORTS rather than skips.
 */
async function loadHiredEmployeeTerms(employeeHrId: string): Promise<HiredEmployeeTerms | null> {
  const pattern = employeeHrId.replace(/([\\%_])/g, "\\$1");
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("employees")
    .select("hr_id,job_title,gross_salary,hire_date")
    .ilike("hr_id", pattern)
    .limit(2);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ job_title: string | null; gross_salary: number | string | null; hire_date: string | null }>;
  if (rows.length !== 1) return null;
  return {
    jobTitle: textOrNull(rows[0].job_title),
    grossSalary: numberOrNull(rows[0].gross_salary),
    hireDate: textOrNull(rows[0].hire_date),
  };
}

// Stage 21 — direct hire. The employee record is created through the normal HR
// "Add Employee" flow first (which also closes the matching position vacancy);
// this just links the application to that employee's HR_ID, closes the
// requisition, and best-effort seeds the initial probation window. Probation
// creation is non-blocking: a failure never rolls back a completed hire.
//
// Two things guard the link (hire-offer-guard.ts explains why they differ in strength):
// the offer must actually have been accepted, or the hire is refused before anything is
// written; and the approved terms are compared against the employee that was created,
// with any difference flagged — recorded on the hire's own audit event and returned to
// the caller — never rejected.
/**
 * Record which offer LETTER an application produced.
 *
 * 🔴 THE POINTER LIVES ON THE RECRUITMENT SIDE, AND THAT DIRECTION IS THE WHOLE DESIGN.
 * `src/lib/offers/types.ts` carries the owner's instruction that the offers module is deliberately
 * independent of recruitment — an offer may be issued to somebody who never entered the ATS, and
 * "the two must not be merged". So `offers` gains no candidate column and learns nothing; the
 * application points AT the offer. The arrow stays recruitment -> offers, exactly as the bridge's
 * own comment describes it.
 *
 * `ats_applications.offer_id` has existed since the table was created and NOTHING has ever written
 * it — 0 of 14 production rows on 2026-09-08, read once in `mapApplication` and set nowhere. The
 * bridge already creates the letter and hands its id back to the browser; it simply never stored
 * it, so the two halves of an offer have never been connected in the database and no screen can
 * answer "which candidate is this offer for".
 *
 * WRITTEN FOR BOTH BRANCHES OF THE BRIDGE. It reuses an existing draft as often as it creates one,
 * and an application whose letter was reused is exactly as linked as one whose letter was new —
 * storing only the created case would leave a gap that looks like "no offer yet".
 *
 * BEST-EFFORT, and never fatal. The recruiter's letter is already created and on screen by the time
 * this runs; failing their request because a pointer could not be stored would lose the letter to
 * save the bookkeeping. A missed link degrades to what the system did before this existed.
 */
export async function recordApplicationOfferLetter(applicationId: string, offerLetterId: string): Promise<void> {
  try {
    const supabase = recruitmentDb();
    const { data, error } = await supabase
      .from("ats_applications")
      .update({ offer_id: offerLetterId, updated_at: new Date().toISOString() })
      .eq("id", applicationId)
      .select("candidate_id")
      .maybeSingle();
    if (error) throw new Error(error.message);

    // AND ON THE PERSON, in the same call. `ats_candidates.offer_id` is the pointer that can answer
    // for a letter with no application behind it — most of them — so the two must not disagree about
    // the ones that do have one.
    //
    // WRITTEN OVER WHATEVER WAS THERE, unlike the merge's fill-a-blank rule. Reaching here means a
    // recruiter has just produced this letter for this person, so it IS the offer now in play; a
    // pointer left on an older letter would put that letter's first working day into a welcome
    // message. The person is read back from the row just updated rather than passed in, so the
    // pointer cannot be stamped onto somebody the application does not actually name.
    const candidateId = textOrNull((data as Record<string, unknown> | null)?.candidate_id);
    if (candidateId) {
      const { error: candidateError } = await supabase
        .from("ats_candidates")
        .update({ offer_id: offerLetterId, updated_at: new Date().toISOString() })
        .eq("id", candidateId);
      if (candidateError) throw new Error(candidateError.message);
    }
  } catch (error) {
    logError("Failed to link an offer letter to its application", {
      error,
      labels: { event: "application_offer_link_failed" },
      context: { applicationId, offerLetterId },
    });
  }
}

/**
 * Resolve a manual source-advert tag to a real channel code, or null to clear it.
 *
 * A blank clears the tag. A code is upper-cased, format-checked, and — the part that matters —
 * confirmed to name a channel that actually exists (including retired ones, which stay resolvable).
 * A typo must never be stored as if it were an advert: it would invent a row in the source-of-hire
 * report that maps to nothing. Inactive channels are allowed on purpose, because a hire can be
 * attributed to a group that has since been retired.
 */
async function resolveAttributedChannelCode(raw: string | null | undefined): Promise<string | null> {
  const code = normalizeChannelCode(raw);
  if (!code) return null;
  if (!isValidChannelCode(code)) throw new Error(`${code} is not a valid PX- advert code.`);
  const channels = await listJobPostChannels({ includeInactive: true });
  const match = channels.find((channel) => channel.code === code);
  if (!match) throw new Error(`No advertising channel has the code ${code}.`);
  return match.code;
}

/**
 * Tag (or clear) which advert this application's candidate actually came from.
 *
 * Separate from the hire itself so HR can attribute the source at any time — most hires arrive with
 * no tracked code at all (a forwarded WhatsApp CV drops the applicant's own message, which is the
 * only place the code lives), and the source is often known only later. Overrides the automatic
 * code in the source-of-hire report. Scope is enforced through the requisition, exactly as every
 * other write here is. Passing an empty code clears the tag.
 */
export async function setApplicationSourceAttribution(
  id: string,
  access: AccessContext,
  input: { channelCode: string | null },
): Promise<Application> {
  const application = await loadApplicationRow(id);
  // Scope check (throws Forbidden if the requisition is out of the caller's reach).
  await getRequisition(access, application.requisitionId);

  const code = await resolveAttributedChannelCode(input.channelCode);

  const supabase = recruitmentDb();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("ats_applications")
    .update({
      attributed_channel_code: code,
      attributed_by_hr_id: code ? (access.hrId ?? null) : null,
      attributed_at: code ? now : null,
      updated_at: now,
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;

  await writeApplicationEvent({
    applicationId: id,
    fromStage: application.stage,
    toStage: application.stage,
    action: "app_source_attributed",
    actorHrId: access.hrId ?? null,
    details: { attributedChannelCode: code },
  });

  return mapApplication(data as ApplicationDbRow);
}

export async function markApplicationHired(
  id: string,
  access: AccessContext,
  input: {
    employeeHrId: string;
    startDate?: string | null;
    probationMonths?: number | null;
    attributedChannelCode?: string | null;
  },
): Promise<{ application: Application; employeeHrId: string; termMismatches: HireTermMismatch[] }> {
  const employeeHrId = textOrNull(input.employeeHrId);
  if (!employeeHrId) throw new Error("The hired employee's HR_ID is required.");

  // Validated BEFORE the hire mutation, so a bad tag rejects the request rather than hiring the
  // person and silently dropping the attribution. Undefined leaves the tag untouched.
  const attributedChannelCode =
    input.attributedChannelCode === undefined
      ? undefined
      : await resolveAttributedChannelCode(input.attributedChannelCode);

  const application = await loadApplicationRow(id);
  const requisition = await getRequisition(access, application.requisitionId);
  if (!requisition) throw new Error("Requisition not found.");

  await assertRecruitmentTransition({
    actionKey: "app_hire",
    role: access.role,
    status: application.stage,
  });

  // Refuse BEFORE any mutation. The registry's stage list is editable at runtime and has
  // already drifted to admit offer_initiated, so the accepted offer is checked here in
  // code rather than trusted to configuration.
  const offer = await getOffer(id);
  assertOfferAcceptedForHire(offer);
  const acceptedOffer = offer!;

  const termMismatches = compareHireTermsToOffer(acceptedOffer, await loadHiredEmployeeTerms(employeeHrId));

  const supabase = recruitmentDb();
  const now = new Date().toISOString();
  const hirePatch: Record<string, unknown> = {
    stage: "hired",
    converted_employee_hr_id: employeeHrId,
    last_stage_changed_at: now,
    updated_at: now,
  };
  // Only touch the tag when the caller supplied one. `undefined` means "leave whatever is already
  // there" (a source tagged earlier survives the hire); a resolved value — including null to clear —
  // is written along with who tagged it and when.
  if (attributedChannelCode !== undefined) {
    hirePatch.attributed_channel_code = attributedChannelCode;
    hirePatch.attributed_by_hr_id = attributedChannelCode ? (access.hrId ?? null) : null;
    hirePatch.attributed_at = attributedChannelCode ? now : null;
  }
  const { data, error } = await supabase
    .from("ats_applications")
    .update(hirePatch)
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
    details: {
      employeeHrId,
      offeredJobTitle: acceptedOffer.jobTitle,
      offeredMonthlyGross: acceptedOffer.monthlyGross,
      offeredStartDate: acceptedOffer.startDate,
      attributedChannelCode: attributedChannelCode ?? null,
      termMismatches,
      termMismatchSummary: describeHireTermMismatches(termMismatches),
    },
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

  return { application: mapApplication(data as ApplicationDbRow), employeeHrId, termMismatches };
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
