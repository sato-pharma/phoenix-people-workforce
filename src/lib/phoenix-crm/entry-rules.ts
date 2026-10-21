/**
 * Phoenix CRM — what a rep sends to validate a customer or enter a visit, checked with no I/O.
 *
 * Owner, 2026-09-16:
 *   - A customer is validated only with a LIVE photo (the clinic sign or door), the location captured
 *     on the spot, and at least one timing. Reference customers and brand-new ones go the same way.
 *   - A new customer's grade: the rep proposes, the district manager approves.
 *   - Dropping a customer needs a reason and the district manager's approval.
 *   - Each visit records the location check, the products discussed and a comment — the comment
 *     REQUIRED since 2026-09-30, typed or spoken (owner: "visit comment is required"). Since 2026-09-29
 *     it needs NO photo: "Log visit" is one tap, the server stamps the time and the location is read
 *     silently (owner: "the medical rep just presses; in the back end we take his location").
 *   - A double visit is the rep with the district manager; a chain visit adds a senior manager
 *     (regional or national). Both count for everyone on them straight away, with no confirmation.
 *
 * Photos never pass through this app: the phone uploads them straight to the private bucket through a
 * signed URL the server issued for one path (photos.ts). Here only the path's shape is checked; the
 * service checks the object exists before it saves.
 */

import { readAccuracyInput } from "@/lib/geo/coordinate-input";
import { BROWSER_PLACEHOLDER } from "@/lib/phoenix-crm/browser-name";
import { isIsoDay } from "@/lib/phoenix-crm/calendar";
import { distanceMeters, isUsableFix } from "@/lib/phoenix-crm/geo";
import { readLocationReaderAnswer } from "@/lib/phoenix-crm/location-reader-probe";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { parseTimings } from "@/lib/phoenix-crm/timings";
import { parseUnplannedReason } from "@/lib/phoenix-crm/unplanned-rules";
import { parseSamplesGiven, type SamplesGiven } from "@/lib/phoenix-crm/samples";
import { parseVisitOutcome, type VisitOutcome } from "@/lib/phoenix-crm/visit-outcome";
import type { PhoenixCrmGrade, PhoenixCrmListType, PhoenixCrmTiming, PhoenixCrmVisitKind } from "@/lib/phoenix-crm/types";

export type EntryRuleResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const CUSTOMER_NAME_MAX = 120;
export const PLACE_TEXT_MAX = 200;
export const VISIT_COMMENT_MAX = 1000;
/** Owner, 2026-09-30: "visit comment is required" — typed or spoken, never left empty. */
export const VISIT_COMMENT_REQUIRED = "Write what happened on the visit — type it or speak it.";
export const DROP_REASON_MAX = 500;
export const VISIT_PRODUCTS_MAX = 12;
export const PHARMACY_NAME_MAX = 120;
/**
 * The pharmacy stock check answers one line's products, not the whole catalogue, so a genuine line
 * never approaches this. It is only a guard against a phone sending a bag of junk keys.
 */
export const PRODUCT_AVAILABILITY_MAX = 60;

/** Whether the pharmacy the rep took feedback from stocks a product, product by product. */
export type ProductAvailability = "has" | "missing";

export const DROP_REASONS = [
  { key: "moved", label: "Moved away" },
  { key: "retired", label: "Retired or stopped practising" },
  { key: "closed", label: "Clinic or place closed" },
  { key: "not_target", label: "Not a target for our line" },
  { key: "duplicate", label: "Duplicate of another customer" },
  { key: "other", label: "Other (write a note)" },
] as const;

export type DropReason = (typeof DROP_REASONS)[number]["key"];

const DROP_REASON_KEYS = new Set<string>(DROP_REASONS.map((reason) => reason.key));

export function dropReasonLabel(key: string | null): string | null {
  if (!key) return null;
  return DROP_REASONS.find((reason) => reason.key === key)?.label ?? null;
}

/**
 * The district manager's read of a new customer's potential, set when he approves an add (owner,
 * 2026-09-29). Stored and shown ONLY: frequency, targets and every KPI read the A/B/C grade.
 */
export const POTENTIAL_GRADES = ["AA", "AB", "AC", "BA", "BB", "BC"] as const;

export type PotentialGrade = (typeof POTENTIAL_GRADES)[number];

export function parsePotentialGrade(value: unknown): PotentialGrade | null {
  const grade = String(value ?? "").trim().toUpperCase();
  return (POTENTIAL_GRADES as readonly string[]).includes(grade) ? (grade as PotentialGrade) : null;
}

export function parseGrade(value: unknown): PhoenixCrmGrade | null {
  const grade = String(value ?? "").trim().toUpperCase();
  return grade === "A" || grade === "B" || grade === "C" ? grade : null;
}

/**
 * A reference grade as iReports360 stores it. The vendor has one "A+" doctor; it reads as A. Anything
 * else unknown is left without a grade rather than guessed.
 */
export function gradeFromReference(value: unknown): PhoenixCrmGrade | null {
  const grade = String(value ?? "").trim().toUpperCase();
  if (grade === "A+") return "A";
  return parseGrade(grade);
}

export function parseListType(value: unknown): PhoenixCrmListType | null {
  const listType = String(value ?? "").trim().toUpperCase();
  return listType === "AM" || listType === "PM" ? listType : null;
}

export function cleanText(value: unknown, max: number): string | null {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.slice(0, max);
}

// ── The evidence captured on the spot ───────────────────────────────────────────────────────────

export type CapturedFix = {
  lat: number;
  lon: number;
  accuracyMeters: number | null;
  /** The phone's clock when the photo was taken, compared with the server's on save. */
  deviceCapturedAt: string | null;
  /**
   * The phone's clock when it TOOK the position above — not when the rep pressed.
   *
   * Two different instants, and the gap between them is the only honest answer to "when was he at the
   * door". A one-tap visit keeps the sharpest reading it has seen and replaces it only with a sharper
   * one or once it is 15 seconds old (`STALE_MS`, use-silent-fix.ts), so a form left open sends a
   * reading older than the tap — while `captured_at`, the server's receipt, has been the only clock on
   * the row.
   *
   * 🔴 BOTH ENDS ON THE PHONE'S OWN CLOCK, deliberately: `deviceCapturedAt` minus this is the age of
   * the reading at the tap, and a handset whose clock is an hour out still reports that age correctly
   * because the error cancels. The skew against the SERVER stays where it already is, on
   * `device_skew_minutes`.
   *
   * Null is NOT MEASURED — an older bundle, or a phone that reported no timestamp. Never refused, and
   * never read as "taken at the tap", which is the one reading that would matter most.
   */
  fixTakenAt: string | null;
  /**
   * Android's own mark on a fix that came from a mock provider — a "Fake GPS" app — as
   * `expo-location` reports it. Null where the question cannot be asked: the web, and iOS.
   *
   * NOTHING IS REFUSED ON THIS (owner, 2026-09-25). It is recorded silently and read only by the
   * Super Admin's integrity board; the rep's save behaves exactly as it always did. A build could of
   * course be patched to stop sending it, which is why it is one signal among several and the others
   * are computed on the server — see src/lib/phoenix-crm/location-integrity.ts.
   */
  deviceMocked: boolean | null;
  /**
   * The PHOTO’s own fix, read at the shutter - never a copy of lat/lon above.
   *
   * Omitted by an older build, by the web, and by any handset whose shutter could not read a
   * position. That is NOT MEASURED and is never refused: a visit saves exactly as before without
   * it, and nothing downstream may read the absence as agreement with the pin.
   */
  photoLat: number | null;
  photoLon: number | null;
  photoAccuracyMeters: number | null;
  photoCapturedAt: string | null;
  /**
   * Whether the BROWSER's own location reader was still its own when this was sent — the question
   * the web can ask where `deviceMocked` cannot (owner, 2026-10-16; location-reader-probe.ts). Null is
   * NOT ASKED: an older bundle, or a page that could not be read. Recorded for the Super Admin's
   * board and refused to nobody, exactly as `deviceMocked` is.
   *
   * Optional on the type so a hand-built fix need not name it; `parseCapturedFix` always sets both.
   */
  readerReplaced?: boolean | null;
  /** Which of the probe's questions answered "replaced", by its own codes and nothing else. */
  readerFindings?: string[];
};

const NO_FIX_AT_THE_PLACE = `Your location was not captured. Allow location for ${BROWSER_PLACEHOLDER} and capture it again at the clinic.`;

/**
 * The one-tap visit takes its location silently. When there is none — location switched off or
 * refused — the save is refused in plain words about HIS OWN work (Golden Rule #1 hides checks, never
 * a save that did not happen): what to switch on, and nothing about any check.
 */
export const NO_FIX_FOR_A_VISIT = `Turn on location for ${BROWSER_PLACEHOLDER}, then tap Log visit again.`;

/**
 * 🔴 THE WIDEST READING THE SERVER TAKES — 250 m to validate a place, 500 m for a visit (owner,
 * 2026-10-03: "accept up to max 500 m in visits and 200 m in validation", then the same hour "inform
 * the rep that validation must be accurate minimum accepted 100m accuracy" — and that evening, shown
 * the first night's refusals, "make the 100m 250m").
 *
 * 🔴 THE 100 m LINE DEAD-ENDED A REP WHOSE PHONE WAS FINE, WHICH IS WHY IT MOVED. Half an hour after
 * the refused-readings table went live it caught nine refusals in 67 seconds from one rep whose PIN
 * read 47 → 58 → 30 → 29 → 27 m — every one inside even the old line — while the photo he took at
 * 21:29:58 read 220 m and never changed: `device_captured_at` was that one instant on all nine rows
 * and `photo_lat`/`photo_lon` were identical to 13 decimals. A retry resends the SAME photo, so each
 * attempt failed on a reading that could not improve, and his coordinate sat 890–911 m from a 2 km
 * privacy-grid corner — no blurring, just a first fix taken before the GPS had settled. The owner was
 * offered the alternative (make a refused photo force a retake, keep 100 m) and chose the wider line.
 *
 * 250 m still refuses what this gate exists to catch: an APPROXIMATE-location phone reports a flat
 * 2,000 m, eight times the line — and the visit's own 500 m stays the wider of the two.
 *
 * On Phoenix CRM's first real day a phone left on APPROXIMATE location validated four different Benha
 * hospitals at one identical point, every reading "within 2,000 m". A place is fixed for good, so each
 * later visit there would have read "0 m apart" — a blur compared with itself — and proved nothing.
 * The place gets the tighter line because it is the point every visit is measured against.
 *
 * 🔴 VALIDATION JUDGES THE CAPTURE-LOCATION PIN ALONE (owner, 2026-10-11, "A" when asked directly). It
 * was BOTH readings from 2026-10-03 ("the system should never accept a photo or location … in
 * validation"); on iPhone Safari the camera is handed an approximate position (2,000 m, 650-1,900 m)
 * while the pin reads 11-30 m, so reps AT the clinic were refused at the end, again and again. A sharp
 * pin now validates beside a rough photo reading, a rough pin is still refused, and the photo's raw
 * reading is stored and read by the integrity board, never by the rep. Never restore the photo gate.
 *
 * 🔴 AND THE SETTING IS NAMED BY THE REP'S OWN BROWSER, NEVER "Phoenix" (2026-10-03). These sentences
 * said "Turn on precise location for Phoenix" — a setting no phone has, because the rep is in a
 * browser and the permission belongs to Chrome, Firefox or Safari. The rep above hunted it for seven
 * hours and tried a second browser before giving up on eighteen planned visits. They now carry
 * `BROWSER_PLACEHOLDER` (browser-name.ts), which the screen replaces with the name on his own settings
 * screen; the sentence is already true unsubstituted, so the server still guesses at nothing.
 *
 * 🔴 AND IT NO LONGER DEAD-ENDS A REP WHO HAS ALREADY SWITCHED IT ON (2026-10-03, same rep, same
 * evening). She turned precise location on — her coordinate came off the 2 km privacy grid and
 * resolved to a street in Banha 2 — and the refusal still told her to switch on the thing she had
 * just switched on, eighteen more times between 16:12 and 18:47. A real coordinate with a wide
 * radius is what a phone reports INDOORS, where no satellite is in view: the second clause is the
 * only way out of that, and without it the sentence is a loop. It still never states his reading
 * (owner, 2026-09-29) — "step outside and wait" is advice about his own work, not a number.
 *
 * A reading wider than its line is treated exactly as NO reading, refused in plain words about his own
 * phone — what to switch on. 🔴 THE PLACE'S LINE IS TOLD TO THE REP, BY THE OWNER'S WORD: the
 * validation screen states it before he starts (`PLACE_PRECISION_NOTE`) and the refusal repeats it.
 * That is a stated requirement of HIS OWN work, like "take a live photo". 🔴 AND SINCE 2026-10-03 THE
 * REFUSAL ALSO NAMES HIS OWN READING ("your phone gave 2,000 m") — the owner's amendment to his
 * 2026-09-29 rule, scoped to this one sentence; see `roughFixAtThePlace` below for what it cost not to
 * have it. The visit's LINE is still never put into words (Golden Rule #1): his reading is about his
 * phone, the line is about the check on him. An UNKNOWN accuracy is still
 * taken, as it always was, and so is a photo whose shutter could not read a position at all. The
 * weak-signal flag in Settings (`weak_gps_meters`) is separate and unchanged: a visit between that
 * line and the visit's line saves, flagged for the manager.
 */
export const PLACE_MAX_ACCURACY_METERS = 250;
export const VISIT_MAX_ACCURACY_METERS = 500;

/** Shown on the validation screen before the photo — the rule, never his reading. */
export const PLACE_PRECISION_NOTE = `Validation needs an accurate location, within ${PLACE_MAX_ACCURACY_METERS} m. Turn on precise location for ${BROWSER_PLACEHOLDER} before you start, and take the photo and capture the location standing at the clinic.`;

// ── A rep's visit is logged at the customer's validated place (owner, 2026-10-20) ───────────────────

/**
 * 🔴 A MEDICAL REP'S VISIT LOGGED MORE THAN 300 m FROM THE CUSTOMER'S VALIDATED PHOTOGRAPH IS REFUSED
 * (owner, 2026-10-20: "MAKE THE SYSTEM NOT ACCEPT MEDICAL REPS VISITS LOGGED AWAY FROM THE VALIDATED
 * PICTURE OF THE CUSTOMER WITH MAXIMUM 300 M APPART").
 *
 * Until that day the same 300 m line (`visit_far_meters`, read live) only FLAGGED a visit silently for
 * the managers, and the rep was told nothing (Golden Rule #1). His word makes it the module's third
 * refusal a rep can meet about where he stands, beside "no reading" and "too rough". Measured on
 * production for 6-19 October 2026: 97 of 2,558 measurable rep visits (3.8%) sat past the line, 38 of
 * them more than a kilometre out — those are what this now turns away.
 *
 * The sentence is about HIS OWN work — be at the customer when you log the call — and never states the
 * line, his distance or the word for any check, exactly as `NO_FIX_FOR_A_VISIT` does. Its second clause
 * is the way out for a rep who IS at the door on a reading that has not settled yet: the same advice
 * the rough-reading refusal gives, so an honest rep is never dead-ended.
 */
export const VISIT_AWAY_FROM_PLACE =
  "This visit can be logged only at the customer's place, and your location now is not there. If you are at the place, step outside, wait a moment for the location to settle, then tap Log visit again.";

/** One active place of the customer on this seat, with both of its readings. */
export type ValidatedPlaceReading = {
  id: string;
  /** The place's own point — the reading its validation settled on (`point_source`). */
  lat: number;
  lon: number;
  /** The shutter's own reading at the door, when the photograph carried one. */
  photoLat: number | null;
  photoLon: number | null;
  photoAccuracyMeters: number | null;
};

/**
 * Where the customer's validated photograph says the place is — THE PHOTOGRAPH IS THE ANCHOR (owner,
 * 2026-10-13, and again on 2026-10-20: "the validated picture of the customer").
 *
 * 🔴 BUT ONLY A SHARP PHOTOGRAPH READING ANCHORS. Since 2026-10-11 a place validates on its PIN alone,
 * because iPhone Safari hands the camera an approximate position (650-2,000 m) while the pin reads
 * 11-30 m — so a photograph's raw reading can sit a kilometre from the door it shows. Measuring a
 * visit against that would refuse an honest rep standing at the door, for good, since a place never
 * moves. A photograph reading within the place's own line (`PLACE_MAX_ACCURACY_METERS`), or one whose
 * phone reported no accuracy, is the anchor; otherwise the place's own validated point is. Measured on
 * production 2026-10-20: 2,510 of 2,627 active places anchor on the photograph, 11 carry a reading
 * wider than 250 m, and the 104 seated in a polyclinic carry none and anchor on the building's point.
 *
 * Since 2026-10-21 this is ONE of the two readings a visit is measured against, never the only one — see
 * `validatedPlaceReadings` for why.
 */
export function validatedPlaceAnchor(place: ValidatedPlaceReading): { lat: number; lon: number } | null {
  if (isUsableFix(place.photoLat, place.photoLon) && withinAccuracy(place.photoAccuracyMeters, PLACE_MAX_ACCURACY_METERS)) {
    return { lat: Number(place.photoLat), lon: Number(place.photoLon) };
  }
  if (isUsableFix(place.lat, place.lon)) return { lat: Number(place.lat), lon: Number(place.lon) };
  return null;
}

/**
 * 🔴 A VISIT IS MEASURED AGAINST BOTH READINGS OF THE PLACE — THE PHOTOGRAPH'S ANCHOR AND THE PLACE'S OWN
 * VALIDATED POINT — AND THE NEARER ONE DECIDES (owner, 2026-10-21, picked from three options after a rep
 * was refused 26 times at a hospital he was standing in).
 *
 * The photograph alone could not carry a 300 m line. Sehet Behteem Hospital's photograph read ±200 m
 * (inside the 250 m "sharp" line) and sat 327 m from the pin the rep captured at the door (±7.9 m), so a
 * rep standing 7-91 m from that pin, on a GPS reading good to ±3-11 m, was measured 324-401 m from a
 * point that could itself be 200 m off — and refused 26 times between 12:07 and 14:38 Cairo on
 * 2026-10-21. His two visits there on 13 and 15 October, before the rule, had read 52-54 m from the pin
 * and flagged ok: three separate days at the pin say the pin is the door.
 *
 * Both readings were taken at the door by the rep who validated the place, so being within the line of
 * EITHER is being at the customer's place — and a rep standing at the validated door is never refused,
 * which is the aim this module's comments name each time the line moves. Measured 2026-10-21 on
 * production: of 2,720 places anchored on a photograph, 2,712 carry a photograph within 100 m of the pin,
 * so for them the nearer reading barely moves the verdict; 8 sit 104 m or more apart, and this hospital
 * (327 m) is the one a rep was refused at. A moved place (`phoenix_crm_move_place`, which never rewrites
 * the photograph) now takes effect for the first time, because its new point is one of the two readings.
 *
 * 🔴 A photograph reading wider than the place's own line is still NOT a reading: it falls out and the
 * point alone stands, exactly as before. Never widen this to the photograph's accuracy circle or to the
 * visit's own radius — the line stays `visit_far_meters` from the nearer of exactly these two points.
 */
export function validatedPlaceReadings(place: ValidatedPlaceReading): { lat: number; lon: number }[] {
  const readings: { lat: number; lon: number }[] = [];
  const anchor = validatedPlaceAnchor(place);
  if (anchor !== null) readings.push(anchor);
  if (isUsableFix(place.lat, place.lon)) {
    const point = { lat: Number(place.lat), lon: Number(place.lon) };
    // A place with no sharp photograph reading anchors on this very point: one reading, never two.
    if (anchor === null || anchor.lat !== point.lat || anchor.lon !== point.lon) readings.push(point);
  }
  return readings;
}

export type VisitPlaceVerdict = {
  /** True only when the customer HAS a validated place and every one of them is past the line. */
  refused: boolean;
  /** Metres to the NEAREST validated place — null when the customer has none to measure against. */
  metres: number | null;
  placeId: string | null;
  /** The line the verdict was given against, kept with any refusal so a later change cannot rewrite it. */
  farMeters: number;
};

/** The owner's 300 m, used only when the settings row hands over something that is not a distance. */
export const VISIT_FAR_FROM_PLACE_DEFAULT_METERS = 300;

/**
 * 🔴 THE REFUSAL STARTS ON THIS VISIT DAY AND NEVER REACHES BACK (owner, 2026-10-20: "do not refuse
 * historical — start from today this rule"). No saved visit is re-judged, un-counted or moved by it —
 * the rule lives only in the save — and a visit CAPTURED before this day is never refused even when it
 * arrives later: an app visit taken with no signal on an earlier day and synced afterwards is judged
 * by the day it was captured (`offline_captured_at`), and so is a photo-slot save, by its slot.
 */
export const FAR_VISIT_REFUSAL_FROM_DAY = "2026-10-20";

/** Does the far-visit refusal apply to a visit captured on this Cairo visit day (`cairoBusinessDay`)? */
export function farVisitRefusalApplies(captureVisitDay: string): boolean {
  return typeof captureVisitDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(captureVisitDay) && captureVisitDay >= FAR_VISIT_REFUSAL_FROM_DAY;
}

/**
 * Is this visit's reading within the line of the customer's validated place?
 *
 * - The NEAREST place decides: a customer with two clinics is at whichever door the rep stood at. And
 *   within a place the NEARER of its two readings decides (`validatedPlaceReadings`): the photograph's
 *   anchor and the validated pin.
 * - A customer with NO validated place is never refused — there is no photograph to be away from (a
 *   pharmacy, which needs no validation, and a customer still waiting for one).
 * - The line is `visit_far_meters` from the module's settings (300 m on production), the same figure a
 *   visit's `location_flag` and the photograph detector are written with, so the refusal, the flag and
 *   the board can never disagree about what far means.
 * - 🔴 THE VISIT'S OWN ACCURACY EXCUSES NOTHING HERE. The integrity board drops a finding whose radius
 *   reaches the door, because a board must not accuse; a door that let the radius widen the line would
 *   let a rep log from 500 m on a rough reading (`VISIT_MAX_ACCURACY_METERS`). Measured 2026-10-20: not
 *   one of the 97 visits past the line was within its own radius, so the guard would have excused none.
 */
export function visitAwayFromValidatedPlace(input: {
  fix: { lat: number; lon: number };
  places: readonly ValidatedPlaceReading[];
  farMeters: number;
}): VisitPlaceVerdict {
  const farMeters = Number.isFinite(input.farMeters) && input.farMeters > 0 ? input.farMeters : VISIT_FAR_FROM_PLACE_DEFAULT_METERS;
  if (!isUsableFix(input.fix.lat, input.fix.lon)) return { refused: false, metres: null, placeId: null, farMeters };
  let nearest: { id: string; metres: number } | null = null;
  for (const place of input.places) {
    for (const reading of validatedPlaceReadings(place)) {
      const metres = distanceMeters({ lat: input.fix.lat, lon: input.fix.lon }, reading);
      if (nearest === null || metres < nearest.metres) nearest = { id: place.id, metres };
    }
  }
  if (nearest === null) return { refused: false, metres: null, placeId: null, farMeters };
  return { refused: nearest.metres > farMeters, metres: nearest.metres, placeId: nearest.id, farMeters };
}

/**
 * What the frame drawn on the camera must contain, shown inside the frame itself.
 *
 * Owner, 2026-10-08: require the customer's name always, no exception for a building with no
 * nameplate. Until that day the module asked for a photo and said nothing whatever about what had to
 * be IN it, which is the largest single cause of the 179 failures among its first 643 captures — a
 * rep cannot satisfy a requirement nobody ever stated.
 *
 * It is a statement of HIS OWN work, like "take a live photo", and not a word about any check on him
 * (Golden Rule #1). 🔴 It may not say "doctor": tests/phoenix-crm-am-pm-words.test.ts refuses that
 * string anywhere under src/lib/phoenix-crm.
 */
export const SIGNBOARD_FRAME_NOTE =
  "Put the signboard inside the box, with the customer's name readable.";

/**
 * 🔴 A CUSTOMER'S PLACE IS PHOTOGRAPHED AT HIS OWN NAMEPLATE, NEVER "THE CLINIC SIGN OR DOOR" (2026-10-18).
 * The old words named a DOOR as good enough, and the audit of 532 places filed "Not readable" found
 * exactly that: hospital fronts, bare doors, a street — every one accepted at the door because nothing
 * said the name had to be in it. `SIGNBOARD_FRAME_NOTE` above stays for a polyclinic's own building
 * sign, which names the building and nobody inside it.
 */
export const NAMEPLATE_FRAME_NOTE = "Photograph the customer's own nameplate, close enough that the name fills the box.";
export const PLACE_PHOTO_NEEDED = "Take a live photo of the customer's own nameplate.";

export const ROUGH_FIX_AT_THE_PLACE = `Validation needs an accurate location, within ${PLACE_MAX_ACCURACY_METERS} m, and your phone gave only a rough one. Turn on precise location for ${BROWSER_PLACEHOLDER}; if it is already on, step outside the building and wait a few seconds, then take the photo and press Capture location again at the clinic.`;
export const ROUGH_FIX_FOR_A_VISIT = `Your phone gave only a rough location. Turn on precise location for ${BROWSER_PLACEHOLDER}; if it is already on, step outside the building and wait a few seconds, then tap Log visit again.`;

/**
 * 🔴 THE REFUSAL NOW NAMES THE REP'S OWN READING (owner, 2026-10-03, asked directly and answered
 * "show the rep her own accuracy number on the refusal"). It AMENDS his 2026-09-29 rule — which said
 * the rep reads WHERE, never HOW WELL — for this one sentence and no other: the read-only location
 * block on the validation screen still shows no coordinate and no accuracy, and the raw readings stay
 * the Super Admin's and the SFE Manager's on the place-move screen.
 *
 * What it cost not to have it: a rep met "your phone gave only a rough one" eighteen times between
 * 16:12 and 18:47 and could not tell 2,000 m from 110 m, so she could not tell whether anything she
 * tried was helping. Nor could the office — a refused reading is never stored, so the number existed
 * for one instant on her screen and nowhere else.
 *
 * 🔴 HIS OWN READING IS NOT THE LINE. The visit's line (`VISIT_MAX_ACCURACY_METERS`) is still never
 * put into words anywhere a rep can read it (Golden Rule #1) — telling him the check sits at 500 m
 * tells him exactly how far he may stand from the clinic. "Your phone gave 2,000 m" tells him about
 * his phone and nothing about the check, which is why one is now said and the other still is not.
 */
function metresSaid(accuracyMeters: number): string {
  return `${Math.round(accuracyMeters).toLocaleString("en-US")} m`;
}

/** The widest reading that put a place outside its line, or null when neither number is to blame. */
export function roughestPlaceReading(fix: CapturedFix): number | null {
  // The PIN alone decides since 2026-10-11 (`placeReadingsPrecise`), so it is the only number to name.
  return fix.accuracyMeters !== null && fix.accuracyMeters > PLACE_MAX_ACCURACY_METERS ? fix.accuracyMeters : null;
}

export function roughFixAtThePlace(fix: CapturedFix): string {
  const reading = roughestPlaceReading(fix);
  if (reading === null) return ROUGH_FIX_AT_THE_PLACE;
  return `Validation needs an accurate location, within ${PLACE_MAX_ACCURACY_METERS} m, and your phone gave ${metresSaid(reading)}. Turn on precise location for ${BROWSER_PLACEHOLDER}; if it is already on, step outside the building and wait a few seconds, then take the photo and press Capture location again at the clinic.`;
}

export function roughFixForAVisit(fix: CapturedFix): string {
  if (fix.accuracyMeters === null) return ROUGH_FIX_FOR_A_VISIT;
  // His reading, never the line he is being measured against.
  return `Your phone gave ${metresSaid(fix.accuracyMeters)}, which is too rough to log a visit. Turn on precise location for ${BROWSER_PLACEHOLDER}; if it is already on, step outside the building and wait a few seconds, then tap Log visit again.`;
}

/** Whether a reading is inside a line. Unknown is inside: it is never refused, as before. */
export function withinAccuracy(accuracyMeters: number | null, maxMeters: number): boolean {
  return accuracyMeters === null || accuracyMeters <= maxMeters;
}

export function parseCapturedFix(raw: Record<string, unknown>, noFixMessage = NO_FIX_AT_THE_PLACE): EntryRuleResult<CapturedFix> {
  if (!isUsableFix(raw.lat, raw.lon)) {
    return { ok: false, error: noFixMessage };
  }
  // Not `Number(...)`, which reads "" and " " as 0: a phone that reported no accuracy was saved as a
  // perfect 0 m fix and shown to the manager as "within 0 m". A blank accuracy is unknown.
  const accuracy = readAccuracyInput(raw.accuracyMeters);
  const deviceCapturedAt = typeof raw.deviceCapturedAt === "string" && !Number.isNaN(Date.parse(raw.deviceCapturedAt)) ? raw.deviceCapturedAt : null;
  // The same guard, for the same reason: a junk value is NOT MEASURED, never a date, and never a
  // refusal. A phone one release behind sends nothing here and saves its visit exactly as before.
  const fixTakenAt = typeof raw.fixTakenAt === "string" && !Number.isNaN(Date.parse(raw.fixTakenAt)) ? raw.fixTakenAt : null;
  // Strictly a boolean or nothing. A body that omits it — an older build, the web, iOS — is
  // "not asked", never "clean", and is never refused for the omission.
  const deviceMocked = typeof raw.deviceMocked === "boolean" ? raw.deviceMocked : null;
  return {
    ok: true,
    value: {
      lat: Number(raw.lat),
      lon: Number(raw.lon),
      accuracyMeters: accuracy !== null && accuracy >= 0 ? Math.round(accuracy * 10) / 10 : null,
      deviceCapturedAt,
      fixTakenAt,
      deviceMocked,
      ...readLocationReaderAnswer(raw),
      // Read through the SAME guards as the pin, and independently of it: a body carrying only
      // half a shutter pair contributes no coordinate at all rather than a lopsided one. Never
      // defaulted to the pin - that substitution is the defect #4781 removed elsewhere.
      photoAccuracyMeters: (() => {
        const photoAccuracy = readAccuracyInput(raw.shutterAccuracyMeters);
        return photoAccuracy !== null && photoAccuracy >= 0 ? Math.round(photoAccuracy * 10) / 10 : null;
      })(),
      photoCapturedAt:
        typeof raw.shutterCapturedAt === "string" && !Number.isNaN(Date.parse(raw.shutterCapturedAt))
          ? raw.shutterCapturedAt
          : null,
      photoLat: isUsableFix(raw.shutterLat, raw.shutterLon) ? Number(raw.shutterLat) : null,
      photoLon: isUsableFix(raw.shutterLat, raw.shutterLon) ? Number(raw.shutterLon) : null,
    },
  };
}

// ── Validating a customer (a place with its timings) ────────────────────────────────────────────

/**
 * What the phone may say about a place: its NAME, its photo, its timings, and the raw fix.
 *
 * Owner, 2026-09-23: "the capture location is never editable and its separated when captured to
 * brick area region clean addresss and raw location". So the address, the part of town, the brick,
 * the area and the region are NOT on this type at all — they are derived on the SERVER from the
 * captured coordinates (`placePayload`, server/list.ts) and frozen there. A body that still carries
 * an `address`, `zone` or `brick` key is ignored rather than refused, so a phone still holding the
 * previous bundle keeps validating; its typed address simply stops being read.
 *
 * `label` stays typed: a place's NAME ("Evening clinic") is what the rep calls it, not where it is.
 */
export type PlaceDraft = CapturedFix & {
  label: string | null;
  photoPath: string;
  timings: PhoenixCrmTiming[];
  /**
   * When the Capture-location button took ITS reading — not when the photo was taken.
   *
   * 🔴 ON `PlaceDraft` AND NOT ON `CapturedFix`, deliberately: only a place is captured twice, so a
   * visit and a marketing capture have no second reading for this to be the time of, and widening the
   * shared shape would put a field on three parsers none of them can fill. Null from any caller that
   * does not send it, and `assessCaptureTrust` then reports the gap as UNMEASURED rather than as
   * agreement — an absence of a timestamp is never corroboration.
   *
   * It is not stored on the place row: the only thing that reads it is the capture-trust comparison,
   * which runs in the same request as the save.
   */
  pinCapturedAt: string | null;
};

/**
 * The place's FIXED point: the photo's own reading, else the pin (owner, 2026-09-29 — "the photo + the
 * location of photo is the more trustable", his ruling for marketing and direct orders the same day).
 * Both raw readings are stored beside it; this only chooses which one the address, brick, area and
 * region are resolved from, and which one every later visit is measured against.
 *
 * Which reading is chosen never rescues a rough PIN: `parsePlaceDraft` refuses a place whose pin is
 * wider than `PLACE_MAX_ACCURACY_METERS` before it gets here, and the SHARPER reading fixes the place
 * (`pickPlacePoint`; owner, 2026-10-11, replacing the 2026-10-03 both-readings rule).
 */
export type PlacePoint = { lat: number; lon: number; accuracyMeters: number | null; source: "photo" | "pin" };

/** One reading of a place: a coordinate and the radius the phone claimed for it (null when unknown). */
export type PlaceReading = { lat: number; lon: number; accuracyMeters: number | null };

/**
 * Which of a place's two readings fixes it: THE SHARPER ONE, the photo's on a tie (owner, 2026-10-11,
 * "perfect fix" after a rep read a wrong address on a place she validated).
 *
 * The photo's reading stays the fixed point whenever it is at least as sharp as the pin, as ruled on
 * 2026-09-29 ("the photo + the location of photo is the more trustable"), and when the photo's accuracy
 * is unknown. But a place is fixed FOR GOOD and its address, brick and area are resolved from this one
 * point, so a photo reading with a wide radius must never beat a pin that is plainly tighter: iPhone
 * Safari hands the camera an approximate position (up to the 250 m line, or 2,000 m) while the same
 * phone's Capture-location button reads 11-30 m, and the address of a point 200 m off is the wrong
 * street. Pure, so the capture screen shows the address of the SAME point the server will save.
 */
export function pickPlacePoint(photo: PlaceReading | null, pin: PlaceReading): PlacePoint {
  const pinIsSharper =
    photo !== null && photo.accuracyMeters !== null && pin.accuracyMeters !== null && pin.accuracyMeters < photo.accuracyMeters;
  if (photo !== null && !pinIsSharper) {
    return { lat: photo.lat, lon: photo.lon, accuracyMeters: photo.accuracyMeters, source: "photo" };
  }
  return { lat: pin.lat, lon: pin.lon, accuracyMeters: pin.accuracyMeters, source: "pin" };
}

export function placePoint(fix: CapturedFix): PlacePoint {
  const photo: PlaceReading | null =
    fix.photoLat !== null && fix.photoLon !== null
      ? { lat: fix.photoLat, lon: fix.photoLon, accuracyMeters: fix.photoAccuracyMeters }
      : null;
  return pickPlacePoint(photo, { lat: fix.lat, lon: fix.lon, accuracyMeters: fix.accuracyMeters });
}

/**
 * Whether a place's reading is inside its line — decided by the PIN (the Capture-location reading)
 * ALONE. 🔴 OWNER, 2026-10-11, answering "A" when asked directly: a sharp pin validates the place even
 * when the photo's own reading is rough. This REPLACES the 2026-10-03 rule that BOTH readings had to be
 * inside the line. Why: on iPhone Safari the camera is handed an APPROXIMATE position (a flat 2,000 m,
 * 650-1,900 m) while the same phone's Capture-location button reads 11-30 m, so reps standing at the
 * clinic were refused at the end, again and again (B-182, B-158). A rough PIN is still refused, and the
 * photo's raw reading is still stored (and still read by the integrity board, above the rep).
 */
export function placeReadingsPrecise(fix: CapturedFix): boolean {
  return withinAccuracy(fix.accuracyMeters, PLACE_MAX_ACCURACY_METERS);
}

// ── What a REFUSED capture was carrying ─────────────────────────────────────────────────────────

/**
 * 🔴 A REFUSED READING USED TO SURVIVE NOWHERE AT ALL, AND THAT IS WHAT THIS ANSWERS (owner,
 * 2026-10-03: "record the refused readings so the next refusal is traceable").
 *
 * `phoenix_crm_location_integrity` is filed AFTER a save succeeds; a refused capture creates no place
 * and no visit; the upload slot keeps only the fact that a slot was asked for. So the number the
 * refusal turned on lived for one instant on the rep's screen and nowhere else — and on 2026-10-03 a
 * rep met the rough-location refusal eighteen times in two and a half hours while the office could not
 * read a single one of those eighteen numbers. Her 2,000 m is knowable at all only because four
 * captures of hers were ACCEPTED earlier that morning, before the 100 m line shipped at 11:24.
 *
 * This is the classifier only: it says what the phone sent and which refusal it was, and writes
 * nothing. The write is `server/refused-readings.ts`, which is void and never throws — the rep's
 * refusal is identical, in the same words, with or without it (Golden Rule #1).
 *
 * 🔴 IT MUST NEVER RE-STATE A THRESHOLD. The two lines move (the place's 100 m is nine days old), so
 * this asks the SAME predicates the doors ask — `placeReadingsPrecise` and `withinAccuracy` — and a
 * capture those accept returns null here. Otherwise a refusal and its record could disagree about
 * whether a reading was rough, which is a worse state than having no record.
 */
export type RefusedReading = {
  /** `no_fix`: no usable coordinate at all. `rough`: a real coordinate, wider than its line. */
  reason: "no_fix" | "rough";
  lat: number | null;
  lon: number | null;
  accuracyMeters: number | null;
  photoLat: number | null;
  photoLon: number | null;
  photoAccuracyMeters: number | null;
  /**
   * 🔴 THE PHOTO ITSELF — the storage path of the live photo the refused capture was carrying
   * (owner, 2026-10-03: "save the photo when a validation is refused").
   *
   * Until this field the refusal kept the photo's two COORDINATES and threw away the picture: the
   * JPEG was already in the bucket, because the browser PUTs it to its slot before the save is even
   * attempted, but nothing pointed at it — `phoenix_crm_photo_uploads` holds only that a slot was
   * asked for, and a refused place or visit row is never created. So the one piece of evidence that
   * shows WHERE the rep was actually standing, readable by a person rather than inferred from a
   * radius, was reachable only by hand-joining unused slots to `storage.objects`.
   *
   * Null for a visit refused with no photo, and for a capture whose body carried no path at all.
   * Nothing is uploaded or deleted here: the bytes exist already and no sweep removes an unused
   * slot, so this is a pointer being kept rather than a file being saved a second time.
   */
  photoPath: string | null;
  deviceCapturedAt: string | null;
  deviceMocked: boolean | null;
  /** The line it had to be inside, stored with the reading so a later rule change cannot rewrite it. */
  maxAccuracyMeters: number;
};

/** The photo's own storage path, read with the same 200-character bound `parseVisitDraft` uses. */
function photoPathOf(body: Record<string, unknown>): string | null {
  const path = String(body.photoPath ?? "").trim();
  return path ? path.slice(0, 200) : null;
}

/** The shutter's own pair, read through the same guards as the pin and never defaulted to it. */
function photoReadingOf(body: Record<string, unknown>): Pick<RefusedReading, "photoLat" | "photoLon" | "photoAccuracyMeters"> {
  const read = isUsableFix(body.shutterLat, body.shutterLon);
  const accuracy = readAccuracyInput(body.shutterAccuracyMeters);
  return {
    photoLat: read ? Number(body.shutterLat) : null,
    photoLon: read ? Number(body.shutterLon) : null,
    photoAccuracyMeters: accuracy !== null && accuracy >= 0 ? Math.round(accuracy * 10) / 10 : null,
  };
}

/**
 * What a refused capture was carrying, or **null when the location was not what refused it** — a
 * missing comment, no products, no photo, a bad customer id. Only a LOCATION refusal is recorded:
 * a table that also held every mistyped form would be a table nobody reads.
 */
export function refusedReadingOf(raw: unknown, subjectKind: "place" | "visit"): RefusedReading | null {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const maxAccuracyMeters = subjectKind === "place" ? PLACE_MAX_ACCURACY_METERS : VISIT_MAX_ACCURACY_METERS;
  const fix = parseCapturedFix(body);
  if (!fix.ok) {
    // No usable pin, so there is no coordinate to store — but the accuracy the phone claimed, its
    // clock and the shutter's own pair may all still be readable, and each is worth having.
    const accuracy = readAccuracyInput(body.accuracyMeters);
    return {
      reason: "no_fix",
      lat: null,
      lon: null,
      accuracyMeters: accuracy !== null && accuracy >= 0 ? Math.round(accuracy * 10) / 10 : null,
      ...photoReadingOf(body),
      photoPath: photoPathOf(body),
      deviceCapturedAt: typeof body.deviceCapturedAt === "string" && !Number.isNaN(Date.parse(body.deviceCapturedAt)) ? body.deviceCapturedAt : null,
      deviceMocked: typeof body.deviceMocked === "boolean" ? body.deviceMocked : null,
      maxAccuracyMeters,
    };
  }
  const precise =
    subjectKind === "place" ? placeReadingsPrecise(fix.value) : withinAccuracy(fix.value.accuracyMeters, VISIT_MAX_ACCURACY_METERS);
  if (precise) return null;
  return {
    reason: "rough",
    lat: fix.value.lat,
    lon: fix.value.lon,
    accuracyMeters: fix.value.accuracyMeters,
    photoLat: fix.value.photoLat,
    photoLon: fix.value.photoLon,
    photoAccuracyMeters: fix.value.photoAccuracyMeters,
    photoPath: photoPathOf(body),
    deviceCapturedAt: fix.value.deviceCapturedAt,
    deviceMocked: fix.value.deviceMocked,
    maxAccuracyMeters,
  };
}

export function parsePlaceDraft(raw: unknown): EntryRuleResult<PlaceDraft> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const photoPath = String(body.photoPath ?? "").trim();
  if (!photoPath) return { ok: false, error: PLACE_PHOTO_NEEDED };
  const fix = parseCapturedFix(body);
  if (!fix.ok) return fix;
  // A place is fixed for good: a rough photo OR a rough pin is no reading (owner, 2026-10-03).
  if (!placeReadingsPrecise(fix.value)) return { ok: false, error: roughFixAtThePlace(fix.value) };
  const timings = parseTimings(body.timings);
  if (!timings.ok) return { ok: false, error: timings.error };
  return {
    ok: true,
    value: {
      ...fix.value,
      label: cleanText(body.label, PLACE_TEXT_MAX),
      photoPath,
      // Read, never required: a caller that sends no pin timestamp leaves the gap unmeasured, which is
      // what it is. An ISO string is the only shape accepted; anything else is no reading.
      pinCapturedAt: typeof body.pinCapturedAt === "string" && !Number.isNaN(Date.parse(body.pinCapturedAt))
        ? body.pinCapturedAt
        : null,
      timings: timings.timings,
    },
  };
}

export type NewCustomerDraft = {
  listType: PhoenixCrmListType;
  name: string;
  speciality: string | null;
  proposedGrade: PhoenixCrmGrade;
};

/**
 * A customer the rep met who is not on his list: AM or PM chosen BY HAND (owner, 2026-09-29 — "it is
 * not AM because he entered it in the morning; let him choose it"), the name and the speciality.
 */
export type OutsideCustomerDraft = Omit<NewCustomerDraft, "proposedGrade">;

export function parseOutsideCustomer(raw: unknown): EntryRuleResult<OutsideCustomerDraft> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const listType = parseListType(body.listType);
  if (!listType) return { ok: false, error: "Choose AM or PM." };
  const name = cleanText(body.name, CUSTOMER_NAME_MAX);
  if (!name || name.length < 3) return { ok: false, error: "Write the customer's full name." };
  return { ok: true, value: { listType, name, speciality: cleanText(body.speciality, 80) } };
}

/** "Add new customer": the same, plus the grade he proposes — the district manager, then SFE, decide. */
export function parseNewCustomer(raw: unknown): EntryRuleResult<NewCustomerDraft> {
  const base = parseOutsideCustomer(raw);
  if (!base.ok) return base;
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const proposedGrade = parseGrade(body.proposedGrade);
  if (!proposedGrade) return { ok: false, error: "Propose a grade (A, B or C). Your district manager and SFE approve it." };
  return { ok: true, value: { ...base.value, proposedGrade } };
}

// ── The customer's phone (owner, 2026-09-30) ────────────────────────────────────────────────────

/** A phone once cleaned: an optional "+", then 7 to 15 digits. The database checks the same shape. */
export const CUSTOMER_PHONE_PATTERN = /^\+?[0-9]{7,15}$/;
/** What the box accepts while he types — room for the spaces and dashes people write a number with. */
export const CUSTOMER_PHONE_INPUT_MAX = 24;
export const CUSTOMER_PHONE_ERROR = "Write the phone as digits — 7 to 15 of them — or leave it empty.";

const ARABIC_INDIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/**
 * The customer's phone as the rep typed it (owner, 2026-09-30: "Add a phone to validation" — optional,
 * corrected later in "Change the details", and ONLY what the rep types: the old list's phones are never
 * used). An Arabic keyboard types ٠١٠… — the same digits. Spaces, dashes, dots and brackets are how a
 * number is written, not part of it, and the invisible direction marks an Arabic screen adds on a copy
 * are dropped with them; "00" before a country code is the "+" it stands for. Empty is no phone at all,
 * never a refusal: it is optional.
 */
export function parseCustomerPhone(value: unknown): EntryRuleResult<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: CUSTOMER_PHONE_ERROR };
  let digits = "";
  for (const char of value) {
    const arabic = ARABIC_INDIC_DIGITS.indexOf(char);
    const persian = PERSIAN_DIGITS.indexOf(char);
    digits += arabic >= 0 ? String(arabic) : persian >= 0 ? String(persian) : char;
  }
  let phone = digits.replace(/[\s\-.()‎‏؜]/g, "");
  if (phone === "") return { ok: true, value: null };
  if (phone.startsWith("00")) phone = `+${phone.slice(2)}`;
  return CUSTOMER_PHONE_PATTERN.test(phone) ? { ok: true, value: phone } : { ok: false, error: CUSTOMER_PHONE_ERROR };
}

// ── A pharmacy's own location (owner, 2026-10-09) ───────────────────────────────────────────────

/**
 * The pin a rep may put on a pharmacy — adding one, or visiting one (owner, 2026-10-09: "make it
 * optional to add its location by a pin button … optional, if you want to save its location do this,
 * if you want also don't do this").
 *
 * OPTIONAL MEANS OPTIONAL: no pin at all is `null` and never a refusal, and nothing about a pharmacy
 * — adding it, visiting it, its feedback — is ever held up by the absence of one. There is no photo,
 * no second reading and no shutter fix: a pharmacy is not validated at its door the way a doctor is,
 * so this is one position, recorded because the rep chose to record it.
 *
 * 🔴 BUT A REFUSED READING IS NOT SAVED SILENTLY. The whole point of the pin is that the server reads
 * the governorate, the area and the brick off it; a phone left on APPROXIMATE location reports a flat
 * 2,000 m, which lands in a different brick from the one the rep is standing in and would be read
 * later as fact. So a reading wider than the VISIT line — the module's existing, wider line, not the
 * validation one — is refused in plain words about his own phone, and he can still save the pharmacy
 * with no location at all. An UNKNOWN accuracy is taken, exactly as everywhere else in this file.
 */
export const ROUGH_PIN_AT_THE_PHARMACY = `Your phone gave only a rough location, so the pharmacy's place was not saved. Turn on precise location for ${BROWSER_PLACEHOLDER}; if it is already on, step outside and wait a few seconds, then press Capture location again — or save the pharmacy without it.`;
const NO_FIX_AT_THE_PHARMACY = `Your location was not captured. Allow location for ${BROWSER_PLACEHOLDER} and capture it again at the pharmacy — or save the pharmacy without it.`;

export type PharmacyPinDraft = { lat: number; lon: number; accuracyMeters: number | null; capturedAt: string | null };

export function parsePharmacyPin(raw: unknown): EntryRuleResult<PharmacyPinDraft | null> {
  // Absent, null, or an empty object: he chose not to pin it. Not an error.
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "object") return { ok: false, error: NO_FIX_AT_THE_PHARMACY };
  const body = raw as Record<string, unknown>;
  if (body.lat === undefined && body.lon === undefined) return { ok: true, value: null };
  const fix = parseCapturedFix(body, NO_FIX_AT_THE_PHARMACY);
  if (!fix.ok) return fix;
  if (!withinAccuracy(fix.value.accuracyMeters, VISIT_MAX_ACCURACY_METERS)) {
    return { ok: false, error: roughPinAtThePharmacy(fix.value.accuracyMeters) };
  }
  return {
    ok: true,
    value: {
      lat: fix.value.lat,
      lon: fix.value.lon,
      accuracyMeters: fix.value.accuracyMeters,
      // The phone's own clock, kept as the rep's "captured at". It is never compared with the server's
      // here: there is no photo slot to compare it against, and nothing is measured against a pharmacy.
      capturedAt: fix.value.deviceCapturedAt,
    },
  };
}

/** His reading, never the line he is being measured against (Golden Rule #1, as for a visit). */
function roughPinAtThePharmacy(accuracyMeters: number | null): string {
  if (accuracyMeters === null) return ROUGH_PIN_AT_THE_PHARMACY;
  return `Your phone gave ${metresSaid(accuracyMeters)}, which is too rough to save the pharmacy's place. Turn on precise location for ${BROWSER_PLACEHOLDER}; if it is already on, step outside and wait a few seconds, then press Capture location again — or save the pharmacy without it.`;
}

export type DropDraft = { reason: DropReason; note: string | null };

/**
 * Owner, 2026-10-12: a rep's ask to drop a customer always carries a comment — the SFE Manager reads it
 * before he drops anyone, alone or in bulk. A reason from the list is not enough on its own.
 */
export const DROP_COMMENT_REQUIRED = "Write why this customer should leave your list — the comment is required.";

/**
 * `requireNote` is the REP's own ask (`createListRequest`). The SFE Manager dropping a customer off a
 * list himself (`sfeDropFromList`) is not the rep's ask and keeps its comment optional.
 */
export function parseDropDraft(raw: unknown, options: { requireNote?: boolean } = {}): EntryRuleResult<DropDraft> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const reason = String(body.reason ?? "").trim();
  if (!DROP_REASON_KEYS.has(reason)) return { ok: false, error: "Choose why this customer should leave your list." };
  const note = cleanText(body.note, DROP_REASON_MAX);
  if (options.requireNote && !note) return { ok: false, error: DROP_COMMENT_REQUIRED };
  if (reason === "other" && !note) return { ok: false, error: "Write why this customer should leave your list." };
  return { ok: true, value: { reason: reason as DropReason, note } };
}

// ── A visit ─────────────────────────────────────────────────────────────────────────────────────

export type VisitDraft = CapturedFix & {
  customerId: string;
  kind: PhoenixCrmVisitKind;
  managerHrId: string | null;
  seniorHrId: string | null;
  /**
   * The line's product manager who came along — on a `product_manager` visit, or as the second person
   * of a chain. Whether he IS one of the line's is not decided here — he holds no seat, so only the
   * server's own list can say (scope.ts `resolveVisitParticipants`).
   */
  productManagerHrId: string | null;
  products: string[];
  /**
   * The pharmacy the rep took feedback from before the customer; he types it, so it is free text.
   * OPTIONAL since 2026-09-29 (owner): the box stays, but a visit is never blocked on it.
   */
  pharmacyName: string | null;
  /** His answer, per line product, of whether that pharmacy stocks it. Products left blank are absent. */
  productAvailability: Record<string, ProductAvailability>;
  comment: string | null;
  /**
   * The photo slot, when the caller still takes one. The one-tap Log visit sends none (owner,
   * 2026-09-29) and the server's own clock dates the visit; a caller that sends one is served exactly
   * as before.
   */
  photoPath: string | null;
  /**
   * An optional spoken note, kept as audio and transcribed never.
   *
   * Null on most visits, and the visit saves either way — the note is a convenience, not evidence. It
   * is deliberately NOT part of `CapturedFix`: a fix is where and when somebody was, and a recording
   * can be made in a car an hour later, which is the whole reason it dates nothing.
   */
  voiceNotePath: string | null;
  voiceNoteSeconds: number | null;
  voiceNoteBytes: number | null;
  /**
   * The kind of visit the rep CHOSE on the first step (owner, 2026-09-29): "planned" offers only
   * today's sent plan; "out_of_plan" is someone on his list who is not on today's plan, and needs his
   * reason and the manager's then SFE's approval; "out_of_list" is someone not on his list at all, whom
   * he validates on the spot and who counts once the district manager and SFE admit him. A caller that
   * still says "unplanned" means out_of_plan.
   *
   * It is what he said, never what is true. The server resolves the truth from the plan's own history
   * and the customer's own status inside phoenix_crm_save_visit. It is carried only so the reason below
   * can be asked for HERE, before the save, instead of coming back as a refusal after it.
   */
  visitType: "planned" | "out_of_plan" | "out_of_list";
  /** His written "why I went", when he chose out of plan. */
  unplannedReason: string | null;
  /**
   * The objection the doctor raised and what the rep will do next — both optional, both chips.
   *
   * It never fails, by design. Every other field on this type can refuse the draft; these four are
   * extras on a visit that is otherwise complete, and a phone one release behind sending a value this
   * one does not know must not cost a rep a visit he actually made. The unknown value is dropped and
   * the visit saves. See `visit-outcome.ts`.
   */
  outcome: VisitOutcome;
  /**
   * What he handed over — free samples of his line's products, and pens, block notes and giveaways.
   *
   * 🔴 A RECORD, never a stock movement: nothing subtracts, nothing is allocated and no balance
   * exists. Junk is dropped rather than refused, for the same reason as the outcome above.
   */
  samplesGiven: SamplesGiven;
  /**
   * How long the form was open on the phone, in seconds — or null when it did not say.
   *
   * 🔴 SILENT (Golden Rule #1). It is never shown to the rep, never mentioned to him and never able
   * to refuse a visit; it is read only by the Super Admin's integrity board, where a CONSTANT value
   * across a rep's whole month is the signal and any single value is not. Clamped, never refused —
   * see `clampFormOpenSeconds`.
   */
  formOpenSeconds: number | null;
  /**
   * Which browser install sent this visit — a random id that install keeps in its own storage, or
   * null when there was no storage to keep one in (`device-install.ts`).
   *
   * 🔴 SILENT (Golden Rule #1), and it travels exactly as `formOpenSeconds` above does: the phone has
   * to SEND it or the fact never exists at all, and nothing reads it back out towards the rep.
   *
   * It names a BROWSER INSTALL and nothing more — never a person, never a handset serial, and 🔴 never
   * a package or APK scan, which the owner forbids by name. Two saves carrying the same id came from
   * one browser profile, which is the whole question it exists to make answerable; two carrying
   * different ids say nothing either way.
   */
  deviceInstallId: string | null;
};

/** A photo slot lasts 2 hours, so nothing legitimate is longer than that between opening and saving. */
export const FORM_OPEN_SECONDS_MAX = 7200;

/**
 * The install id, read strictly.
 *
 * Shaped like the id `device-install.ts` writes and nothing else, so a body that puts a sentence, a
 * person's name or 4 KB of junk in this key lands as null rather than filing it as a device. Never
 * refused, for the same reason as the stopwatch: the rep is at a door, and this is a field he is not
 * even told exists.
 *
 * The shape test is the repo's one `isUuid`, never a regex written here — `tests/malformed-uuid-id-guards.test.ts`
 * refuses a second copy of that pattern anywhere under `src/`, because identical regexes never
 * disagree until one of them is edited. Trimming and lowercasing happen HERE, before the guard,
 * since `isUuid` deliberately does neither: this is a body field being normalised for storage, not
 * an id about to be handed to a uuid column.
 */
export function parseDeviceInstallId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return isUuid(value) ? value : null;
}

/**
 * The phone's stopwatch, clamped.
 *
 * Never refused and never thrown on: a build one release behind, a browser that lost the clock, a
 * value of "abc" — each lands as null and the visit saves. The rep is standing at a door with a photo
 * he cannot retake, and this is the one field on the whole form he is not even told exists.
 */
export function clampFormOpenSeconds(raw: unknown): number | null {
  // Explicitly, because `Number(null)` and `Number("")` are BOTH 0 — a body that said nothing would
  // otherwise land as a visit saved in under a second, which is the one reading that matters most.
  if (typeof raw !== "number" && !(typeof raw === "string" && raw.trim() !== "")) return null;
  const value = Math.floor(Number(raw));
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.min(value, FORM_OPEN_SECONDS_MAX);
}

/** The recorder caps at 60s; the column allows 120, so a long note is clamped rather than refused. */
const VOICE_NOTE_SECONDS_MAX = 120;
const VOICE_NOTE_BYTES_MAX = 2 * 1024 * 1024;

/**
 * The duration and size the phone reported, clamped rather than trusted.
 *
 * Neither is evidence and neither gates the save — they are what the review screen prints beside the
 * play button, so a wrong one is a wrong label, not a wrong visit. What IS authoritative is the path,
 * and only the database can settle that: `phoenix_crm_take_voice` refuses a path this person was not
 * issued, so a forged one fails at the save with a named code rather than being guessed at here.
 */
function clampVoiceNumber(raw: unknown, max: number): number | null {
  const value = Math.round(Number(raw));
  if (!Number.isFinite(value) || value < 1) return null;
  return Math.min(value, max);
}

/**
 * The pharmacy stock answers the phone sent: an object of product → "has"/"missing". Anything else — a
 * blank product, an answer that is not one of the two, more entries than a line could hold — is dropped
 * rather than refused, so a stray key never blocks a visit. The keys are checked against the line's
 * real products on the server (saveVisit), the same way the discussed products are.
 */
export function parseProductAvailability(raw: unknown): Record<string, ProductAvailability> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, ProductAvailability> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= PRODUCT_AVAILABILITY_MAX) break;
    const product = cleanText(key, 80);
    if (!product) continue;
    if (value === "has" || value === "missing") out[product] = value;
  }
  return out;
}

/** The kind of visit he chose; "unplanned", from a caller one release behind, is out of plan. */
export function parseVisitType(value: unknown): VisitDraft["visitType"] {
  if (value === "out_of_list") return "out_of_list";
  if (value === "out_of_plan" || value === "unplanned") return "out_of_plan";
  return "planned";
}

export function parseVisitDraft(raw: unknown): EntryRuleResult<VisitDraft> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (!isUuid(body.customerId)) return { ok: false, error: "Choose the customer you visited." };
  const kind = String(body.kind ?? "single").trim();
  if (kind !== "single" && kind !== "double" && kind !== "product_manager" && kind !== "chain") {
    return { ok: false, error: "Choose who was on the visit." };
  }
  const managerHrId = cleanText(body.managerHrId, 40);
  const seniorHrId = cleanText(body.seniorHrId, 40);
  const productManagerHrId = cleanText(body.productManagerHrId, 40);
  if ((kind === "double" || kind === "chain") && !managerHrId) {
    return { ok: false, error: "Choose the district manager who was on the visit." };
  }
  // The second person of a chain is a senior manager OR a product manager (owner, 2026-10-06) — one of
  // the two; whether both were sent, and whether the person is one of the line's, is the server's check.
  if (kind === "chain" && !seniorHrId && !productManagerHrId) return { ok: false, error: "Choose the senior manager who was on the visit." };
  if (kind === "product_manager" && !productManagerHrId) {
    return { ok: false, error: "Choose the product manager who was on the visit." };
  }

  // Optional (owner, 2026-09-29): the box stays on the form, and a visit is never blocked on it.
  const pharmacyName = cleanText(body.pharmacyName, PHARMACY_NAME_MAX);

  const productsRaw = Array.isArray(body.products) ? body.products : [];
  const products = [...new Set(productsRaw.map((product) => cleanText(product, 80)).filter((product): product is string => Boolean(product)))];
  if (products.length === 0) return { ok: false, error: "Choose the products you discussed." };
  if (products.length > VISIT_PRODUCTS_MAX) return { ok: false, error: `Choose at most ${VISIT_PRODUCTS_MAX} products.` };

  const productAvailability = parseProductAvailability(body.productAvailability);

  const commentText = String(body.comment ?? "").trim();
  if (!commentText) return { ok: false, error: VISIT_COMMENT_REQUIRED };
  if (commentText.length > VISIT_COMMENT_MAX) return { ok: false, error: `The comment is longer than ${VISIT_COMMENT_MAX} characters.` };

  // No photo on the one-tap visit; a caller that still sends one keeps its path.
  const photoPath = cleanText(body.photoPath, 200);
  const fix = parseCapturedFix(body, NO_FIX_FOR_A_VISIT);
  if (!fix.ok) return fix;
  if (!withinAccuracy(fix.value.accuracyMeters, VISIT_MAX_ACCURACY_METERS)) return { ok: false, error: roughFixForAVisit(fix.value) };

  // The kind he chose. The reason is asked for here, before the save, so an off-plan visit never gets
  // as far as the server without one — the server still decides which kind it really was.
  const visitType = parseVisitType(body.visitType);
  let unplannedReason: string | null = null;
  if (visitType === "out_of_plan") {
    const reason = parseUnplannedReason(body.unplannedReason);
    if (!reason.ok) return { ok: false, error: reason.error };
    unplannedReason = reason.value;
  }

  // All three travel together or none does: a path with no numbers would print an empty player, and
  // numbers with no path would print a duration for a recording nobody can hear.
  const voiceNotePath = cleanText(body.voiceNotePath, 200);

  return {
    ok: true,
    value: {
      ...fix.value,
      customerId: String(body.customerId).toLowerCase(),
      kind,
      // Each slot is cleared by the kind, so a stale pick on the form can never ride along: a product
      // manager is on a `product_manager` visit or as the second person of a chain and on no other, and
      // a manager on no PM visit.
      managerHrId: kind === "single" || kind === "product_manager" ? null : managerHrId,
      seniorHrId: kind === "chain" ? seniorHrId : null,
      productManagerHrId: kind === "product_manager" || kind === "chain" ? productManagerHrId : null,
      products,
      pharmacyName,
      productAvailability,
      comment: commentText || null,
      photoPath,
      voiceNotePath,
      voiceNoteSeconds: voiceNotePath ? clampVoiceNumber(body.voiceNoteSeconds, VOICE_NOTE_SECONDS_MAX) : null,
      voiceNoteBytes: voiceNotePath ? clampVoiceNumber(body.voiceNoteBytes, VOICE_NOTE_BYTES_MAX) : null,
      visitType,
      unplannedReason,
      outcome: parseVisitOutcome(body),
      samplesGiven: parseSamplesGiven(body.samplesGiven),
      formOpenSeconds: clampFormOpenSeconds(body.formOpenSeconds),
      deviceInstallId: parseDeviceInstallId(body.deviceInstallId),
    },
  };
}

/**
 * Minutes between the phone's clock and the server's; beyond this the entry is marked "phone clock
 * off". The same 15 minutes the company's other live-capture checks allow.
 */
export const DEVICE_CLOCK_TOLERANCE_MINUTES = 15;

export function deviceClockSkewMinutes(deviceCapturedAt: string | null, serverNow: Date): number | null {
  if (!deviceCapturedAt) return null;
  const device = Date.parse(deviceCapturedAt);
  if (Number.isNaN(device)) return null;
  return Math.round((device - serverNow.getTime()) / 60000);
}

export function isReportMonth(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function isReportDay(value: unknown): value is string {
  return isIsoDay(value);
}
