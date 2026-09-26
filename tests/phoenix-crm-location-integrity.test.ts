import assert from "node:assert/strict";

import {
  CONSTANT_ACCURACY_MIN_FIXES,
  checkLocationIntegrity,
  MAX_TRAVEL_KMH,
  PHOENIX_CRM_INTEGRITY_LABELS,
  PHOENIX_CRM_STRONG_INTEGRITY_FLAGS,
  REPLAY_MIN_GAP_MINUTES,
  TRAVEL_MIN_METERS,
  ZERO_JITTER_METERS,
  type PhoenixCrmPriorFix,
} from "../src/lib/phoenix-crm/location-integrity.ts";
import { parseCapturedFix } from "../src/lib/phoenix-crm/entry-rules.ts";

/**
 * Phoenix CRM — the mock-location and GPS-plausibility checks.
 *
 * Two things are pinned here, and the second matters as much as the first:
 *
 *   1. THE DETECTORS FIRE on what they are meant to catch — and, at least as important, do NOT fire
 *      on an honest rep. Half of the cases below are deliberately innocent: a rep in one building all
 *      morning, a wide fix indoors, two readings minutes apart from a cached position. A false
 *      positive here accuses a real person of fraud, which is worse than a missed catch.
 *
 *   2. THE REP IS NEVER TOLD (owner, 2026-09-25). No message, no refusal, no field on any screen he
 *      can open. That is a property of the whole change rather than of one function, so it is
 *      checked against the source of the paths a rep's app actually renders.
 */

const CAIRO_CLINIC = { lat: 30.0444187, lon: 31.2357116 };

function at(iso: string): Date {
  return new Date(iso);
}

function prior(overrides: Partial<PhoenixCrmPriorFix> = {}): PhoenixCrmPriorFix {
  return {
    lat: CAIRO_CLINIC.lat,
    lon: CAIRO_CLINIC.lon,
    accuracyMeters: 20,
    capturedAt: at("2026-09-24T09:00:00.000Z"),
    repHrId: "R-1",
    customerId: "c-1",
    ...overrides,
  };
}

function judge(input: {
  lat?: number;
  lon?: number;
  accuracyMeters?: number | null;
  capturedAt?: string;
  deviceMocked?: boolean | null;
  history?: PhoenixCrmPriorFix[];
  customerId?: string | null;
}) {
  return checkLocationIntegrity({
    fix: {
      lat: input.lat ?? CAIRO_CLINIC.lat,
      lon: input.lon ?? CAIRO_CLINIC.lon,
      accuracyMeters: input.accuracyMeters === undefined ? 18 : input.accuracyMeters,
      capturedAt: at(input.capturedAt ?? "2026-09-24T12:00:00.000Z"),
    },
    repHrId: "R-1",
    customerId: input.customerId === undefined ? "c-9" : input.customerId,
    deviceMocked: input.deviceMocked ?? null,
    history: input.history ?? [],
  });
}

export function runPhoenixCrmLocationIntegrityTests(): void {
  // ── Layer 1 — the phone's own confession ──────────────────────────────────────────────────────

  {
    const verdict = judge({ deviceMocked: true });
    assert.ok(verdict.flags.includes("mock_provider"), "Android's mock-provider flag must be caught");
    assert.equal(verdict.strong, true, "a mock provider is damning on its own");
  }

  {
    // Null is "we could not ask" — the web, and iOS. It is never read as a confession.
    assert.equal(judge({ deviceMocked: null }).flags.includes("mock_provider"), false);
    assert.equal(judge({ deviceMocked: false }).flags.includes("mock_provider"), false);
  }

  // ── Replay — a coordinate that has been used before ───────────────────────────────────────────

  {
    const verdict = judge({
      capturedAt: "2026-09-24T12:00:00.000Z",
      history: [prior({ capturedAt: at("2026-09-24T09:00:00.000Z") })],
    });
    assert.ok(verdict.flags.includes("coordinate_replay"), "the same coordinate hours later is a replay");
    assert.equal(verdict.strong, true);
  }

  {
    // A DIFFERENT rep on the same coordinate counts immediately: two people cannot share 11 cm.
    const verdict = judge({
      capturedAt: "2026-09-24T12:00:00.000Z",
      history: [prior({ repHrId: "R-2", capturedAt: at("2026-09-24T11:59:00.000Z") })],
    });
    assert.ok(verdict.flags.includes("coordinate_replay"), "a shared coordinate is a shared preset");
  }

  {
    // …but the SAME rep minutes apart is an ordinary cached fix, and must not be flagged.
    const gap = REPLAY_MIN_GAP_MINUTES - 5;
    const verdict = judge({
      capturedAt: "2026-09-24T12:00:00.000Z",
      history: [prior({ capturedAt: at(`2026-09-24T${String(11).padStart(2, "0")}:${String(60 - gap).padStart(2, "0")}:00.000Z`) })],
    });
    assert.equal(verdict.flags.includes("coordinate_replay"), false, "a cached fix minutes apart is not fraud");
  }

  {
    // A real second reading differs in the sixth decimal. That must stay clean.
    const verdict = judge({
      lat: CAIRO_CLINIC.lat + 0.000004,
      history: [prior({ capturedAt: at("2026-09-24T09:00:00.000Z") })],
    });
    assert.equal(verdict.flags.includes("coordinate_replay"), false, "a fix that moved 40 cm is a real fix");
  }

  // ── Travel — physics ──────────────────────────────────────────────────────────────────────────

  {
    // Cairo to Alexandria, ~180 km, twenty minutes apart. Nobody did that.
    const verdict = judge({
      lat: 31.2000924,
      lon: 29.9187387,
      capturedAt: "2026-09-24T09:20:00.000Z",
      history: [prior({ capturedAt: at("2026-09-24T09:00:00.000Z") })],
    });
    assert.ok(verdict.flags.includes("impossible_travel"), "180 km in 20 minutes must be caught");
    assert.equal(verdict.strong, true);
  }

  {
    // The same trip over four hours is an ordinary working day and must stay clean.
    const verdict = judge({
      lat: 31.2000924,
      lon: 29.9187387,
      capturedAt: "2026-09-24T13:00:00.000Z",
      history: [prior({ capturedAt: at("2026-09-24T09:00:00.000Z") })],
    });
    assert.equal(verdict.flags.includes("impossible_travel"), false, "Cairo to Alexandria in four hours is a drive");
  }

  {
    // A wide, noisy indoor fix must never invent a trip: both error bars come off the distance first.
    const verdict = judge({
      lat: CAIRO_CLINIC.lat + 0.01,
      accuracyMeters: 1500,
      capturedAt: "2026-09-24T09:00:30.000Z",
      history: [prior({ accuracyMeters: 1500, capturedAt: at("2026-09-24T09:00:00.000Z") })],
    });
    assert.equal(verdict.flags.includes("impossible_travel"), false, "receiver noise is not travel");
  }

  // ── The day — jitter and accuracy ─────────────────────────────────────────────────────────────

  {
    // Four customers, five hours, and the position never moved. A real receiver cannot do this.
    const frozen = [
      prior({ customerId: "c-1", capturedAt: at("2026-09-24T07:00:00.000Z") }),
      prior({ customerId: "c-2", capturedAt: at("2026-09-24T09:00:00.000Z") }),
      prior({ customerId: "c-3", capturedAt: at("2026-09-24T11:00:00.000Z") }),
    ];
    const verdict = judge({ capturedAt: "2026-09-24T12:00:00.000Z", history: frozen });
    assert.ok(verdict.flags.includes("zero_jitter"), "a day that never moved must be caught");
    assert.equal(verdict.strong, true);
  }

  {
    // The same building all morning, with ordinary drift, is a polyclinic — and is NOT fraud.
    const drifting = [
      prior({ customerId: "c-1", lat: CAIRO_CLINIC.lat + 0.00012, capturedAt: at("2026-09-24T07:00:00.000Z") }),
      prior({ customerId: "c-2", lat: CAIRO_CLINIC.lat - 0.00009, capturedAt: at("2026-09-24T09:00:00.000Z") }),
      prior({ customerId: "c-3", lon: CAIRO_CLINIC.lon + 0.00011, capturedAt: at("2026-09-24T11:00:00.000Z") }),
    ];
    const verdict = judge({ capturedAt: "2026-09-24T12:00:00.000Z", history: drifting });
    assert.equal(verdict.flags.includes("zero_jitter"), false, "a rep working one building must never be flagged");
  }

  {
    // Identical accuracy all day — a corroborating signal, deliberately NOT damning on its own.
    const history = Array.from({ length: CONSTANT_ACCURACY_MIN_FIXES }, (_unused, index) =>
      prior({
        customerId: `c-${index}`,
        lat: CAIRO_CLINIC.lat + index * 0.004,
        accuracyMeters: 12,
        capturedAt: at(`2026-09-24T0${index + 1}:00:00.000Z`),
      }),
    );
    const verdict = checkLocationIntegrity({
      fix: { lat: CAIRO_CLINIC.lat + 0.05, lon: CAIRO_CLINIC.lon, accuracyMeters: 12, capturedAt: at("2026-09-24T12:00:00.000Z") },
      repHrId: "R-1",
      customerId: "c-99",
      deviceMocked: null,
      history,
    });
    assert.ok(verdict.flags.includes("constant_accuracy"));
    assert.equal(PHOENIX_CRM_STRONG_INTEGRITY_FLAGS.includes("constant_accuracy"), false, "identical accuracy only corroborates");
  }

  // ── Precision — a coordinate nobody measured ──────────────────────────────────────────────────

  {
    assert.ok(judge({ lat: 30.05, lon: 31.24 }).flags.includes("typed_coordinate"), "a four-decimal pin was chosen, not measured");
    assert.equal(judge({}).flags.includes("typed_coordinate"), false, "a real seven-decimal fix is clean");
  }

  // ── An honest visit is completely clean ───────────────────────────────────────────────────────

  {
    const verdict = judge({
      lat: 30.0512345,
      lon: 31.2398765,
      accuracyMeters: 14,
      deviceMocked: false,
      history: [prior({ lat: 30.0401234, lon: 31.2301234, capturedAt: at("2026-09-24T10:30:00.000Z") })],
    });
    assert.deepEqual(verdict.flags, [], "an ordinary visit must produce no flags at all");
    assert.equal(verdict.strong, false);
  }

  // ── The contract: every flag has plain English, and strong flags are a subset ──────────────────

  for (const flag of Object.keys(PHOENIX_CRM_INTEGRITY_LABELS)) {
    assert.ok(PHOENIX_CRM_INTEGRITY_LABELS[flag as keyof typeof PHOENIX_CRM_INTEGRITY_LABELS].length > 10, `${flag} needs a readable label`);
  }
  for (const flag of PHOENIX_CRM_STRONG_INTEGRITY_FLAGS) {
    assert.ok(flag in PHOENIX_CRM_INTEGRITY_LABELS, `${flag} must have a label`);
  }
  assert.ok(MAX_TRAVEL_KMH >= 150 && TRAVEL_MIN_METERS >= 1000 && ZERO_JITTER_METERS <= 10, "thresholds must stay on the generous side");

  // ── The wire: a body that says nothing is "not asked", never "clean", and never refused ────────

  {
    const parsed = parseCapturedFix({ lat: CAIRO_CLINIC.lat, lon: CAIRO_CLINIC.lon, accuracyMeters: 12 });
    assert.equal(parsed.ok, true, "an older build that sends no mock flag must still save");
    if (parsed.ok) assert.equal(parsed.value.deviceMocked, null);

    const mocked = parseCapturedFix({ lat: CAIRO_CLINIC.lat, lon: CAIRO_CLINIC.lon, deviceMocked: true });
    assert.equal(mocked.ok, true, "a confessed mock location must still SAVE — the rep is never refused");
    if (mocked.ok) assert.equal(mocked.value.deviceMocked, true);

    // Anything that is not a boolean is "not asked", so a junk value cannot fake innocence either.
    const junk = parseCapturedFix({ lat: CAIRO_CLINIC.lat, lon: CAIRO_CLINIC.lon, deviceMocked: "false" });
    if (junk.ok) assert.equal(junk.value.deviceMocked, null);
  }

  // ── THE OWNER'S RULE: the rep is never told ───────────────────────────────────────────
  //
  // Moved to `tests/phoenix-crm-blind-half.test.ts` on 2026-09-26, and WIDENED there.
  //
  // It lived here as a hard-coded list of six rep-facing files, which is a guard that cannot grow:
  // the seventh screen anyone writes is born unchecked, and the module is about to gain several.
  // The replacement DERIVES the surface by sweeping the rep-facing roots, so a new screen is covered
  // the moment it exists, and it reads JSX text as well as string literals — a word typed straight
  // into the markup went past the old guard entirely.
  //
  // Do not re-add the list here. One guard, one place, and it grows by itself.

  console.log("phoenix-crm location integrity: OK");
}
