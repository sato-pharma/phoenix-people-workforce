import assert from "node:assert/strict";

import { autoAcceptMin, autoAcceptTextMin, partitionAutoApply, shouldAutoAccept } from "../src/lib/sales/normalizer/auto-apply.ts";
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

  // ---------------------------------------------------------------------------------------
  // The TEXTUAL path (2026-08-27). Geography is unavailable for ~97% of customers, so a
  // deterministic twin corroborated by address text auto-applies without a geocode.
  // ---------------------------------------------------------------------------------------
  const TEXT_MIN = 93;
  const corroborated = { addressCorroborated: true };
  const uncorroborated = { addressCorroborated: false };

  // Env clamp for the textual floor: default 93, floor 90, ceiling 100, garbage → default.
  assert.equal(autoAcceptTextMin(undefined), 93);
  assert.equal(autoAcceptTextMin("95"), 95);
  assert.equal(autoAcceptTextMin("80"), 90);
  assert.equal(autoAcceptTextMin("150"), 100);
  assert.equal(autoAcceptTextMin("abc"), 93);

  // THE HEADLINE: propagated + address-corroborated + NO geocode → accepted at the textual floor.
  // Before this path existed every one of these was parked, which is how 14,345 codes piled up.
  assert.equal(shouldAutoAccept({ confidence: 93, propagation: corroborated, signals: signals({ geocoded: false }), source: "propagated" }, MIN, TEXT_MIN), true);
  // Same, with no signals object at all (the no-Google-key branch of customer-suggest.ts).
  assert.equal(shouldAutoAccept({ confidence: 93, propagation: corroborated, signals: undefined, source: "propagated" }, MIN, TEXT_MIN), true);

  // ...and it is still TWO signals, not one. Name match alone (no address overlap) stays parked.
  assert.equal(shouldAutoAccept({ confidence: 90, propagation: uncorroborated, signals: signals({ geocoded: false }), source: "propagated" }, MIN, TEXT_MIN), false);
  assert.equal(shouldAutoAccept({ confidence: 93, propagation: uncorroborated, signals: signals({ geocoded: false }), source: "propagated" }, MIN, TEXT_MIN), false);
  // Below the textual floor → parked even when corroborated.
  assert.equal(shouldAutoAccept({ confidence: 92, propagation: corroborated, signals: signals({ geocoded: false }), source: "propagated" }, MIN, TEXT_MIN), false);
  // The AI never gets the textual path — it has no deterministic twin behind it.
  assert.equal(shouldAutoAccept({ confidence: 99, propagation: corroborated, signals: signals({ geocoded: false }), source: "ai" }, MIN, TEXT_MIN), false);
  // Unknown source likewise.
  assert.equal(shouldAutoAccept({ confidence: 99, propagation: corroborated, signals: signals({ geocoded: false }), source: undefined }, MIN, TEXT_MIN), false);

  // CRITICAL: the textual path must never RESCUE a suggestion that geography contradicts.
  // When a geocode exists, the geographic gate governs and the textual evidence is ignored.
  assert.equal(shouldAutoAccept({ confidence: 96, propagation: corroborated, signals: signals({ distanceKm: 40 }), source: "propagated" }, MIN, TEXT_MIN), false);
  // And a contradicting geocode is demoted to 45 upstream, which fails both floors.
  assert.equal(shouldAutoAccept({ confidence: 45, propagation: corroborated, signals: signals({ distanceKm: 80 }), source: "propagated" }, MIN, TEXT_MIN), false);
  // A corroborated twin that IS geocoded and near still passes the geographic path unchanged.
  assert.equal(shouldAutoAccept({ confidence: 95, propagation: corroborated, signals: signals({ distanceKm: 2 }), source: "propagated" }, MIN, TEXT_MIN), true);

  // The new evidence flows through the partition helper too.
  const textCandidates = [
    { confidence: 93, id: "t1", propagation: corroborated, signals: signals({ geocoded: false }), source: "propagated" as const },
    { confidence: 93, id: "t2", propagation: uncorroborated, signals: signals({ geocoded: false }), source: "propagated" as const },
  ];
  const textPartition = partitionAutoApply(textCandidates, MIN);
  assert.deepEqual(textPartition.accepted.map((c) => c.id), ["t1"]);
  assert.deepEqual(textPartition.parked.map((c) => c.id), ["t2"]);
}
