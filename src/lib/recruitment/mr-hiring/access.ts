// Recruitment / Medical Rep hiring — who may see a candidate's journey, who may record each step, and
// who may see the NSM's proposed salary.
//
// THE OWNER'S DECISIONS (7 Nov 2026), on top of the email:
//   * The final decision is the HR Manager's alone — the Super Admin seat (`recruitmentManageRoles`).
//   * The NSM's proposed salary is seen by the HR Manager, Talent Acquisition (HR Resourcing) and the
//     NSM who wrote it — never the DSM, the CEO or anyone else. It is stripped on the server.
//   * HR may decide without DSM feedback any time after the DSM interview has ended; no deadline.
//
// THE TIMELINE (§10) IS FOR EVERYONE INVOLVED: the HR Manager and Talent Acquisition in full, the CEO
// to read, and a manager who is on one of the candidate's interviews, was sent the CV, or sits above
// the manager who was. Anyone else is refused — a CV is a real applicant's personal record.
//
// Pure rules first (testable), then the two that need the database.

import type { AccessContext } from "@/lib/auth/permissions";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { recruitmentManageRoles } from "@/lib/recruitment/access";
import { isCandidateWithinViewerTeam } from "@/lib/recruitment/hiring-manager-team";
import { isCandidateSentToCaller } from "@/lib/recruitment/hiring-manager-view";
import type { MrCandidateRecord } from "@/lib/recruitment/mr-hiring/facts-db";
import {
  dsmBookingAwaitingFeedback,
  latestRoundBooking,
  mrHiringStage,
  mrInterviewEnded,
  type MrBookingFact,
  type MrCandidateFacts,
  type MrRecommendationFact,
  type MrStep,
} from "@/lib/recruitment/mr-hiring/stage";
import type { MrInterviewRound, MrResultStep } from "@/lib/recruitment/mr-hiring/vocabulary";

export type MrViewer = {
  hrIdKey: string | null;
  /** The HR Manager — the Super Admin seat. Makes the final decision. */
  isHrManager: boolean;
  /** Talent Acquisition — the HR Resourcing seat. Works the CVs with the HR Manager. */
  isTalentAcquisition: boolean;
  isCeo: boolean;
  /** HR screening, the first interview, booking and the no-DSM decision: HR Manager or Talent Acquisition. */
  canWork: boolean;
  /** Opens the Medical Rep Hiring page and every journey: HR Manager, Talent Acquisition, CEO. */
  readsAll: boolean;
};

export function mrViewer(access: Pick<AccessContext, "hrId" | "role">): MrViewer {
  const isHrManager = (recruitmentManageRoles as readonly string[]).includes(access.role);
  const isTalentAcquisition = access.role === "HR Resourcing";
  const isCeo = access.role === "CEO";
  return {
    canWork: isHrManager || isTalentAcquisition,
    hrIdKey: canonicalHrIdKey(access.hrId ?? "") || null,
    isCeo,
    isHrManager,
    isTalentAcquisition,
    readsAll: isHrManager || isTalentAcquisition || isCeo,
  };
}

function sameHr(left: string | null | undefined, rightKey: string | null): boolean {
  if (!left || !rightKey) return false;
  return canonicalHrIdKey(left) === rightKey;
}

/** Whether the viewer is the lead or a panel member of this interview. */
export function isOnBooking(viewer: MrViewer, booking: Pick<MrBookingFact, "interviewerHrId" | "panelistHrIds"> | null): boolean {
  if (!booking || !viewer.hrIdKey) return false;
  return sameHr(booking.interviewerHrId, viewer.hrIdKey) || booking.panelistHrIds.some((hrId) => sameHr(hrId, viewer.hrIdKey));
}

/** Whether the viewer is the LEAD interviewer of this interview. */
export function isLeadOnBooking(viewer: MrViewer, booking: Pick<MrBookingFact, "interviewerHrId"> | null): boolean {
  return Boolean(booking && sameHr(booking.interviewerHrId, viewer.hrIdKey));
}

/** Whether the viewer may see this recommendation's proposed salary. */
export function canSeeSalary(viewer: MrViewer, recommendation: Pick<MrRecommendationFact, "byHrId">): boolean {
  return viewer.isHrManager || viewer.isTalentAcquisition || sameHr(recommendation.byHrId, viewer.hrIdKey);
}

/** The recommendations with the salary removed wherever this viewer may not see it. */
export function redactRecommendationsFor(viewer: MrViewer, recommendations: readonly MrRecommendationFact[]): MrRecommendationFact[] {
  return recommendations.map((recommendation) =>
    canSeeSalary(viewer, recommendation) ? { ...recommendation } : { ...recommendation, proposedSalary: null },
  );
}

/** The candidate's facts with the salary removed wherever this viewer may not see it. */
export function redactFactsFor(viewer: MrViewer, facts: MrCandidateFacts): MrCandidateFacts {
  return { ...facts, recommendations: redactRecommendationsFor(viewer, facts.recommendations) };
}

/** Which workflow step a result step belongs to. */
export function stageStepForResult(step: MrResultStep): MrStep {
  if (step === "hr_screening") return "screening";
  if (step === "final_decision") return "decision";
  if (step === "nsm_final" || step === "joint_final") return "final";
  return step;
}

/** The interview round a result step is recorded against, or null for screening and the decision. */
export function roundForResultStep(step: MrResultStep): MrInterviewRound | null {
  return step === "hr_screening" || step === "final_decision" ? null : step;
}

export type MrRecordCheck = { ok: true; booking: MrBookingFact | null; decidedWithoutDsm: boolean } | { ok: false; reason: string };

/**
 * Whether this viewer may record a result at this step for this candidate, now — with the plain
 * sentence that says why not. Every check is made here, before anything is written.
 */
export function mayRecordStep(
  viewer: MrViewer,
  facts: MrCandidateFacts,
  step: MrResultStep,
  options: { decidedWithoutDsm?: boolean; now?: Date } = {},
): MrRecordCheck {
  const now = options.now ?? new Date();
  const stage = mrHiringStage(facts, now);
  const target = stageStepForResult(step);

  if (!stage.open && stage.closed === "held") {
    return { ok: false, reason: "This CV did not come through a company WhatsApp, so it is held and not considered." };
  }
  if (!stage.open && stage.closed === "hired") return { ok: false, reason: "This candidate is already hired." };
  // A result is recorded at the step the candidate is on — or, to change a mind, at the step that
  // closed them (a "Keep as backup" turned into a "Pass"). Never at a step already left behind.
  const atStep = stage.open ? stage.step === target : stage.closedAt === target;
  if (!atStep) {
    return { ok: false, reason: "That step is not the one this candidate is on — refresh the page to see where they are." };
  }

  const round = roundForResultStep(step);
  if (round && stage.jointFinal !== (round === "joint_final") && (round === "nsm_final" || round === "joint_final")) {
    return { ok: false, reason: "The final interview booked for this candidate is the other kind of final." };
  }
  const booking = round ? latestRoundBooking(facts, round) : null;
  if (round) {
    if (!booking) return { ok: false, reason: "Book this interview first." };
    if (!mrInterviewEnded(booking, now)) return { ok: false, reason: "The result is recorded once the interview has ended." };
  }

  if (step === "final_decision") {
    return viewer.isHrManager
      ? { booking: null, decidedWithoutDsm: false, ok: true }
      : { ok: false, reason: "The final decision is the HR Manager's." };
  }
  if (step === "hr_screening" || step === "hr_first") {
    return viewer.canWork ? { booking, decidedWithoutDsm: false, ok: true } : { ok: false, reason: "HR records this step." };
  }
  if (step === "dsm") {
    if (options.decidedWithoutDsm) {
      if (!viewer.canWork) return { ok: false, reason: "Only HR may decide without the DSM's feedback." };
      if (!dsmBookingAwaitingFeedback(facts, now)) {
        return { ok: false, reason: "HR decides only once the DSM interview has ended with no DSM feedback." };
      }
      return { booking, decidedWithoutDsm: true, ok: true };
    }
    return isOnBooking(viewer, booking)
      ? { booking, decidedWithoutDsm: false, ok: true }
      : { ok: false, reason: "The DSM who held this interview records its feedback." };
  }
  // rsm, hr_manager, nsm_final, joint_final.
  return isOnBooking(viewer, booking) || viewer.isHrManager
    ? { booking, decidedWithoutDsm: false, ok: true }
    : { ok: false, reason: "The interviewer on this interview records its result." };
}

/** Whether this viewer may write the NSM's recommendation for this candidate, now. */
export function mayRecommend(viewer: MrViewer, facts: MrCandidateFacts, now: Date = new Date()): MrRecordCheck {
  const stage = mrHiringStage(facts, now);
  if (!stage.open || stage.step !== "recommendation") {
    return { ok: false, reason: "The recommendation is written after the final interview has passed." };
  }
  const booking = latestRoundBooking(facts, stage.jointFinal ? "joint_final" : "nsm_final");
  if (!booking) return { ok: false, reason: "Book the final interview first." };
  return isOnBooking(viewer, booking) || viewer.isHrManager
    ? { booking, decidedWithoutDsm: false, ok: true }
    : { ok: false, reason: "The NSM who held the final interview writes the recommendation." };
}

/** Whether this viewer may book interviews in this workflow — HR only. */
export function mayBookMrInterview(viewer: MrViewer): boolean {
  return viewer.canWork;
}

/** Pure half of the journey gate: the read-all seats, or someone on one of the candidate's interviews. */
export function readsJourneyWithoutLookup(viewer: MrViewer, record: Pick<MrCandidateRecord, "bookingPeople" | "sentToHrId">): boolean {
  if (viewer.readsAll) return true;
  if (!viewer.hrIdKey) return false;
  if (sameHr(record.sentToHrId, viewer.hrIdKey)) return true;
  return record.bookingPeople.some((booking) => booking.hrIds.some((hrId) => sameHr(hrId, viewer.hrIdKey)));
}

/**
 * Whether this person may read the candidate's hiring journey (§10). The CV-send and team checks reach
 * the database, so they are asked only when the pure half has not already answered.
 */
export async function mayReadMrJourney(access: AccessContext, record: MrCandidateRecord): Promise<boolean> {
  const viewer = mrViewer(access);
  if (readsJourneyWithoutLookup(viewer, record)) return true;
  if (!viewer.hrIdKey) return false;
  const candidateId = record.facts.candidateId;
  if (await isCandidateSentToCaller(access, candidateId).catch(() => false)) return true;
  return isCandidateWithinViewerTeam(access, candidateId).catch(() => false);
}
