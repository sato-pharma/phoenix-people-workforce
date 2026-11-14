// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A SHARED PLACE — one door, several customers behind it.
//
// Owner, 2026-10-09, in chat (Arabic): validate the polyclinic itself ONCE, then register each
// customer's times inside it, "from X to Y and from X to Y", at most THREE a day; he must upload a
// photo of the timetable showing the names of the people he is adding; the polyclinic's location is
// taken once, so seating needs no location; and the administrator has the right to review the
// timetable afterwards.
//
// 🔴 ONE TIMETABLE FOR THE BUILDING, NOT ONE PER DOCTOR (owner, 2026-10-10 — his one amendment to the
// design above: "when he adds the doctors, the three doctors we agreed in the same polyclinic, ask him
// for only one timetable, not for every doctor"). The board on the wall lists everybody who receives
// behind that door, which is exactly what makes it the right evidence for each of them, so it is
// photographed ONCE with the VENUE's name stamped into the image and every customer seated afterwards
// is saved against that one photograph. The rep is asked again only when he says the timetable
// changed, and that new photograph becomes the building's.
//
// WHY IT EXISTS. A place is validated at the door by a live signboard photo that must carry the
// CUSTOMER'S OWN NAME. That works for a customer with his own clinic and cannot work for a polyclinic:
// the sign names the BUILDING, five customers receive behind one door, and each of them needed a
// capture at a spot where the sign could never name him — so they stayed unvalidated, and an
// unvalidated customer's visits are saved and score nothing.
//
// WHAT A SHARED PLACE IS NOT (his first answers, 2026-10-09): it is a VENUE ONLY. It is on nobody's
// list, it takes no visit of its own, it counts in no call rate and in no KPI. The customer seated
// inside it stays the one who is planned, visited and counted.
//
// 🔴 THE NAME. `src/lib/venues/**` already means the marketing and direct-order notion of a shop, so
// this concept is "shared place" everywhere in code and in SQL. The rep's screen never says it: it
// says "Polyclinic or centre", and the four kinds below carry his words.
//
// WHAT IS REUSED RATHER THAN RESTATED: the two readings and the 250 m line are `parseCapturedFix`,
// `placeReadingsPrecise` and `placePoint` from entry-rules.ts — the venue is captured by exactly the
// discipline a place is, because it is the point every visit behind that door will be measured
// against. The timetable's own days and hours are `parseTimings`, which already refuses a seating with
// no weekday and no start time — the owner's "at least one day and one starting time".
//
// The account, his words in full, and why the timetable is the BUILDING's rather than one image per
// doctor: docs/phoenix-crm-shared-places.md.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

import { readAccuracyInput } from "@/lib/geo/coordinate-input";
import { isUuid } from "@/lib/http/uuid";
import {
  cleanText,
  type CapturedFix,
  type EntryRuleResult,
  parseCapturedFix,
  placeReadingsPrecise,
  roughFixAtThePlace,
  type ValidatedPlaceReading,
  VISIT_MAX_ACCURACY_METERS,
  visitAwayFromValidatedPlace,
  type VisitPlaceVerdict,
  withinAccuracy,
} from "@/lib/phoenix-crm/entry-rules";
import { isUsableFix } from "@/lib/phoenix-crm/geo";
import { parseTimings } from "@/lib/phoenix-crm/timings";
import type { PhoenixCrmTiming } from "@/lib/phoenix-crm/types";

/**
 * Scope is every shared venue, not the polyclinic alone (his third answer, 2026-10-09) — but THREE
 * kinds, not four: he read the chooser on the rep's own screen the same day and said "remove medical
 * tower option". A tower is captured as whichever of these three the sign on it says.
 */
export const SHARED_PLACE_KINDS = [
  { key: "polyclinic", label: "Polyclinic", one: "One polyclinic" },
  { key: "medical_centre", label: "Medical centre", one: "One medical centre" },
  { key: "hospital_outpatient", label: "Hospital outpatient", one: "One hospital outpatient clinic" },
] as const;

export type SharedPlaceKind = (typeof SHARED_PLACE_KINDS)[number]["key"];

export const SHARED_PLACE_KIND_KEYS: readonly SharedPlaceKind[] = SHARED_PLACE_KINDS.map((kind) => kind.key);

/** The screen's own words for the whole idea. The rep never reads "shared place". */
export const SHARED_PLACE_TITLE = "Polyclinic or centre";
/** What the venue's name box asks for: the building, never a person. */
export const SHARED_PLACE_NAME_LABEL = "The name on the building";
export const SHARED_PLACE_NAME_MAX = 200;

/** Nothing off the wire is trusted to be one of the four. */
export function parseSharedPlaceKind(value: unknown): SharedPlaceKind | null {
  const key = String(value ?? "").trim();
  return SHARED_PLACE_KIND_KEYS.find((candidate) => candidate === key) ?? null;
}

export function sharedPlaceKindLabel(key: string | null): string | null {
  if (!key) return null;
  return SHARED_PLACE_KINDS.find((kind) => kind.key === key)?.label ?? null;
}

/**
 * What the building is called inside a sentence: "this polyclinic", "this medical centre", "this
 * hospital" (owner, 14 Nov 2026, "Fix all three": 78 hospitals and centres were told "The sign names
 * this polyclinic"). A hospital's outpatient suite is signed by its hospital, so it is the hospital.
 */
export function sharedPlaceKindNoun(key: string | null): string {
  if (key === "polyclinic") return "polyclinic";
  if (key === "medical_centre") return "medical centre";
  if (key === "hospital_outpatient") return "hospital";
  return "building";
}

/** "One medical centre" — the subject of the cap sentences below. */
function oneOfThese(kind: SharedPlaceKind): string {
  return SHARED_PLACE_KINDS.find((entry) => entry.key === kind)?.one ?? "One shared place";
}

// ── Capturing the venue ─────────────────────────────────────────────────────────────────────────

/**
 * What the phone may say about a shared place: the name on the building, which of the four it is, the
 * signboard photo, and the raw fix.
 *
 * It names NO location field of its own, exactly as `PlaceDraft` does not: the address, the part of
 * town, the brick, the area and the region are derived on the SERVER from the captured coordinates and
 * frozen there (owner, 2026-09-23). A body still carrying them is ignored rather than refused.
 */
export type SharedPlaceDraft = CapturedFix & {
  name: string;
  kind: SharedPlaceKind;
  photoPath: string;
  /** When Capture location took ITS reading — read, never required, exactly as on a place. */
  pinCapturedAt: string | null;
};

export const SHARED_PLACE_NO_PHOTO = "Take a live photo of the sign on the building.";
export const SHARED_PLACE_NO_NAME = "Write the name on the building.";
export const SHARED_PLACE_NO_KIND = "Choose what this place is.";
export const SHARED_PLACE_JUNK_NAME = "This does not read as a name. Write the name exactly as the sign on the building spells it.";

/** A word of Latin letters, and of Arabic letters — the two scripts a building's sign is written in. */
const LATIN_WORD = /^[a-z]+$/i;
const ARABIC_LETTER = /[ء-ي]/;

/**
 * Whether a typed building name is a keyboard mash rather than a name (owner, 2026-11-14: "fix the junk
 * polyclinic names" — he chose "refuse junk at the door"). Two held buildings that day were named
 * "ىىوزنخ" and "FEFEFFE"; the photo under each showed no sign at all, so the reviewer had no name to judge.
 *
 * 🔴 IT REFUSES ONLY WHAT NO REAL NAME CAN BE, never what merely looks unusual: an acronym ("CMC", "NMC"),
 * a doctor's name, a number in a name ("Clinic 2"), a stretched letter ("العيـــن", "جاااس") and a
 * missing space ("مكةالمكرمة") all pass. Measured against every name on production the day it landed: of
 * 336 buildings it refuses "ىىوزنخ", "FEFEFFE" and the retired "Djkl", and of 18,330 customer names only
 * "OOOOOOOOOOOO", "ىوؤف" and two whose word starts with "ى"/"ة" for a missing space ("ىالامريكان"),
 * which the rep retypes as the sign spells it. A name that passes is still read against the sign by the
 * door reader, and a building is never approved by the system — this is the cheap first line, not the
 * judgement.
 *
 *   1. no letter at all ("1234", "...");
 *   2. an Arabic word that STARTS with "ى" or "ة" — no word can ("ىىوزنخ"); the tatweel "ـ" is ignored;
 *   3. one Latin letter three times running ("OOOO", "xxx") — Arabic is exempt: a stretched "جاااس" is
 *      how some signs are written;
 *   4. a Latin word of five letters or more made of two letters only ("FEFEFFE", "asasa");
 *   5. a lower- or mixed-case Latin word of four letters or more with no vowel ("sdfg", "Djkl") — an
 *      all-capital one is an acronym and passes.
 */
export function sharedPlaceNameIsJunk(name: string | null | undefined): boolean {
  const text = String(name ?? "").replace(/ـ/g, "").replace(/\s+/g, " ").trim();
  if (!text) return false;
  if (!/\p{L}/u.test(text)) return true;
  if (/([a-z])\1\1/i.test(text)) return true;
  for (const word of text.split(/[\s\-_.,/()]+/).filter(Boolean)) {
    if (ARABIC_LETTER.test(word)) {
      if (/^[ىة]/.test(word.replace(/[^ء-ي]/g, ""))) return true;
      continue;
    }
    if (!LATIN_WORD.test(word)) continue;
    const lower = word.toLowerCase();
    if (lower.length >= 5 && new Set(lower).size <= 2) return true;
    if (lower.length >= 4 && word !== word.toUpperCase() && !/[aeiouy]/.test(lower)) return true;
  }
  return false;
}

/**
 * 🔴 BOTH READINGS, AT THE DOOR, EVEN THOUGH NO GOOGLE CHECK RUNS ON A VENUE (owner, 2026-10-09,
 * asked about exactly this: "even if no Google check, he must validate by a live photo and location").
 * The Google check is judged against the customer's name as the LIST holds it, and a venue has no list
 * name — so it is not run; the live photo and the two readings are what make the point trustworthy,
 * and the administrator's review is the human gate behind them.
 */
export function parseSharedPlaceDraft(raw: unknown): EntryRuleResult<SharedPlaceDraft> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const photoPath = String(body.photoPath ?? "").trim();
  if (!photoPath) return { ok: false, error: SHARED_PLACE_NO_PHOTO };
  const name = cleanText(body.name, SHARED_PLACE_NAME_MAX);
  if (!name || name.length < 3) return { ok: false, error: SHARED_PLACE_NO_NAME };
  if (sharedPlaceNameIsJunk(name)) return { ok: false, error: SHARED_PLACE_JUNK_NAME };
  const kind = parseSharedPlaceKind(body.kind);
  if (!kind) return { ok: false, error: SHARED_PLACE_NO_KIND };
  const fix = parseCapturedFix(body);
  if (!fix.ok) return fix;
  // A venue is fixed for good and every visit behind that door is measured against it, so a rough
  // photo OR a rough pin is no reading — the same line a place is held to (owner, 2026-10-03).
  if (!placeReadingsPrecise(fix.value)) return { ok: false, error: roughFixAtThePlace(fix.value) };
  return {
    ok: true,
    value: {
      ...fix.value,
      name,
      kind,
      photoPath,
      pinCapturedAt:
        typeof body.pinCapturedAt === "string" && !Number.isNaN(Date.parse(body.pinCapturedAt))
          ? body.pinCapturedAt
          : null,
    },
  };
}

// ── Seating a customer in it ────────────────────────────────────────────────────────────────────

/**
 * What the phone may say when it seats a customer: which venue, the TIMETABLE photo, and the hours.
 *
 * 🔴 NO POINT OF ITS OWN, and that is the point of the whole design (owner, 2026-10-09: the polyclinic's
 * location is taken once). The point, the brick, the area and the region are copied from the venue on
 * the server; the location of the visit itself is taken on the visit, as always. The one reading a
 * seating carries (`standingAt`, owner, 3 Nov 2026) answers one question at the door and is never stored
 * on the place.
 */
export type SeatedPlaceDraft = {
  sharedPlaceId: string;
  /**
   * Where the phone stood when Save was pressed, read in silence. Null is NOT MEASURED — location off,
   * no reading in time, an older build, or one too rough to say — and it seats exactly as before.
   */
  standingAt: SeatingReading | null;
  /**
   * The BUILDING's timetable, photographed live — or null, which means "use the one already on file
   * for this venue" (owner, 2026-10-10). The server never takes reuse on the phone's word: it reads
   * the venue's stored path itself and sends that, so a null here can only ever resolve to the
   * photograph this venue already has.
   */
  photoPath: string | null;
  /**
   * The phone says that photo was uploaded rather than taken live. The server takes it only after two
   * refused photographs (`scheduleUploadAllowed`), and it means nothing without a photo.
   */
  photoUploaded: boolean;
  timings: PhoenixCrmTiming[];
  label: string | null;
  /**
   * AM or PM: the session this customer receives in at the building (owner, 2026-10-10). Null when the
   * phone names none (a build from before today), and the database then seats him in his own list.
   */
  session: "AM" | "PM" | null;
};

export type SeatingReading = { lat: number; lon: number; accuracyMeters: number | null };

/**
 * 🔴 A REP SEATS A CUSTOMER ONLY WHILE STANDING IN THAT BUILDING (owner, 3 Nov 2026, chose "Refuse at
 * seating", amending his own 2026-10-09 "no location"). Hadeer Abdelnaser Osman Hassan's Dr Farid Shawky
 * was seated in a look-alike building 3.9 km from the door they stood at, the far-visit rule then
 * refused every visit at the real door, and only the Super Admin could undo it.
 *
 * The sentence is about HIS OWN work and the way out — never the line, his metres or a check, as
 * `VISIT_AWAY_FROM_PLACE` — and it is Golden Rule #1's fourth exception, by his word. Measured over the
 * 30 days before: of 315 seatings with a visit reading within 20 minutes, 299 (95%) sat inside the line.
 */
export const SEATING_AWAY_FROM_BUILDING =
  "This customer can be added only while you are in their building, and your location now is not there. Choose the building you are in. If you are there, step outside, wait a moment for the location to settle, then save again.";

/** Sends the rep's screen back to the building step, as `SCHEDULE_RETAKE_CODE` sends it to the timetable. */
export const SEATING_AWAY_CODE = "phoenix_crm_seating_away_from_building";

/**
 * Read one reading off the wire, or null. Total: nothing here refuses, because a seating with no usable
 * reading saves as it always did. A reading wider than the visit's own line (500 m) says nothing about
 * which building he is in, so it is no reading at all and never a refusal.
 */
export function parseSeatingReading(raw: unknown): SeatingReading | null {
  if (!raw || typeof raw !== "object") return null;
  const reading = raw as Record<string, unknown>;
  if (!isUsableFix(reading.lat, reading.lon)) return null;
  const accuracy = readAccuracyInput(reading.accuracyMeters);
  const accuracyMeters = accuracy !== null && accuracy >= 0 ? accuracy : null;
  if (!withinAccuracy(accuracyMeters, VISIT_MAX_ACCURACY_METERS)) return null;
  return { lat: Number(reading.lat), lon: Number(reading.lon), accuracyMeters };
}

/**
 * Is this seating past the far line from the building? Null when there is no reading to ask with.
 *
 * It IS `visitAwayFromValidatedPlace`, never a second distance rule: the line is `visit_far_meters`, and
 * the building's two door readings answer as a customer's two do, the nearer deciding. So a rep the
 * seating lets through can log his visit there, because the visit is asked the same question.
 */
export function seatingAwayFromBuilding(input: {
  building: ValidatedPlaceReading;
  standingAt: SeatingReading | null;
  farMeters: number;
}): VisitPlaceVerdict | null {
  if (input.standingAt === null) return null;
  return visitAwayFromValidatedPlace({ fix: input.standingAt, places: [input.building], farMeters: input.farMeters });
}

export const SEATED_PLACE_NO_SESSION = "Choose whether this customer receives in the AM or the PM.";
export const SEATED_PLACE_NO_VENUE = "Choose the polyclinic or centre this customer receives in.";
/**
 * Raised only when the venue has NO timetable on file and the phone sent no photograph either — the
 * first customer seated in a building, where the board still has to be captured.
 */
export const SEATED_PLACE_NO_PHOTO = "Take a live photo of the timetable on the wall.";
/** Under the timetable camera. His instruction, in his own order: the photo, then the hours. */
export const SEATED_PLACE_PHOTO_HINT =
  "Photograph the schedule on the wall. One photo covers everybody who receives in this building — you will not be asked for it again.";
/** The note that stands in place of the camera once the building's board is on file. */
export const SEATED_PLACE_PHOTO_ON_FILE = "The timetable of this building is already on file.";
/** The way back to the camera when the board on the wall has been replaced. */
export const SEATED_PLACE_PHOTO_REPLACE = "The timetable changed — photograph it again";

export function parseSeatedPlaceDraft(raw: unknown): EntryRuleResult<SeatedPlaceDraft> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const sharedPlaceId = String(body.sharedPlaceId ?? "").trim();
  if (!isUuid(sharedPlaceId)) return { ok: false, error: SEATED_PLACE_NO_VENUE };
  // 🔴 A MISSING PHOTO IS NOT A REFUSAL HERE ANY MORE (owner, 2026-10-10): it is the ordinary shape of
  // the second, third and fourth doctor in a building whose board is already photographed. The refusal
  // moved to the server, where the venue's stored timetable is the only thing that can answer it —
  // effectiveSeatedPhoto() in server/shared-places.ts raises SEATED_PLACE_NO_PHOTO when there is
  // neither a fresh photograph nor one on file.
  const photoPath = String(body.photoPath ?? "").trim() || null;
  // His "at least one day and one starting time" is `parseTimings`' own rule — one normal window with
  // a start minute — so it is asked here rather than restated. The end of a window stays optional.
  const timings = parseTimings(body.timings);
  if (!timings.ok) return { ok: false, error: timings.error };
  const rawSession = String(body.session ?? "").trim().toUpperCase();
  if (rawSession !== "" && rawSession !== "AM" && rawSession !== "PM") return { ok: false, error: SEATED_PLACE_NO_SESSION };
  return {
    ok: true,
    value: {
      sharedPlaceId,
      standingAt: parseSeatingReading(body.standingAt),
      photoPath,
      photoUploaded: photoPath !== null && body.photoUploaded === true,
      timings: timings.timings,
      label: cleanText(body.label, 80),
      session: rawSession === "" ? null : (rawSession as "AM" | "PM"),
    },
  };
}

// ── Three a day, at the plan and at the door ────────────────────────────────────────────────────

/**
 * 🔴 THE CAP IS A SETTING, NOT A CONSTANT — `shared_place_daily_cap`, beside `pm_daily_cap` and
 * `am_daily_cap`, read live on every path. Three is only its default (owner, 2026-10-09).
 *
 * It bites BOTH when the rep plans the day and at the door (his second answer, the same day), and it
 * counts VISITS inside one venue — never windows per customer, which he was offered and rejected.
 */
export const SHARED_PLACE_DAILY_CAP_DEFAULT = 3;

/** The database's own refusal when the fourth visit of a day reaches the trigger. */
export const SHARED_PLACE_DAY_FULL_CODE = "phoenix_crm:shared_place_day_full";

/**
 * One day of one venue, over the cap. `dayLabel` is passed in — `planDayLabel`'s own words — so this
 * module never imports the plan rules that call it.
 *
 * Golden rule #1: it names the venue, the count and the cap, and nothing about any check on him.
 */
export function sharedPlaceCapRefusal(input: {
  name: string;
  kind: SharedPlaceKind;
  dayLabel: string;
  placed: number;
  cap: number;
}): string {
  return `${input.name} has ${input.placed} visits on ${input.dayLabel}. ${oneOfThese(input.kind)} holds ${input.cap} visits a day at most.`;
}

/** The same sentence on the send, where the fix is a different one: take one off and save first. */
export function sharedPlaceSendCapRefusal(input: {
  name: string;
  kind: SharedPlaceKind;
  dayLabel: string;
  placed: number;
  cap: number;
}): string {
  return `${sharedPlaceCapRefusal(input)} Take one off that day, save, then send.`;
}

/**
 * At the door, where the refusal comes from the database's own trigger.
 *
 * 🔴 IT NAMES NEITHER THE VENUE NOR THE NUMBER, and that is deliberate rather than lazy: this
 * sentence lives in `db.ts`'s static REFUSALS table, which is reached from a Postgres exception and
 * knows nothing but the code — and the rep is standing inside the place, so of the two things the
 * plan refusal has to tell him (which venue, and what to do) only the second is news. The cap is a
 * setting, so a number written here could also be the wrong one.
 */
export const SHARED_PLACE_DAY_FULL_TEXT =
  "This polyclinic or centre already has all the visits it takes in one day. Log the others on another day.";

/**
 * A plan day's visits per venue: `day → sharedPlaceId → count`.
 *
 * It counts the ITEMS of the plan, whatever customer each one is for, because the cap is the venue's.
 * An item whose place is not seated in one contributes nothing — a customer with his own clinic is
 * never part of a venue's day.
 */
export function countSharedPlaceDays(
  items: ReadonlyArray<{ planDate: string; sharedPlaceId: string | null }>,
): Map<string, Map<string, number>> {
  const perDay = new Map<string, Map<string, number>>();
  for (const item of items) {
    if (!item.sharedPlaceId) continue;
    const venues = perDay.get(item.planDate) ?? new Map<string, number>();
    venues.set(item.sharedPlaceId, (venues.get(item.sharedPlaceId) ?? 0) + 1);
    perDay.set(item.planDate, venues);
  }
  return perDay;
}

/** What a caller needs to name the venue in the refusal. */
export type SharedPlaceNamed = { sharedPlaceId: string; name: string; kind: SharedPlaceKind };

/**
 * The first day, in date order, where one venue is over the cap — or null.
 *
 * Days are answered sorted, never in Map order, so the earliest offending day is the one named: Map
 * order depends on which rows a read happened to return first, which would make the refusal wobble
 * between two saves of the same plan.
 */
export function sharedPlanCapRefusal(input: {
  items: ReadonlyArray<{ planDate: string; sharedPlaceId: string | null }>;
  venues: ReadonlyMap<string, SharedPlaceNamed>;
  cap: number;
  dayLabel: (isoDay: string) => string;
  onlyDays?: ReadonlyArray<string> | null;
  /** The send's own closing sentence. The save's refusal ends at the cap. */
  forSend?: boolean;
  /**
   * The venues the owner lifted outright for this seat (owner, 2026-10-31 — named hospitals: any count on
   * the plan, planned or not), from `phoenix_crm_venue_cap_lifted`, the door's own rule. Nothing planned
   * there is counted, so the venue is never full.
   */
  liftedVenues?: ReadonlySet<string>;
  /**
   * A venue's own raised daily number (owner, 2026-11-02: "instead of making the cap 3, make it 5, make it 7"),
   * `sharedPlaceId → number`, from `daily_cap`. It can only widen: the door holds the greater of the two, so
   * this does too, and a venue left out of the map holds `cap`.
   */
  venueCaps?: ReadonlyMap<string, number>;
}): string | null {
  const nameable = input.onlyDays ? new Set(input.onlyDays) : null;
  const lifted = input.liftedVenues;
  const perDay = countSharedPlaceDays(
    lifted && lifted.size > 0 ? input.items.filter((item) => !item.sharedPlaceId || !lifted.has(item.sharedPlaceId)) : input.items,
  );
  for (const day of [...perDay.keys()].sort()) {
    if (nameable && !nameable.has(day)) continue;
    const venues = perDay.get(day);
    if (!venues) continue;
    for (const sharedPlaceId of [...venues.keys()].sort()) {
      const placed = venues.get(sharedPlaceId) ?? 0;
      const capHere = Math.max(input.cap, input.venueCaps?.get(sharedPlaceId) ?? 0);
      if (placed <= capHere) continue;
      const venue = input.venues.get(sharedPlaceId);
      const said = {
        name: venue?.name ?? SHARED_PLACE_TITLE,
        kind: venue?.kind ?? "polyclinic",
        dayLabel: input.dayLabel(day),
        placed,
        cap: capHere,
      };
      return input.forSend ? sharedPlaceSendCapRefusal(said) : sharedPlaceCapRefusal(said);
    }
  }
  return null;
}
