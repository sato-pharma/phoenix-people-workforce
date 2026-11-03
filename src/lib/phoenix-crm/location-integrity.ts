/**
 * Phoenix CRM — is this GPS fix real? Pure arithmetic, no I/O.
 *
 * WHY THIS EXISTS. A "Fake GPS" app on Android feeds the phone any coordinate its owner points at on
 * a map. Everything else Phoenix captures survives that — the photo is still live, the clock is still
 * checked, the upload slot is still single-use — but the position, which is what the whole 300 m
 * check rests on, becomes whatever the rep wanted it to be. Worse at validation than at a visit: a
 * faked PLACE becomes the reference point every later visit is measured against, so one spoof makes
 * a year of visits read "ok".
 *
 * THE REP IS NEVER TOLD (owner, 2026-09-25). Nothing here refuses a save, changes a message, or adds
 * a field to any screen a rep can open. A spoofed visit saves exactly like an honest one, at the same
 * speed, with the same words — and the evidence goes to a table his app never reads. That is
 * deliberate: an error that says "fake location detected" teaches the one person you caught precisely
 * what to defeat next time, and teaches everyone he tells. Silence catches the whole population once.
 *
 * TWO LAYERS, BECAUSE THE FIRST ONE IS A CLIENT.
 *
 *   Layer 1 — the phone's own confession. Android marks every fix that came from a mock provider and
 *   `expo-location` hands it to us as `mocked`. It is authoritative and free, and it names no app, so
 *   it catches every fake-GPS APK including ones nobody has heard of and ones renamed to hide. But it
 *   is a number a patched build could simply stop sending, and on the web and on iOS it does not
 *   exist at all.
 *
 *   Layer 2 — what the SERVER can prove on its own, below. None of it needs the phone's cooperation,
 *   so a patched app, a spoofed browser and a rep who never updates are all still covered. These are
 *   physics and statistics on coordinates we already store.
 *
 * NO FALSE POSITIVE IS WORTH A CATCH. Each threshold below is set where an honest rep cannot reach it
 * — a real receiver's own noise is the thing being measured, and every bound is on the generous side
 * of what a phone in a pocket in Cairo traffic actually does. A flag here is evidence for a human to
 * read, never a verdict and never an action.
 *
 * 🔴 ONE EXCEPTION, ON THE OWNER'S OWN WORD: `travel_rests_on_held_wait`. No software can prove when an
 * offline phone was pressed, so an honest drained queue and a forged wait read the same. He ruled that the
 * risk is not accepted, and that such a case lowers the rank until he settles it. See `checkHeldLocationIntegrity`.
 *
 * 🔴 AND THE FIRST THING TO ASK OF A FIX IS WHETHER IT IS A RECEIVER READING AT ALL. With Android's
 * "Precise location" switched off the OS hands back a grid-snapped tile centre with a fixed
 * accuracy — a number that repeats and never drifts by construction — and four of the five
 * detectors below read exactly that as a preset. It accused a working rep three times on
 * 2026-10-03. `COARSE_ACCURACY_METERS` is that gate, and its comment carries the measurement.
 */

import { cairoBusinessDay } from "@/lib/phoenix-crm/calendar";
import { distanceMeters, type GeoPoint } from "@/lib/phoenix-crm/geo";

/** What a fix can be marked with. Strong flags are individually damning; weak ones corroborate. */
export type PhoenixCrmIntegrityFlag =
  /** Android itself said the fix came from a mock provider. */
  | "mock_provider"
  /** This exact coordinate has been used before — a real receiver never repeats to 6 decimals. */
  | "coordinate_replay"
  /** The rep could not physically have travelled between his last fix and this one. */
  | "impossible_travel"
  /** A day of fixes with no drift at all, over hours, at several customers. */
  | "zero_jitter"
  /** Every fix of the day reported the same accuracy to the tenth of a metre. */
  | "constant_accuracy"
  /** A coordinate with a typist's precision rather than a receiver's. */
  | "typed_coordinate"
  /** The phone was handing out approximate location, so no precision test below means anything. */
  | "coarse_location"
  // ── The place's two readings, compared with each other at last (2026-10-08) ──────────────────
  //
  // A place stores TWO independent fixes — the photo's own shutter reading and the separate Capture
  // location pin — and until this date NOTHING anywhere compared them to one another. Each was
  // checked against PLACE_MAX_ACCURACY_METERS on its own and that was all, so three live active
  // places sit with their photo and their pin 687 m, 869 m and 1,553 m apart, both readings
  // individually "precise" and the gap unmeasured. `assessCaptureTrust` in
  // src/lib/evidence/capture-trust.ts already answers exactly this question and three other modules
  // already consume it; Phoenix CRM simply never called it.
  //
  // 🔴 ONLY `photo_pin_disagrees` IS STRONG. CAPTURE_DRIFT_AGREE_METRES' own doc records that two
  // urban-canyon fixes can legitimately sit ~150 m apart and a rep who steps outside a building for
  // signal moves further still, so a drift is corroboration and never an accusation. Measured on
  // production the day these landed: 3 places `drifted`, ZERO `disagrees` — the strong flag fires on
  // nobody, which is the right shape for a detector nobody has calibrated yet.
  /** The photo and the pin are irreconcilable — past CAPTURE_DRIFT_DISAGREE_METRES. */
  | "photo_pin_disagrees"
  /** Further apart than one doorway, between the two capture-trust lines. */
  | "photo_pin_drifted"
  /** The pin was taken long before the shutter — past CAPTURE_GAP_FLAG_SECONDS. */
  | "photo_pin_gap_long"
  /** Both readings identical to the bit, which a receiver does not do twice. */
  | "photo_pin_identical"
  // ── What the signboard in the photo actually says (2026-10-08) ───────────────────────────────
  //
  // The module validated a LOCATION while the owner graded an IDENTIFICATION, and only the first was
  // ever built: of the 643 places validated in the module's first five days, 561 got no identity
  // check of any kind, because the only one that existed covers AM accounts alone. These two flags
  // are what the nightly sweep files once it has read a place's own signboard
  // (src/lib/phoenix-crm/signboard-rules.ts).
  //
  // 🔴 A FLAG, NEVER A HOLD, FOR A PLACE ALREADY VALIDATED (owner, 2026-10-08: "flag them, you decide
  // each"). Nothing un-validates one of the 643 and no rep is told anything — he works through the
  // integrity board at his own pace, and every move off a place carries a written reason.
  /** The sign names somebody else — not this customer, and not his place. */
  | "sign_other_name"
  /**
   * No name to judge: the photo shows no signboard at all, or a PM signboard names no person — on a
   * PM capture a person is what identifies the door.
   *
   * 🔴 WEAK, AND IT HAS TO BE: many real Egyptian practices sign the specialty and the building and
   * no person, which is exactly why an AM capture judged against its place name treats a sign naming
   * nobody as a MATCH. On a PM capture it is worth looking at and is never on its own an accusation.
   */
  | "sign_no_name"
  // ── What the roster, the calendar and the brick master already knew (2026-10-12) ─────────────
  //
  // The second-pass CRM audit found three checks nobody was making, and all three are answered from
  // data Phoenix already holds — no new capture, no new field on any screen, nothing asked of a rep.
  //
  // 🔴 ALL FIVE ARE WEAK AND MUST STAY WEAK. None of them is evidence of anything on its own: a rep
  // on a conference day very often WAS at a conference and at a doctor, a popular doctor really is
  // seen three times in a week when a launch is on, and a place far from its brick is usually a
  // brick master that has never been drawn for that governorate. They corroborate a position case;
  // they do not open one. Adding any of them to PHOENIX_CRM_STRONG_INTEGRITY_FLAGS would move a
  // number the rep can read, because that list is the one gate `countedIntegrityFlags` and the
  // nightly ranks score share.
  /** The rep had approved FULL-DAY leave on the day he saved this visit. */
  | "visit_on_leave"
  /**
   * The day is recorded as a full day away from the field — a meeting, a conference, a health day,
   * training or travel. `sales_day` and `admin_work` are NOT away: a sales day IS field work and
   * admin work is routinely a half day at a desk and a half day on the road.
   */
  | "visit_on_full_day_activity"
  /**
   * The manager, senior or product manager NAMED on this visit was himself off duty that day.
   *
   * 🔴 THIS IS THE ROSTER HALF, AND IT IS THE ONLY HALF THERE IS. The audit asked for the companion's
   * own POSITION on the day to be compared with the visit's — and that cannot be built: of the 15
   * distinct companions named on production visits, ZERO have ever saved a CRM visit themselves
   * (measured 2026-10-12), because managers do not save calls. There is no fix of theirs to compare
   * with. What the roster can answer is whether the named person was on leave or away at all.
   */
  | "companion_off_duty"
  /** One rep called the same customer three or more times inside a rolling seven days. */
  | "customer_revisited_fast"
  /**
   * The place sits further from the brick it is filed under than BRICK_FAR_KM.
   *
   * Weak twice over: it is a finding about the DATA and not about a person. 71 active places on
   * 12 Oct 2026, and the usual cause is a brick master with no polygon drawn anywhere near the town.
   */
  | "place_brick_far"
  // ── The visit against the PHOTOGRAPH of the place it names (2026-10-13) ──────────────────────
  //
  // The owner's instruction, in his own words: "since u have the accurate validation the photo with
  // location then drop the suspected one and compare visits vs the accurate", and then, of the 48
  // visits that comparison found sitting far from the door, "i want the integrity report to show
  // exactly this". Until these flags existed the comparison was a sentence on a PLACE's panel and
  // nothing else: 47 of those 48 visits reached the board through no case of their own.
  //
  // 🔴 BOTH ARE WEAK, AND BOTH MUST STAY WEAK. A visit is saved where the phone is when the box is
  // filled in, which is not always the door: a rep who fills the form in the car outside, in the
  // lift, or at the next clinic along produces exactly this reading and has done nothing at all.
  // Adding either to PHOENIX_CRM_STRONG_INTEGRITY_FLAGS would move a number the rep can read
  // (`countedIntegrityFlags` and the nightly ranks score share that one list), which is what the
  // owner's "flag it, never stop the rep" ruling refuses.
  /** The visit's own fix sits further from the place's photograph than the settings call far. */
  | "visit_far_from_photo"
  /**
   * And further than a kilometre, which is a different question to a reader.
   *
   * Measured on production 13 Oct 2026: of the 46 visits this detector files on, 14 are past a
   * kilometre and the worst is 5.9 km. A second FLAG rather than a second detector, so one case
   * carries both and a reader can still see the shorter ones for what they are.
   */
  | "visit_very_far_from_photo"
  // ── The browser's own location reader (2026-10-16) ──────────────────────────────────────────
  //
  // Owner, 2026-10-16: "add a silent check for a replaced location reader in Phoenix CRM". An add-on
  // that changes where a page thinks the phone is puts its own function in place of the browser's
  // location reader, and the page asks that at the tap (src/lib/phoenix-crm/location-reader-probe.ts).
  // The web's answer to the question Android's mock flag answers on a phone.
  //
  // 🔴 STRONG, ON THE OWNER'S OWN WORD (2026-10-16: "make the location reader flag strong"), the same
  // day it shipped weak. It therefore moves the rep's Phoenix Ranks Integrity score — the one owner
  // exception to Golden Rule #1 — through `countedIntegrityFlags`. It is NOT a precision flag, so an
  // approximate fix does not excuse it. A privacy add-on that blurs location replaces the reader the
  // same way; the board's ordinary-cause line says so, and the settle click is how a case that turns
  // out to be that stops costing the rep.
  /** The page reported that the browser's own location reader had been replaced. */
  | "location_reader_replaced"
  // ── A trip that is possible only if the phone's own claim of a wait is true (3 Nov 2026) ───────
  //
  // 🔴 STRONG, ON THE OWNER'S OWN WORD. Told a forged wait could hide an impossible-travel reading: "this
  // rsik is not accpeted at all must fix". Asked how to treat a case Phoenix cannot tell apart from a forged
  // wait: "Lower rank until settled (Recommended)". It therefore moves the rep's Phoenix Ranks Integrity
  // score through `countedIntegrityFlags`, an honest rep's included, and the settle click is what clears it.
  // It is NOT a precision flag, so an approximate fix does not excuse it.
  /** The two readings fit only if the phone truly held one of them for want of signal. */
  | "travel_rests_on_held_wait";

export const PHOENIX_CRM_STRONG_INTEGRITY_FLAGS: readonly PhoenixCrmIntegrityFlag[] = [
  "mock_provider",
  "coordinate_replay",
  "impossible_travel",
  "zero_jitter",
  "photo_pin_disagrees",
  "sign_other_name",
  "location_reader_replaced",
  "travel_rests_on_held_wait",
];

/**
 * The flags that rest on the fix being PRECISE. Each one reads a coarse reading as a preset: an
 * approximate fix repeats its coordinate because it is quantised, and reports one accuracy all day
 * because that number is a constant, not a measurement. None of them can say anything about a fix
 * whose own error bar is wider than the thing being measured.
 */
export const PHOENIX_CRM_PRECISION_INTEGRITY_FLAGS: readonly PhoenixCrmIntegrityFlag[] = [
  "coordinate_replay",
  "zero_jitter",
  "constant_accuracy",
  "typed_coordinate",
];

/** Human wording for the board. Plain English — the reader is a manager, not an engineer. */
export const PHOENIX_CRM_INTEGRITY_LABELS: Record<PhoenixCrmIntegrityFlag, string> = {
  mock_provider: "The phone reported a mock location app",
  coordinate_replay: "This exact coordinate was used before",
  impossible_travel: "Could not have travelled that far in the time",
  travel_rests_on_held_wait: "This trip is possible only if the phone really held a visit without signal",
  zero_jitter: "The position never moved all day",
  constant_accuracy: "Every reading had identical accuracy",
  typed_coordinate: "The coordinate looks typed, not measured",
  coarse_location: "The phone was set to approximate location, not precise",
  photo_pin_disagrees: "The photo and the pin are in different parts of the city",
  photo_pin_drifted: "The photo and the pin are further apart than one doorway",
  photo_pin_gap_long: "The pin was taken long before the photo",
  photo_pin_identical: "The photo and the pin are the same reading, to the bit",
  // 🔴 "SOMEBODY ELSE" IS ONLY HALF THE FLAG, AND ON AN AM CAPTURE IT IS SIMPLY UNTRUE. The check
  // asks a PM frame for a person and an AM frame for a PLACE (`judgeSignboards`, step 5), so three
  // of the seven cases standing on 2026-10-12 — a hospital signed "TANTA GENERAL HOSPITAL", a
  // department sign reading قسم الاستقبال, a clinic door reading عيادة الأطفال — carried no person's
  // name at all and were read as naming one. The board is where he decides each case, so the
  // sentence has to hold for both halves of the check. It may not say "doctor" either:
  // `tests/phoenix-crm-am-pm-words.test.ts` sweeps every screen string in this module for
  // that word and for "account", on the owner's 2026-09-23 rule, and this label went RED on it.
  sign_other_name: "The signboard in the photo names a different person or place",
  sign_no_name: "No name could be read on the signboard in the photo",
  visit_on_leave: "The rep had approved full-day leave on this day",
  visit_on_full_day_activity: "The day is recorded as a full day away from the field",
  companion_off_duty: "The manager named on the visit was off duty that day",
  customer_revisited_fast: "This customer was called three times inside a week",
  place_brick_far: "The place sits far outside the brick it is filed under",
  // Plain English, and it says PHOTOGRAPH rather than "the place": the photograph is what this
  // detector measures against, on the owner's own instruction, and the place's kept point is a
  // different reading that happens to be the same point for 1,312 of the 1,403 validated places.
  visit_far_from_photo: "The visit was saved far from the photograph taken at the place",
  visit_very_far_from_photo: "The visit was saved more than a kilometre from the photograph",
  location_reader_replaced: "The browser's own location reader had been replaced on the page",
};

/**
 * Which full-day activities mean the rep was AWAY from the field, for `visit_on_full_day_activity`.
 *
 * 🔴 `sales_day` AND `admin_work` ARE NOT HERE, AND THAT IS THE WHOLE POINT OF THE LIST. A sales day
 * IS field work — flagging it would accuse every rep who records one — and admin work is routinely
 * half a day at a desk and half a day on the road. Measured on production 2026-10-12: the five below
 * account for 22 visits by 3 reps; adding those two would have swept in far more honest days than
 * questionable ones.
 *
 * The keys are `PhoenixCrmDayActivity`'s own, and `tests/phoenix-crm-location-integrity.test.ts`
 * refuses a key that is not one of them — a typo here is a silently dead branch.
 */
export const PHOENIX_CRM_AWAY_DAY_ACTIVITIES: readonly string[] = [
  "meeting",
  "conference",
  "health_day",
  "training",
  "travel",
];

/**
 * How many calls on one customer by one rep inside a rolling week is worth a look.
 *
 * Three, not two: a doctor seen twice in a week is ordinary — a morning clinic and an afternoon one,
 * or a follow-up after a sample drop — and 14 customers reach three on production (measured
 * 2026-10-12) against a far larger number that reach two. A weak flag that fires on a quarter of the
 * customer base is a flag nobody reads.
 */
export const REVISIT_WINDOW_DAYS = 7;
export const REVISIT_WINDOW_VISITS = 3;

/**
 * How far from its own brick a place has to sit before the row is worth looking at, in kilometres.
 *
 * 3 km is `BRICK_TRUST_KM`'s own neighbourhood: a place inside it was matched to the brick, so this
 * flag is only ever raised on a place the brick lookup ALREADY recorded as `none_nearby` — the
 * distance is read from the row, never recomputed, so this board and the brick report cannot print
 * two different numbers for one place. A place filed by reach into the seat's own area (owner,
 * 2026-10-29, `OWN_AREA_REACH_KM`) is `matched`, so it is never flagged here whatever its distance.
 */
export const BRICK_FAR_KM = 3;

// ── Thresholds ──────────────────────────────────────────────────────────────────────────────────
// Every one of these is pinned by tests/phoenix-crm-location-integrity.test.ts. Loosen one only with
// a measurement in front of you: they are the line between catching a cheat and accusing a rep.

/**
 * The band the HISTORY QUERY fetches candidates in — six decimals, about 11 cm — and nothing more.
 *
 * 🔴 IT IS NOT THE TEST ANY MORE, AND THE REASON IT USED TO BE IS FALSE. This comment read "a GNSS
 * receiver reporting the same 11 cm twice, ever, does not happen: even a phone lying still on a
 * table walks several metres over an afternoon." Production disproved it on 2026-10-11: one rep's
 * two readings, 22 minutes apart in the same hospital, came back 30.032354829736 and
 * 30.0323547138734 — about 1.3 cm apart, well inside the band — carrying DIFFERENT accuracies,
 * 49.9 m and 54.9 m, so neither was a cached copy of the other. Two honest readings. The board
 * called it "this exact coordinate was used before", and a strong flag is charged to the rep's
 * Integrity score by `countedIntegrityFlags` in rep-ranks/field-quality.ts.
 *
 * `sameCoordinate` now asks the coordinate to REPEAT — identical to its last stored digit, which is
 * what a preset in a fake-GPS app does and what a receiver computing a fresh solution does not. The
 * constant stays because `server/location-integrity.ts` still needs an index-friendly equality band
 * to pull candidates with (`COORDINATE_BAND`), and narrowing the comparison inside that band can
 * only ever drop a case, never add one.
 */
export const REPLAY_DECIMALS = 6;

/**
 * …and a phone CAN hand the same reading back twice, so a repeat by the same rep only counts once
 * the readings are this far apart. A repeat by a DIFFERENT rep counts immediately — two people
 * cannot share a coordinate to the last digit, and one they do share is a shared preset.
 */
export const REPLAY_MIN_GAP_MINUTES = 20;

/** Straight-line km/h no rep reaches between two clinics. The Cairo–Alex road at 120 gives ~110. */
export const MAX_TRAVEL_KMH = 150;

/** Below this the "distance" is receiver noise, not travel, whatever the clock says. */
export const TRAVEL_MIN_METERS = 2_000;

/** A day whose fixes all sit inside this radius has not moved. */
export const ZERO_JITTER_METERS = 5;

/** …and it only counts with enough readings, enough customers and enough hours to rule out drift. */
export const ZERO_JITTER_MIN_FIXES = 4;
export const ZERO_JITTER_MIN_CUSTOMERS = 3;
export const ZERO_JITTER_MIN_SPAN_MINUTES = 120;

/** Identical accuracy this many times in a day. Real accuracy wanders with the sky and the walls. */
export const CONSTANT_ACCURACY_MIN_FIXES = 5;

/** A coordinate that is exactly itself at four decimals (~11 m) was chosen, not measured. */
export const TYPED_COORDINATE_DECIMALS = 4;

/**
 * At or above this reported accuracy the fix is an APPROXIMATE-LOCATION fix, and no precision test
 * may be run on it.
 *
 * 🔴 WHY, measured on production 2026-10-05. Android's "Precise location" toggle has an off
 * position, and with it off the OS stops giving the app a receiver reading: it hands back a
 * grid-snapped coordinate for a ~1–2 km tile with a FIXED accuracy. That is not a degraded GPS fix,
 * it is a different kind of number — and every detector above read it as a preset. One rep,
 * Yasmeen Samy, had her phone that way for one morning on 3 October and the board accused her
 * three times over with `coordinate_replay` (a STRONG flag) and `constant_accuracy`: 11 fixes,
 * 4 customers, `spreadMeters: 0`, every reading exactly 2000 m, and `deviceMocked: null` — the
 * phone never confessed anything, because there was nothing to confess. She was working.
 *
 * 🔴 And `zero_jitter` — also strong, and worse — missed her only on the clock: that morning spanned
 * 59 minutes against the 120 the detector wants. A full day on the same setting reads as "the
 * position never moved all day" about a rep who moved all day.
 *
 * WHERE THE LINE GOES. 772 real fixes from 14 reps: median 14 m, 95th 60 m, 99th 122.4 m. Above
 * that the population is EMPTY until 1273.4 m, and the only inhabitants of the far end are the four
 * approximate-mode fixes themselves (1273.4, 1414.0, 2000.0 ×2). 500 m sits in that empty band —
 * four times the worst honest fix, and well under half the nearest coarse one — so it separates the
 * two populations without touching a single real reading.
 *
 * WHAT IT DOES NOT WAIVE. `mock_provider` and `impossible_travel` still fire on a coarse fix: the
 * first is the phone's own confession and owes nothing to precision, and the second already
 * subtracts both readings' error bars, so a 2000 m fix simply needs a bigger impossibility. And a
 * coarse fix is not silent — it carries `coarse_location`, which is the honest reading of it and
 * the one a manager can act on by asking for Precise location to be switched back on. A rep whose
 * every fix is coarse is now a visible pattern instead of a false accusation.
 */
export const COARSE_ACCURACY_METERS = 500;

// ── Input ───────────────────────────────────────────────────────────────────────────────────────

/**
 * A fix at the moment he was there rather than the moment it arrived (the visit retry, owner, 3 Nov 2026). A save
 * the phone held for want of signal has a late `captured_at`, and compared raw a drained queue reads as visits
 * seconds apart. Both sides of a comparison go through this, each with its own wait. A save never held is
 * returned as it is, which is every save before this existed.
 */
export function atTheDoor<T extends { capturedAt: Date }>(fix: T, queuedSeconds: number | null | undefined): T {
  if (!queuedSeconds || !Number.isFinite(queuedSeconds)) return fix;
  return { ...fix, capturedAt: new Date(fix.capturedAt.getTime() - queuedSeconds * 1000) };
}

/** One fix already on record, as the history query returns it. */
export type PhoenixCrmPriorFix = GeoPoint & {
  accuracyMeters: number | null;
  capturedAt: Date;
  repHrId: string;
  customerId: string | null;
};

export type PhoenixCrmIntegrityInput = {
  fix: GeoPoint & { accuracyMeters: number | null; capturedAt: Date };
  repHrId: string;
  customerId: string | null;
  /** Android's own mock-provider flag. Null on the web and on iOS, where it does not exist. */
  deviceMocked: boolean | null;
  /**
   * The browser's answer to whether its location reader was still its own (location-reader-probe.ts).
   * Null or absent is NOT ASKED — an older bundle, a page that could not be read — never "clean".
   */
  readerReplaced?: boolean | null;
  readerFindings?: readonly string[];
  /**
   * The rep's own recent fixes, plus any fix by anyone that shares this coordinate. Order does not
   * matter; the caller decides how far back to look.
   */
  history: readonly PhoenixCrmPriorFix[];
};

/** A fix on record with the wait its phone claimed for it, compared at arrival and again at the door. */
export type PhoenixCrmHeldPriorFix = PhoenixCrmPriorFix & { queuedSeconds?: number | null };

export type PhoenixCrmHeldIntegrityInput = Omit<PhoenixCrmIntegrityInput, "history"> & {
  /** How long the phone says it held THIS save. Null on a save that never waited. */
  queuedSeconds: number | null | undefined;
  /** Raw, every side at its arrival. This function does the moving, so nothing is shifted twice. */
  history: readonly PhoenixCrmHeldPriorFix[];
  /** When the rep's own saves reached the server, the capture's own included. A manager's save is not one. */
  ownArrivals: readonly Date[];
};

export type PhoenixCrmIntegrityVerdict = {
  flags: PhoenixCrmIntegrityFlag[];
  /** True when at least one strong flag fired — what the board sorts on. */
  strong: boolean;
  /** The numbers behind the flags, kept so a later reading can audit the call rather than trust it. */
  signals: Record<string, unknown>;
};

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * The same coordinate REPEATED — identical to its last stored digit, not merely nearby.
 *
 * 🔴 NEVER WIDEN THIS BACK TO A ROUNDED MATCH. Rounding to `REPLAY_DECIMALS` is what the history
 * query bands on, and it read two honest readings 1.3 cm apart as one replayed coordinate — see that
 * constant's comment for the production pair and what it cost the rep. A fake-GPS preset repeats
 * exactly; a receiver solving for position again does not.
 */
function sameCoordinate(left: GeoPoint, right: GeoPoint): boolean {
  return left.lat === right.lat && left.lon === right.lon;
}

function minutesBetween(left: Date, right: Date): number {
  return Math.abs(left.getTime() - right.getTime()) / 60_000;
}

/** A value that is exactly itself rounded to `decimals` — i.e. it carries no finer information. */
function isRounded(value: number, decimals: number): boolean {
  return Math.abs(value - roundTo(value, decimals)) < 1e-9;
}

/**
 * The Cairo VISIT day a capture is filed under — the day that ends at 02:00, not the calendar day.
 *
 * 🔴 It was the calendar day until 2026-10-02, and the comment claiming that was "the day the visit
 * is filed under" was simply wrong: `phoenix_crm_save_visit` has filed a visit under
 * `((captured_at − 2h) at Cairo)::date` since 2026-09-29, because the owner allows the day's visits
 * to be logged until 02:00. The two day detectors below group by this, so before the fix a rep's
 * 01:30 captures were split off into the next day — which both broke up a day that should have been
 * read together and could have put one capture in a "day" of its own.
 */
function cairoDay(at: Date): string {
  return cairoBusinessDay(at);
}

// ── The detectors ───────────────────────────────────────────────────────────────────────────────

/**
 * Judge one fix against what came before it.
 *
 * Deliberately total: it never throws and never reaches for anything outside its input, so a caller
 * can run it inside a save without a single new way for that save to fail. A rep's visit must not be
 * lost because a fraud check had a bad day.
 */
export function checkLocationIntegrity(input: PhoenixCrmIntegrityInput): PhoenixCrmIntegrityVerdict {
  const flags = new Set<PhoenixCrmIntegrityFlag>();
  const signals: Record<string, unknown> = {};
  const { fix, history, repHrId } = input;

  // ── Layer 1 — the phone told us ───────────────────────────────────────────────────────────────
  if (input.deviceMocked === true) flags.add("mock_provider");
  signals.deviceMocked = input.deviceMocked;
  // The browser's half of the same question. Recorded either way, so a later reading can tell "asked
  // and its own" (false) from "never asked" (null); a flag only on a positive answer.
  if (input.readerReplaced === true) flags.add("location_reader_replaced");
  signals.readerReplaced = input.readerReplaced ?? null;
  if (input.readerFindings && input.readerFindings.length > 0) signals.readerFindings = [...input.readerFindings];

  // ── Is this fix precise enough to be judged on precision at all? ──────────────────────────────
  //
  // Two readings cannot support a conclusion about precision: one too coarse to locate anything,
  // and one that reported NO accuracy at all. Either is evidence of nothing precise on EITHER side
  // of a comparison, so both come out of both: this fix stops being judged, and such a reading
  // already on record stops being something to judge against. Without that second half an honest
  // precise fix gets flagged for "replaying" the tile centre its own phone handed back an hour
  // earlier — the same false accusation, one reading later.
  //
  // 🔴 AN UNKNOWN ACCURACY IS NOT A GOOD ACCURACY. It is deliberately ACCEPTED at the capture gate
  // (`entry-rules.ts`: "an UNKNOWN accuracy is still taken, as it always was") — the owner's
  // decision, so that a handset that reports no figure never costs a rep his visit. The hole the
  // second-pass audit found was that `isCoarse` then returned false for it, so the same reading the
  // gate waved through on the grounds that we cannot measure it was handed to all four precision
  // detectors and judged as though we had. Measured on production 2026-10-12: 18 of 1,598 visits and
  // 7 of 1,418 places carry no accuracy figure, every one of them eligible for all four. None had
  // actually tripped one — the five precision flags standing all report a real accuracy — so this
  // closes the hole before it accuses anybody rather than after.
  const isCoarse = (accuracyMeters: number | null): boolean =>
    accuracyMeters !== null && Number.isFinite(accuracyMeters) && accuracyMeters >= COARSE_ACCURACY_METERS;

  /** No usable accuracy figure at all. A missing measurement, never a perfect one. */
  const isUnmeasured = (accuracyMeters: number | null): boolean =>
    accuracyMeters === null || !Number.isFinite(accuracyMeters);

  /** Too coarse, or never measured — either way nothing precise may be concluded from it. */
  const cannotSupportPrecision = (accuracyMeters: number | null): boolean =>
    isCoarse(accuracyMeters) || isUnmeasured(accuracyMeters);

  const fixIsCoarse = isCoarse(fix.accuracyMeters);
  const fixIsUnmeasured = isUnmeasured(fix.accuracyMeters);
  const measured = history.filter((prior) => !cannotSupportPrecision(prior.accuracyMeters));

  if (fixIsCoarse) {
    flags.add("coarse_location");
    signals.coarse = {
      accuracyMeters: fix.accuracyMeters,
      thresholdMeters: COARSE_ACCURACY_METERS,
      suppressed: [...PHOENIX_CRM_PRECISION_INTEGRITY_FLAGS],
    };
  }
  // 🔴 NO FLAG for an unmeasured reading, only this signal. `coarse_location` would be a false
  // statement about it, and a flag of its own would file a standing board case against every rep
  // whose handset is quiet about accuracy — 25 captures already — which is the opposite of the
  // point. The suppression is recorded so the Super Admin can see WHY a row says little.
  if (fixIsUnmeasured) {
    signals.unmeasuredAccuracy = {
      accuracyMeters: fix.accuracyMeters,
      suppressed: [...PHOENIX_CRM_PRECISION_INTEGRITY_FLAGS],
    };
  }
  // Counted apart, because "ignored as coarse" and "ignored as unmeasured" are different facts
  // about the rep's history and reading one as the other sends the next session to the wrong rule.
  const coarseIgnored = history.filter((prior) => isCoarse(prior.accuracyMeters)).length;
  const unmeasuredIgnored = history.filter((prior) => isUnmeasured(prior.accuracyMeters)).length;
  if (coarseIgnored > 0) signals.coarseHistoryIgnored = coarseIgnored;
  if (unmeasuredIgnored > 0) signals.unmeasuredHistoryIgnored = unmeasuredIgnored;

  /**
   * Publish a precision-dependent flag — unless this fix cannot support one.
   *
   * 🔴 `mock_provider` and `impossible_travel` do NOT come through here, by the owner's 2026-10-05
   * ruling: the phone's own mock answer and a trip nobody could have made are not claims about
   * precision, and travel takes both readings' error bars off the distance before judging, so a
   * reading with no accuracy figure contributes no slack and cannot invent a trip either.
   */
  const addPrecisionFlag = (flag: PhoenixCrmIntegrityFlag): void => {
    if (!fixIsCoarse && !fixIsUnmeasured) flags.add(flag);
  };

  // ── Replay — this coordinate has been used before ─────────────────────────────────────────────
  const replay = measured.find((prior) => {
    if (!sameCoordinate(fix, prior)) return false;
    if (prior.repHrId !== repHrId) return true;
    return minutesBetween(fix.capturedAt, prior.capturedAt) > REPLAY_MIN_GAP_MINUTES;
  });
  if (replay) {
    addPrecisionFlag("coordinate_replay");
    signals.replay = {
      byRepHrId: replay.repHrId,
      sameRep: replay.repHrId === repHrId,
      minutesApart: Math.round(minutesBetween(fix.capturedAt, replay.capturedAt)),
      capturedAt: replay.capturedAt.toISOString(),
    };
  }

  // ── Travel — the rep's own previous fix, wherever and whenever it was ─────────────────────────
  const ownEarlier = history
    .filter((prior) => prior.repHrId === repHrId && prior.capturedAt.getTime() < fix.capturedAt.getTime())
    .sort((left, right) => right.capturedAt.getTime() - left.capturedAt.getTime())[0];
  if (ownEarlier) {
    const gross = distanceMeters(fix, ownEarlier);
    // Both readings' own error bars come off the distance first, so a wide fix never invents a trip.
    const slack = (fix.accuracyMeters ?? 0) + (ownEarlier.accuracyMeters ?? 0);
    const travelled = Math.max(0, gross - slack);
    const hours = minutesBetween(fix.capturedAt, ownEarlier.capturedAt) / 60;
    const kmh = hours > 0 ? travelled / 1000 / hours : Number.POSITIVE_INFINITY;
    if (travelled >= TRAVEL_MIN_METERS && kmh > MAX_TRAVEL_KMH) {
      flags.add("impossible_travel");
      signals.travel = { meters: Math.round(travelled), minutes: Math.round(hours * 60), kmh: Math.round(kmh) };
    }
  }

  // ── The day — jitter and accuracy, over this rep's own fixes of the same Cairo day ────────────
  const day = cairoDay(fix.capturedAt);
  const sameDay = [
    { lat: fix.lat, lon: fix.lon, accuracyMeters: fix.accuracyMeters, capturedAt: fix.capturedAt, customerId: input.customerId },
    ...measured.filter((prior) => prior.repHrId === repHrId && cairoDay(prior.capturedAt) === day),
  ];

  if (sameDay.length >= ZERO_JITTER_MIN_FIXES) {
    let spread = 0;
    for (let left = 0; left < sameDay.length; left += 1) {
      for (let right = left + 1; right < sameDay.length; right += 1) {
        spread = Math.max(spread, distanceMeters(sameDay[left], sameDay[right]));
      }
    }
    const customers = new Set(sameDay.map((entry) => entry.customerId).filter((id): id is string => Boolean(id))).size;
    const times = sameDay.map((entry) => entry.capturedAt.getTime());
    const spanMinutes = (Math.max(...times) - Math.min(...times)) / 60_000;
    signals.day = { fixes: sameDay.length, customers, spreadMeters: Math.round(spread), spanMinutes: Math.round(spanMinutes) };
    if (spread < ZERO_JITTER_METERS && customers >= ZERO_JITTER_MIN_CUSTOMERS && spanMinutes >= ZERO_JITTER_MIN_SPAN_MINUTES) {
      addPrecisionFlag("zero_jitter");
    }

    const accuracies = sameDay.map((entry) => entry.accuracyMeters).filter((value): value is number => value !== null);
    if (accuracies.length >= CONSTANT_ACCURACY_MIN_FIXES && new Set(accuracies.map((value) => roundTo(value, 1))).size === 1) {
      addPrecisionFlag("constant_accuracy");
      signals.constantAccuracy = accuracies[0];
    }
  }

  // ── Precision — a coordinate nobody measured ──────────────────────────────────────────────────
  if (isRounded(fix.lat, TYPED_COORDINATE_DECIMALS) && isRounded(fix.lon, TYPED_COORDINATE_DECIMALS)) {
    addPrecisionFlag("typed_coordinate");
  }

  const ordered = [...flags].sort();
  return {
    flags: ordered,
    strong: ordered.some((flag) => PHOENIX_CRM_STRONG_INTEGRITY_FLAGS.includes(flag)),
    signals,
  };
}

/**
 * How close to an arrival a contact may sit without contradicting a claimed wait. The sender is oldest first
 * and a few seconds apart, so a held visit and a fresh press land together the moment signal returns.
 */
export const HELD_WAIT_CONTACT_GRACE_MINUTES = 5;

/**
 * How much of a claimed wait the server will believe: all of it, or none.
 *
 * A wait is only the phone's word, but one thing can contradict it from the server's own clock. If this rep's
 * phone reached Phoenix in the middle of the wait, an online Phoenix would have sent the held visit then. So
 * one of their own arrivals inside the wait voids it. A contact inside the grace does not, or the save that
 * ended the wait would count against it.
 */
export function creditedHeldSeconds(claimedSeconds: number | null | undefined, arrivalAt: Date, ownArrivals: readonly Date[]): number {
  if (!claimedSeconds || !Number.isFinite(claimedSeconds) || claimedSeconds <= 0) return 0;
  const arrival = arrivalAt.getTime();
  const waitBegan = arrival - claimedSeconds * 1000;
  const graceBegins = arrival - HELD_WAIT_CONTACT_GRACE_MINUTES * 60_000;
  const contradicted = ownArrivals.some((contact) => contact.getTime() > waitBegan && contact.getTime() < graceBegins);
  return contradicted ? 0 : claimedSeconds;
}

/**
 * The check for a capture when a wait is claimed on either side. A wait may correct the comparison, and it may
 * never make a reading disappear (owner, 3 Nov 2026: "this rsik is not accpeted at all must fix").
 *
 * It runs twice. At ARRIVAL, on the server's own clock, nothing the phone says moves anything. At the DOOR, each
 * side moved back by the wait the server will credit.
 *
 *   - Every finding from either pass stands, so a wait cannot hide a replay or a day with no drift.
 *   - A trip impossible at the door is `impossible_travel`: even taking the phone's word, nobody made it.
 *   - A trip impossible only at arrival is `travel_rests_on_held_wait`: it fits only if the claim is true. An honest
 *     drained queue and a forged wait both land here and cannot be told apart, so a person reads it, and until
 *     they settle it the rank carries it.
 *
 * A capture with no claim on either side gets exactly what `checkLocationIntegrity` always gave it.
 */
export function checkHeldLocationIntegrity(input: PhoenixCrmHeldIntegrityInput): PhoenixCrmIntegrityVerdict {
  const { queuedSeconds, history, ownArrivals, ...capture } = input;
  const arrival = checkLocationIntegrity({ ...capture, history });
  if (!queuedSeconds && !history.some((prior) => prior.queuedSeconds)) return arrival;

  const creditedSeconds = creditedHeldSeconds(queuedSeconds, capture.fix.capturedAt, ownArrivals);
  const door = checkLocationIntegrity({
    ...capture,
    fix: atTheDoor(capture.fix, creditedSeconds),
    history: history.map((prior) => atTheDoor(prior, creditedHeldSeconds(prior.queuedSeconds, prior.capturedAt, ownArrivals))),
  });

  const flags = new Set<PhoenixCrmIntegrityFlag>([...door.flags, ...arrival.flags.filter((flag) => flag !== "impossible_travel")]);
  if (arrival.flags.includes("impossible_travel") && !door.flags.includes("impossible_travel")) flags.add("travel_rests_on_held_wait");

  const previous = history
    .filter((prior) => prior.repHrId === capture.repHrId && prior.capturedAt.getTime() < capture.fix.capturedAt.getTime())
    .sort((left, right) => right.capturedAt.getTime() - left.capturedAt.getTime())[0];
  const ordered = [...flags].sort();
  return {
    flags: ordered,
    strong: ordered.some((flag) => PHOENIX_CRM_STRONG_INTEGRITY_FLAGS.includes(flag)),
    // The arrival pass's `travel` survives when the door's has none, because the case story prints those numbers.
    signals: {
      ...arrival.signals,
      ...door.signals,
      heldWait: { claimedSeconds: queuedSeconds ?? 0, creditedSeconds, priorClaimedSeconds: previous?.queuedSeconds ?? 0 },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A FLAG IS A READING WITH A DATE ON IT — whether a later reading still supports a signboard case.
//
// Pure, here beside the flags and their labels, for the reason the rest of this file is pure: the
// judging holds no I/O, so it can be tested on real verdict shapes rather than inferred from the
// board's source text. The board reads the place row and asks this.
//
// 🔴 A SIGNBOARD VERDICT IS NOT A PROPERTY OF THE PHOTOGRAPH. Measured 2026-10-09: the same frame
// read `other_name` at 18:12 and `unjudged` at 18:34, and another read blank at 18:35 and a clear
// nameplate at 18:48. Legibility moves and the verdict moves with it, so four of the five signboard
// flags standing on the owner's board that evening were already contradicted by the place's own
// stored verdict — two of them by a plain `match`, and a matched place leaves the nightly backlog,
// so those two would never have been re-read and would have stood for ever against a named person.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The two signboard verdicts that put a name on the integrity board. Anything else is not a flag. */
const FLAGGABLE_SIGNBOARD_VERDICTS = new Set(["other_name", "no_name"]);

/**
 * The only verdicts that take a filed flag OFF the board. A failure to read is not one of them.
 *
 * 🔴 "COULD NOT BE READ" IS NOT AN ANSWER, AND IT MUST NOT WITHDRAW A CASE. The flag stands on the
 * reading that FILED it, and a later reading either overturns it (`match`), confirms it
 * (`other_name`, `no_name`) or says nothing at all (`unjudged`) — and saying nothing leaves the
 * filing exactly where it was. This is the same principle the dates already follow below: null is
 * "nothing read it again", never "it was withdrawn".
 *
 * Measured 2026-10-12 on the owner's board: مستشفى المنشاوى العام was filed STRONG `sign_other_name`
 * on 9 Oct, the 12 Oct 03:36 pass could not read the sign, and the case left the standing list with
 * nobody having decided anything — and a withdrawn case offers no settle button, so it could never
 * be decided either. Worse, `SIGNBOARD_REREAD_REASONS` keeps retrying exactly those unreadable
 * places, so a case judged this way flickers on and off the board with each night's luck rather
 * than on its evidence. The board's own counter text ("read again to a verdict that no longer
 * carries them") is untrue of a reading that reached no verdict.
 */
const WITHDRAWING_SIGNBOARD_VERDICTS = new Set(["match"]);

/** Which filed flag each of those verdicts corresponds to, so "still the same finding" is a test. */
const SIGNBOARD_VERDICT_FLAG: Record<string, string> = {
  other_name: "sign_other_name",
  no_name: "sign_no_name",
};

/**
 * What a later reading says, in the integrity board's own words.
 *
 * Deliberately NOT the sentences the two place boards print. Those answer "what does this place's
 * sign say"; these answer "does it still say the thing this flag was filed for", which is a different
 * question and reads wrongly in the other voice. A reason not named here falls back to the verdict's
 * own sentence, so a reason added later can never surface as a code.
 */
const LATER_READING_TEXT: Record<string, string> = {
  match: "the sign names this customer after all",
  other_name: "the sign names somebody else",
  no_name: "there is no name on the sign to judge",
  unjudged: "the sign could not be read",
};

const LATER_READING_UNJUDGED_TEXT: Record<string, string> = {
  name_unusable: "there is nothing on a sign to compare",
  unconfirmed: "two readings of the sign disagreed with each other",
  unreadable: "the sign could not be read, and it is still being retried",
  unreadable_final: "the sign could not be read, and it has had every attempt it gets",
};

function laterReadingWords(verdict: string, reason: string | null): string {
  if (verdict !== "unjudged") return LATER_READING_TEXT[verdict] ?? LATER_READING_TEXT.unjudged;
  return LATER_READING_UNJUDGED_TEXT[reason ?? ""] ?? LATER_READING_TEXT.unjudged;
}

/** A signboard verdict as the place row stores it, pared to what judging a later reading needs. */
export type StoredSignboardVerdict = {
  verdict: string;
  reason: string | null;
  /** When that reading was taken, as an ISO instant. Null when the stored check never carried one. */
  checkedAt: string | null;
  signText: string | null;
};

/**
 * `phoenix_crm_places.signboard_check`, as the two readers that judge a later reading need it.
 *
 * 🔴 ONE COERCION, TWO READERS. The board and Phoenix Ranks must agree about a withdrawn case or a
 * rep is charged on a screen for a finding another screen has already dropped — which is exactly
 * what happened for the three cases measured on 2026-10-12. A second hand-rolled `typeof` block is
 * how the two would drift apart again, so the shape is read in one place and nowhere else.
 *
 * Returns null for anything that is not a check with a verdict in it. Null means "nothing read it
 * again", which leaves the flag standing — the same direction every other unknown falls here.
 */
export function readStoredSignboardVerdict(value: unknown): StoredSignboardVerdict | null {
  if (!value || typeof value !== "object") return null;
  const stored = value as Record<string, unknown>;
  if (typeof stored.verdict !== "string") return null;
  return {
    verdict: stored.verdict,
    reason: typeof stored.reason === "string" ? stored.reason : null,
    checkedAt: typeof stored.checkedAt === "string" ? stored.checkedAt : null,
    signText: typeof stored.signText === "string" && stored.signText.trim() !== "" ? stored.signText : null,
  };
}

/**
 * A reading of the same signboard taken AFTER a flag was filed, and whether it still says it.
 *
 * Derived from `phoenix_crm_places.signboard_check` at board time rather than stored on the case —
 * the same discipline the board already follows for a visit's `distance_meters`. A stored copy is a
 * second place for the truth to live, and a flag whose place is never re-read again would keep
 * whatever had been written into it the day it was filed.
 */
export type IntegrityLaterReading = {
  /** When the sign was last read, as an ISO instant. Always later than the flag's own filing. */
  checkedAt: string;
  /** Does the later reading still reach a verdict that would put a name on the board? */
  supportsFlag: boolean;
  /**
   * Does it take the flag off the board? Only a reading that ANSWERS the flag does.
   *
   * 🔴 NOT `!supportsFlag` — that was the defect. An `unjudged` reading supports nothing and
   * answers nothing, so it is false on both: the case keeps standing and keeps its settle button,
   * and the board still prints "read again on <date> and the sign could not be read".
   */
  withdrawsFlag: boolean;
  /** Is it the SAME finding as the one filed, and not merely still a finding? */
  sameFinding: boolean;
  /** What it says, in plain English, ready to print after "read again on <date>". */
  words: string;
  /** The sign's own words at that reading, in their own script. Null when it read nothing. */
  signText: string | null;
};

/**
 * Does a later reading of the same signboard still support the flag that was filed?
 *
 * 🔴 "LATER" IS MEASURED AGAINST WHEN THE FLAG WAS FILED, NEVER AGAINST THE CAPTURE. A case's
 * `captured_at` is when the REP stood at the door, days before the nightly pass ever read the
 * photograph — judge against that and the reading that FILED the flag withdraws it, emptying the
 * board of every signboard case at once. `created_at` is when the row was written, and an upsert
 * leaves it at the first filing, so a re-filed flag is judged against the first time it was made.
 *
 * 🔴 AND A MISSING OR UNPARSEABLE DATE LEAVES THE FLAG STANDING. Null is "nothing read it again",
 * never "it was withdrawn" — a board that quietly drops findings it cannot date is worse than one
 * that shows a stale finding, because the stale one can be read and judged.
 *
 * 🔴 A READING THAT REACHED NO VERDICT LEAVES IT STANDING FOR THE SAME REASON. `supportsFlag` says
 * whether the newest reading is itself a finding; `withdrawsFlag` says whether it takes the filed
 * one away, and only `match` does (`WITHDRAWING_SIGNBOARD_VERDICTS`). The board must read
 * `withdrawsFlag` — reading `!supportsFlag` withdrew every case whose sign had merely become
 * unreadable, which is the one thing legibility is known to do from one night to the next.
 */
export function judgeLaterSignboardReading(input: {
  source: string;
  flags: string[];
  /** The ISO instant the flag was filed — the case row's `created_at`. */
  filedAt: string | null;
  stored: StoredSignboardVerdict | null;
}): IntegrityLaterReading | null {
  // Only the signboard pass keeps a re-readable verdict somewhere else. Every other detector's
  // evidence is the capture itself, which cannot change its mind.
  if (input.source !== "signboard") return null;
  if (!input.stored || !input.stored.checkedAt || !input.filedAt) return null;
  const readAt = Date.parse(input.stored.checkedAt);
  const filedAt = Date.parse(input.filedAt);
  if (!Number.isFinite(readAt) || !Number.isFinite(filedAt) || readAt <= filedAt) return null;
  const supportsFlag = FLAGGABLE_SIGNBOARD_VERDICTS.has(input.stored.verdict);
  return {
    checkedAt: input.stored.checkedAt,
    supportsFlag,
    withdrawsFlag: WITHDRAWING_SIGNBOARD_VERDICTS.has(input.stored.verdict),
    sameFinding: supportsFlag && input.flags.includes(SIGNBOARD_VERDICT_FLAG[input.stored.verdict] ?? ""),
    words: laterReadingWords(input.stored.verdict, input.stored.reason),
    signText: input.stored.signText,
  };
}

// ── The three silent detectors (2026-10-12) — pure, and each the whole rule ─────────────────────
//
// 🔴 EVERY ONE OF THESE RETURNS FLAGS AND NOTHING ELSE. No refusal, no hold, no message, no number
// a rep can read: the owner's standing ruling on this module is "flag it, never stop the rep", and
// all five flags they can return are weak. They are here rather than in `server/silent-detectors.ts`
// so the arithmetic can be tested without a database, exactly as `checkLocationIntegrity` is.

/** One day's roster facts for the rep who saved a visit, and for whoever is named beside him. */
export type RosterDayInput = {
  /** True when the rep has approved leave covering the WHOLE day. A half day is not one. */
  repOnFullDayLeave: boolean;
  /** The full-day day-activity kinds recorded against the rep for that date. */
  repFullDayActivities: readonly string[];
  /** True when any companion named on the visit was on full-day leave or a full-day away activity. */
  companionOffDuty: boolean;
};

/**
 * What the roster says about the day a visit was saved on.
 *
 * 🔴 A HALF DAY IS NEVER A FINDING, AND THAT IS THE MEASUREMENT THAT SHAPED THIS. The audit reported
 * "1 visit inside approved leave" and 8 companion hits; read with `day_part = 'full_day'` all nine
 * vanish — every one was a half-day leave, and a rep with a morning excuse who calls a doctor in the
 * afternoon has done nothing at all. `repOnFullDayLeave` is therefore the caller's promise that the
 * whole day was covered, never "a leave row overlaps this date".
 */
export function judgeRosterDay(input: RosterDayInput): PhoenixCrmIntegrityFlag[] {
  const flags: PhoenixCrmIntegrityFlag[] = [];
  if (input.repOnFullDayLeave) flags.push("visit_on_leave");
  if (input.repFullDayActivities.some((activity) => PHOENIX_CRM_AWAY_DAY_ACTIVITIES.includes(activity))) {
    flags.push("visit_on_full_day_activity");
  }
  if (input.companionOffDuty) flags.push("companion_off_duty");
  return flags;
}

/**
 * Was this customer called too often in too few days by one rep?
 *
 * The dates are the visits' own business days, in any order; duplicates on one day count once,
 * because two calls on one doctor in one day is the double-visit rule's question and not this one.
 * A ROLLING window: the test is whether any REVISIT_WINDOW_DAYS-wide span holds
 * REVISIT_WINDOW_VISITS of them, never whether a calendar week does — a Thursday-and-Sunday pair
 * either side of a week boundary is the shape a calendar window misses.
 */
export function judgeRevisitCadence(businessDays: readonly string[]): PhoenixCrmIntegrityFlag[] {
  const days = [...new Set(businessDays.filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)))].sort();
  if (days.length < REVISIT_WINDOW_VISITS) return [];
  for (let start = 0; start + REVISIT_WINDOW_VISITS - 1 < days.length; start += 1) {
    const first = Date.parse(`${days[start]}T00:00:00Z`);
    const last = Date.parse(`${days[start + REVISIT_WINDOW_VISITS - 1]}T00:00:00Z`);
    if (!Number.isFinite(first) || !Number.isFinite(last)) continue;
    // Inclusive: Sunday to the following Saturday is seven days apart by the calendar and is one
    // week to a human, so `< REVISIT_WINDOW_DAYS` would miss exactly the span the rule names.
    if ((last - first) / 86_400_000 <= REVISIT_WINDOW_DAYS - 1) return ["customer_revisited_fast"];
  }
  return [];
}

/**
 * Is this place filed under a brick it is nowhere near?
 *
 * `brickDistanceKm` is read from the place row — `resolvePlaceLocation` wrote it when the place was
 * saved or moved — and is null when nobody ever looked. 🔴 NULL IS UNKNOWN AND FILES NOTHING: a row
 * written before the brick lookup existed has not been measured, and an unmeasured place is not a
 * far one. `brickMatched` is the row's own `brick_lookup = 'matched'` answer, and a matched place is
 * never flagged whatever the distance says — the lookup is the authority on its own verdict.
 */
export function judgePlaceBrickDistance(input: {
  brickDistanceKm: number | null;
  brickMatched: boolean;
}): PhoenixCrmIntegrityFlag[] {
  if (input.brickMatched) return [];
  if (input.brickDistanceKm === null || !Number.isFinite(input.brickDistanceKm)) return [];
  return input.brickDistanceKm > BRICK_FAR_KM ? ["place_brick_far"] : [];
}

// ── The visit against the photograph of its place (2026-10-13) ─────────────────────────────────

/**
 * Past how many metres a visit is far enough from the door to be a different question.
 *
 * The "far" line itself is NOT declared here: it is `visit_far_meters` in the module's own settings
 * (300 m on production, read live), the same figure a visit's own `location_flag` is written with,
 * so this detector and the place-vs-actual report can never disagree about what far means. A second
 * threshold in this file would be a second answer to one question.
 */
export const VISIT_PHOTO_VERY_FAR_METERS = 1000;

/**
 * WHOSE VISIT IS THIS? The one answer every visit-keyed detector asks, in one place.
 *
 * 🔴 `rep_hr_id` IS NULL ON A MANAGER'S OWN SINGLE VISIT, AND THAT IS THE DESIGN, NOT A LOST REP.
 * `resolveVisitParticipants` (`scope.ts`) returns `repHrId: null, managerHrId: actor` when a manager
 * enters a single visit on a territory — its sibling refusal says so in words: *"This territory has
 * no rep, so the visit can only be entered as your own single visit."* Every such row on production
 * (17 of them, 3–12 October 2026, two District Sales Managers) carries `manager_hr_id` equal to
 * `entered_by_hr_id`, a real fix accurate to 12–27 m, and `capture_source = 'server'` because the
 * save came from a browser rather than the app.
 *
 * 🔴 SO READING ONLY `rep_hr_id` LEFT A MANAGER'S OWN CALLS CHECKED BY NOTHING. Until 13 October
 * 2026 the roster, cadence and photograph passes each skipped a row with no rep, and one of those 17
 * sits **3,236 m** from the photograph of the place it names — measurable, past the line, past both
 * accuracy margins, and invisible. The board prints a name beside every case; this is where that
 * name comes from, so there is one for a manager too.
 *
 * It is `rep ?? manager` and never the other way round: on a double or a chain visit the rep is the
 * one whose call it was and the manager was with him. Null only where neither is set, and a row
 * naming nobody is still filed against nobody.
 */
export function personOnTheVisit(input: { repHrId: string | null; managerHrId: string | null }): string | null {
  const rep = typeof input.repHrId === "string" ? input.repHrId.trim().toUpperCase() : "";
  if (rep !== "") return rep;
  const manager = typeof input.managerHrId === "string" ? input.managerHrId.trim().toUpperCase() : "";
  return manager === "" ? null : manager;
}

/** One visit and the photograph it is measured against, each with the margin its phone reported. */
export type VisitPhotographInput = {
  visit: GeoPoint & { accuracyMeters: number | null };
  photograph: GeoPoint & { accuracyMeters: number | null };
  /** The settings' own far line, in metres — `visitFarMeters`, never a constant from this file. */
  farMeters: number;
};

/**
 * How far a visit sits from the photograph of the place it names, and whether that is a finding.
 *
 * THE PHOTOGRAPH IS THE ANCHOR (owner, 13 October 2026). A photograph carries the fix its own
 * shutter took at the door, so it is the one reading nobody can drag across a map; a pin can be.
 * This measures the visit against that reading alone and reports the metres whether or not it flags,
 * because the metres are what the panel prints and "not far" is a number a reader still wants.
 *
 * 🔴 AN ACCURACY CIRCLE THAT REACHES THE DOOR IS NOT A FINDING, AND THAT GUARD IS THE WHOLE
 * DIFFERENCE BETWEEN 48 AND 46. Measured on production 13 Oct 2026, the 48 visits past the 300 m
 * line include two of Yasmeen Samy's from 3 October, each reported accurate to 2,000 m — a phone
 * with precise location switched off, which is the one explanation on this board that is not a
 * judgement call (§8). A fix whose own margin covers the distance has not measured anything, so it
 * accuses nobody: both are dropped here rather than filed and settled later. The photograph's own
 * margin is read the same way.
 */
export function judgeVisitAgainstPhotograph(input: VisitPhotographInput): {
  flags: PhoenixCrmIntegrityFlag[];
  /** The metres between the two, always — null only when either reading is not a coordinate. */
  metres: number | null;
} {
  const { visit, photograph } = input;
  if (!Number.isFinite(visit.lat) || !Number.isFinite(visit.lon)) return { flags: [], metres: null };
  if (!Number.isFinite(photograph.lat) || !Number.isFinite(photograph.lon)) return { flags: [], metres: null };
  const metres = distanceMeters({ lat: visit.lat, lon: visit.lon }, { lat: photograph.lat, lon: photograph.lon });
  const far = Number.isFinite(input.farMeters) && input.farMeters > 0 ? input.farMeters : 300;
  if (metres <= far) return { flags: [], metres };
  // The margins, read as circles: either one reaching the other reading means the gap was never
  // measured. Null is "the phone reported none", which is not a reason to excuse anything.
  const visitMargin = visit.accuracyMeters !== null && Number.isFinite(visit.accuracyMeters) ? visit.accuracyMeters : 0;
  const photoMargin = photograph.accuracyMeters !== null && Number.isFinite(photograph.accuracyMeters) ? photograph.accuracyMeters : 0;
  if (metres <= visitMargin || metres <= photoMargin) return { flags: [], metres };
  const flags: PhoenixCrmIntegrityFlag[] = ["visit_far_from_photo"];
  if (metres > VISIT_PHOTO_VERY_FAR_METERS) flags.push("visit_very_far_from_photo");
  return { flags, metres };
}
