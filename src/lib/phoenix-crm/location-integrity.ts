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
 */

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
  | "typed_coordinate";

export const PHOENIX_CRM_STRONG_INTEGRITY_FLAGS: readonly PhoenixCrmIntegrityFlag[] = [
  "mock_provider",
  "coordinate_replay",
  "impossible_travel",
  "zero_jitter",
];

/** Human wording for the board. Plain English — the reader is a manager, not an engineer. */
export const PHOENIX_CRM_INTEGRITY_LABELS: Record<PhoenixCrmIntegrityFlag, string> = {
  mock_provider: "The phone reported a mock location app",
  coordinate_replay: "This exact coordinate was used before",
  impossible_travel: "Could not have travelled that far in the time",
  zero_jitter: "The position never moved all day",
  constant_accuracy: "Every reading had identical accuracy",
  typed_coordinate: "The coordinate looks typed, not measured",
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

/** The same calendar day in Cairo, which is the day the visit is filed under. */
function cairoDay(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
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

  // ── Replay — this coordinate has been used before ─────────────────────────────────────────────
  const replay = history.find((prior) => {
    if (!sameCoordinate(fix, prior)) return false;
    if (prior.repHrId !== repHrId) return true;
    return minutesBetween(fix.capturedAt, prior.capturedAt) > REPLAY_MIN_GAP_MINUTES;
  });
  if (replay) {
    flags.add("coordinate_replay");
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
    ...history.filter((prior) => prior.repHrId === repHrId && cairoDay(prior.capturedAt) === day),
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
      flags.add("zero_jitter");
    }

    const accuracies = sameDay.map((entry) => entry.accuracyMeters).filter((value): value is number => value !== null);
    if (accuracies.length >= CONSTANT_ACCURACY_MIN_FIXES && new Set(accuracies.map((value) => roundTo(value, 1))).size === 1) {
      flags.add("constant_accuracy");
      signals.constantAccuracy = accuracies[0];
    }
  }

  // ── Precision — a coordinate nobody measured ──────────────────────────────────────────────────
  if (isRounded(fix.lat, TYPED_COORDINATE_DECIMALS) && isRounded(fix.lon, TYPED_COORDINATE_DECIMALS)) {
    flags.add("typed_coordinate");
  }

  const ordered = [...flags].sort();
  return {
    flags: ordered,
    strong: ordered.some((flag) => PHOENIX_CRM_STRONG_INTEGRITY_FLAGS.includes(flag)),
    signals,
  };
}
