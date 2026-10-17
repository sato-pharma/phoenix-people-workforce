/**
 * Phoenix CRM — the system's recommendation on every place check, and why (owner, 2026-10-17: "add
 * system recommendations to approve or no on every validation", then "and the reason of system
 * recommendation").
 *
 * Pure and screen-free, so every sentence is pinned by `tests/phoenix-crm-place-check-advice.test.ts`.
 * It reads ONLY evidence the Place checks page already holds — what was read on the sign, on the
 * timetable, and what Google answered — and answers one of three things:
 *
 * - `approve` — the evidence names the customer (or the building) where the rep stood;
 * - `reject`  — the evidence says the photo is not of this customer, not a timetable, or cannot show the name;
 * - `look`    — the system has no answer it would stand behind, and says why.
 *
 * 🔴 A RECOMMENDATION, NEVER A DECISION. Nothing here approves or rejects anything: the Super Admin's
 * click is the decision, as it has been since 2026-10-03. And `refusal` — the reason a Reject opens on
 * — is set ONLY where the reading was confident (the sign or timetable read clearly and named somebody
 * else, or there is plainly no sign or timetable). A photograph the system could not read never opens a
 * Reject on a reason, so a reject is never one click away from telling a rep something the system did
 * not actually see (the rule `evidenceReason` in shared-place-customers.tsx already kept).
 *
 * 🔴 IT IS THE SUPER ADMIN'S ALONE. A district manager's board never draws it: his screen says nothing
 * about who decides, and the word "recommendation" is on the list of what it must not say (owner,
 * 2026-10-13). And it never reaches the rep (golden rule #1).
 *
 * No string here may contain "doctor", "doctors", "account" or "accounts" — the module's word sweep
 * reads this tree — and nothing names how the reading was made.
 */

import { SCHEDULE_MAX_TRIES, type ScheduleHeldBecause, type ScheduleLegibility, type ScheduleProblem } from "@/lib/phoenix-crm/schedule-rules";
import { SIGNBOARD_MAX_READ_ATTEMPTS } from "@/lib/phoenix-crm/signboard-rules";
import type { ValidationRefusalReason } from "@/lib/phoenix-crm/validation-feedback";

export type PlaceCheckAdviceKind = "approve" | "reject" | "look";

export type PlaceCheckAdvice = {
  kind: PlaceCheckAdviceKind;
  /** Why, in one or two plain sentences. */
  reason: string;
  /** What was read, verbatim and in its own script, quoted under the reason. */
  quote: string | null;
  /** The refusal reason a Reject opens on — set only where the reading was confident. */
  refusal: ValidationRefusalReason | null;
};

/** The word on the badge. */
export const PLACE_CHECK_ADVICE_LABEL: Record<PlaceCheckAdviceKind, string> = {
  approve: "Approve",
  reject: "Reject",
  look: "Check it yourself",
};

/** What was read on a sign — the same shape the clinic rows, the held rows and the buildings carry. */
export type SignEvidence = { verdict: string; reason: string | null; signText: string | null } | null;

/** What was read on a timetable for one customer. */
export type TimetableEvidence = {
  verdict: "match" | "other_name" | "no_schedule" | "unjudged";
  scheduleText: string | null;
  hoursRead: string | null;
  reason?: string | null;
  legibility?: ScheduleLegibility | null;
  problem?: ScheduleProblem | null;
  heldBecause?: ScheduleHeldBecause | null;
} | null;

function approve(reason: string, quote: string | null = null): PlaceCheckAdvice {
  return { kind: "approve", reason, quote, refusal: null };
}

function reject(reason: string, quote: string | null, refusal: ValidationRefusalReason | null): PlaceCheckAdvice {
  return { kind: "reject", reason, quote, refusal };
}

function look(reason: string, quote: string | null = null): PlaceCheckAdvice {
  return { kind: "look", reason, quote, refusal: null };
}

const NO_ANSWER = "The reading did not come back, so the system has no answer. Look at the photo yourself.";

/** What is wrong with a timetable photograph, as a clause: "it was taken too far away". */
const PROBLEM_CLAUSE: Record<ScheduleProblem, string> = {
  not_a_timetable: "it is not a timetable",
  too_far: "it was taken too far away",
  blurred: "the photo is blurred",
  glare: "a reflection covers it",
  cut_off: "part of it is cut off",
};

/**
 * The sign at a door. `subject` says what the sign must name: a single clinic's customer, or a
 * polyclinic's own building (its sign is read for the place's name, never a person's).
 */
export function adviseOnSign(sign: SignEvidence, subject: "customer" | "building" = "customer"): PlaceCheckAdvice {
  const who = subject === "building" ? "the building" : "the customer";
  if (!sign) {
    return look(
      subject === "building"
        ? "The sign on this building has not been read. Look at the photo yourself."
        : "This sign has not been read: the place was saved before signs were read at the door. Look at the photo yourself.",
    );
  }
  if (sign.verdict === "match") return approve(`The sign in the photo names ${who}.`, sign.signText);
  if (sign.verdict === "other_name") {
    return reject(
      `The sign in the photo names ${subject === "building" ? "a different place" : "somebody else"}, not ${who}.`,
      sign.signText,
      "wrong_name",
    );
  }
  if (sign.verdict === "no_name") return reject(`No sign naming ${who} is in the photo.`, sign.signText, "no_signboard");
  switch (sign.reason) {
    case "unreadable_final":
      return reject(
        `The sign was read ${SIGNBOARD_MAX_READ_ATTEMPTS} times and could not be read once, so it cannot show that this is ${who}.`,
        sign.signText,
        null,
      );
    case "unreadable":
      return look("The sign could not be read on the first try, and it is read again tonight. Look at the photo yourself.", sign.signText);
    case "unconfirmed":
      return look("Two readings of this sign disagreed, so the system will not say either way.", sign.signText);
    case "name_unusable":
      return look(`There is nothing to compare: ${who}'s name cannot be matched against a sign.`, sign.signText);
    default:
      return look(NO_ANSWER, sign.signText);
  }
}

/** The timetable inside a polyclinic, for one customer seated behind its door. */
export function adviseOnTimetable(timetable: TimetableEvidence): PlaceCheckAdvice {
  if (!timetable) return look("The timetable has not been read for this customer yet. Look at the photo yourself.");
  const read = timetable.scheduleText;
  if (timetable.verdict === "match") {
    return approve(
      timetable.hoursRead ? "The timetable names the customer, with their hours beside the name." : "The timetable names the customer.",
      timetable.hoursRead ?? read,
    );
  }
  if (timetable.verdict === "other_name") {
    return reject("The timetable was read clearly and the customer's name is not on it.", read, "schedule_other_name");
  }
  if (timetable.verdict === "no_schedule") return reject("The photo does not show a timetable.", read, "schedule_missing");

  // Unjudged. The scanner's own hold after its tries comes first: it is the strongest thing said.
  if (timetable.heldBecause === "timetable_missing") {
    return reject(`No timetable was found in ${SCHEDULE_MAX_TRIES} photos.`, read, "schedule_missing");
  }
  if (timetable.reason === "unreadable" || timetable.heldBecause === "timetable_unreadable") {
    if (timetable.problem === "not_a_timetable") return reject("The photo does not show a timetable.", read, "schedule_missing");
    const tries = timetable.heldBecause === "timetable_unreadable" ? ` after ${SCHEDULE_MAX_TRIES} photos` : "";
    // 🔴 SOMETHING WAS READ: the customer's name may be exactly the part that was not. That is a photo to
    // look at, turned and zoomed, never a rejection the system cannot stand behind.
    if (read) {
      return look(`Part of the timetable was read${tries} and the customer's name was not in that part. Turn or zoom the photo to check.`, read);
    }
    const clause = timetable.problem ? `: ${PROBLEM_CLAUSE[timetable.problem]}` : "";
    return reject(`Nothing on the timetable could be read${tries}${clause}, so it cannot show the customer's name.`, null, null);
  }
  if (timetable.reason === "held_elsewhere") return look("The timetable was not read: this customer was already held for another reason.");
  return look(NO_ANSWER, read);
}

function metres(distance: number): string {
  return distance >= 1000 ? `${(distance / 1000).toFixed(1)} km` : `${Math.round(distance)} m`;
}

/** The Google half of a held clinic, as a clause the sign's answer is joined to. */
function googleClause(reason: string | null, nearestListingMeters: number | null): string | null {
  switch (reason) {
    case "no_confident_listing":
      return "Google has no listing it is sure is this customer";
    case "lookup_failed":
      return "Google could not be asked at the time";
    case "listing_far":
    case "listing_off":
      return nearestListingMeters === null
        ? "Google's listing for this customer is far from where the rep stood"
        : `Google's listing for this customer is ${metres(nearestListingMeters)} from where the rep stood`;
    default:
      return null;
  }
}

/** A held row of the queue — a clinic Google or its sign held, or a seated customer the timetable held. */
export type HeldRowEvidence = {
  photoKind: "signboard" | "schedule";
  reason: string | null;
  signText: string | null;
  hoursRead: string | null;
  /** The nearest Google listing's distance from where the rep stood, when Google returned any. */
  nearestListingMeters: number | null;
  evidence: {
    checkReason: string | null;
    heldBecause: ScheduleHeldBecause | null;
    legibility: ScheduleLegibility | null;
    problem: ScheduleProblem | null;
    signboard: SignEvidence;
  };
};

export function adviseOnHeldRow(row: HeldRowEvidence): PlaceCheckAdvice {
  if (row.photoKind === "schedule") {
    return adviseOnTimetable({
      verdict: row.reason === "schedule_other_name" ? "other_name" : row.reason === "schedule_missing" ? "no_schedule" : "unjudged",
      scheduleText: row.signText,
      hoursRead: row.hoursRead,
      reason: row.evidence.checkReason,
      legibility: row.evidence.legibility,
      problem: row.evidence.problem,
      heldBecause: row.evidence.heldBecause,
    });
  }
  if (row.reason === "sign_other_name") return reject("The sign in the photo names somebody else, not the customer.", row.signText, "wrong_name");
  if (row.reason === "sign_no_name") return reject("No sign naming the customer is in the photo.", row.signText, "no_signboard");

  // A Google hold — or a place refused by hand from the list. The sign at the door is the stronger
  // witness: Google's pin can be years old, the sign is what the rep stood in front of today.
  const sign = adviseOnSign(row.evidence.signboard);
  const google = googleClause(row.reason, row.nearestListingMeters);
  if (!google) return sign;
  // Every clause opens on the name Google, so it is joined as written, never lower-cased.
  if (sign.kind === "approve") return approve(`The sign in the photo names the customer, although ${google}.`, sign.quote);
  if (sign.kind === "reject") return reject(`${sign.reason.replace(/\.$/, "")}, and ${google}.`, sign.quote, sign.refusal);
  return look(`${google}, and the sign gives no answer either. Look at the photo yourself.`, sign.quote);
}

/** A row of the queue as the page holds it: the nearest of Google's listings is the one the clause names. */
export function adviseOnReview(
  row: Omit<HeldRowEvidence, "nearestListingMeters"> & { listings: ReadonlyArray<{ distanceMeters: number }> },
): PlaceCheckAdvice {
  const nearest = row.listings.length === 0 ? null : Math.min(...row.listings.map((listing) => listing.distanceMeters));
  return adviseOnHeldRow({ ...row, nearestListingMeters: nearest });
}

/** A place in use that the system never held: its own sign, or — seated in a polyclinic — the timetable. */
export function adviseOnPlaceInUse(row: { photoKind: "signboard" | "schedule"; signboard: SignEvidence; schedule: TimetableEvidence }): PlaceCheckAdvice {
  return row.photoKind === "schedule" ? adviseOnTimetable(row.schedule) : adviseOnSign(row.signboard);
}

/** A polyclinic, medical centre or hospital outpatient suite: the sign on its own door. */
export function adviseOnBuilding(row: { signboard: SignEvidence }): PlaceCheckAdvice {
  return adviseOnSign(row.signboard, "building");
}
