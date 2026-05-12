import assert from "node:assert/strict";

import {
  OFFICIAL_OUTSTATION_MINIMUM_DISTANCE_KM,
  classifyOutstationExpenseEligibility,
  TOLERANCE_OUTSTATION_MINIMUM_DISTANCE_KM,
} from "../src/lib/outstation/classification.ts";

const basePolicy = {
  officialMinimumDistanceKm: OFFICIAL_OUTSTATION_MINIMUM_DISTANCE_KM,
  toleranceMinimumDistanceKm: TOLERANCE_OUTSTATION_MINIMUM_DISTANCE_KM,
};

export function runOutstationPolicyClassificationTests() {
  const eligible = classifyOutstationExpenseEligibility({
    actualDistanceKm: 60,
    policy: basePolicy,
  });
  assert.equal(eligible.classification, "eligible");
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.requires_warning, false);
  assert.equal(eligible.requires_manual_exception, false);

  const above = classifyOutstationExpenseEligibility({
    actualDistanceKm: 120.5,
    policy: basePolicy,
  });
  assert.equal(above.classification, "eligible");
  assert.equal(above.eligible, true);
  assert.equal(above.requires_warning, false);

  const exactTolerance = classifyOutstationExpenseEligibility({
    actualDistanceKm: 58,
    policy: basePolicy,
  });
  assert.equal(exactTolerance.classification, "tolerance_eligible");
  assert.equal(exactTolerance.eligible, false);
  assert.equal(exactTolerance.requires_warning, true);

  const inToleranceBand = classifyOutstationExpenseEligibility({
    actualDistanceKm: 59.5,
    policy: basePolicy,
  });
  assert.equal(inToleranceBand.classification, "tolerance_eligible");
  assert.equal(inToleranceBand.requires_warning, true);

  const justBelowTolerance = classifyOutstationExpenseEligibility({
    actualDistanceKm: 57.99,
    policy: basePolicy,
  });
  assert.equal(justBelowTolerance.classification, "not_eligible");
  assert.equal(justBelowTolerance.eligible, false);
  assert.equal(justBelowTolerance.requires_warning, false);

  const missing = classifyOutstationExpenseEligibility({
    actualDistanceKm: null,
    policy: basePolicy,
  });
  assert.equal(missing.classification, "missing_distance");
  assert.equal(missing.requires_manual_exception, false);

  const invalidNegative = classifyOutstationExpenseEligibility({
    actualDistanceKm: -1,
    policy: basePolicy,
  });
  assert.equal(invalidNegative.classification, "manual_exception");
  assert.equal(invalidNegative.eligible, false);
  assert.equal(invalidNegative.requires_manual_exception, true);

  const invalidDistance = classifyOutstationExpenseEligibility({
    actualDistanceKm: Number.NaN,
    policy: basePolicy,
  });
  assert.equal(invalidDistance.classification, "invalid_distance");
  assert.equal(invalidDistance.requires_warning, false);

  const defaultTolerance = classifyOutstationExpenseEligibility({
    actualDistanceKm: 58.9,
    policy: { officialMinimumDistanceKm: 60 },
  });
  assert.equal(defaultTolerance.classification, "tolerance_eligible");
}
