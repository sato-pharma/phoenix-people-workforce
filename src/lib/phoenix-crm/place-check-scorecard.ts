/**
 * Phoenix CRM — Place checks, one line per rep: what each one's captures came to (owner, 2026-10-17:
 * "eyeball the check places full module all tabs and tell me is this a report that really shows me
 * data? or it's a bunch of chaos"). The board drew every row and summed nothing, so a rep who sent
 * thirty photographs of a pavement read exactly like one who sent thirty clear signboards.
 *
 * Pure and screen-free, like `shared-place-groups.ts`, so the sums are pinned by a test. It is built
 * from the rows the page already holds — no read of its own.
 *
 * 🔴 EVERY PLACE IS COUNTED ONCE, IN EXACTLY ONE COLUMN, so the columns add up to `places`. A place
 * waiting for a decision is `waiting` whatever was read on it; a place in use that a person approved is
 * `confirmed`; anything else in use is judged on its OWN evidence — the timetable for a customer seated
 * in a polyclinic, the sign for everybody else (the same split `adviseOnPlaceInUse` makes). Customers
 * sent back are customers, not places, so they sit beside the sum, never inside it.
 */

import type { ReopenedCustomerRow, ValidatedPlaceRow, ValidationReviewRow } from "@/lib/phoenix-crm/view-types";

/** Where one place stands, for the scorecard. */
export type PlaceStanding = "confirmed" | "notReadable" | "wrongPhoto" | "anotherName" | "notRead" | "waiting";

export type RepScore = {
  repName: string;
  /** Places in use or waiting — the sum of the six standings. */
  places: number;
  confirmed: number;
  /** A photo the reader could not read: the sign, or the timetable, illegible. */
  notReadable: number;
  /** No sign in the photo, or no timetable — a photograph of something else. */
  wrongPhoto: number;
  /** The sign, or the timetable, read clearly and naming somebody else. */
  anotherName: number;
  /** Not read yet, could not be compared, or the reading never came back. */
  notRead: number;
  /** Held for a decision. */
  waiting: number;
  /** Customers sent back to To validate and not captured again since. Beside the sum, never in it. */
  sentBack: number;
  /** Customers seated in a polyclinic, and how many of them its timetable names. */
  seated: number;
  seatedOnTimetable: number;
};

type InUse = Pick<ValidatedPlaceRow, "placeId" | "repName" | "reviewed" | "photoKind" | "signboard" | "schedule">;
type Waiting = Pick<ValidationReviewRow, "placeId" | "repName" | "photoKind">;

/** The sign's reasons that mean "the photograph could not be read", as opposed to "there was nothing to compare". */
const SIGN_UNREADABLE = new Set(["unreadable", "unreadable_final", "unconfirmed"]);

/**
 * Whether a SIGN's reading says the photograph could not be read — the one rule the scorecard's "Not
 * readable" column and the review's Not readable tab both use, so the two can never count differently.
 * A verdict the reader reached is not unreadable, and neither is a sign it called legible or decorative
 * (2026-10-18): that is a name it could not compare, and a new photo would read the same.
 */
export function signCouldNotBeRead(sign: { verdict: string; reason?: string | null; problem?: string | null } | null | undefined): boolean {
  if (!sign) return false;
  if (sign.verdict === "match" || sign.verdict === "other_name" || sign.verdict === "no_name") return false;
  if (sign.problem === "none" || sign.problem === "stylised") return false;
  return SIGN_UNREADABLE.has(sign.reason ?? "");
}

/**
 * Whether a TIMETABLE's reading says the photograph could not be read: no verdict reached, and either
 * the reader said unreadable or the scanner held it after its tries for that reason. A photograph that
 * is not a timetable at all is the wrong photo, not an unreadable one.
 */
export function timetableCouldNotBeRead(
  timetable: { verdict?: string | null; reason?: string | null; heldBecause?: string | null; problem?: string | null } | null | undefined,
): boolean {
  if (!timetable) return false;
  if (timetable.verdict && timetable.verdict !== "unjudged") return false;
  if (timetable.problem === "not_a_timetable") return false;
  return timetable.reason === "unreadable" || timetable.heldBecause === "timetable_unreadable";
}

/** Where a place in use stands, on its own evidence. */
export function standingOfPlaceInUse(row: InUse): Exclude<PlaceStanding, "waiting"> {
  // A person looked and it is still in use: he approved it.
  if (row.reviewed) return "confirmed";
  if (row.photoKind === "schedule") {
    const schedule = row.schedule;
    if (!schedule) return "notRead";
    if (schedule.verdict === "match") return "confirmed";
    if (schedule.verdict === "other_name") return "anotherName";
    if (schedule.verdict === "no_schedule") return "wrongPhoto";
    return schedule.reason === "unreadable" ? "notReadable" : "notRead";
  }
  const sign = row.signboard;
  if (!sign) return "notRead";
  if (sign.verdict === "match") return "confirmed";
  if (sign.verdict === "other_name") return "anotherName";
  if (sign.verdict === "no_name") return "wrongPhoto";
  return signCouldNotBeRead(sign) ? "notReadable" : "notRead";
}

function blank(repName: string): RepScore {
  return {
    repName,
    places: 0,
    confirmed: 0,
    notReadable: 0,
    wrongPhoto: 0,
    anotherName: 0,
    notRead: 0,
    waiting: 0,
    sentBack: 0,
    seated: 0,
    seatedOnTimetable: 0,
  };
}

/** Every count on a line, for the total — written out so a new count cannot be left out of it silently. */
const SCORE_COUNTS = [
  "places",
  "confirmed",
  "notReadable",
  "wrongPhoto",
  "anotherName",
  "notRead",
  "waiting",
  "sentBack",
  "seated",
  "seatedOnTimetable",
] as const satisfies ReadonlyArray<Exclude<keyof RepScore, "repName">>;

/** The photographs that went wrong — what puts a rep at the top of the list. */
export function problemsOf(score: RepScore): number {
  return score.notReadable + score.wrongPhoto + score.anotherName + score.sentBack;
}

/**
 * One line per rep, worst first: the larger SHARE of a rep's captures that went wrong comes first, so a
 * rep whose every photograph failed is read before one with a few bad among many; at an equal share the
 * larger count comes first, then the name.
 */
export function placeCheckScorecard(input: {
  waiting: ReadonlyArray<Waiting>;
  inUse: ReadonlyArray<InUse>;
  reopened: ReadonlyArray<Pick<ReopenedCustomerRow, "repName">>;
}): { reps: RepScore[]; total: RepScore } {
  const byRep = new Map<string, RepScore>();
  const scoreOf = (repName: string) => {
    const existing = byRep.get(repName);
    if (existing) return existing;
    const created = blank(repName);
    byRep.set(repName, created);
    return created;
  };

  // A place with a decision open is counted there, once, even when the same place is also in use.
  const waitingPlaces = new Set<string>();
  for (const row of input.waiting) {
    if (waitingPlaces.has(row.placeId)) continue;
    waitingPlaces.add(row.placeId);
    const score = scoreOf(row.repName);
    score.places += 1;
    score.waiting += 1;
    if (row.photoKind === "schedule") score.seated += 1;
  }
  const counted = new Set<string>();
  for (const row of input.inUse) {
    if (waitingPlaces.has(row.placeId) || counted.has(row.placeId)) continue;
    counted.add(row.placeId);
    const score = scoreOf(row.repName);
    score.places += 1;
    score[standingOfPlaceInUse(row)] += 1;
    if (row.photoKind === "schedule") {
      score.seated += 1;
      if (row.schedule?.verdict === "match") score.seatedOnTimetable += 1;
    }
  }
  for (const row of input.reopened) scoreOf(row.repName).sentBack += 1;

  const reps = [...byRep.values()].sort((left, right) => {
    const leftShare = problemsOf(left) / Math.max(1, left.places + left.sentBack);
    const rightShare = problemsOf(right) / Math.max(1, right.places + right.sentBack);
    if (rightShare !== leftShare) return rightShare - leftShare;
    if (problemsOf(right) !== problemsOf(left)) return problemsOf(right) - problemsOf(left);
    return left.repName.localeCompare(right.repName);
  });

  const total = blank("Every rep");
  for (const score of reps) {
    for (const key of SCORE_COUNTS) total[key] += score[key];
  }
  return { reps, total };
}

