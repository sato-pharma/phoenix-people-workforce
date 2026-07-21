import assert from "node:assert/strict";

import {
  addDistinctTargetValue,
  sumDistinctTargetValues,
} from "../src/lib/employee-portal/service.ts";

// Regression coverage for the med-rep achievement inflation bug (fixed PR #1083,
// "sum distinct targets in performance views, not max"): a rep's target for a
// (territory, period, product) cell can appear on several sales rows — the SAME figure
// repeated (Retail/Stores/Discount echo rows), OR genuinely different additive figures.
// The fix sums the DISTINCT values per key (dedup via cent-rounded Set), never a naive
// SUM-with-duplicates (which double/triple-counts an echoed target) and never a MAX
// (which would collapse genuinely-different-but-legitimate targets down to one).
export function runPortalTargetDedupTests() {
  // Two identical echo rows for the same key collapse to ONE contribution, not two.
  {
    const map = new Map<string, Set<number>>();
    addDistinctTargetValue(map, "rep::territory::2026-06::Product A", 1000);
    addDistinctTargetValue(map, "rep::territory::2026-06::Product A", 1000);
    assert.equal(sumDistinctTargetValues(map.get("rep::territory::2026-06::Product A")), 1000);
  }

  // Genuinely different target values for the same key are additive (summed), not maxed.
  {
    const map = new Map<string, Set<number>>();
    addDistinctTargetValue(map, "rep::territory::2026-06::Product A", 1000);
    addDistinctTargetValue(map, "rep::territory::2026-06::Product A", 500);
    assert.equal(sumDistinctTargetValues(map.get("rep::territory::2026-06::Product A")), 1500);
  }

  // Different keys (e.g. different territories for the same rep/period/product) never
  // interfere with each other — each key's Set is independent.
  {
    const map = new Map<string, Set<number>>();
    addDistinctTargetValue(map, "rep::territory-A::2026-06::Product A", 1000);
    addDistinctTargetValue(map, "rep::territory-B::2026-06::Product A", 800);
    assert.equal(sumDistinctTargetValues(map.get("rep::territory-A::2026-06::Product A")), 1000);
    assert.equal(sumDistinctTargetValues(map.get("rep::territory-B::2026-06::Product A")), 800);
  }

  // Floating-point noise (e.g. 1000.0000000001 vs 1000 from spreadsheet import round-trip)
  // must still collapse to one distinct value — comparison is per integer cent.
  {
    const map = new Map<string, Set<number>>();
    addDistinctTargetValue(map, "k", 1000);
    addDistinctTargetValue(map, "k", 1000.0000000001);
    assert.equal(sumDistinctTargetValues(map.get("k")), 1000);
  }

  // Zero, negative, and non-finite targets are ignored (never inflate or corrupt the set) —
  // a missing/invalid target row must not contribute a phantom target.
  {
    const map = new Map<string, Set<number>>();
    addDistinctTargetValue(map, "k", 0);
    addDistinctTargetValue(map, "k", -100);
    addDistinctTargetValue(map, "k", NaN);
    assert.equal(sumDistinctTargetValues(map.get("k")), 0);
    assert.equal(map.has("k"), false, "a key with only invalid targets never gets a Set entry");
  }

  // A key that was never touched sums to 0, not an error.
  assert.equal(sumDistinctTargetValues(undefined), 0);

  // End-to-end regression check matching the original bug report shape: a rep with 3 rows
  // for the same (territory, period, product) — 2 identical echoes + the real value — must
  // sum to the real value once, not 2x or 3x it (the confirmed inflation: 68.3% correct vs
  // ~133% shown).
  {
    const map = new Map<string, Set<number>>();
    const key = "PD-0005::CairoTerritory::2026-06::ProductX";
    addDistinctTargetValue(map, key, 50000);
    addDistinctTargetValue(map, key, 50000);
    addDistinctTargetValue(map, key, 50000);
    const target = sumDistinctTargetValues(map.get(key));
    assert.equal(target, 50000, "3 identical echo rows must sum to the target once, not 2x/3x");
    const sales = 34150; // matches the memory's confirmed 68.3% correct achievement
    const achievementPercent = (sales / target) * 100;
    assert.ok(
      Math.abs(achievementPercent - 68.3) < 0.1,
      `achievement must be ~68.3%, not ~133% (sum(sales)/max(target) inflation) or ~34% (sum(sales)/sum(3x target) deflation) — got ${achievementPercent}`,
    );
  }
}
