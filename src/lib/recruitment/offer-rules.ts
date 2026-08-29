import type { ApplicationStage, RecruitmentActionKey } from "./types";

/**
 * Offer decisions, with no database behind them.
 *
 * The offer chain itself is declared in workflow_registry_modules and enforced by
 * assertRecruitmentTransition -- roles, allowed from-stages and all. What lives here is the part
 * the registry cannot express: whether the terms are complete enough to ask for approval, and
 * whether an offer is allowed to reach a candidate yet.
 *
 * That second question is the important one. The owner's rule is one approval before anything is
 * sent, and offerSendBlockReason is what delivers it. The registry USED to list app_offer_sent as
 * reachable from offer_initiated as well as offer_generated -- a shortcut straight past approval --
 * and this guard is why that was never exploitable. The entry was retired in
 * 20260829234500_retire_offer_initiated_send_shortcut.sql, so the two now agree; the guard stays
 * because the registry is runtime-editable and could gain the entry back at any time.
 */

export type OfferTerms = {
  jobTitle: string | null;
  monthlyGross: number | null;
  startDate: string | null;
};

export type OfferApprovalTrail = {
  submittedForApprovalAt: string | null;
  approvedAt: string | null;
  sentAt: string | null;
};

export const offerResponses = ["accepted", "declined", "expired"] as const;
export type OfferResponse = (typeof offerResponses)[number];

function isBlank(value: string | null | undefined): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

/**
 * What is still missing before this offer can go for approval, named in the words the recruiter
 * will read. An empty array means ready.
 *
 * All three are required rather than only the salary: the offer letter needs a title and a start
 * date, and the start date is what seeds the probation window when the hire is converted.
 */
export function missingOfferTerms(terms: OfferTerms): string[] {
  const missing: string[] = [];
  if (isBlank(terms.jobTitle)) missing.push("job title");
  if (typeof terms.monthlyGross !== "number" || !Number.isFinite(terms.monthlyGross) || terms.monthlyGross <= 0) {
    missing.push("monthly gross salary");
  }
  if (isBlank(terms.startDate)) missing.push("start date");
  return missing;
}

export function isOfferReadyToSubmit(terms: OfferTerms): boolean {
  return missingOfferTerms(terms).length === 0;
}

/**
 * Why this offer may not be sent yet, or null if it may.
 *
 * Approval is the gate, not the stage. Reading approvedAt rather than trusting the stage is what
 * made the registry's old offer_initiated -> offer_sent shortcut unreachable, and it is what keeps
 * any future re-widening of that action harmless -- the registry is editable at runtime, so it can
 * never be the thing that decides this.
 */
export function offerSendBlockReason(offer: (OfferTerms & OfferApprovalTrail) | null): string | null {
  if (!offer) return "There is no offer on this application yet — prepare one first.";
  const missing = missingOfferTerms(offer);
  if (missing.length > 0) return `The offer is missing its ${missing.join(", ")}.`;
  if (!offer.submittedForApprovalAt) return "This offer has not been submitted for approval yet.";
  if (!offer.approvedAt) return "This offer is still waiting for approval — it cannot be sent until it is approved.";
  if (offer.sentAt) return "This offer has already been sent.";
  return null;
}

export function canSendOffer(offer: (OfferTerms & OfferApprovalTrail) | null): boolean {
  return offerSendBlockReason(offer) === null;
}

/**
 * Which registry action turns the current stage into a draft. Null when the stage is already
 * offer_draft (editing the terms again is not a transition) or when the application is nowhere
 * near an offer.
 */
export function prepareActionForStage(stage: ApplicationStage): RecruitmentActionKey | null {
  if (stage === "offer_initiated" || stage === "offer_negotiation") return "app_offer_prepare";
  return null;
}

/** Stages where the offer panel has something to show or do. */
export const offerStages = [
  "offer_initiated",
  "offer_draft",
  "offer_pending_approval",
  "offer_approved",
  "offer_generated",
  "offer_sent",
  "offer_negotiation",
  "offer_accepted",
  "offer_declined",
  "offer_expired",
] as const satisfies readonly ApplicationStage[];

export function isOfferStage(stage: string): stage is (typeof offerStages)[number] {
  return (offerStages as readonly string[]).includes(stage);
}

export function actionForOfferResponse(response: OfferResponse): RecruitmentActionKey {
  if (response === "accepted") return "app_offer_accepted";
  if (response === "declined") return "app_offer_declined";
  return "app_offer_expired";
}

export function isOfferResponse(value: unknown): value is OfferResponse {
  return typeof value === "string" && (offerResponses as readonly string[]).includes(value);
}
