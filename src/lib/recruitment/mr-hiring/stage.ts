// Recruitment / Medical Rep hiring — where one candidate is in the 8 November 2026 workflow.
//
// DERIVED, NEVER STORED. The step is worked out every time from what is already recorded — the
// candidate's status, the interviews booked for them (with their round), the results written at each
// step, the NSM's recommendation and the linked offer. Nothing writes a "current step" column, so the
// step can never drift from the doors that already move a candidate: the workspace's shortlist and
// reject, the offer pipeline's own outcome sync, and Mark as hired.
//
// THE ORDER IS THE EMAIL'S (docs/recruitment-mr-hiring-workflow.md):
//   1 HR screening → 2 1st interview · HR → 3 2nd interview · DSM → 4 3rd interview · HR Manager →
//   5 Final interview · NSM (or the joint HR Manager + NSM final, which replaces 4 and 5) →
//   6 NSM recommendation → 7 Final decision (the HR Manager alone) → 8 Offer.
// A "Keep as backup" or "Do not pass" at any step closes the candidate there; a CV received from
// 8 November 2026 that never reached a company WhatsApp is held (§2).
//
// PURE. Takes the facts and a clock, returns the answer — testable without a database, importable by
// the client components that render it.

import {
  MR_STEPS,
  MR_WORKFLOW_START,
  receivedOnOrAfter,
  type MrClosed,
  type MrInterviewRound,
  type MrLine,
  type MrPlatform,
  type MrRecommendation,
  type MrResult,
  type MrResultStep,
  type MrStep,
} from "@/lib/recruitment/mr-hiring/vocabulary";

export type MrBookingFact = {
  id: string;
  round: MrInterviewRound | null;
  startsAt: string;
  durationMinutes: number;
  platform: MrPlatform;
  location: string | null;
  zoomJoinUrl: string | null;
  outcome: string | null;
  interviewerHrId: string | null;
  interviewerName: string | null;
  panelistHrIds: string[];
};

export type MrStepResultFact = {
  id: string;
  step: MrResultStep;
  result: MrResult;
  rating: number | null;
  comment: string;
  decidedWithoutDsm: boolean;
  /** The 1st-interview result only: the area the candidate is applying to, as HR confirmed it. */
  confirmedArea: string | null;
  /** The 1st-interview result only: the line HR confirmed. Pedia adds the RSM interview. */
  confirmedLine: MrLine | null;
  bookingId: string | null;
  byHrId: string;
  byName: string | null;
  createdAt: string;
};

export type MrRecommendationFact = {
  id: string;
  recommendation: MrRecommendation;
  /** Null for a viewer who may not see salary — the server strips it before it leaves. */
  proposedSalary: number | null;
  proposedJoiningDate: string | null;
  note: string | null;
  bookingId: string | null;
  byHrId: string;
  byName: string | null;
  createdAt: string;
};

export type MrOfferFact = {
  id: string;
  status: "draft" | "sent" | "accepted" | "declined" | "withdrawn";
  /** YYYY-MM-DD, already converted from the offer's free-text dates; null when unreadable. */
  issuedOn: string | null;
  validUntil: string | null;
  startDate: string | null;
};

export type MrCandidateFacts = {
  candidateId: string;
  /** The normalized candidate status: new · shortlisted · backup · sent_to_manager · rejected · hired. */
  status: string;
  /** When the CV arrived — the candidate row's own `created_at`. */
  receivedAt: string;
  /** Whether any of the candidate's CVs reached one of the company WhatsApp lines. */
  onOfficialLine: boolean;
  bookings: readonly MrBookingFact[];
  results: readonly MrStepResultFact[];
  recommendations: readonly MrRecommendationFact[];
  offer: MrOfferFact | null;
};

/** What state the current step is in. */
export type MrStepState =
  | "to_record"
  | "to_book"
  | "booked"
  | "awaiting_result"
  | "awaiting_recommendation"
  | "awaiting_decision"
  | "to_prepare_offer"
  | "offer_draft"
  | "offer_sent"
  | "offer_expired"
  | "offer_accepted"
  | "offer_declined";

/** The one next thing to do, as a key the screens turn into a button. */
export type MrNextAction =
  | "record_screening"
  | "book_hr_first"
  | "record_hr_first"
  | "book_dsm"
  | "record_dsm"
  | "book_rsm"
  | "record_rsm"
  | "book_hr_manager"
  | "record_hr_manager"
  | "book_final"
  | "record_final"
  | "record_recommendation"
  | "make_decision"
  | "prepare_offer"
  | "open_offer"
  | "mark_hired";

/** Who the next action waits for. */
export type MrWaitingFor =
  | { kind: "hr" }
  | { kind: "hr_manager" }
  | { kind: "interview" }
  | { kind: "interviewer"; hrId: string | null; name: string | null }
  | { kind: "candidate" }
  | { kind: "nobody" };

/** One step in the drawer's checklist. */
export type MrChecklistItem = {
  step: MrStep;
  status: "done" | "current" | "skipped" | "upcoming" | "closed_here";
  /** The latest result recorded at this step, when one was. */
  result: MrStepResultFact | null;
  /** The interview behind this step, when one was booked. */
  booking: MrBookingFact | null;
};

export type MrStage =
  | {
      open: true;
      step: MrStep;
      state: MrStepState;
      action: MrNextAction | null;
      waitingFor: MrWaitingFor;
      /** The interview the current step is about, when there is one. */
      booking: MrBookingFact | null;
      /** True when the DSM interview has ended with no DSM feedback — HR may then decide (§6). */
      hrMayDecideWithoutDsm: boolean;
      /** The final round is the joint HR Manager + NSM final, so step 4 is skipped. */
      jointFinal: boolean;
      checklist: MrChecklistItem[];
    }
  | {
      open: false;
      closed: MrClosed;
      /** The step it closed at; null when it was held, or closed by its status alone. */
      closedAt: MrStep | null;
      jointFinal: boolean;
      checklist: MrChecklistItem[];
    };

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function newest<T extends { createdAt: string }>(rows: readonly T[]): T | null {
  let best: T | null = null;
  for (const row of rows) {
    if (!best || row.createdAt > best.createdAt || (row.createdAt === best.createdAt && compareIds(row, best) > 0)) best = row;
  }
  return best;
}

function compareIds(left: unknown, right: unknown): number {
  const a = String((left as { id?: unknown }).id ?? "");
  const b = String((right as { id?: unknown }).id ?? "");
  return a.localeCompare(b, "en", { numeric: true });
}

/** The latest booking of the given rounds — the one that counts if a round was rebooked. */
function latestBooking(bookings: readonly MrBookingFact[], rounds: readonly MrInterviewRound[]): MrBookingFact | null {
  let best: MrBookingFact | null = null;
  for (const booking of bookings) {
    if (!booking.round || !rounds.includes(booking.round)) continue;
    if (!best || booking.startsAt > best.startsAt) best = booking;
  }
  return best;
}

function latestResult(results: readonly MrStepResultFact[], steps: readonly MrResultStep[]): MrStepResultFact | null {
  return newest(results.filter((row) => steps.includes(row.step)));
}

/** The line HR confirmed at the newest 1st-interview result, or null when none was confirmed. */
export function mrConfirmedLine(facts: Pick<MrCandidateFacts, "results">): MrLine | null {
  return latestResult(facts.results, ["hr_first"])?.confirmedLine ?? null;
}

/** The area HR confirmed at the newest 1st-interview result, or null when none was confirmed. */
export function mrConfirmedArea(facts: Pick<MrCandidateFacts, "results">): string | null {
  return latestResult(facts.results, ["hr_first"])?.confirmedArea?.trim() || null;
}

/**
 * Whether this candidate has the RSM interview: HR confirmed the Pedia line at the 1st interview
 * (owner, 7 Nov 2026 — "by default, it is not appearing"). An RSM interview already booked or
 * evaluated keeps its step, so nothing that happened ever disappears from the journey.
 */
export function mrRsmApplies(facts: Pick<MrCandidateFacts, "results" | "bookings">): boolean {
  if (mrConfirmedLine(facts) === "pedia") return true;
  return facts.bookings.some((booking) => booking.round === "rsm") || facts.results.some((row) => row.step === "rsm");
}

/**
 * The interview HR may still change — the one the candidate's current step is booked on and that has
 * no result yet (owner, 7 Nov 2026: "make me able to change this time"). Still to come, or its time
 * passed with nothing recorded — a phone call nobody answered is moved, not failed. Null for any
 * other id, a step whose result is in, or a step with nothing booked.
 */
export function mrReschedulableBooking(stage: MrStage, bookingId?: string): (MrBookingFact & { round: MrInterviewRound }) | null {
  if (!stage.open || (stage.state !== "booked" && stage.state !== "awaiting_result") || !stage.booking || !stage.booking.round) return null;
  if (bookingId !== undefined && stage.booking.id !== bookingId) return null;
  return stage.booking as MrBookingFact & { round: MrInterviewRound };
}

/** Whether an interview's time is over. */
export function mrInterviewEnded(booking: Pick<MrBookingFact, "startsAt" | "durationMinutes">, now: Date): boolean {
  const start = new Date(booking.startsAt).getTime();
  if (!Number.isFinite(start)) return false;
  return start + Math.max(0, booking.durationMinutes) * 60_000 <= now.getTime();
}

/** Cairo calendar day of an instant, YYYY-MM-DD. */
function cairoDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", timeZone: "Africa/Cairo", year: "numeric" }).format(now);
}

/**
 * Whether a CV is held for not reaching a company WhatsApp (§2): received on or after the start, and
 * never delivered to either official line. A CV from before the start is never held.
 */
export function isHeldOffChannel(facts: Pick<MrCandidateFacts, "receivedAt" | "onOfficialLine">): boolean {
  if (facts.onOfficialLine) return false;
  return receivedOnOrAfter(facts.receivedAt, MR_WORKFLOW_START);
}

type InterviewStepSpec = {
  step: "hr_first" | "dsm" | "rsm" | "hr_manager" | "final";
  rounds: readonly MrInterviewRound[];
  book: MrNextAction;
  record: MrNextAction;
};

const INTERVIEW_STEPS: readonly InterviewStepSpec[] = [
  { book: "book_hr_first", record: "record_hr_first", rounds: ["hr_first"], step: "hr_first" },
  { book: "book_dsm", record: "record_dsm", rounds: ["dsm"], step: "dsm" },
  { book: "book_rsm", record: "record_rsm", rounds: ["rsm"], step: "rsm" },
  { book: "book_hr_manager", record: "record_hr_manager", rounds: ["hr_manager"], step: "hr_manager" },
  { book: "book_final", record: "record_final", rounds: ["nsm_final", "joint_final"], step: "final" },
];

/**
 * Where the candidate is. `now` is passed in so the answer is testable and the same instant is used
 * for every candidate on one page.
 */
export function mrHiringStage(facts: MrCandidateFacts, now: Date = new Date()): MrStage {
  const status = facts.status;
  const jointBooking = latestBooking(facts.bookings, ["joint_final"]);
  const jointResult = latestResult(facts.results, ["joint_final"]);
  const finalBooking = latestBooking(facts.bookings, ["nsm_final", "joint_final"]);
  const finalResult = latestResult(facts.results, ["nsm_final", "joint_final"]);
  // The joint final replaces the 3rd interview AND the NSM final — §7's "or". Which one was chosen is
  // read off whichever of the two final rounds is the latest booked (or, with none booked, recorded).
  const jointFinal = finalBooking
    ? finalBooking.round === "joint_final"
    : Boolean(jointResult && (!finalResult || finalResult.step === "joint_final")) || Boolean(jointBooking);

  const checklist: MrChecklistItem[] = MR_STEPS.map((step) => ({ booking: null, result: null, status: "upcoming", step }));
  const item = (step: MrStep) => checklist[MR_STEPS.indexOf(step)];
  // The RSM interview is the Pedia line's alone — decided up front, so a candidate who is not on it
  // never shows the step, not even as "upcoming" while the earlier steps run.
  const rsmApplies = mrRsmApplies(facts);
  if (!rsmApplies) item("rsm").status = "skipped";
  const mark = (step: MrStep, status: MrChecklistItem["status"], result: MrStepResultFact | null = null, booking: MrBookingFact | null = null) => {
    const entry = item(step);
    entry.status = status;
    entry.result = result;
    entry.booking = booking;
  };
  const closeAt = (closed: MrClosed, step: MrStep | null): MrStage => {
    if (step) item(step).status = "closed_here";
    return { checklist, closed, closedAt: step, jointFinal, open: false };
  };
  const openAt = (
    step: MrStep,
    state: MrStepState,
    action: MrNextAction | null,
    waitingFor: MrWaitingFor,
    booking: MrBookingFact | null = null,
    hrMayDecideWithoutDsm = false,
  ): MrStage => {
    const entry = item(step);
    entry.status = "current";
    entry.booking = booking ?? entry.booking;
    // A candidate the workspace put in back-up, with nothing in progress, reads as kept as backup —
    // the status was a person's decision and the workflow has nothing pending that contradicts it.
    if (status === "backup" && (state === "to_book" || state === "to_record")) {
      entry.status = "closed_here";
      return { checklist, closed: "backup", closedAt: step, jointFinal, open: false };
    }
    return { action, booking, checklist, hrMayDecideWithoutDsm, jointFinal, open: true, state, step, waitingFor };
  };

  // A hire is final whatever else the record holds, and a rejection made anywhere (the workspace's own
  // reject included) closes the candidate — re-opening one changes the status, and this follows it.
  if (status === "hired") return closeAt("hired", null);

  // §2 — a CV that never reached a company WhatsApp is not considered.
  if (isHeldOffChannel(facts)) return closeAt("held", null);

  const closedByResult = (result: MrStepResultFact | null, step: MrStep): MrStage | null => {
    if (!result) return null;
    if (result.result === "backup") return closeAt("backup", step);
    if (result.result === "not_pass") return closeAt("rejected", step);
    return null;
  };

  // 1 — HR screening. Booking the first interview IS passing screening when nobody wrote it down
  // separately; the checklist then shows the step done with no result line rather than an invented one.
  const screening = latestResult(facts.results, ["hr_screening"]);
  const anyRoundBooked = facts.bookings.some((booking) => booking.round !== null);
  if (screening) {
    mark("screening", "done", screening);
    const closed = closedByResult(screening, "screening");
    if (closed) return closed;
  } else if (anyRoundBooked || facts.results.some((row) => row.step !== "hr_screening")) {
    mark("screening", "done");
  } else {
    if (status === "rejected") return closeAt("rejected", "screening");
    return openAt("screening", "to_record", "record_screening", { kind: "hr" });
  }

  // 2 to 5 — the interviews.
  for (const spec of INTERVIEW_STEPS) {
    if (spec.step === "hr_manager" && jointFinal) {
      mark("hr_manager", "skipped");
      continue;
    }
    const rounds = spec.step === "final" ? (jointFinal ? (["joint_final"] as const) : (["nsm_final"] as const)) : spec.rounds;
    const booking = latestBooking(facts.bookings, rounds);
    const result = latestResult(facts.results, rounds as readonly MrResultStep[]);
    // The RSM interview is "if applicable" (the Pedia line, as HR confirmed it at the 1st interview):
    // off the Pedia line the candidate goes straight on to the 3rd interview. On it, the RSM interview
    // is booked and evaluated like every other round, and the 3rd interview waits for it.
    if (spec.step === "rsm" && !rsmApplies) continue;
    if (result) {
      mark(spec.step, "done", result, booking);
      const closed = closedByResult(result, spec.step);
      if (closed) return closed;
      continue;
    }
    if (status === "rejected") return closeAt("rejected", spec.step);
    if (!booking) return openAt(spec.step, "to_book", spec.book, { kind: "hr" });
    if (!mrInterviewEnded(booking, now)) return openAt(spec.step, "booked", null, { kind: "interview" }, booking);
    const waitingFor: MrWaitingFor =
      spec.step === "hr_first"
        ? { kind: "hr" }
        : spec.step === "hr_manager"
          ? { kind: "hr_manager" }
          : { hrId: booking.interviewerHrId, kind: "interviewer", name: booking.interviewerName };
    return openAt(spec.step, "awaiting_result", spec.record, waitingFor, booking, spec.step === "dsm");
  }

  // 6 — the NSM's recommendation (§8). Needed after the final whichever kind of final it was.
  const recommendation = newest(facts.recommendations);
  if (!recommendation) {
    if (status === "rejected") return closeAt("rejected", "recommendation");
    return openAt(
      "recommendation",
      "awaiting_recommendation",
      "record_recommendation",
      { hrId: finalBooking?.interviewerHrId ?? null, kind: "interviewer", name: finalBooking?.interviewerName ?? null },
      finalBooking,
    );
  }
  mark("recommendation", "done");

  // 7 — the HR Manager's final decision (§9). A "keep as backup" recommendation still comes here:
  // the email gives the decision to the HR Manager, not to the recommendation.
  const decision = latestResult(facts.results, ["final_decision"]);
  if (!decision) {
    if (status === "rejected") return closeAt("rejected", "decision");
    return openAt("decision", "awaiting_decision", "make_decision", { kind: "hr_manager" });
  }
  mark("decision", "done", decision);
  const closedByDecision = closedByResult(decision, "decision");
  if (closedByDecision) return closedByDecision;

  // 8 — the offer.
  const offer = facts.offer;
  if (status === "rejected") return closeAt("rejected", "offer");
  if (!offer || offer.status === "withdrawn") return openAt("offer", "to_prepare_offer", "prepare_offer", { kind: "hr" });
  if (offer.status === "draft") return openAt("offer", "offer_draft", "open_offer", { kind: "hr" });
  if (offer.status === "accepted") return openAt("offer", "offer_accepted", "mark_hired", { kind: "hr" });
  if (offer.status === "declined") return openAt("offer", "offer_declined", "open_offer", { kind: "hr" });
  // Sent. Expired is SHOWN only — nothing changes the offer's own status here.
  if (offer.validUntil && DAY_KEY.test(offer.validUntil) && offer.validUntil < cairoDay(now)) {
    return openAt("offer", "offer_expired", "open_offer", { kind: "hr" });
  }
  return openAt("offer", "offer_sent", "open_offer", { kind: "candidate" });
}

/** The DSM interview that HR may decide on without feedback — ended, and the DSM recorded nothing. */
export function dsmBookingAwaitingFeedback(facts: Pick<MrCandidateFacts, "bookings" | "results">, now: Date): MrBookingFact | null {
  const booking = latestBooking(facts.bookings, ["dsm"]);
  if (!booking || !mrInterviewEnded(booking, now)) return null;
  if (latestResult(facts.results, ["dsm"])) return null;
  return booking;
}

/** The latest booking of one round, for the writers that need "the" DSM or final interview. */
export function latestRoundBooking(facts: Pick<MrCandidateFacts, "bookings">, round: MrInterviewRound): MrBookingFact | null {
  return latestBooking(facts.bookings, [round]);
}

/** How many candidates sit at each step, and in each closed pile — for a strip of counts. */
export function mrStageCounts(stages: readonly MrStage[]): Record<MrStep | MrClosed, number> {
  const counts = Object.fromEntries([...MR_STEPS, "hired", "backup", "rejected", "held"].map((key) => [key, 0])) as Record<
    MrStep | MrClosed,
    number
  >;
  for (const stage of stages) {
    if (stage.open) counts[stage.step] += 1;
    else counts[stage.closed] += 1;
  }
  return counts;
}
