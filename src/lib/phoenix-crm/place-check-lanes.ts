/**
 * Phoenix CRM — Place checks: the two lanes a waiting decision sits in, and the ONE waiting number.
 *
 * The rebuild, 23 Nov 2026 (`docs/approvals-rebuild-2026-11.md`, Part 2). The page drew every waiting
 * place in one list under a line that said what the system recommended across all of them, and four
 * figures on it counted "waiting" four ways. Here every open decision is sorted once, and counted once.
 *
 * Pure and screen-free. The board sorts with it, the header counts with it, and the test pins both.
 *
 * 🔴 A LANE DECIDES NOTHING. "Ready" is the system saying the evidence is the kind he approves 19 times
 * in 20; the press is still his, one row or the whole lane. Only `sign-wins-rules.ts` approves by itself.
 *
 * 🔴 READY NEEDS ALL THREE: the advice is Approve, that kind of advice is confident, and Approve can be
 * pressed (a customer still short of a full name is never approved, so it is never Ready).
 *
 * 🔴 THE 30-DAY COUNT OUTRANKS THE TABLE. `confident` on an advice is where the kind stood on his first
 * 2,353 decisions. Once a kind has 20 decisions of his in the last 30 days, the page believes those: a
 * kind he now agrees with 19 times in 20 becomes Ready, and one he stopped agreeing with leaves it.
 *
 * 🔴 A BUILDING IS ONE DECISION, AND IT IS READY ONLY IF EVERYTHING OPEN IN IT IS: the building itself
 * when it is held, and every customer waiting behind it. One thing in it to look at makes it his call.
 *
 * 🔴 ONE UNIT: A DECISION. A single clinic is one. A building is one however many customers wait behind
 * it. It is `needsYouDecisionCount`'s unit, so this page, Needs You and the review button say one number.
 */

import { adviseOnBuilding, adviseOnReview, adviseOnTimetable, type PlaceCheckAdvice, type PlaceCheckAdviceKind } from "@/lib/phoenix-crm/place-check-advice";
import { AGREEMENT_READY_MIN_DECISIONS, type PlaceCheckAgreement } from "@/lib/phoenix-crm/place-check-stored-advice";
import { approvalNeedsFullName } from "@/lib/phoenix-crm/pm-name-rules";
import { venueNeedsDecision, type VenueGroup } from "@/lib/phoenix-crm/shared-place-groups";
import { WAITING_LONG_HOURS } from "@/lib/phoenix-crm/waiting-rules";

export type PlaceCheckLane = "ready" | "your_call";

export const PLACE_CHECK_LANE_LABEL: Record<PlaceCheckLane, string> = {
  ready: "Ready",
  your_call: "Your call",
};

/**
 * The page's verbs, and no others (the audit: "Refuse", "Reject", "Not validated" and "Send back" named
 * one action on four screens). Approve validates; Reject retires the place and says what is wrong with
 * the photo, which IS the ask for a new one: the rep validates again from his own list, so the page has
 * no third "New photo" action to give a second name to. A decision is taken back with the other verb,
 * "after all" (owner, 14 Nov 2026, "Approve it after all"): the button says what the row becomes.
 *
 * 🔴 EVERY BULK ACTION OF THE PAGE IS ONE OF THESE FOUR (`tests/phoenix-crm-place-check-lanes.test.ts`).
 */
export const PLACE_CHECK_VERBS = {
  approve: "Approve",
  reject: "Reject",
  approveAfterAll: "Approve after all",
  rejectAfterAll: "Reject after all",
} as const;

/**
 * The word the page used beside "Reject" for the same action, in each form a screen drew it. The wording
 * test reads every place-check screen for them. ("Refused at the door" is the system's own refusal of a
 * capture, a different thing, and is written in lower case wherever it is said.)
 */
export const PLACE_CHECK_RETIRED_VERBS = ["Refuse", "Refused", "Refusing"] as const;

/** What one open thing looks like to the sorter: the advice on it, and whether Approve can be pressed. */
export type LaneSubject = {
  advice: Pick<PlaceCheckAdvice, "kind" | "code" | "confident">;
  /** A clinic customer still short of a full name: Approve is refused for it everywhere. */
  needsFullName: boolean;
};

export type LaneReading = {
  lane: PlaceCheckLane;
  /** Why it is his call, in one sentence. Null in Ready. */
  because: string | null;
};

type ReadyKinds = Pick<PlaceCheckAgreement, "kinds"> | null;

/**
 * Whether this kind of advice is one the page may call sure. His last 30 days answer once they hold
 * enough decisions of that kind; until then the table's own `confident` stands.
 */
export function adviceIsConfidentNow(advice: Pick<PlaceCheckAdvice, "kind" | "code" | "confident">, agreement: ReadyKinds): boolean {
  const counted = agreement?.kinds.find((kind) => kind.code === advice.code && kind.advice === advice.kind);
  if (counted && counted.agreed !== null && counted.decided >= AGREEMENT_READY_MIN_DECISIONS) return counted.meetsReady;
  return advice.confident;
}

const LEAN: Record<PlaceCheckAdviceKind, string> = {
  approve: "The system leans to Approve, and this kind of evidence has not matched your answer 19 times in 20.",
  reject: "The system leans to Reject. A rejection is always your call.",
  look: "The system could not tell from the photo.",
};

export const LANE_SHORT_NAME = "The name on file is not a full name yet, so it cannot be approved.";

/** The lane of one clinic, or of one thing inside a building. */
export function laneOf(subject: LaneSubject, agreement: ReadyKinds = null): LaneReading {
  if (subject.needsFullName) return { lane: "your_call", because: LANE_SHORT_NAME };
  if (subject.advice.kind === "approve" && adviceIsConfidentNow(subject.advice, agreement)) return { lane: "ready", because: null };
  return { lane: "your_call", because: LEAN[subject.advice.kind] };
}

/** One building with something open: itself when it is held, and the customers waiting behind it. */
export type LaneBuilding = {
  /** The building's own advice when it is HELD; null when the building is in use and only customers wait. */
  building: LaneSubject | null;
  waiting: ReadonlyArray<LaneSubject>;
};

/**
 * A building's lane. Ready only when nothing open in it is his call; otherwise the first thing that is
 * says why, the building before the customers, so the sentence names what he will meet first.
 */
export function laneOfBuilding(group: LaneBuilding, agreement: ReadyKinds = null): LaneReading {
  if (group.building) {
    const own = laneOf(group.building, agreement);
    if (own.lane === "your_call") return { lane: "your_call", because: `The building: ${own.because}` };
  }
  const calls = group.waiting.map((subject) => laneOf(subject, agreement)).filter((reading) => reading.lane === "your_call");
  if (calls.length === 0) return { lane: "ready", because: null };
  const behind = group.waiting.length === 1 ? "The customer waiting in it" : `${calls.length} of the ${group.waiting.length} customers waiting in it`;
  return { lane: "your_call", because: `${behind}: ${calls[0].because}` };
}

// ── The board's own rows ────────────────────────────────────────────────────────────────────────

type ReviewRow = Parameters<typeof adviseOnReview>[0] & { listType: unknown; customerName: unknown };

/** One waiting clinic as the board holds it: the advice the row itself draws, and whether Approve is open. */
export function laneOfReviewRow(row: ReviewRow, agreement: ReadyKinds = null): LaneReading {
  return laneOf({ advice: adviseOnReview(row), needsFullName: approvalNeedsFullName(row) }, agreement);
}

/** A customer waiting behind a door with no review row to answer on: one press cannot settle him. */
export const LANE_NO_REVIEW_ROW = "A customer waiting in it has no review to answer on yet, so it is opened and decided by hand.";

/**
 * One building with something open, as the board holds it. The building's own advice counts only while
 * it is HELD; each customer waiting behind it is read against the building's one timetable, exactly as
 * his own row reads it.
 */
export function laneOfVenueGroup(group: Pick<VenueGroup, "venue" | "customers">, agreement: ReadyKinds = null): LaneReading {
  const waiting = group.customers.filter((customer) => customer.state === "waiting");
  if (waiting.some((customer) => customer.reviewId === null)) return { lane: "your_call", because: LANE_NO_REVIEW_ROW };
  return laneOfBuilding(
    {
      building: group.venue.status === "held" ? { advice: adviseOnBuilding(group.venue), needsFullName: false } : null,
      waiting: waiting.map((customer) => ({
        advice: adviseOnTimetable(customer.timetable, group.venue.timetableExempt !== null),
        needsFullName: approvalNeedsFullName(customer),
      })),
    },
    agreement,
  );
}

type WaitingClinic = ReviewRow & { waitingLong?: boolean };

/**
 * Every open decision the board holds, as the header counts it: each waiting clinic, and each building
 * with something open. The caller hands the rows BEFORE its filters, so the header's number never moves
 * with a filter and is the number Needs You shows.
 */
export function deskUnitsOf(
  input: { clinics: ReadonlyArray<WaitingClinic>; groups: ReadonlyArray<Pick<VenueGroup, "venue" | "customers">> },
  agreement: ReadyKinds = null,
): DeskUnit[] {
  const clinics = input.clinics.map<DeskUnit>((row) => ({
    kind: "clinic",
    lane: laneOfReviewRow(row, agreement).lane,
    customersBehind: 0,
    waitingLong: row.waitingLong === true,
  }));
  const buildings = input.groups.filter(venueNeedsDecision).map<DeskUnit>((group) => {
    const waiting = group.customers.filter((customer) => customer.state === "waiting");
    return {
      kind: "building",
      lane: laneOfVenueGroup(group, agreement).lane,
      customersBehind: waiting.length,
      waitingLong: group.venue.status === "held" ? group.venue.waitingLong === true : waiting.some((customer) => customer.waitingLong === true),
    };
  });
  return [...clinics, ...buildings];
}

// ── The one waiting number ──────────────────────────────────────────────────────────────────────

/** One open decision as the header counts it. */
export type DeskUnit = {
  kind: "clinic" | "building";
  lane: PlaceCheckLane;
  /** A building only: how many customers wait behind it. A held building with nobody behind it is 0. */
  customersBehind: number;
  /** It has waited `WAITING_LONG_HOURS` or more. */
  waitingLong: boolean;
};

export type PlaceCheckDesk = {
  /** Every open decision: clinics plus buildings. The page's one number. */
  decisions: number;
  clinics: number;
  buildings: number;
  /** Customers waiting behind those buildings. Named beside the number, never added to it. */
  customersBehind: number;
  ready: number;
  yourCall: number;
  /** Decisions that have waited 72 hours or more. */
  waitingLong: number;
};

export function placeCheckDesk(units: ReadonlyArray<DeskUnit>): PlaceCheckDesk {
  const desk: PlaceCheckDesk = { decisions: units.length, clinics: 0, buildings: 0, customersBehind: 0, ready: 0, yourCall: 0, waitingLong: 0 };
  for (const unit of units) {
    if (unit.kind === "clinic") desk.clinics += 1;
    else {
      desk.buildings += 1;
      desk.customersBehind += Math.max(0, Math.floor(unit.customersBehind));
    }
    if (unit.lane === "ready") desk.ready += 1;
    else desk.yourCall += 1;
    if (unit.waitingLong) desk.waitingLong += 1;
  }
  return desk;
}

const count = (total: number, one: string, many: string) => `${total} ${total === 1 ? one : many}`;

/** "34 decisions wait for you" — the headline, in the one unit. */
export function deskHeadline(desk: PlaceCheckDesk): string {
  if (desk.decisions === 0) return "Nothing waits for you";
  return `${count(desk.decisions, "decision waits", "decisions wait")} for you`;
}

/**
 * What the number is made of: "14 clinics and 20 buildings, with 31 customers waiting behind them."
 * Empty when nothing waits. A part that is zero is left out, so the sentence never says "0 buildings".
 */
export function deskMakeUp(desk: PlaceCheckDesk): string {
  if (desk.decisions === 0) return "";
  const parts = [
    desk.clinics > 0 ? count(desk.clinics, "clinic", "clinics") : null,
    desk.buildings > 0 ? count(desk.buildings, "building", "buildings") : null,
  ].filter((part): part is string => part !== null);
  const behind =
    desk.customersBehind > 0
      ? `, with ${count(desk.customersBehind, "customer", "customers")} waiting behind ${desk.buildings === 1 ? "it" : "them"}`
      : "";
  return `${parts.join(" and ")}${behind}.`;
}

/** "6 have waited over 72 hours." Empty when none has, so the line is drawn only when it says something. */
export function deskLongWait(desk: PlaceCheckDesk): string {
  if (desk.waitingLong === 0) return "";
  return `${count(desk.waitingLong, "has", "have")} waited over ${WAITING_LONG_HOURS} hours.`;
}

/**
 * Why the rows of "Your call" are his, counted: the lane's one line above its list. The commonest reason
 * first; a tie reads in the sentence's own order, so the line never shuffles between two reads.
 */
export function yourCallReasons(readings: ReadonlyArray<LaneReading>): Array<{ because: string; count: number }> {
  const counted = new Map<string, number>();
  for (const reading of readings) {
    if (reading.lane !== "your_call" || !reading.because) continue;
    counted.set(reading.because, (counted.get(reading.because) ?? 0) + 1);
  }
  return [...counted.entries()]
    .map(([because, total]) => ({ because, count: total }))
    .sort((left, right) => right.count - left.count || left.because.localeCompare(right.because));
}

// ── The Ready lane's one press ──────────────────────────────────────────────────────────────────

/** The two routes a row's own Approve already posts to. The lane's press posts to no other. */
export const READY_REVIEW_ROUTE = "/api/phoenix-crm/validation-reviews";
export const READY_BUILDING_ROUTE = "/api/phoenix-crm/validation-reviews/shared-place";

/** One request of "Approve all": a row's own approval, exactly as its own button sends it. */
export type ReadyRequest = {
  kind: "clinic" | "building" | "customer";
  /** The building it is, or stands behind; null for a clinic. A customer is left alone when his building's own approval fails. */
  building: string | null;
  name: string;
  route: string;
  body: { reviewId: string; decision: "approve"; note: "" } | { sharedPlaceId: string; decision: "approve"; note: "" };
  /** The row its own control draws, so the saved mark lands under exactly that control. */
  subject: unknown;
};

/**
 * What "Approve all" sends, in order: each ready building, then the customers waiting behind it, then the
 * ready clinics.
 *
 * 🔴 IT IS THE SAME ANSWER N TIMES, NEVER A SECOND DECISION PATH (`place-check-bulk.tsx` says why): every
 * request here is one a row's own Approve makes, so the audit rows are the same rows and the rep is told
 * what a one-row approval tells him. A building in use is not approved again: only its waiting customers are.
 */
export function readyLaneRequests(input: {
  reviews: ReadonlyArray<{ reviewId: string; customerName: string }>;
  groups: ReadonlyArray<Pick<VenueGroup, "venue" | "customers">>;
}): ReadyRequest[] {
  const requests: ReadyRequest[] = [];
  for (const group of input.groups) {
    const building = group.venue.sharedPlaceId;
    if (group.venue.status === "held") {
      requests.push({
        kind: "building",
        building,
        name: group.venue.name,
        route: READY_BUILDING_ROUTE,
        body: { sharedPlaceId: building, decision: "approve", note: "" },
        subject: group.venue,
      });
    }
    for (const customer of group.customers) {
      if (customer.state !== "waiting" || customer.reviewId === null) continue;
      requests.push({
        kind: "customer",
        building,
        name: customer.customerName,
        route: READY_REVIEW_ROUTE,
        body: { reviewId: customer.reviewId, decision: "approve", note: "" },
        subject: customer,
      });
    }
  }
  for (const row of input.reviews) {
    requests.push({
      kind: "clinic",
      building: null,
      name: row.customerName,
      route: READY_REVIEW_ROUTE,
      body: { reviewId: row.reviewId, decision: "approve", note: "" },
      subject: row,
    });
  }
  return requests;
}
