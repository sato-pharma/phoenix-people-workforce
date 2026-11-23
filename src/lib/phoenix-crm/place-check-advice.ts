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
 * 🔴 A RECOMMENDATION, NEVER A DECISION — with ONE exception the owner chose on 23 Nov 2026 ("Yes, the
 * sign wins"): a place only the Google check held, whose sign names the customer, is approved by the
 * system (`sign-wins-rules.ts`). Everything else here approves and rejects nothing: the Super Admin's
 * click is the decision, as it has been since 2026-10-03.
 *
 * 🔴 THE TABLE IS HIS OWN 2,353 DECISIONS, READ ON PRODUCTION ON 23 NOV 2026 (the rebuild; the account
 * is `docs/approvals-rebuild-2026-11-place-checks.md`). The advice used to say Reject, with the reason
 * filled in, on evidence he mostly approved: a sign naming somebody else (he approved 135 of 182 the
 * door held for it, and 46 of 49 Google held), a photo with no sign naming the customer (21 of 34), a
 * sign nobody could read (most of them), a timetable read without his customer's name on it (10 of 16).
 * A building whose sign names another place read the same way: he approved 20 of 33. Each of those now
 * says "Check it yourself" and opens Reject on no reason. `refusal` — the reason a Reject opens on — is
 * set ONLY where he rejected almost every time: a photo with no sign in it at all (20 of 21), a building
 * with no sign naming it (15 of 15) and a photo that is not a timetable (57 of 68).
 *
 * `confident` is narrower still: the kinds the page may call ready, or sure, because he agreed at least
 * 19 times in 20. A sign naming the customer is one (117 of 117 where only Google held the place, and
 * none of the 167 the system approved at the door was rejected afterwards). 🔴 A timetable naming the
 * customer is NOT (he approved 116 of 143), nor is a building whose sign names it (100 of 120): the
 * advice still says Approve, and the page does not call it ready. The 30-day meter is what may promote
 * a kind; nobody promotes one by hand without its number.
 *
 * `code` names the kind of advice, never its wording, so the decision can keep it
 * (`system_advice_code_at_decision`) and the page can say, kind by kind, how often he agreed.
 *
 * 🔴 IT IS THE SUPER ADMIN'S ALONE. A district manager's board never draws it: his screen says nothing
 * about who decides, and the word "recommendation" is on the list of what it must not say (owner,
 * 2026-10-13). And it never reaches the rep (golden rule #1).
 *
 * No string here may contain "doctor", "doctors", "account" or "accounts" — the module's word sweep
 * reads this tree — and nothing names how the reading was made.
 */

import { SCHEDULE_MAX_TRIES, type ScheduleHeldBecause, type ScheduleLegibility, type ScheduleProblem } from "@/lib/phoenix-crm/schedule-rules";
import { approve, BUILDING_PREFIX, GOOGLE_PREFIX, look, NO_ANSWER, type PlaceCheckAdvice, PROBLEM_CLAUSE, reject, type SignEvidence, type TimetableEvidence } from "@/lib/phoenix-crm/place-check-advice-kinds";

// The kinds, their labels and the evidence each adviser reads live in `place-check-advice-kinds.ts` since
// the split of 23 Nov 2026 (no file of Place checks over 400 lines); every caller still imports them here.
export { type PlaceCheckAdviceKind, type PlaceCheckAdvice, PLACE_CHECK_ADVICE_LABEL, type SignEvidence, type TimetableEvidence, PLACE_CHECK_ADVICE_KIND_CODES, placeCheckAdviceKindLabel } from "@/lib/phoenix-crm/place-check-advice-kinds";

/**
 * The sign at a door. `subject` says what the sign must name: a single clinic's customer, or a
 * polyclinic's own building (its sign is read for the place's name, never a person's).
 */
export function adviseOnSign(sign: SignEvidence, subject: "customer" | "building" = "customer"): PlaceCheckAdvice {
  const advice = signAdvice(sign, subject);
  // A building's sign answers another question (the place's own name), so its kinds are counted apart.
  return subject === "building" ? { ...advice, code: `${BUILDING_PREFIX}${advice.code}` } : advice;
}

function signAdvice(sign: SignEvidence, subject: "customer" | "building"): PlaceCheckAdvice {
  const who = subject === "building" ? "the building" : "the customer";
  if (!sign) {
    return look(
      "sign_unread",
      subject === "building"
        ? "The sign on this building has not been read. Look at the photo yourself."
        : "This sign has not been read: the place was saved before signs were read at the door. Look at the photo yourself.",
    );
  }
  // A building he approved 100 times in 120 on this reading is not one the page may call ready.
  if (sign.verdict === "match") return approve("sign_match", `The sign in the photo names ${who}.`, sign.signText, subject === "customer");
  if (sign.verdict === "other_name") {
    // 🔴 HE APPROVED MOST OF THESE (23 Nov 2026): the practice under its own name, a relative's plate, the
    // centre the customer works in; a building under the name people call it (20 of 33). The system says
    // what it read and leaves the answer to him.
    if (subject === "building") return look("sign_other_name", "The sign in the photo names a different place, not the building. Compare the two names yourself.", sign.signText);
    return look("sign_other_name", "The sign in the photo names somebody else, not the customer. Compare the two names yourself.", sign.signText);
  }
  if (sign.verdict === "no_name") {
    // A building with no sign naming it: he rejected all 15.
    if (subject === "building") return reject("sign_no_name", "No sign naming the building is in the photo.", sign.signText, "no_signboard", true);
    // A photo with no sign in it at all is the one kind he rejected almost every time (20 of 21).
    if (sign.problem === "no_plate") {
      return reject("sign_no_plate", "The photo shows no sign at all: a street, a wall or a bare door.", sign.signText, "no_signboard", true);
    }
    return look("sign_no_name", "No sign naming the customer was found in the photo. Look at the photo yourself.", sign.signText);
  }
  // 🔴 A NEW PHOTO HAS ALREADY BEEN ASKED FOR (owner, 2026-10-19: 289 of the 349 Not readable places were
  // sent back and each still said "Reject"). Rejecting now would send the customer back to To validate
  // on top of the photo the rep is already retaking, so the advice is to wait for it.
  if (sign.retake) {
    return look("sign_retake", "The rep has been asked for a new photo of this sign. Nothing needs you until it arrives.", sign.signText);
  }
  switch (sign.reason) {
    case "unreadable_final":
      // 🔴 A LEGIBLE SIGN IS NOT AN UNREADABLE PHOTO (2026-10-18). The reader said the sign reads clearly
      // ("د. محمد زكي" for محمد ذكي), that its lettering is decorative, or that it is a building's own
      // sign, and the name still did not confirm: the system has no verdict, so it is the admin's look —
      // never a Reject on a photo a new one would not change.
      if (sign.problem === "none") {
        return look("sign_unclear", `The sign reads clearly, but the system cannot tell whether it names ${who}. Compare it with the photo yourself.`, sign.signText);
      }
      if (sign.problem === "stylised") {
        return look("sign_stylised", `The lettering on this sign is decorative, and the system could not read the name with confidence. Compare it with ${who}'s name yourself.`, sign.signText);
      }
      if (sign.problem === "building_sign_only") {
        return look("sign_building_only", `The photo shows the building's own sign, and the system cannot tell whether it is ${who}. Look at the photo yourself.`, sign.signText);
      }
      // 🔴 A SIGN NOBODY COULD READ IS HIS LOOK, NEVER A REJECT (23 Nov 2026): cut off, too far, blurred or
      // in glare, he approved more of them than he rejected.
      return look("sign_unreadable", `The sign could not be read, so the system cannot say whether this is ${who}. Look at the photo yourself.`, sign.signText);
    case "unreadable":
      // 🔴 A BUILDING'S SIGN IS NEVER READ AGAIN (owner, 14 Nov 2026, "Fix all three"): the night pass reads
      // a customer's own place only, and 65 buildings had said "read again tonight" for up to a month.
      if (subject === "building") return look("sign_unreadable", "The sign on this building could not be read. Look at the photo yourself.", sign.signText);
      return look("sign_read_again", "The sign could not be read on the first try, and it is read again tonight. Look at the photo yourself.", sign.signText);
    case "not_comparable":
      return look("sign_other_script", `The sign is written in another script from ${who}'s name, so the system cannot compare them. Compare it with the photo yourself.`, sign.signText);
    case "unconfirmed":
      return look("sign_readings_disagree", "Two readings of this sign disagreed, so the system will not say either way.", sign.signText);
    case "name_unusable":
      return look("sign_name_unusable", `There is nothing to compare: ${who}'s name cannot be matched against a sign.`, sign.signText);
    default:
      return look("sign_no_answer", NO_ANSWER, sign.signText);
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
    return look("timetable_exempt", "This building has no timetable, so none can show this customer's name. You validate its customers yourself, as an exception.");
  }
  if (!timetable) return look("timetable_unread", "The timetable has not been read for this customer yet. Look at the photo yourself.");
  const read = timetable.scheduleText;
  if (timetable.verdict === "match") {
    // 🔴 Approve, and NOT ready: he approved 116 of the 143 a timetable named (23 Nov 2026).
    return approve(
      "timetable_match",
      timetable.hoursRead ? "The timetable names the customer, with their hours beside the name." : "The timetable names the customer.",
      timetable.hoursRead ?? read,
      false,
    );
  }
  const notATimetable = () => reject("timetable_missing", "The photo does not show a timetable.", read, "schedule_missing");
  if (timetable.verdict === "other_name") {
    if (timetable.problem === "not_a_timetable") return notATimetable();
    // 🔴 HE APPROVED 10 OF THESE 16 (23 Nov 2026): the name is on the board written another way, or on a
    // part the reading missed. The system says what it read; Reject opens on no reason.
    return look("timetable_other_name", "The timetable was read and the customer's name was not found on it. Check the photo yourself: the name may be written another way.", read);
  }
  // 🔴 A screen photo is SAVED AND HELD for you, never refused (owner, 2026-10-28): some polyclinics post
  // their timetable only online, so the system cannot say it is wrong — it says what it saw and you decide.
  if (timetable.problem === "on_a_screen" || timetable.heldBecause === "timetable_on_a_screen") {
    return look(
      "timetable_on_screen",
      "The timetable was photographed on a phone or computer screen, not on the building's wall. Some polyclinics post their timetable only online: check the customer's name on the screen and decide.",
      read,
    );
  }
  if (timetable.verdict === "no_schedule") {
    // The reading said why (not a timetable, or none found in every try): he rejected 57 of those 68. A
    // hold from before the reading said why carries neither, and he approved 19 of those 22.
    if (timetable.problem === "not_a_timetable" || timetable.heldBecause === "timetable_missing") return notATimetable();
    return look("timetable_not_found", "The system did not find a timetable in the photo. Look at the photo yourself.", read);
  }

  // Unjudged. The scanner's own hold after its tries comes first: it is the strongest thing said.
  if (timetable.heldBecause === "timetable_missing") {
    return reject("timetable_missing", `No timetable was found in ${SCHEDULE_MAX_TRIES} photos.`, read, "schedule_missing");
  }
  if (timetable.reason === "unreadable" || timetable.heldBecause === "timetable_unreadable") {
    if (timetable.problem === "not_a_timetable") return notATimetable();
    const tries = timetable.heldBecause === "timetable_unreadable" ? ` after ${SCHEDULE_MAX_TRIES} photos` : "";
    // 🔴 SOMETHING WAS READ: the customer's name may be exactly the part that was not. That is a photo to
    // look at, turned and zoomed, never a rejection the system cannot stand behind.
    if (read) {
      return look("timetable_part_read", `Part of the timetable was read${tries} and the customer's name was not in that part. Turn or zoom the photo to check.`, read);
    }
    const clause = timetable.problem ? `: ${PROBLEM_CLAUSE[timetable.problem]}` : "";
    return reject("timetable_unreadable", `Nothing on the timetable could be read${tries}${clause}, so it cannot show the customer's name.`, null, null);
  }
  if (timetable.reason === "held_elsewhere") return look("timetable_held_elsewhere", "The timetable was not read: this customer was already held for another reason.");
  return look("timetable_no_answer", NO_ANSWER, read);
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

/** The advice on a place only Google held whose sign names the customer: the group the system approves itself. */
export const GOOGLE_SIGN_MATCH_CODE = `${GOOGLE_PREFIX}sign_match`;

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

/**
 * `buildingHasNoTimetable` is the building's own declaration ("this building has no timetable"), which
 * only a seated customer's row can carry: the decision keeps the advice the building's panel showed.
 */
export function adviseOnHeldRow(row: HeldRowEvidence, buildingHasNoTimetable = false): PlaceCheckAdvice {
  if (row.photoKind === "schedule") {
    return adviseOnTimetable(
      {
        verdict: row.reason === "schedule_other_name" ? "other_name" : row.reason === "schedule_missing" ? "no_schedule" : "unjudged",
        scheduleText: row.signText,
        hoursRead: row.hoursRead,
        reason: row.evidence.checkReason,
        legibility: row.evidence.legibility,
        problem: row.evidence.problem,
        heldBecause: row.evidence.heldBecause,
        uploaded: row.evidence.uploaded,
      },
      buildingHasNoTimetable,
    );
  }
  // The door held it for what the sign said. The hold's own record is what he is shown, so it speaks
  // even when the place's stored reading has moved on; the kind of problem rides the place's reading.
  if (row.reason === "sign_other_name") {
    return adviseOnSign({ verdict: "other_name", reason: row.reason, signText: row.signText, problem: row.evidence.signboard?.problem });
  }
  if (row.reason === "sign_no_name") {
    return adviseOnSign({ verdict: "no_name", reason: row.reason, signText: row.signText, problem: row.evidence.signboard?.problem });
  }

  // A Google hold — or a place refused by hand from the list. The sign at the door is the stronger
  // witness: Google's pin can be years old, the sign is what the rep stood in front of today.
  const sign = adviseOnSign(row.evidence.signboard);
  const google = googleClause(row.reason, row.nearestListingMeters);
  if (!google) return sign;
  // Every clause opens on the name Google, so it is joined as written, never lower-cased.
  // 🔴 THE SIGN WINS (owner, 23 Nov 2026): he approved all 117 of these, so the system approves them
  // itself (`GOOGLE_SIGN_MATCH_CODE`, sign-wins-rules.ts). One still on the board is one the rule left.
  const code = `${GOOGLE_PREFIX}${sign.code}`;
  if (sign.kind === "approve") return { ...sign, code, reason: `The sign in the photo names the customer, although ${google}.` };
  if (sign.kind === "reject") return { ...sign, code, reason: `${sign.reason.replace(/\.$/, "")}, and ${google}.` };
  return { ...sign, code, reason: `${google}. ${sign.reason}` };
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
