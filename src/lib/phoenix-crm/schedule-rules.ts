import { signNamesCustomer, type PhoenixCrmSignboardCheck } from "@/lib/phoenix-crm/signboard-rules";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Does the TIMETABLE in the photo name this customer?
//
// Owner, 2026-10-09 (Arabic, in chat): he must upload a photo of the schedule showing the names of
// the people he wants to add, "ارفعه عند كل واحد" — upload it at each one. This is the question that
// replaces the signboard when a customer is seated in a shared place: behind a polyclinic's one door
// the sign names the BUILDING, and what names the person is the schedule hanging inside it.
//
// 🔴 ONE NAME-MATCHER IN THE MODULE, NOT TWO. The folding and the quorum are `signNamesCustomer`'s,
// read in its PM mode — the mode that matches a PERSON — because a timetable is a list of people and
// their hours. A second fold is exactly the drift tests/phoenix-crm-customer-name-fold.test.ts exists
// to refuse: `normalizeContactName` is the only one of this repository's six Arabic folds that strips
// د / دكتور / الدكتور, and it already has a SQL twin.
//
// WHAT IS DIFFERENT FROM A SIGNBOARD, and why this is a file of its own rather than a flag:
//   · the photo is PAPER on purpose, so the signboard list's "a photo of paper, not a building" is
//     wrong by construction about it (validation-feedback.ts keeps the two pick-lists apart);
//   · there is no AM half of the rule — a timetable names people whatever list the customer is on;
//   · a venue's own sign is still judged by `judgeSignboard`, in its place-name mode.
//
// IT GATES THE SAME WAY A SIGNBOARD DOES: a confident negative HOLDS the seating — saved, the
// customer left under To validate, one review row raised, the rep reading only that the system is
// checking — and NO SIGNAL NEVER HOLDS, because holding on the absence of an answer would hold every
// seating in the field the moment the provider is slow or the key lapses.
//
// The pure/server split is the house one: this file judges and holds no I/O;
// src/lib/phoenix-crm/server/schedule-check.ts fetches the bytes and asks the question.
//
// 🔴 No string here may contain "doctor", "doctors", "account" or "accounts" —
// tests/phoenix-crm-am-pm-words.test.ts sweeps this tree. "customer" and "clinic".
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export type ScheduleVerdictKind =
  /** The timetable names the customer being seated. */
  | "match"
  /** It is a timetable, it was read, and this customer is not on it. Held for review. */
  | "other_name"
  /** Confidently not a timetable at all. Held the same way. */
  | "no_schedule"
  /** No answer was obtained. NEVER a pass, and never a hold. */
  | "unjudged";

export type ScheduleCheckReason =
  | "no_api_key"
  | "no_bytes"
  | "unreadable"
  | "call_failed"
  /** The seating is already held for another reason, so no call was made at all. */
  | "held_elsewhere"
  /** 🔴 The same two keys the owner approved as refusal reasons, so the record and the pick-list agree. */
  | "schedule_other_name"
  | "schedule_missing";

export type PhoenixCrmScheduleCheck = {
  verdict: ScheduleVerdictKind;
  /** Why, for every verdict but `match`. Null on a match. */
  reason: ScheduleCheckReason | null;
  /** What the timetable reads, verbatim, in its own script. Arabic stays Arabic. */
  scheduleText: string | null;
  /** The names read on it as the names of PEOPLE. */
  personNames: string[];
  /** The days and hours read beside this customer's name, as written. Evidence, never parsed into timings. */
  hoursRead: string | null;
  /** 0–1. Stored for analysis, NEVER rendered. */
  nameScore: number | null;
  /** One sentence a Super Admin can act on. */
  note: string | null;
  checkedAt: string;
  /** How much of the image was cropped off the bottom before it was read. */
  croppedFraction: number | null;
};

/**
 * "No answer was obtained, and here is why" — the record every absence takes, so a seated place can
 * always tell NOT CHECKED from CHECKED AND CLEAN.
 */
export function scheduleUnjudged(
  reason: ScheduleCheckReason,
  croppedFraction: number | null = null,
): PhoenixCrmScheduleCheck {
  return {
    checkedAt: new Date().toISOString(),
    croppedFraction,
    hoursRead: null,
    nameScore: null,
    note: null,
    personNames: [],
    reason,
    scheduleText: null,
    verdict: "unjudged",
  };
}

/** Turn what the model reported into one of the four verdicts. */
export function judgeSchedule(input: {
  customerName: string | null;
  schedulePresent: boolean | null;
  scheduleText: string | null;
  personNames: readonly string[];
  hoursRead: string | null;
  note: string | null;
  croppedFraction: number;
}): PhoenixCrmScheduleCheck {
  const base = {
    checkedAt: new Date().toISOString(),
    croppedFraction: input.croppedFraction,
    hoursRead: input.hoursRead,
    note: input.note,
    personNames: [...input.personNames],
    scheduleText: input.scheduleText,
  };

  // 🔴 NO TIMETABLE AT ALL, said confidently — a wall, a prescription pad, a shopfront. A model that
  // is merely UNSURE answers null and lands in `unjudged` below; only an explicit `false` with
  // nothing transcribed holds.
  const nothingRead = input.personNames.length === 0 && !input.scheduleText;
  if (input.schedulePresent === false && nothingRead) {
    return { ...base, nameScore: null, reason: "schedule_missing", verdict: "no_schedule" };
  }

  // The PM mode of the module's one name-matcher: a timetable is a list of PEOPLE, whatever list the
  // customer is on. `placeNames` is deliberately empty — the building's name is the venue's question.
  const { matches, score } = signNamesCustomer({
    customerName: input.customerName,
    listType: "PM",
    personNames: input.personNames,
    placeNames: [],
    signText: input.scheduleText,
  });

  if (matches === true) return { ...base, nameScore: score, reason: null, verdict: "match" };
  if (matches === false) return { ...base, nameScore: score, reason: "schedule_other_name", verdict: "other_name" };

  // null — either side folded away, or nothing was transcribed. Never a pass, never a hold.
  return { ...base, nameScore: score, reason: "unreadable", verdict: "unjudged" };
}

/**
 * Does this verdict hold the seating for the administrator to look at?
 *
 * 🔴 `unjudged` is false here in every one of its reasons, for the reason `signboardHoldsForReview`
 * records: the key has run out of credits twice in this system's life, both times silently, and a
 * hold on the absence of an answer would have stopped every capture in the field on both days.
 */
export function scheduleHoldsForReview(check: PhoenixCrmScheduleCheck): boolean {
  return check.verdict === "other_name" || check.verdict === "no_schedule";
}

/**
 * What the database keeps when a timetable HOLDS the seating — the review row's evidence.
 *
 * 🔴 IT LANDS IN A COLUMN LITERALLY NAMED `google`, AND THE NAME IS WRONG RATHER THAN THE CODE, for
 * the reason `signboardHoldRecord` records in full: that column is generically "the evidence the
 * system judged on", and the one review row per place is the only slot there is. `verdict: "schedule"`
 * says which detector spoke. Do not reshape the record to match the column's name.
 */
export function scheduleHoldRecord(
  check: PhoenixCrmScheduleCheck,
  venue: { sharedPlaceId: string; name: string; lat: number; lon: number },
): Record<string, unknown> {
  return {
    verdict: "schedule",
    reason: check.reason,
    checkedAt: check.checkedAt,
    scheduleText: check.scheduleText,
    personNames: check.personNames,
    hoursRead: check.hoursRead,
    note: check.note,
    nameScore: check.nameScore,
    croppedFraction: check.croppedFraction,
    // The point is the VENUE's, taken once at its door — a seated capture has no reading of its own,
    // which is the whole design. Named so the board can say where it came from.
    sharedPlace: { sharedPlaceId: venue.sharedPlaceId, name: venue.name },
    point: { lat: venue.lat, lon: venue.lon, accuracyMeters: null, source: "shared_place" },
    // The queue renders Google's candidate listings from this key. A timetable hold has none, and an
    // empty list is what the loader already treats as "nothing to show" — never a missing key.
    listings: [],
  };
}

/** A signboard check and a schedule check are stored in the same column on different rows. */
export type PhoenixCrmPlaceCheck = PhoenixCrmSignboardCheck | PhoenixCrmScheduleCheck;
