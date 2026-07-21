import assert from "node:assert/strict";

import { isReconciled } from "../src/lib/sales/territory/reconciliation.ts";

// The internal self-reconciliation guarantee (v1 scope): every parent total the module shows
// must be provably the exact sum of its own already-fetched children. Cross-system
// reconciliation against the legacy Sales Queue pipeline is explicitly out of scope for v1
// (owner-confirmed) — this only guards the internal check.
export function runTerritoryReconciliationTests() {
  assert.equal(
    isReconciled({ units: 100, value: 5000 }, { units: 100, value: 5000 }),
    true,
    "an exact match reconciles",
  );
  assert.equal(
    isReconciled({ units: 100.000001, value: 5000.000001 }, { units: 100, value: 5000 }),
    true,
    "floating-point noise within epsilon still reconciles",
  );
  assert.equal(
    isReconciled({ units: 99, value: 5000 }, { units: 100, value: 5000 }),
    false,
    "a real units mismatch does not reconcile",
  );
  assert.equal(
    isReconciled({ units: 100, value: 4999 }, { units: 100, value: 5000 }),
    false,
    "a real value mismatch does not reconcile",
  );
  assert.equal(
    isReconciled({ units: 0, value: 0 }, { units: 0, value: 0 }),
    true,
    "an empty area (no matching pharmacies) reconciles trivially at zero",
  );
}
