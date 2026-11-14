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

/**
 * What was read on a sign — the same shape the clinic rows, the held rows and the buildings carry.
 * `problem` is what the reader said stops the name being read (2026-10-18); absent on older reads.
 */
export type SignEvidence = {
  verdict: string;
  reason: string | null;
  signText: string | null;
  problem?: string | null;
  /** The rep has been asked for a new photo of this sign and has not sent it yet. */
  retake?: boolean;
} | null;

/** What was read on a timetable for one customer. */
export type TimetableEvidence = {
  verdict: "match" | "other_name" | "no_schedule" | "unjudged";
  scheduleText: string | null;
  hoursRead: string | null;
  reason?: string | null;
  legibility?: ScheduleLegibility | null;
  problem?: ScheduleProblem | null;
  heldBecause?: ScheduleHeldBecause | null;
  /** The photo was uploaded from the phone on the last try, not taken live. */
  uploaded?: boolean;
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
  on_a_screen: "it was photographed off a phone or computer screen",
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
  // 🔴 A NEW PHOTO HAS ALREADY BEEN ASKED FOR (owner, 2026-10-19: 289 of the 349 Not readable places were
  // sent back and each still said "Reject"). Rejecting now would send the customer back to To validate
  // on top of the photo the rep is already retaking, so the advice is to wait for it.
  if (sign.retake) {
    return look("The rep has been asked for a new photo of this sign. Nothing needs you until it arrives.", sign.signText);
  }
  switch (sign.reason) {
    case "unreadable_final":
      // 🔴 A LEGIBLE SIGN IS NOT AN UNREADABLE PHOTO (2026-10-18). The reader said the sign reads clearly
      // ("د. محمد زكي" for محمد ذكي), that its lettering is decorative, or that it is a building's own
      // sign, and the name still did not confirm: the system has no verdict, so it is the admin's look —
      // never a Reject on a photo a new one would not change.
      if (sign.problem === "none") {
        return look(`The sign reads clearly, but the system cannot tell whether it names ${who}. Compare it with the photo yourself.`, sign.signText);
      }
      if (sign.problem === "stylised") {
        return look(`The lettering on this sign is decorative, and the system could not read the name with confidence. Compare it with ${who}'s name yourself.`, sign.signText);
      }
      if (sign.problem === "building_sign_only") {
        return look(`The photo shows the building's own sign, and the system cannot tell whether it is ${who}. Look at the photo yourself.`, sign.signText);
      }
      return reject(`The sign could not be read, so it cannot show that this is ${who}.`, sign.signText, null);
    case "unreadable":
      // 🔴 A BUILDING'S SIGN IS NEVER READ AGAIN (owner, 14 Nov 2026, "Fix all three"): the night pass reads
      // a customer's own place only, and 65 buildings had said "read again tonight" for up to a month.
      if (subject === "building") return look("The sign on this building could not be read. Look at the photo yourself.", sign.signText);
      return look("The sign could not be read on the first try, and it is read again tonight. Look at the photo yourself.", sign.signText);
    case "not_comparable":
      return look(`The sign is written in another script from ${who}'s name, so the system cannot compare them. Compare it with the photo yourself.`, sign.signText);
    case "unconfirmed":
      return look("Two readings of this sign disagreed, so the system will not say either way.", sign.signText);
    case "name_unusable":
      return look(`There is nothing to compare: ${who}'s name cannot be matched against a sign.`, sign.signText);
    default:
      return look(NO_ANSWER, sign.signText);
  }
}

/**
 * The timetable inside a polyclinic, for one customer seated behind its door.
 *
 * `buildingHasNone` is the administrator's own exception (owner, 2026-10-18: City clinic is itself the
 * polyclinic and has no timetable, so its customers are validated by him instead): no photograph can
 * name anybody there, so the system has no verdict to give and says so, rather than calling the missing
 * timetable a fault and recommending a rejection the rep would be told is about his photo.
 */
export function adviseOnTimetable(timetable: TimetableEvidence, buildingHasNone = false): PlaceCheckAdvice {
  const advice = timetableAdvice(timetable, buildingHasNone);
  // Said whatever the reading was: the stamp on an upload looks exactly like a capture's (owner, 2026-11-02).
  return timetable?.uploaded ? { ...advice, reason: `${advice.reason} This photo was uploaded from the phone, after two live photos could not be read.` } : advice;
}

function timetableAdvice(timetable: TimetableEvidence, buildingHasNone: boolean): PlaceCheckAdvice {
  if (buildingHasNone) {
    return look("This building has no timetable, so none can show this customer's name. You validate its customers yourself, as an exception.");
  }
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
  // 🔴 A screen photo is SAVED AND HELD for you, never refused (owner, 2026-10-28): some polyclinics post
  // their timetable only online, so the system cannot say it is wrong — it says what it saw and you decide.
  if (timetable.problem === "on_a_screen" || timetable.heldBecause === "timetable_on_a_screen") {
    return look(
      "The timetable was photographed on a phone or computer screen, not on the building's wall. Some polyclinics post their timetable only online: check the customer's name on the screen and decide.",
      read,
    );
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
    uploaded?: boolean;
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
      uploaded: row.evidence.uploaded,
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
