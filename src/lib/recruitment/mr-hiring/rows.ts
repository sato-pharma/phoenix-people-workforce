// Recruitment / Medical Rep hiring — one candidate as a row on the page, the drawer and the manager
// portal, with exactly what THIS viewer may do next.
//
// PURE. Takes a loaded record, the viewer and a clock. The salary is stripped here, on the server,
// before the row is handed to any component (`redactFactsFor`) — a component never receives a number
// its viewer may not see, so there is nothing for the browser to hide.
//
// "WHAT MAY I DO" IS ASKED OF THE SAME RULES THE WRITERS ENFORCE (access.ts), so a button is offered
// only where the route will accept it. The route still checks again: the button is a convenience,
// the route is the gate.

import { offerComposerHref } from "@/lib/recruitment/workspace/links";
import type { MrCandidateRecord } from "@/lib/recruitment/mr-hiring/facts-db";
import { mayBookMrInterview, mayRecommend, mayRecordStep, redactFactsFor, type MrViewer } from "@/lib/recruitment/mr-hiring/access";
import { isCairoOrGiza } from "@/lib/recruitment/mr-hiring/inputs";
import { firstOfficialArrival } from "@/lib/recruitment/mr-hiring/official-line";
import {
  mrHiringStage,
  type MrBookingFact,
  type MrRecommendationFact,
  type MrStage,
  type MrStepResultFact,
} from "@/lib/recruitment/mr-hiring/stage";
import { MR_INTERVIEW_ROUNDS, type MrInterviewRound, type MrResultStep, type MrStep } from "@/lib/recruitment/mr-hiring/vocabulary";
import { normalizeGovernorate } from "@/lib/recruitment/candidate-region";

/** What this viewer may do to this candidate now. */
export type MrRowActions = {
  /** The step this viewer may record a result at now, or null. */
  record: MrResultStep | null;
  /** HR may decide the DSM step without the DSM's feedback (§6). */
  decideWithoutDsm: boolean;
  /** This viewer may write the NSM's recommendation (§8). */
  recommend: boolean;
  /** The interview rounds this viewer may book now. */
  book: MrInterviewRound[];
};

export type MrRow = {
  candidateId: string;
  name: string;
  area: string | null;
  governorate: string | null;
  /** Answer to §3's question, read from the governorate; null when no governorate is recorded. */
  inCairoOrGiza: boolean | null;
  /** The company WhatsApp line the CV first reached, or null when it reached none. */
  arrivedOn: string | null;
  source: string | null;
  receivedAt: string;
  stage: MrStage;
  /** The newest result recorded at any step. */
  lastResult: MrStepResultFact | null;
  /** The newest NSM recommendation, with the salary removed unless this viewer may see it. */
  recommendation: MrRecommendationFact | null;
  /** Every interview booked in the workflow, oldest first. */
  bookings: MrBookingFact[];
  offerId: string | null;
  /** The offer composer for this candidate, carrying the proposed joining date — when an offer is next. */
  offerHref: string | null;
  can: MrRowActions;
};

/** A row on the manager portal's "My Medical Rep interviews". */
export type MrInterviewRow = MrRow & {
  /** The interviews in this candidate's journey that the viewer is on, oldest first. */
  mine: MrBookingFact[];
};

/** The result step a workflow step is recorded under, or null where nothing is recorded (6 and 8). */
export function resultStepForStage(step: MrStep, jointFinal: boolean): MrResultStep | null {
  switch (step) {
    case "screening":
      return "hr_screening";
    case "hr_first":
    case "dsm":
    case "rsm":
    case "hr_manager":
      return step;
    case "final":
      return jointFinal ? "joint_final" : "nsm_final";
    case "decision":
      return "final_decision";
    default:
      return null;
  }
}

/** Why this round cannot be booked at this stage, or null when it can. */
export function mrBookingRefusal(stage: MrStage, round: MrInterviewRound): string | null {
  if (!stage.open) {
    return stage.closed === "held"
      ? "This CV did not come through a company WhatsApp, so it is held and not considered."
      : "This candidate is out of the process — nothing more to book.";
  }
  const toBook = stage.state === "to_book";
  const allowed =
    (round === "hr_first" && (stage.step === "screening" || (stage.step === "hr_first" && toBook))) ||
    (round === "dsm" && stage.step === "dsm" && toBook) ||
    // The RSM interview is "if applicable" (the Pedia line): with none booked the stage has already
    // moved past it to the 3rd interview, so it is offered there, until the 3rd interview is booked —
    // and only while it was never held (an RSM interview already evaluated is not booked again).
    (round === "rsm" && stage.step === "hr_manager" && toBook && stage.checklist.some((item) => item.step === "rsm" && item.status === "skipped")) ||
    (round === "hr_manager" && stage.step === "hr_manager" && toBook) ||
    (round === "nsm_final" && stage.step === "final" && toBook && !stage.jointFinal) ||
    // §7's "or": the joint final replaces the 3rd interview and the NSM final, so it is offered from
    // either of those steps while nothing is booked for them.
    (round === "joint_final" && toBook && (stage.step === "hr_manager" || stage.step === "final"));
  if (allowed) return null;
  if (stage.open && (stage.state === "booked" || stage.state === "awaiting_result")) {
    return "This step already has an interview — move or cancel it on the interview calendar.";
  }
  return "That interview is not the next step for this candidate — refresh the page to see where they are.";
}

function newestResult(results: readonly MrStepResultFact[]): MrStepResultFact | null {
  let best: MrStepResultFact | null = null;
  for (const row of results) if (!best || row.createdAt > best.createdAt) best = row;
  return best;
}

function newestRecommendation(rows: readonly MrRecommendationFact[]): MrRecommendationFact | null {
  let best: MrRecommendationFact | null = null;
  for (const row of rows) if (!best || row.createdAt > best.createdAt) best = row;
  return best;
}

export function buildMrRow(viewer: MrViewer, record: MrCandidateRecord, now: Date = new Date()): MrRow {
  const facts = record.facts;
  const stage = mrHiringStage(facts, now);
  const step = stage.open ? stage.step : stage.closedAt;
  const resultStep = step ? resultStepForStage(step, stage.jointFinal) : null;
  const record_ = resultStep && mayRecordStep(viewer, facts, resultStep, { now }).ok ? resultStep : null;
  const decideWithoutDsm =
    stage.open && stage.step === "dsm" && stage.hrMayDecideWithoutDsm && mayRecordStep(viewer, facts, "dsm", { decidedWithoutDsm: true, now }).ok;
  const recommend = mayRecommend(viewer, facts, now).ok;
  // The RSM interview is offered beside the 3rd interview, never ahead of it: the first round listed is
  // the one the page's button books, and the RSM's applies to the Pedia line only.
  const bookable = mayBookMrInterview(viewer) ? MR_INTERVIEW_ROUNDS.filter((round) => mrBookingRefusal(stage, round) === null) : [];
  const book = [...bookable.filter((round) => round !== "rsm"), ...bookable.filter((round) => round === "rsm")];

  // The salary leaves the server only for the HR Manager, Talent Acquisition and the NSM who wrote it.
  const visible = redactFactsFor(viewer, facts);
  const recommendation = newestRecommendation(visible.recommendations);
  const offerNext = stage.open && stage.step === "offer" && stage.action === "prepare_offer";
  const governorateKnown = Boolean(normalizeGovernorate(record.governorate));

  return {
    area: record.area,
    arrivedOn: firstOfficialArrival(record.intake)?.lineLabel ?? null,
    bookings: facts.bookings.filter((booking) => booking.round !== null).sort((left, right) => left.startsAt.localeCompare(right.startsAt)),
    can: { book, decideWithoutDsm, recommend, record: record_ },
    candidateId: facts.candidateId,
    governorate: record.governorate,
    inCairoOrGiza: governorateKnown ? isCairoOrGiza(record.governorate) : null,
    lastResult: newestResult(facts.results),
    name: record.name,
    offerHref: offerNext && viewer.canWork ? offerComposerHref(facts.candidateId, null, "medical_rep", null, recommendation?.proposedJoiningDate ?? null) : null,
    offerId: record.offerId,
    receivedAt: facts.receivedAt,
    recommendation,
    source: record.source,
    stage,
  };
}
