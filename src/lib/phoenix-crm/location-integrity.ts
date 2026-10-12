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
  | "sign_no_name";

export const PHOENIX_CRM_STRONG_INTEGRITY_FLAGS: readonly PhoenixCrmIntegrityFlag[] = [
  "mock_provider",
  "coordinate_replay",
  "impossible_travel",
  "zero_jitter",
  "photo_pin_disagrees",
  "sign_other_name",
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
  zero_jitter: "The position never moved all day",
  constant_accuracy: "Every reading had identical accuracy",
  typed_coordinate: "The coordinate looks typed, not measured",
  coarse_location: "The phone was set to approximate location, not precise",
  photo_pin_disagrees: "The photo and the pin are in different parts of the city",
  photo_pin_drifted: "The photo and the pin are further apart than one doorway",
  photo_pin_gap_long: "The pin was taken long before the photo",
  photo_pin_identical: "The photo and the pin are the same reading, to the bit",
  sign_other_name: "The signboard in the photo names somebody else",
  sign_no_name: "No name could be read on the signboard in the photo",
};

// ── Thresholds ──────────────────────────────────────────────────────────────────────────────────
// Every one of these is pinned by tests/phoenix-crm-location-integrity.test.ts. Loosen one only with
// a measurement in front of you: they are the line between catching a cheat and accusing a rep.

/**
 * Two fixes are "the same coordinate" at six decimals — about 11 cm. A GNSS receiver reporting the
 * same 11 cm twice, ever, does not happen: even a phone lying still on a table walks several metres
 * over an afternoon.
 */
export const REPLAY_DECIMALS = 6;

/**
 * …but a phone CAN hand back a cached fix to two readings taken minutes apart, so a repeat by the
 * same rep only counts once the readings are this far apart. A repeat by a DIFFERENT rep counts
 * immediately — two people cannot occupy the same 11 cm, and a shared coordinate is a shared preset.
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
   * The rep's own recent fixes, plus any fix by anyone that shares this coordinate. Order does not
   * matter; the caller decides how far back to look.
   */
  history: readonly PhoenixCrmPriorFix[];
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

function sameCoordinate(left: GeoPoint, right: GeoPoint): boolean {
  return roundTo(left.lat, REPLAY_DECIMALS) === roundTo(right.lat, REPLAY_DECIMALS) && roundTo(left.lon, REPLAY_DECIMALS) === roundTo(right.lon, REPLAY_DECIMALS);
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

  // ── Is this fix precise enough to be judged on precision at all? ──────────────────────────────
  //
  // A coarse reading is evidence of nothing precise on EITHER side of a comparison, so it is taken
  // out of both: this fix stops being judged, and a coarse fix already on record stops being
  // something to judge against. Without that second half an honest precise fix gets flagged for
  // "replaying" the tile centre its own phone handed back an hour earlier — the same false
  // accusation, one reading later.
  const isCoarse = (accuracyMeters: number | null): boolean =>
    accuracyMeters !== null && Number.isFinite(accuracyMeters) && accuracyMeters >= COARSE_ACCURACY_METERS;

  const fixIsCoarse = isCoarse(fix.accuracyMeters);
  const measured = history.filter((prior) => !isCoarse(prior.accuracyMeters));

  if (fixIsCoarse) {
    flags.add("coarse_location");
    signals.coarse = {
      accuracyMeters: fix.accuracyMeters,
      thresholdMeters: COARSE_ACCURACY_METERS,
      suppressed: [...PHOENIX_CRM_PRECISION_INTEGRITY_FLAGS],
    };
  }
  if (measured.length !== history.length) {
    signals.coarseHistoryIgnored = history.length - measured.length;
  }

  /** Publish a precision-dependent flag — unless this fix is too coarse to support one. */
  const addPrecisionFlag = (flag: PhoenixCrmIntegrityFlag): void => {
    if (!fixIsCoarse) flags.add(flag);
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
