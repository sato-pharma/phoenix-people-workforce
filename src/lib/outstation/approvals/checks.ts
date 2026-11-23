/**
 * The checks Expense Approvals runs on a claim before it reaches the approver — one small module.
 *
 * Rebuilt 2026-11-23 (owner: "REBUILD FROM SCRATCH"). The checks it replaces read iReports360
 * positions, which stopped on 6 Nov 2026, and a territory test that fired on 56 of the 64 waiting
 * claims — so every claim read "needs a look" and the reading said nothing.
 *
 * 🔴 EACH CHECK ANSWERS pass, fail OR unknown IN ONE SENTENCE, and a claim is READY only when every
 *    check that applies to it passed. "Could not check" is never a pass: a grandfathered claim with
 *    no photo, a day before the team moved to Phoenix CRM and a source that could not be read all
 *    put the claim in "Your call" with that sentence.
 *
 * 🔴 THE SYSTEM FLAGS AND NEVER REJECTS. Nothing here moves money or changes a status; it files the
 *    claim in a lane and says why. The approver's press decides.
 *
 * What each check is built on was measured against the owner's own decisions on production that
 * day, not assumed:
 *   - Two photos taken a minute apart were approved 78% of the time against 82% with no flag at
 *     all, so "taken together" tells nothing and passes; the stay is read from the visits.
 *   - A departure photo taken after the trip ended was approved 60% of the time — a real signal.
 *   - What he rejected for, in his own words: a duplicate, no field work, a medical rep's
 *     hand-typed claim the system never priced, and a meeting cost with no invoice.
 *
 * Pure: the facts are gathered by `queue.ts` and `field-evidence.ts`; every verdict here is pinned
 * on behaviour without a database (tests/outstation-approvals-checks.test.ts).
 */

import type { CheckAnswer, CheckKey, ClaimCheck, ClaimPreCut, ClaimVerdict } from "@/lib/outstation/approvals/types";
import { isOutstationEvidenceWaivedRole, isOutstationTicketWaivedRole } from "@/lib/outstation/evidence-waiver";
import { idleDayDeductionSuggestions } from "@/lib/outstation/idle-day-deduction";

/** A departure photo farther than this from the arrival photo is not "around the destination". */
export const DEPARTURE_MAX_KM_FROM_ARRIVAL = 40;

/** A claim for a meeting or another cost is not a trip: it has no trip days, photos or route. */
const NON_TRIP_TYPES = new Set(["meeting", "other"]);

export const CHECK_LABEL: Record<CheckKey, string> = {
  amounts: "Amounts",
  arrival_photo: "Arrival photo",
  departure_photo: "Departure photo",
  duplicate: "Duplicate",
  field_work: "Field work",
  route: "Route",
  ticket: "Ticket",
};

/** The order a row prints them in. */
const DISPLAY_ORDER: CheckKey[] = ["field_work", "route", "arrival_photo", "departure_photo", "ticket", "duplicate", "amounts"];

/** The order the ONE reason of a "Your call" row is picked in: what he rejects for first. */
const REASON_ORDER: CheckKey[] = ["duplicate", "field_work", "route", "amounts", "arrival_photo", "departure_photo", "ticket"];

export type FieldWorkDay = {
  /** A visit that day was within reach of the claimed destination. */
  atDestination: boolean;
  /** Before this person's team was counted from Phoenix CRM: the old system holds the day. */
  beforePhoenix: boolean;
  date: string;
  meetings: number;
  /** At least one visit that day carried a position. */
  positioned: boolean;
  visits: number;
};

export type FieldWorkReading = {
  days: FieldWorkDay[];
  /** Trip days whose visits were all back home, on a trip far enough for that to mean something. */
  homeDays: string[];
  km: { claimed: number; farthest: number; needsLook: boolean } | null;
};

export type ClaimPhotoFacts = {
  /** The Cairo day it was taken; null when the photo carries no time. */
  capturedOn: string | null;
  hasPosition: boolean;
  onFile: boolean;
};

export type ClaimCheckFacts = {
  arrival: ClaimPhotoFacts & {
    /** An uploaded file's own day (EXIF); undefined when nobody read it, null when it had none. */
    fileTakenOn?: string | null;
    uploaded: boolean;
  };
  /** Files attached to the claim: tickets, an invoice, a receipt. */
  attachments: number;
  departure: ClaimPhotoFacts & {
    flags: string[];
    kmFromArrival: number | null;
    minutesAfterArrival: number | null;
  };
  /** Other claims that share this employee, day and destination. */
  duplicateTrips: string[];
  /** Other claims that repeat this claim's ticket, other cost or receipt. */
  duplicateTickets: string[];
  eligibilityReason: string | null;
  eligibilityStatus: string | null;
  evidenceGateStatus: string | null;
  expenseType: string;
  /** Null when Phoenix CRM could not be read — never the same as "nothing there". */
  fieldWork: FieldWorkReading | null;
  hasNoTicketFare: boolean;
  role: string | null;
  /** Today in Cairo, `YYYY-MM-DD`. */
  today: string;
  transportation: string;
  tripDates: string[];
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "24 Nov" — from the date's own text, so no timezone can move it. */
export function shortDay(iso: string | null | undefined): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  if (!match) return "an unknown day";
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1] ?? ""}`.trim();
}

function dayList(dates: ReadonlyArray<string>): string {
  const labels = dates.map(shortDay);
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function check(key: CheckKey, answer: CheckAnswer, sentence: string): ClaimCheck {
  return { answer, key, label: CHECK_LABEL[key], sentence };
}

export function isTripClaim(expenseType: string | null | undefined): boolean {
  return !NON_TRIP_TYPES.has(String(expenseType ?? "").trim().toLowerCase());
}

/** Trip days with no visit and no recorded meeting — measured days only, never a day not yet over. */
export function idleTripDates(facts: Pick<ClaimCheckFacts, "fieldWork" | "today" | "tripDates">): string[] {
  if (!facts.fieldWork) return [];
  const byDate = new Map(facts.fieldWork.days.map((day) => [day.date, day]));
  return facts.tripDates.filter((date) => {
    const day = byDate.get(date);
    if (!day || day.beforePhoenix || date >= facts.today) return false;
    return day.visits + day.meetings === 0;
  });
}

function fieldWorkCheck(facts: ClaimCheckFacts): ClaimCheck {
  const reading = facts.fieldWork;
  if (!reading) return check("field_work", "unknown", "Phoenix CRM could not be read just now, so the trip days are not checked.");
  const byDate = new Map(reading.days.map((day) => [day.date, day]));
  const total = facts.tripDates.length;
  const idle = idleTripDates(facts);
  if (idle.length > 0) {
    return check(
      "field_work",
      "fail",
      total === 1
        ? `No visit and no meeting on ${shortDay(idle[0])}.`
        : `No visit and no meeting on ${idle.length} of ${total} days: ${dayList(idle)}.`,
    );
  }
  const pending = facts.tripDates.filter((date) => date >= facts.today);
  if (pending.length > 0) {
    return check("field_work", "unknown", `The trip is not over: ${plural(pending.length, "day")} still to be worked.`);
  }
  const before = facts.tripDates.filter((date) => byDate.get(date)?.beforePhoenix);
  if (before.length > 0) {
    return check(
      "field_work",
      "unknown",
      `${plural(before.length, "day")} ${before.length === 1 ? "was" : "were"} before this team moved to Phoenix CRM, so ${before.length === 1 ? "it" : "they"} cannot be checked here.`,
    );
  }
  const visits = facts.tripDates.reduce((sum, date) => sum + (byDate.get(date)?.visits ?? 0), 0);
  const meetings = facts.tripDates.reduce((sum, date) => sum + (byDate.get(date)?.meetings ?? 0), 0);
  const work = [visits > 0 ? plural(visits, "visit") : null, meetings > 0 ? plural(meetings, "meeting") : null]
    .filter(Boolean)
    .join(" and ");
  return check("field_work", "pass", `${total === 1 ? "Worked the day" : `Worked all ${total} days`}: ${work}.`);
}

function routeCheck(facts: ClaimCheckFacts): ClaimCheck {
  const reading = facts.fieldWork;
  if (!reading) return check("route", "unknown", "Phoenix CRM could not be read just now, so the route is not checked.");
  if (reading.homeDays.length > 0) {
    return check("route", "fail", `Every visit was back home on ${plural(reading.homeDays.length, "trip day")}: ${dayList(reading.homeDays)}.`);
  }
  if (reading.km?.needsLook) {
    return check(
      "route",
      "fail",
      `${Math.round(reading.km.claimed)} km claimed, and the farthest visit is ${Math.round(reading.km.farthest)} km from home.`,
    );
  }
  const days = reading.days.filter((day) => facts.tripDates.includes(day.date));
  if (days.some((day) => day.atDestination)) return check("route", "pass", "Visits were at the claimed destination.");
  if (days.some((day) => day.positioned)) {
    return check("route", "unknown", "The visits were away from the claimed destination, and not back home either.");
  }
  return check("route", "unknown", "No visit carries a position to compare with the claimed destination.");
}

function notOwedPhoto(facts: ClaimCheckFacts, key: "arrival_photo" | "departure_photo"): ClaimCheck | null {
  if (isOutstationEvidenceWaivedRole(facts.role)) return check(key, "pass", "This role owes no trip photos.");
  if (facts.evidenceGateStatus === "grandfathered") {
    return check(key, "unknown", "Submitted before the two-photo rule, so there is no photo to check.");
  }
  return null;
}

function onTrip(day: string | null, facts: ClaimCheckFacts): boolean {
  const first = facts.tripDates[0];
  const last = facts.tripDates[facts.tripDates.length - 1];
  return Boolean(day && first && last && day >= first && day <= last);
}

function arrivalCheck(facts: ClaimCheckFacts): ClaimCheck {
  const notOwed = notOwedPhoto(facts, "arrival_photo");
  if (notOwed) return notOwed;
  const photo = facts.arrival;
  if (!photo.onFile) return check("arrival_photo", "fail", "No arrival photo.");
  if (photo.uploaded) {
    if (photo.fileTakenOn && onTrip(photo.fileTakenOn, facts)) {
      return check("arrival_photo", "pass", `Uploaded; the file says it was taken on ${shortDay(photo.fileTakenOn)}.`);
    }
    if (photo.fileTakenOn) {
      return check("arrival_photo", "fail", `Uploaded; the file says it was taken on ${shortDay(photo.fileTakenOn)}, outside the trip.`);
    }
    return check("arrival_photo", "unknown", "Uploaded, not taken with the live camera, and the file carries no time of its own.");
  }
  if (!photo.hasPosition) return check("arrival_photo", "fail", "The arrival photo holds no GPS position.");
  if (!onTrip(photo.capturedOn, facts)) {
    return check("arrival_photo", "fail", `Taken on ${shortDay(photo.capturedOn)}, outside the trip.`);
  }
  return check("arrival_photo", "pass", `Live photo with its position, taken on ${shortDay(photo.capturedOn)}.`);
}

function stayLabel(minutes: number): string {
  if (minutes < 60) return `${Math.max(0, Math.round(minutes))} min`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return hours >= 48 ? `${Math.round(hours / 24)} days` : `${hours} h`;
}

function departureCheck(facts: ClaimCheckFacts): ClaimCheck {
  const notOwed = notOwedPhoto(facts, "departure_photo");
  if (notOwed) return notOwed;
  const photo = facts.departure;
  const last = facts.tripDates[facts.tripDates.length - 1];
  if (!photo.onFile) {
    return last && last >= facts.today
      ? check("departure_photo", "unknown", "Not taken yet: the trip is not over.")
      : check("departure_photo", "fail", "No departure photo.");
  }
  if (!photo.hasPosition) return check("departure_photo", "fail", "The departure photo holds no GPS position.");
  if (photo.flags.includes("outside_trip_window")) {
    return check("departure_photo", "fail", `Taken on ${shortDay(photo.capturedOn)}, after the trip ended.`);
  }
  if (photo.kmFromArrival !== null && photo.kmFromArrival > DEPARTURE_MAX_KM_FROM_ARRIVAL) {
    return check("departure_photo", "fail", `Taken ${Math.round(photo.kmFromArrival)} km from the arrival photo.`);
  }
  if (photo.kmFromArrival === null || photo.minutesAfterArrival === null) {
    return check("departure_photo", "pass", "Live photo with its position, inside the trip.");
  }
  const km = Math.round(photo.kmFromArrival * 10) / 10;
  // Taken together tells nothing either way (78% approved against 82% with no flag), so it passes
  // and says what it is: the stay is read from the visits, not from two photos a minute apart.
  if (photo.minutesAfterArrival < 30) {
    return check("departure_photo", "pass", `Taken with the arrival photo, ${stayLabel(photo.minutesAfterArrival)} apart; the stay is read from the visits.`);
  }
  return check("departure_photo", "pass", `Taken ${km} km from the arrival photo, ${stayLabel(photo.minutesAfterArrival)} later.`);
}

/** Null for a car trip: a car owes no ticket, and a line that can only pass is noise. */
function ticketCheck(facts: ClaimCheckFacts): ClaimCheck | null {
  const transport = facts.transportation.trim().toLowerCase();
  if (transport === "car") return null;
  if (transport === "no_ticket") {
    return facts.hasNoTicketFare
      ? check("ticket", "pass", "No ticket: priced at the fixed train fare.")
      : check("ticket", "unknown", "A no-ticket trip with no fixed fare on file.");
  }
  if (facts.attachments > 0) return check("ticket", "pass", `${plural(facts.attachments, "ticket photo")} attached.`);
  if (transport === "train" || transport === "bus") {
    return isOutstationTicketWaivedRole(facts.role)
      ? check("ticket", "pass", "This role owes no ticket.")
      : check("ticket", "fail", `A ${transport} trip with no ticket attached.`);
  }
  return check("ticket", "unknown", "Other transport with nothing attached.");
}

function duplicateCheck(facts: ClaimCheckFacts): ClaimCheck {
  if (facts.duplicateTrips.length > 0) {
    return check("duplicate", "fail", `Same day and destination as ${facts.duplicateTrips.join(", ")}.`);
  }
  if (facts.duplicateTickets.length > 0) {
    return check("duplicate", "fail", `Repeats a ticket, cost or receipt of ${facts.duplicateTickets.join(", ")}.`);
  }
  return check("duplicate", "pass", "No other claim covers this trip.");
}

function amountsCheck(facts: ClaimCheckFacts): ClaimCheck {
  if (!isTripClaim(facts.expenseType)) {
    return facts.attachments > 0
      ? check("amounts", "unknown", "A meeting or other cost: the amount is the employee's, so read the invoice.")
      : check("amounts", "fail", "A meeting or other cost with no invoice or picture attached.");
  }
  if (String(facts.eligibilityStatus ?? "").trim().toLowerCase() === "eligible") {
    return check("amounts", "pass", "Priced by the system from the distance and allowance rules.");
  }
  const stored = String(facts.eligibilityReason ?? "").trim();
  return check("amounts", "unknown", stored || "The amounts were typed by the employee, not priced by the system.");
}

/** Every check that applies to this claim, in the order a row prints them. */
export function runClaimChecks(facts: ClaimCheckFacts): ClaimCheck[] {
  const checks: Array<ClaimCheck | null> = isTripClaim(facts.expenseType)
    ? [fieldWorkCheck(facts), routeCheck(facts), arrivalCheck(facts), departureCheck(facts), ticketCheck(facts), duplicateCheck(facts), amountsCheck(facts)]
    : [duplicateCheck(facts), amountsCheck(facts)];
  const present = checks.filter((entry): entry is ClaimCheck => entry !== null);
  return present.sort((left, right) => DISPLAY_ORDER.indexOf(left.key) - DISPLAY_ORDER.indexOf(right.key));
}

/** The lane and its one reason, from the checks alone. */
export function verdictFromChecks(checks: ClaimCheck[], idleDates: string[] = []): ClaimVerdict {
  const ready = checks.length > 0 && checks.every((entry) => entry.answer === "pass");
  if (ready) return { checks, idleDates, lane: "ready", reason: null };
  const pick = (answer: CheckAnswer) =>
    REASON_ORDER.map((key) => checks.find((entry) => entry.key === key && entry.answer === answer)).find(Boolean) ?? null;
  const first = pick("fail") ?? pick("unknown");
  return { checks, idleDates, lane: "your_call", reason: first ? first.sentence : "Nothing could be checked on this claim." };
}

export function judgeClaim(facts: ClaimCheckFacts): ClaimVerdict {
  return verdictFromChecks(runClaimChecks(facts), isTripClaim(facts.expenseType) ? idleTripDates(facts) : []);
}

/**
 * What Approve pays on a trip with idle days and an allowance: the owner's "Approver sees it
 * pre-cut" (2026-11-07) — the first share `idleDayDeductionSuggestions` offers, with the amount on
 * the button. Null when there is nothing to cut. "Keep full claim" stays one press away.
 */
export function claimPreCut(input: { allowance: number; idleDays: number; total: number; tripDays: number }): ClaimPreCut | null {
  const [first] = idleDayDeductionSuggestions(input);
  if (!first) return null;
  const payable = Math.round((input.total - first.deduction) * 100) / 100;
  if (!(payable >= 0) || first.deduction <= 0) return null;
  return { deduction: first.deduction, label: first.label, payable, reason: first.reason };
}
