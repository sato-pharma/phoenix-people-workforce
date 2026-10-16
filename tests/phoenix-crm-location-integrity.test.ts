import assert from "node:assert/strict";

import {
  COARSE_ACCURACY_METERS,
  CONSTANT_ACCURACY_MIN_FIXES,
  checkLocationIntegrity,
  MAX_TRAVEL_KMH,
  PHOENIX_CRM_INTEGRITY_LABELS,
  PHOENIX_CRM_PRECISION_INTEGRITY_FLAGS,
  PHOENIX_CRM_STRONG_INTEGRITY_FLAGS,
  REPLAY_MIN_GAP_MINUTES,
  TRAVEL_MIN_METERS,
  ZERO_JITTER_METERS,
  BRICK_FAR_KM,
  judgePlaceBrickDistance,
  judgeRevisitCadence,
  judgeRosterDay,
  judgeVisitAgainstPhotograph,
  personOnTheVisit,
  VISIT_PHOTO_VERY_FAR_METERS,
  PHOENIX_CRM_AWAY_DAY_ACTIVITIES,
  REVISIT_WINDOW_DAYS,
  REVISIT_WINDOW_VISITS,
  type PhoenixCrmPriorFix,
} from "../src/lib/phoenix-crm/location-integrity.ts";
import { PHOENIX_CRM_DAY_ACTIVITIES } from "../src/lib/phoenix-crm/day-activities.ts";
import { parseCapturedFix } from "../src/lib/phoenix-crm/entry-rules.ts";
import { probeLocationReader, readLocationReaderAnswer } from "../src/lib/phoenix-crm/location-reader-probe.ts";
import { countedIntegrityFlags } from "../src/lib/rep-ranks/field-quality.ts";

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

  {
    // 🔴 THE PRODUCTION FALSE POSITIVE, VERBATIM — the pair that retired the rounded match.
    // One rep, the same hospital, 22 minutes apart (so past REPLAY_MIN_GAP_MINUTES), two readings
    // 1.3 cm apart carrying DIFFERENT accuracies — 49.9 m and 54.9 m — which is what proves neither
    // is a cached copy of the other. Inside REPLAY_DECIMALS these round to the same six decimals, so
    // the old test called it a replay and charged him a STRONG flag on the Integrity board and in
    // Phoenix Ranks. A receiver solving for position twice lands near itself; it does not repeat.
    const verdict = judge({
      lat: 30.0323547138734,
      lon: 31.0041319110873,
      accuracyMeters: 54.9,
      capturedAt: "2026-10-11T08:45:43.161Z",
      history: [
        prior({
          lat: 30.032354829736,
          lon: 31.0041317788402,
          accuracyMeters: 49.9,
          capturedAt: at("2026-10-11T08:23:33.961Z"),
        }),
      ],
    });
    assert.equal(
      verdict.flags.includes("coordinate_replay"),
      false,
      "two honest readings 1.3 cm apart are not a replayed coordinate",
    );
    assert.equal(verdict.strong, false, "and nothing else on that pair may make it a strong case either");
  }

  {
    // …while the shape it exists to catch is untouched: the SAME coordinate to the last digit, which
    // is what a fake-GPS preset hands back. Mahmoud's and Nada's production rows are both this.
    const verdict = judge({
      lat: 30.5602031056426,
      lon: 31.0106195072006,
      accuracyMeters: 18.7,
      capturedAt: "2026-10-06T12:40:29.294Z",
      history: [
        prior({
          lat: 30.5602031056426,
          lon: 31.0106195072006,
          accuracyMeters: 18.7,
          capturedAt: at("2026-10-06T12:09:13.989Z"),
        }),
      ],
    });
    assert.ok(verdict.flags.includes("coordinate_replay"), "an exactly repeated coordinate is still a replay");
    assert.equal(verdict.strong, true);
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

  // ── Approximate location — a phone setting, not a fraud ───────────────────────────────────────
  //
  // Android's "Precise location" toggle has an off position. With it off the OS returns a
  // grid-snapped tile centre with one fixed accuracy, so the coordinate repeats and the accuracy
  // never varies BY CONSTRUCTION. Four of the detectors above read that as a preset, and on
  // 2026-10-03 they accused a working rep three times over. These cases are the gate.

  {
    // The production shape, to the digit: Yasmeen Samy's morning — 11 fixes, 4 customers, zero
    // spread, every reading exactly 2000 m, and the phone confessing nothing because there was
    // nothing to confess. Those rows carried `coordinate_replay`, which is STRONG.
    const COARSE_TILE = { lat: 30.4684684684685, lon: 31.1899555209043 };
    const morning = Array.from({ length: 10 }, (_unused, index) =>
      prior({
        ...COARSE_TILE,
        accuracyMeters: 2000,
        customerId: `c-${index % 4}`,
        capturedAt: at(`2026-10-03T07:${String(19 + index * 3).padStart(2, "0")}:58.648Z`),
      }),
    );
    const verdict = checkLocationIntegrity({
      fix: { ...COARSE_TILE, accuracyMeters: 2000, capturedAt: at("2026-10-03T08:10:00.000Z") },
      repHrId: "R-1",
      customerId: "c-3",
      deviceMocked: null,
      history: morning,
    });
    assert.deepEqual(verdict.flags, ["coarse_location"], "an approximate-location morning is ONE honest observation, not a case");
    assert.equal(verdict.strong, false, "a phone setting must never be damning");
    assert.equal(PHOENIX_CRM_STRONG_INTEGRITY_FLAGS.includes("coarse_location"), false);
  }

  {
    // Every precision flag, one at a time, must go quiet on a coarse fix — and say so in `signals`
    // rather than vanishing, so a manager reading the row can see what was set aside and why.
    const verdict = judge({
      lat: 30.05,
      lon: 31.24,
      accuracyMeters: COARSE_ACCURACY_METERS,
      history: [prior({ lat: 30.05, lon: 31.24, accuracyMeters: 2000, capturedAt: at("2026-09-24T09:00:00.000Z") })],
    });
    for (const flag of PHOENIX_CRM_PRECISION_INTEGRITY_FLAGS) {
      assert.equal(verdict.flags.includes(flag), false, `${flag} cannot be claimed about an approximate fix`);
    }
    const coarse = verdict.signals.coarse as { thresholdMeters: number; suppressed: string[] } | undefined;
    assert.equal(coarse?.thresholdMeters, COARSE_ACCURACY_METERS, "the row records the line it fell on");
    assert.deepEqual([...(coarse?.suppressed ?? [])].sort(), [...PHOENIX_CRM_PRECISION_INTEGRITY_FLAGS].sort());
    assert.equal(verdict.signals.coarseHistoryIgnored, 1, "and how many coarse readings were left out of the evidence");
  }

  {
    // 🔴 THE LATENT ONE. Her morning spanned 59 minutes and `zero_jitter` wants 120, so the clock is
    // all that saved her from "the position never moved all day" — a STRONG flag — on a full day.
    const allDay = [
      prior({ accuracyMeters: 2000, customerId: "c-1", capturedAt: at("2026-10-03T06:00:00.000Z") }),
      prior({ accuracyMeters: 2000, customerId: "c-2", capturedAt: at("2026-10-03T08:00:00.000Z") }),
      prior({ accuracyMeters: 2000, customerId: "c-3", capturedAt: at("2026-10-03T10:00:00.000Z") }),
    ];
    const verdict = checkLocationIntegrity({
      fix: { ...CAIRO_CLINIC, accuracyMeters: 2000, capturedAt: at("2026-10-03T11:00:00.000Z") },
      repHrId: "R-1",
      customerId: "c-4",
      deviceMocked: null,
      history: allDay,
    });
    assert.equal(verdict.flags.includes("zero_jitter"), false, "a tile centre that never drifts is the tile, not the rep");
    assert.equal(verdict.strong, false);
  }

  {
    // The other half of the gate: a PRECISE fix must not be flagged for repeating a coarse reading
    // its own phone produced earlier. Without this the false accusation just lands one fix later.
    const verdict = judge({
      accuracyMeters: 14,
      capturedAt: "2026-09-24T12:00:00.000Z",
      history: [prior({ accuracyMeters: 2000, capturedAt: at("2026-09-24T09:00:00.000Z") })],
    });
    assert.equal(verdict.flags.includes("coordinate_replay"), false, "a coarse prior is not a coordinate anyone can replay");
    assert.deepEqual(verdict.flags, [], "and nothing else may fire on it either");
  }

  {
    // What the gate does NOT waive. The phone's own confession owes nothing to precision…
    const confessed = judge({ accuracyMeters: 2000, deviceMocked: true });
    assert.ok(confessed.flags.includes("mock_provider"), "a mock provider is caught at any accuracy");
    assert.equal(confessed.strong, true, "and is still damning");

    // …and physics still applies, with both error bars subtracted first: Cairo to Alexandria in
    // twenty minutes is impossible by far more than 4 km of slack.
    const flown = judge({
      lat: 31.2000924,
      lon: 29.9187387,
      accuracyMeters: 2000,
      capturedAt: "2026-09-24T09:20:00.000Z",
      history: [prior({ accuracyMeters: 2000, capturedAt: at("2026-09-24T09:00:00.000Z") })],
    });
    assert.ok(flown.flags.includes("impossible_travel"), "a coarse fix cannot buy immunity from physics");
    assert.equal(flown.strong, true);
  }

  {
    // The line sits in an empty band: 772 real fixes reach 122.4 m at the 99th, and the nearest
    // coarse reading measured was 1273.4 m. A wide-but-real indoor fix stays fully judged.
    const wideButReal = judge({
      accuracyMeters: 122.4,
      capturedAt: "2026-09-24T12:00:00.000Z",
      history: [prior({ accuracyMeters: 122.4, capturedAt: at("2026-09-24T09:00:00.000Z") })],
    });
    assert.ok(wideButReal.flags.includes("coordinate_replay"), "an honest wide fix is still held to the precision tests");
    assert.equal(wideButReal.flags.includes("coarse_location"), false, "122 m is a receiver reading, not a tile");
    assert.ok(COARSE_ACCURACY_METERS > 122.4 * 4, "the gate stays clear of the worst honest fix measured");
    assert.ok(COARSE_ACCURACY_METERS < 1273.4, "and below the nearest approximate-mode fix measured");
  }

  {
    // 🔴 THIS BLOCK ASSERTED THE OPPOSITE UNTIL 2026-10-12, and the old wording — "an older build
    // that sends no accuracy must keep being judged as before" — WAS the hole the second-pass audit
    // found under gap 15. The capture gate deliberately ACCEPTS a reading with no accuracy figure
    // (`entry-rules.ts`: "an UNKNOWN accuracy is still taken, as it always was") precisely because
    // we cannot measure it, and `isCoarse` then returned false for null, so the very same reading
    // was handed to all four precision detectors and judged as though we could. Fixed on the
    // owner's instruction: "fix the unknown-accuracy hole in the precision detectors".
    //
    // Measured on production the same day: 18 of 1,598 visits and 7 of 1,418 places report no
    // accuracy, every one of them eligible for all four detectors; none had tripped one, so this
    // closes the hole before it accused anybody rather than after.
    //
    // 🔴 THE TWO HALVES ARE PINNED SEPARATELY AND MUST STAY THAT WAY. A single case with a null
    // accuracy on BOTH sides passes whichever half is broken, because the other half suppresses it
    // — written that way first, it went green with the old gate restored.

    // Half one: THIS fix reported no accuracy. The prior is an ordinary 20 m reading at the same
    // point, so the only thing stopping a replay verdict is the gate.
    const silentFix = judge({
      accuracyMeters: null,
      capturedAt: "2026-09-24T12:00:00.000Z",
      history: [prior({ capturedAt: at("2026-09-24T09:00:00.000Z") })],
    });
    assert.equal(silentFix.flags.includes("coarse_location"), false, "a missing accuracy is not an approximate fix");
    assert.equal(
      silentFix.flags.includes("coordinate_replay"),
      false,
      "a reading that reported no accuracy cannot support a precision verdict: the gate takes it on trust, so the detectors may not judge it",
    );
    assert.deepEqual(silentFix.flags, [], "and it earns no flag of its own — 25 quiet handsets are not 25 standing cases");
    const unmeasured = silentFix.signals.unmeasuredAccuracy as { suppressed: string[] } | undefined;
    assert.deepEqual(
      [...(unmeasured?.suppressed ?? [])].sort(),
      [...PHOENIX_CRM_PRECISION_INTEGRITY_FLAGS].sort(),
      "the row records WHICH detectors went quiet, as a coarse row does",
    );

    // Half two: a perfectly good fix, over a PRIOR that reported no accuracy. Without this half an
    // honest reading is flagged for replaying a point nobody ever measured — the same false
    // accusation as the coarse case, one reading later.
    const silentPrior = judge({
      accuracyMeters: 18,
      capturedAt: "2026-09-24T12:00:00.000Z",
      history: [prior({ accuracyMeters: null, capturedAt: at("2026-09-24T09:00:00.000Z") })],
    });
    assert.equal(
      silentPrior.flags.includes("coordinate_replay"),
      false,
      "an unmeasured prior is not a coordinate anyone can be accused of replaying",
    );
    assert.equal(silentPrior.signals.unmeasuredHistoryIgnored, 1, "and the row counts the unmeasured priors");
    assert.equal(
      silentPrior.signals.coarseHistoryIgnored,
      undefined,
      "apart from the coarse ones — reading one as the other sends the next session to the wrong rule",
    );
    assert.equal(
      silentPrior.signals.unmeasuredAccuracy,
      undefined,
      "and says nothing about THIS fix, which measured itself perfectly well",
    );
  }

  {
    // The two that still fire on it, by the owner's 2026-10-05 ruling: neither is a claim about
    // precision. A missing accuracy contributes no slack to the distance, so it cannot invent a
    // trip either — the travel check is stricter on it, not kinder.
    const mocked = judge({ accuracyMeters: null, deviceMocked: true });
    assert.ok(
      mocked.flags.includes("mock_provider"),
      "an unknown accuracy is no shelter from the phone's own confession",
    );
    const flown = judge({
      accuracyMeters: null,
      lat: 31.2001187,
      lon: 29.9001116,
      capturedAt: "2026-09-24T09:20:00.000Z",
      history: [prior({ capturedAt: at("2026-09-24T09:00:00.000Z") })],
    });
    assert.ok(flown.flags.includes("impossible_travel"), "nor from physics");
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

  // ── The three silent detectors (2026-10-12) ───────────────────────────────────────────────────
  //
  // Each one's HONEST case matters more than its catch, because all three read data that is normal
  // almost everywhere: a working rep has away days, a good doctor is seen often, and most of the
  // brick master has never been drawn.

  {
    // Every away key is a real day-activity key. A typo here is not a type error — it is a branch
    // that can never be true, and the detector would simply never fire.
    const keys = new Set<string>(PHOENIX_CRM_DAY_ACTIVITIES.map((entry) => entry.key));
    for (const away of PHOENIX_CRM_AWAY_DAY_ACTIVITIES) {
      assert.ok(keys.has(away), `${away} is not a day-activity key, so the roster check can never match it`);
    }
    // 🔴 AND THE TWO THAT MUST STAY OUT. A sales day IS field work; admin work is routinely half a
    // day at a desk and half on the road. Flagging either accuses every rep who records one.
    assert.equal(PHOENIX_CRM_AWAY_DAY_ACTIVITIES.includes("sales_day"), false, "a sales day is field work, not a day away");
    assert.equal(PHOENIX_CRM_AWAY_DAY_ACTIVITIES.includes("admin_work"), false, "admin work is not a day away from the field");
  }

  {
    const clean = judgeRosterDay({ repOnFullDayLeave: false, repFullDayActivities: [], companionOffDuty: false });
    assert.deepEqual(clean, [], "an ordinary day files nothing at all");

    assert.deepEqual(
      judgeRosterDay({ repOnFullDayLeave: true, repFullDayActivities: [], companionOffDuty: false }),
      ["visit_on_leave"],
      "a visit saved on a full day of approved leave is worth a look",
    );
    assert.deepEqual(
      judgeRosterDay({ repOnFullDayLeave: false, repFullDayActivities: ["conference"], companionOffDuty: false }),
      ["visit_on_full_day_activity"],
      "a visit on a full conference day is worth a look",
    );
    assert.deepEqual(
      judgeRosterDay({ repOnFullDayLeave: false, repFullDayActivities: ["sales_day"], companionOffDuty: false }),
      [],
      "a sales day must never be read as a day away from the field",
    );
    assert.deepEqual(
      judgeRosterDay({ repOnFullDayLeave: false, repFullDayActivities: ["admin_work", "sales_day"], companionOffDuty: false }),
      [],
      "admin work beside a sales day is still a working day",
    );
    assert.deepEqual(
      judgeRosterDay({ repOnFullDayLeave: false, repFullDayActivities: [], companionOffDuty: true }),
      ["companion_off_duty"],
      "a named companion who was off duty is worth a look",
    );
    // All three at once, in the declared order, and still WEAK — the strength is the filer's to
    // compute from the shared list, and no flag here is in it.
    const all = judgeRosterDay({ repOnFullDayLeave: true, repFullDayActivities: ["training"], companionOffDuty: true });
    assert.deepEqual(all, ["visit_on_leave", "visit_on_full_day_activity", "companion_off_duty"]);
    for (const flag of all) {
      assert.equal(
        (PHOENIX_CRM_STRONG_INTEGRITY_FLAGS as readonly string[]).includes(flag),
        false,
        `${flag} must stay weak — a strong flag moves the rep's own Integrity score`,
      );
    }
  }

  {
    // The cadence rule, at and either side of its own edge.
    assert.deepEqual(judgeRevisitCadence(["2026-10-01", "2026-10-03"]), [], "two calls in a week is ordinary");
    assert.deepEqual(
      judgeRevisitCadence(["2026-10-01", "2026-10-03", "2026-10-07"]),
      ["customer_revisited_fast"],
      "three calls inside seven days is worth a look",
    );
    // 🔴 THE WINDOW IS INCLUSIVE: Thursday to the following Wednesday is seven days to a human.
    assert.deepEqual(judgeRevisitCadence(["2026-10-01", "2026-10-04", "2026-10-07"]), ["customer_revisited_fast"]);
    // …and the eighth day is outside it.
    assert.deepEqual(judgeRevisitCadence(["2026-10-01", "2026-10-04", "2026-10-09"]), [], "three calls spread over nine days is not a cluster");
    // Two calls on ONE day are one day: that is the double-visit rule's question, not this one.
    assert.deepEqual(judgeRevisitCadence(["2026-10-01", "2026-10-01", "2026-10-02"]), [], "two calls in one day count once");
    // A ROLLING window, not a calendar week: the cluster here straddles a week boundary.
    assert.deepEqual(judgeRevisitCadence(["2026-10-09", "2026-10-10", "2026-10-11"]), ["customer_revisited_fast"]);
    // Order must not matter, and nor must rubbish in the list.
    assert.deepEqual(judgeRevisitCadence(["2026-10-07", "2026-10-01", "2026-10-03"]), ["customer_revisited_fast"]);
    assert.deepEqual(judgeRevisitCadence(["", "not-a-date", "2026-10-01"]), [], "an unparseable day files nothing");
    assert.equal(REVISIT_WINDOW_VISITS, 3, "the rule is three calls; two is ordinary clinic life");
    assert.equal(REVISIT_WINDOW_DAYS, 7, "the window is one week");
  }

  {
    // 🔴 NULL IS UNKNOWN AND FILES NOTHING. A place written before the brick lookup existed has not
    // been measured, and an unmeasured place is not a far one.
    assert.deepEqual(judgePlaceBrickDistance({ brickDistanceKm: null, brickMatched: false }), [], "an unmeasured brick distance is not a far one");
    // 🔴 AND A MATCHED PLACE IS NEVER FLAGGED, whatever the distance column says: the lookup is the
    // authority on its own verdict, and this flag is only ever about a place it could not match.
    assert.deepEqual(judgePlaceBrickDistance({ brickDistanceKm: 99, brickMatched: true }), [], "a matched place is never far from its own brick");
    assert.deepEqual(judgePlaceBrickDistance({ brickDistanceKm: BRICK_FAR_KM, brickMatched: false }), [], "exactly at the bound is inside it");
    assert.deepEqual(
      judgePlaceBrickDistance({ brickDistanceKm: BRICK_FAR_KM + 0.1, brickMatched: false }),
      ["place_brick_far"],
      "a place past the bound with no brick matched is worth a look",
    );
    assert.deepEqual(judgePlaceBrickDistance({ brickDistanceKm: Number.NaN, brickMatched: false }), [], "an unreadable distance files nothing");
  }

  {
    // Every new flag has plain English, and none of them is strong.
    for (const flag of ["visit_on_leave", "visit_on_full_day_activity", "companion_off_duty", "customer_revisited_fast", "place_brick_far"] as const) {
      const label = PHOENIX_CRM_INTEGRITY_LABELS[flag];
      assert.ok(label && label !== flag, `${flag} has no label of its own — the board would print the raw code`);
      assert.equal(
        (PHOENIX_CRM_PRECISION_INTEGRITY_FLAGS as readonly string[]).includes(flag),
        false,
        `${flag} does not rest on a precise fix — it reads no coordinate at all`,
      );
    }
  }

  {
    // ── The visit against the PHOTOGRAPH of its place (2026-10-13, the owner's own instruction) ──
    //
    // "since u have the accurate validation the photo with location then drop the suspected one and
    // compare visits vs the accurate". The photograph carries the fix its own shutter took at the
    // door; the pin can be saved from anywhere, and it is dropped from this judgement entirely.
    const atTheDoor = { lat: 30.0444, lon: 31.2357, accuracyMeters: 15 };
    // 0.00400 degrees of latitude is about 445 m — past the 300 m line and well inside a kilometre.
    const nearby = { lat: 30.0484, lon: 31.2357, accuracyMeters: 20 };
    // 0.02000 degrees is about 2,224 m.
    const faraway = { lat: 30.0644, lon: 31.2357, accuracyMeters: 20 };

    const near = judgeVisitAgainstPhotograph({ visit: nearby, photograph: atTheDoor, farMeters: 300 });
    assert.deepEqual(near.flags, ["visit_far_from_photo"], "past the far line is one flag, not two");
    assert.ok(near.metres !== null && Math.round(near.metres) > 300 && Math.round(near.metres) < 1000, `445 m expected, got ${near.metres}`);

    const far = judgeVisitAgainstPhotograph({ visit: faraway, photograph: atTheDoor, farMeters: 300 });
    assert.deepEqual(far.flags, ["visit_far_from_photo", "visit_very_far_from_photo"], "past a kilometre carries both flags, in that order");

    // 🔴 THE METRES COME BACK EVEN WHEN NOTHING IS FILED, because the panel prints the measurement
    // and not only the finding: a visit AT the door is the commonest answer and is worth saying.
    const inside = judgeVisitAgainstPhotograph({ visit: { lat: 30.0454, lon: 31.2357, accuracyMeters: 10 }, photograph: atTheDoor, farMeters: 300 });
    assert.deepEqual(inside.flags, [], "inside the far line files nothing");
    assert.ok(inside.metres !== null && inside.metres > 0, "the distance is still measured and returned");

    // 🔴 THE ACCURACY GUARD, AND IT IS NOT DECORATION. It removes exactly the two readings that
    // explain themselves: Yasmeen Samy's two 3 Oct visits reported about 2,000 m of their own
    // margin (precise location switched off), so the gap to the photograph was never measured at
    // all. 48 cases become 46 by measurement, never by judgement.
    const coarseVisit = judgeVisitAgainstPhotograph({ visit: { ...faraway, accuracyMeters: 3000 }, photograph: atTheDoor, farMeters: 300 });
    assert.deepEqual(coarseVisit.flags, [], "a fix whose own margin covers the gap has measured nothing");
    assert.ok(coarseVisit.metres !== null, "and the distance is still reported, so the panel can say why");
    const coarsePhoto = judgeVisitAgainstPhotograph({ visit: faraway, photograph: { ...atTheDoor, accuracyMeters: 3000 }, farMeters: 300 });
    assert.deepEqual(coarsePhoto.flags, [], "the photograph's own margin is read the same way");

    // A missing coordinate is UNKNOWN: no flag, and no zero pretending to be a distance.
    assert.deepEqual(judgeVisitAgainstPhotograph({ visit: { lat: Number.NaN, lon: 31.2357, accuracyMeters: null }, photograph: atTheDoor, farMeters: 300 }), { flags: [], metres: null });
    assert.deepEqual(judgeVisitAgainstPhotograph({ visit: nearby, photograph: { lat: 30.0444, lon: Number.NaN, accuracyMeters: null }, farMeters: 300 }), { flags: [], metres: null });

    // The far line is the module's own setting, so a settings change moves this detector with it —
    // and a nonsense setting falls back to 300 rather than filing on everything.
    assert.deepEqual(judgeVisitAgainstPhotograph({ visit: nearby, photograph: atTheDoor, farMeters: 5000 }).flags, [], "a wider setting files nothing here");
    // 🔴 AND THE FALLBACK IS TESTED WHERE IT CHANGES THE ANSWER. A 445 m gap is filed at
    // farMeters = 0 whether the fallback exists or not, so asserting it there pins nothing: this
    // reading is 150 m out, which the 300 m fallback calls ordinary and a bare 0 would call far —
    // and a settings row that came back empty would otherwise file on EVERY visit in the window.
    const justInside = { lat: 30.0457, lon: 31.2357, accuracyMeters: 10 };
    assert.deepEqual(judgeVisitAgainstPhotograph({ visit: justInside, photograph: atTheDoor, farMeters: 0 }).flags, [], "a zero setting falls back to 300 m, not to zero");
    assert.deepEqual(judgeVisitAgainstPhotograph({ visit: justInside, photograph: atTheDoor, farMeters: Number.NaN }).flags, [], "and so does an unreadable one");
    assert.deepEqual(judgeVisitAgainstPhotograph({ visit: justInside, photograph: atTheDoor, farMeters: 100 }).flags, ["visit_far_from_photo"], "a real setting is obeyed");

    assert.equal(VISIT_PHOTO_VERY_FAR_METERS, 1000, "the second flag is a kilometre — a different question to a reader");

    // 🔴 NEITHER FLAG IS STRONG, AND THAT IS THE RULE, NOT AN OVERSIGHT. The strong list is the one
    // gate `countedIntegrityFlags` and the nightly rep-ranks score share, so a strong flag here
    // would move a number every rep can read for 45 visits saved from the car outside.
    for (const flag of ["visit_far_from_photo", "visit_very_far_from_photo"] as const) {
      const label = PHOENIX_CRM_INTEGRITY_LABELS[flag];
      assert.ok(label && label !== flag, `${flag} has no label of its own — the board would print the raw code`);
      assert.equal(
        (PHOENIX_CRM_STRONG_INTEGRITY_FLAGS as readonly string[]).includes(flag),
        false,
        `${flag} must stay weak — a strong flag moves the rep's own Integrity score`,
      );
    }
  }

  // ── Whose visit is it? (2026-10-13) ─────────────────────────────────────────────────────────
  {
    // 🔴 A MANAGER'S OWN SINGLE VISIT HAS NO REP BY DESIGN, AND HE IS THE PERSON ON IT.
    // `resolveVisitParticipants` writes `repHrId: null, managerHrId: actor` for exactly that case,
    // and every such row on production (17 of them, two District Sales Managers) carries a real fix.
    // Before this answer existed the roster, cadence and photograph passes each skipped them, so one
    // visit 3,236 m from its place's photograph was measurable, past the line, and visible to nothing.
    assert.equal(personOnTheVisit({ repHrId: null, managerHrId: "AI-0007" }), "AI-0007", "a manager's own visit is HIS");
    assert.equal(personOnTheVisit({ repHrId: "", managerHrId: "b-120" }), "B-120", "and his id is read the way every other id here is");
    assert.equal(personOnTheVisit({ repHrId: "  b-120  ", managerHrId: null }), "B-120", "a padded rep id is still the rep");

    // 🔴 THE REP WINS WHENEVER THERE IS ONE. On a double or a chain visit the call was the rep's and
    // the manager was with him; reading the manager first would file every double visit against the
    // manager and take the rep's own call off his own board.
    assert.equal(personOnTheVisit({ repHrId: "PH-0100", managerHrId: "AI-0007" }), "PH-0100", "a double visit is the rep's, not his manager's");

    // Nobody at all is still nobody — the board prints a name beside every case.
    assert.equal(personOnTheVisit({ repHrId: null, managerHrId: null }), null);
    assert.equal(personOnTheVisit({ repHrId: "   ", managerHrId: "" }), null, "whitespace names nobody");
  }

  // ── The browser's own location reader (owner, 2026-10-16) ───────────────────────────────────
  //
  // "add a silent check for a replaced location reader in Phoenix CRM". The web cannot ask Android's
  // mock question, but it can ask whether the page's location reader is still the browser's own.
  {
    // A stand-in for the browser, built from a function that prints `[native code]` the way the
    // engine's own do — `Math.max` is a real native function in node.
    class EngineGeolocation {}
    class EnginePosition {}
    class EngineCoords {}
    for (const method of ["getCurrentPosition", "watchPosition", "clearWatch"]) {
      Object.defineProperty(EngineGeolocation.prototype, method, { value: Math.max });
    }
    const browser = (reader: unknown = new EngineGeolocation()) => {
      class EngineNavigator {}
      Object.defineProperty(EngineNavigator.prototype, "geolocation", { get: () => reader });
      return {
        navigator: new EngineNavigator() as object,
        Geolocation: EngineGeolocation as unknown,
        GeolocationPosition: EnginePosition as unknown,
        GeolocationCoordinates: EngineCoords as unknown,
      };
    };
    const enginePosition = () => {
      const position = new EnginePosition();
      Object.defineProperty(position, "coords", { value: new EngineCoords() });
      return position;
    };

    // 1 · An untouched browser is ASKED and answers "its own" — false, never null.
    assert.deepEqual(
      probeLocationReader(browser(), [enginePosition()]),
      { readerReplaced: false, readerFindings: [] },
      "an untouched browser must never be accused",
    );

    // 2 · A method written onto the reader itself — what a location-changing add-on does.
    const patched = new EngineGeolocation();
    Object.defineProperty(patched, "getCurrentPosition", {
      value: (success: (position: unknown) => void) => success({ coords: { latitude: 30, longitude: 31 } }),
    });
    const onTheReader = probeLocationReader(browser(patched));
    assert.equal(onTheReader.readerReplaced, true, "a replaced method must be caught");
    assert.deepEqual(onTheReader.readerFindings, ["method_own_property", "method_not_engine_code"]);

    // 3 · The engine's own prototype rewritten, so nothing is "own" anywhere — the source still says.
    class RewrittenGeolocation {}
    Object.defineProperty(RewrittenGeolocation.prototype, "getCurrentPosition", { value: function getCurrentPosition() {} });
    Object.defineProperty(RewrittenGeolocation.prototype, "watchPosition", { value: Math.max });
    assert.deepEqual(
      probeLocationReader({ ...browser(new RewrittenGeolocation()), Geolocation: RewrittenGeolocation }).readerFindings,
      ["method_not_engine_code"],
      "a prototype rewrite is caught by its source alone",
    );

    // 4 · The whole reader swapped on navigator for a plain object.
    const swapped = browser();
    Object.defineProperty(swapped.navigator, "geolocation", { value: { getCurrentPosition() {}, watchPosition() {} } });
    assert.deepEqual(
      probeLocationReader(swapped).readerFindings,
      ["navigator_own_property", "reader_not_engine_object", "method_own_property", "method_not_engine_code"],
      "a swapped reader answers every question it can",
    );

    // 5 · A made-up reading handed back through a reader that looks untouched.
    assert.deepEqual(
      probeLocationReader(browser(), [{ coords: { latitude: 30, longitude: 31 }, timestamp: 1 }]).readerFindings,
      ["position_not_engine_object"],
      "a plain-object reading is not the engine's",
    );

    // 6 · An engine that does not name the position types (an older Safari) is NOT asked that question.
    const older = { ...browser(), GeolocationPosition: undefined, GeolocationCoordinates: undefined };
    assert.equal(probeLocationReader(older, [{ coords: {} }]).readerReplaced, false, "an unnamed type is never read as a replaced one");

    // 7 · No reader at all is NOT ASKED — null, never "clean" and never "replaced".
    assert.deepEqual(probeLocationReader({}), { readerReplaced: null, readerFindings: [] });
    assert.deepEqual(probeLocationReader({ navigator: {} }), { readerReplaced: null, readerFindings: [] });

    // 8 · Total: a page whose objects throw on being read never throws out of the probe.
    const refuse = () => {
      throw new Error("no");
    };
    assert.doesNotThrow(() => probeLocationReader({ navigator: new Proxy({}, { get: refuse, getOwnPropertyDescriptor: refuse }) }));

    // 9 · The wire: only a boolean and only known codes survive; anything sent in their place is dropped.
    const parsed = parseCapturedFix({
      lat: CAIRO_CLINIC.lat,
      lon: CAIRO_CLINIC.lon,
      readerReplaced: true,
      readerFindings: ["method_not_engine_code", "<b>anything</b>", 7, "method_own_property"],
    });
    assert.equal(parsed.ok, true, "a replaced reader must still SAVE — the rep is never refused");
    if (parsed.ok) {
      assert.equal(parsed.value.readerReplaced, true);
      assert.deepEqual(parsed.value.readerFindings, ["method_own_property", "method_not_engine_code"]);
    }
    const olderBundle = parseCapturedFix({ lat: CAIRO_CLINIC.lat, lon: CAIRO_CLINIC.lon });
    if (olderBundle.ok) {
      assert.deepEqual([olderBundle.value.readerReplaced, olderBundle.value.readerFindings], [null, []], "an older bundle is not asked");
    }
    assert.deepEqual(readLocationReaderAnswer({ readerReplaced: "true", readerFindings: "method_own_property" }), {
      readerReplaced: null,
      readerFindings: [],
    });

    // 10 · The judgement: a positive answer files a WEAK flag; null and false file nothing.
    const base = {
      fix: { ...CAIRO_CLINIC, accuracyMeters: 18, capturedAt: at("2026-10-16T09:00:00.000Z") },
      repHrId: "R-1",
      customerId: "c-9",
      deviceMocked: null,
      history: [],
    };
    const replaced = checkLocationIntegrity({ ...base, readerReplaced: true, readerFindings: ["method_not_engine_code"] });
    assert.deepEqual(replaced.flags, ["location_reader_replaced"], "a replaced reader must be filed");
    assert.equal(replaced.strong, true, "and it is STRONG, on the owner's word — it moves the rep's own Integrity score");
    assert.deepEqual(replaced.signals.readerFindings, ["method_not_engine_code"], "the findings travel with the case");
    assert.equal(checkLocationIntegrity({ ...base, readerReplaced: false }).flags.length, 0, "an untouched reader files nothing");
    assert.equal(checkLocationIntegrity({ ...base, readerReplaced: false }).signals.readerReplaced, false, "and is recorded as asked");
    assert.equal(checkLocationIntegrity(base).signals.readerReplaced, null, "an older capture is recorded as not asked");
    assert.equal(
      (PHOENIX_CRM_STRONG_INTEGRITY_FLAGS as readonly string[]).includes("location_reader_replaced"),
      true,
      "the reader flag is strong (owner, 2026-10-16: make the location reader flag strong)",
    );
    assert.match(PHOENIX_CRM_INTEGRITY_LABELS.location_reader_replaced, /location reader/, "the board says what was found, in words");
    // Strong means it reaches the rank: the Phoenix Ranks reader counts it, and an approximate fix does
    // not excuse it, because a replaced reader is not a precision finding.
    assert.deepEqual(countedIntegrityFlags(["location_reader_replaced"], 18), ["location_reader_replaced"], "it costs the Integrity score");
    assert.deepEqual(countedIntegrityFlags(["location_reader_replaced"], 2000), ["location_reader_replaced"], "even on an approximate fix");
  }

  console.log("phoenix-crm location integrity: OK");
}
