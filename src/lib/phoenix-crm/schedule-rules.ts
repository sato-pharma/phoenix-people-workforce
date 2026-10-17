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
// 🔴 SINCE 2026-10-17 IT IS A SCANNER, NOT A SILENT GATE (owner, in chat: the timetable photo must be
// read on the spot "like a scanner", never accepted and called unreadable afterwards, and never block
// the rep endlessly). `scheduleDoorAction` is the whole ruling:
//   · the board is read and names him            → saved;
//   · the board is read and does NOT name him    → saved, HELD for the administrator, and the rep is
//                                                  told why (his ruling for this one case);
//   · not a timetable, or not readable           → refused at the door with what to fix — try 1, try 2;
//                                                  the 3rd failure is saved and HELD, never accepted;
//   · NO ANSWER AT ALL (no key, a lost call, no bytes) → saved, exactly as before. Refusing or holding
//     on the absence of an answer would stop every seating in the field the moment the provider is
//     slow or the key lapses, and the key has run dry silently twice.
// The tries are counted per rep, per BUILDING, per Cairo day (`phoenix_crm_refused_readings`), because
// the timetable is the building's one board and a brand-new customer has no id to count against.
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

/** How much of the board the reader could read, in its own judgement. */
export type ScheduleLegibility = "clear" | "partial" | "unreadable";

/** What is wrong with the photograph, when something is — the words the rep is told come from this. */
export type ScheduleProblem = "not_a_timetable" | "too_far" | "blurred" | "glare" | "cut_off";

export const SCHEDULE_LEGIBILITIES: readonly ScheduleLegibility[] = ["clear", "partial", "unreadable"];
export const SCHEDULE_PROBLEMS: readonly ScheduleProblem[] = ["not_a_timetable", "too_far", "blurred", "glare", "cut_off"];

export function parseScheduleLegibility(value: unknown): ScheduleLegibility | null {
  return typeof value === "string" && (SCHEDULE_LEGIBILITIES as readonly string[]).includes(value) ? (value as ScheduleLegibility) : null;
}

export function parseScheduleProblem(value: unknown): ScheduleProblem | null {
  return typeof value === "string" && (SCHEDULE_PROBLEMS as readonly string[]).includes(value) ? (value as ScheduleProblem) : null;
}

export type PhoenixCrmScheduleCheck = {
  verdict: ScheduleVerdictKind;
  /** Why, for every verdict but `match`. Null on a match. */
  reason: ScheduleCheckReason | null;
  /**
   * The reader's own judgement of the board, from 2026-10-17. ABSENT on a record written before then,
   * which is why it is optional rather than null: an old verdict was never asked.
   */
  legibility?: ScheduleLegibility | null;
  /** What was wrong with the photograph, from the same date. Absent on an older record. */
  problem?: ScheduleProblem | null;
  /** On a seating the scanner HELD: how many photographs of this board were tried that day. */
  tries?: number;
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
  /** Absent from a caller that predates the scanner; read as "not asked". */
  legibility?: ScheduleLegibility | null;
  problem?: ScheduleProblem | null;
}): PhoenixCrmScheduleCheck {
  const legibility = input.legibility ?? null;
  const problem = input.problem ?? null;
  const base = {
    checkedAt: new Date().toISOString(),
    croppedFraction: input.croppedFraction,
    hoursRead: input.hoursRead,
    legibility,
    note: input.note,
    personNames: [...input.personNames],
    problem,
    scheduleText: input.scheduleText,
  };

  // 🔴 NO TIMETABLE AT ALL, said confidently — a wall, a prescription pad, a shopfront, a pavement. A
  // model that is merely UNSURE answers null and lands in `unjudged` below; only an explicit "no" —
  // `schedule_present: false` or the problem `not_a_timetable` — with nothing transcribed is this.
  const nothingRead = input.personNames.length === 0 && !input.scheduleText;
  if (nothingRead && (input.schedulePresent === false || problem === "not_a_timetable")) {
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

  // Any reading that names him is a match, however much of the rest was legible.
  if (matches === true) return { ...base, nameScore: score, reason: null, verdict: "match" };
  // 🔴 "NOT ON IT" IS SAID ONLY OF A BOARD THE READER CALLS CLEAR. On a board it could read only in
  // part, his name may be exactly the part it could not read — so that is a photograph to take again,
  // closer, not a customer to hold. A reader that did not say (an older caller) keeps the old verdict.
  if (matches === false && (legibility === null || legibility === "clear")) {
    return { ...base, nameScore: score, reason: "schedule_other_name", verdict: "other_name" };
  }

  // null — either side folded away, or nothing was transcribed — or a "not on it" the reader could not
  // see all of. Never a pass; at the door, a photograph to retake (`scheduleDoorAction`).
  return { ...base, nameScore: score, reason: "unreadable", verdict: "unjudged" };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The scanner at the door (owner, 2026-10-17).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Three photographs of a board, then the seating is saved and held (owner, 2026-10-17: "3 tries"). */
export const SCHEDULE_MAX_TRIES = 3;

/**
 * The refusal code a retake travels under. It starts `phoenix_crm_photo_` on purpose: the rep's
 * screen already discards a refused photograph and returns to its step on that prefix, and reads this
 * exact code to open the camera even when the refused board was the one on file.
 */
export const SCHEDULE_RETAKE_CODE = "phoenix_crm_photo_timetable_retake";

/** Why the scanner held a seating — the sentence the rep reads is keyed by it. */
export type ScheduleHeldBecause = "name_not_on_timetable" | "timetable_unreadable" | "timetable_missing";

/** The two refusal reasons the tries are counted under, as `phoenix_crm_refused_readings` stores them. */
export type ScheduleRetakeReason = "timetable_unreadable" | "timetable_missing";

export type ScheduleDoorAction =
  | { kind: "save" }
  | { kind: "retake"; reason: ScheduleRetakeReason; message: string; nextTry: number }
  | { kind: "hold"; heldBecause: ScheduleHeldBecause; tries: number };

/**
 * 🔴 THE REP'S WORDS SAY "CUSTOMER", NEVER THE WORD HE USED IN CHAT — tests/phoenix-crm-am-pm-words.test.ts
 * refuses it in any string of this tree. Everything else is his sentence (owner, 2026-10-17: "tell the
 * rep that the dr name is not in the timetable so held for admin approval").
 */
export const SCHEDULE_HELD_TEXT: Record<ScheduleHeldBecause, string> = {
  name_not_on_timetable: "The customer's name is not on the timetable, so it is held for admin approval.",
  timetable_unreadable: `The timetable could not be read after ${SCHEDULE_MAX_TRIES} tries, so it is held for admin approval.`,
  timetable_missing: `No timetable was found in the photo after ${SCHEDULE_MAX_TRIES} tries, so it is held for admin approval.`,
};

export function parseScheduleHeldBecause(value: unknown): ScheduleHeldBecause | null {
  return typeof value === "string" && value in SCHEDULE_HELD_TEXT ? (value as ScheduleHeldBecause) : null;
}

export function scheduleHeldText(value: unknown): string | null {
  return typeof value === "string" && value in SCHEDULE_HELD_TEXT ? SCHEDULE_HELD_TEXT[value as ScheduleHeldBecause] : null;
}

/** What the rep is told to do differently, by what the reader said was wrong. Never names a check. */
function retakeAdvice(check: PhoenixCrmScheduleCheck): string {
  if (check.verdict === "no_schedule" || check.problem === "not_a_timetable") {
    return "This photo does not show the building's timetable. Photograph the timetable on the wall, with the names in the frame.";
  }
  if (check.personNames.length > 0 || check.scheduleText) {
    // It read SOME of the board and did not find him: say so, and ask for the part with his name.
    return "The customer's name was not found, and part of the timetable cannot be read. Photograph the part that shows the name, close and straight on.";
  }
  switch (check.problem) {
    case "too_far":
      return "The timetable is too far away to read. Step closer so the names fill the photo.";
    case "blurred":
      return "The photo is blurred. Hold the phone still and take it again.";
    case "glare":
      return "A reflection covers the timetable. Step to one side so the light does not shine on it, and take it again.";
    case "cut_off":
      return "Part of the timetable is cut off. Fit the whole timetable in the frame and take it again.";
    default:
      return "The names on the timetable cannot be read. Step closer, hold the phone straight and keep every name in the frame.";
  }
}

/**
 * What the door does with one reading of the board, given how many photographs of THIS building's
 * board this rep has already had refused today.
 *
 * 🔴 ONLY A READER THAT ANSWERED CAN ASK FOR A RETAKE. `no_api_key`, `call_failed`, `no_bytes` and
 * `held_elsewhere` are the absence of an answer, and they save exactly as they did before the scanner:
 * refusing on them would stop every seating in the field when the key lapses.
 */
export function scheduleDoorAction(check: PhoenixCrmScheduleCheck, earlierTries: number): ScheduleDoorAction {
  if (check.verdict === "match") return { kind: "save" };
  const tried = Math.max(0, Math.floor(Number.isFinite(earlierTries) ? earlierTries : 0));
  if (check.verdict === "other_name") return { kind: "hold", heldBecause: "name_not_on_timetable", tries: tried + 1 };
  const photoProblem = check.verdict === "no_schedule" || (check.verdict === "unjudged" && check.reason === "unreadable");
  if (!photoProblem) return { kind: "save" };
  const missing = check.verdict === "no_schedule";
  if (tried + 1 >= SCHEDULE_MAX_TRIES) {
    return { kind: "hold", heldBecause: missing ? "timetable_missing" : "timetable_unreadable", tries: tried + 1 };
  }
  const nextTry = tried + 2;
  return {
    kind: "retake",
    reason: missing ? "timetable_missing" : "timetable_unreadable",
    message: `${retakeAdvice(check)} Try ${nextTry} of ${SCHEDULE_MAX_TRIES}.`,
    nextTry,
  };
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
  /** Set when the scanner held it: why, and on which try. Absent on the older holds. */
  held?: { heldBecause: ScheduleHeldBecause; tries: number },
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
    legibility: check.legibility ?? null,
    problem: check.problem ?? null,
    heldBecause: held?.heldBecause ?? null,
    tries: held?.tries ?? null,
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
