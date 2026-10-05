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
  | "coarse_location";

export const PHOENIX_CRM_STRONG_INTEGRITY_FLAGS: readonly PhoenixCrmIntegrityFlag[] = [
  "mock_provider",
  "coordinate_replay",
  "impossible_travel",
  "zero_jitter",
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
