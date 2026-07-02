import assert from "node:assert/strict";

import { autoAcceptMin, partitionAutoApply, shouldAutoAccept } from "../src/lib/sales/normalizer/auto-apply.ts";
import type { GeoSignals } from "../src/lib/sales/normalizer/geo-validate.ts";

function signals(overrides: Partial<GeoSignals>): GeoSignals {
  return { distanceKm: null, geocoded: true, governorateMatch: false, markazMatch: false, ...overrides };
}

export function runSosAutoApplyTests() {
  // Env clamp: default 95, floor 90, ceiling 100, garbage → default.
  assert.equal(autoAcceptMin(undefined), 95);
  assert.equal(autoAcceptMin("97"), 97);
  assert.equal(autoAcceptMin("80"), 90);
  assert.equal(autoAcceptMin("150"), 100);
  assert.equal(autoAcceptMin("abc"), 95);
  assert.equal(autoAcceptMin("-5"), 95);

  const MIN = 95;

  // Propagated + close distance → accepted.
  assert.equal(shouldAutoAccept({ confidence: 97, signals: signals({ distanceKm: 3 }), source: "propagated" }, MIN), true);
  // Propagated + markaz match (no distance) → accepted.
  assert.equal(shouldAutoAccept({ confidence: 95, signals: signals({ markazMatch: true }), source: "propagated" }, MIN), true);
  // Propagated + far distance + no markaz → rejected even at 96.
  assert.equal(shouldAutoAccept({ confidence: 96, signals: signals({ distanceKm: 40 }), source: "propagated" }, MIN), false);
  // Propagated + high confidence but NOT geocoded → rejected (single signal never auto-applies).
  assert.equal(shouldAutoAccept({ confidence: 96, signals: signals({ geocoded: false }), source: "propagated" }, MIN), false);
  assert.equal(shouldAutoAccept({ confidence: 96, signals: undefined, source: "propagated" }, MIN), false);

  // AI needs the strongest proof: distance < 5 km.
  assert.equal(shouldAutoAccept({ confidence: 95, signals: signals({ distanceKm: 4.9 }), source: "ai" }, MIN), true);
  assert.equal(shouldAutoAccept({ confidence: 95, signals: signals({ distanceKm: 5.1 }), source: "ai" }, MIN), false);
  // AI + markaz match alone is NOT enough.
  assert.equal(shouldAutoAccept({ confidence: 95, signals: signals({ markazMatch: true }), source: "ai" }, MIN), false);
  // AI + no distance → rejected.
  assert.equal(shouldAutoAccept({ confidence: 99, signals: signals({ governorateMatch: true }), source: "ai" }, MIN), false);

  // Below threshold → rejected regardless of signals.
  assert.equal(shouldAutoAccept({ confidence: 94, signals: signals({ distanceKm: 1 }), source: "ai" }, MIN), false);
  assert.equal(shouldAutoAccept({ confidence: 94, signals: signals({ distanceKm: 1, markazMatch: true }), source: "propagated" }, MIN), false);
  // At threshold exactly → eligible.
  assert.equal(shouldAutoAccept({ confidence: 95, signals: signals({ distanceKm: 1 }), source: "ai" }, MIN), true);

  // Missing confidence / unknown source → rejected.
  assert.equal(shouldAutoAccept({ confidence: undefined, signals: signals({ distanceKm: 1 }), source: "ai" }, MIN), false);
  assert.equal(shouldAutoAccept({ confidence: 99, signals: signals({ distanceKm: 1 }), source: undefined }, MIN), false);

  // Partition keeps order and never drops entries.
  const candidates = [
    { confidence: 97, id: "a", signals: signals({ distanceKm: 2 }), source: "propagated" as const },
    { confidence: 60, id: "b", signals: signals({ distanceKm: 2 }), source: "ai" as const },
    { confidence: 96, id: "c", signals: signals({ distanceKm: 3 }), source: "ai" as const },
    { confidence: 96, id: "d", signals: signals({ geocoded: false }), source: "propagated" as const },
  ];
  const { accepted, parked } = partitionAutoApply(candidates, MIN);
  assert.deepEqual(accepted.map((c) => c.id), ["a", "c"]);
  assert.deepEqual(parked.map((c) => c.id), ["b", "d"]);
  assert.equal(accepted.length + parked.length, candidates.length);
}
