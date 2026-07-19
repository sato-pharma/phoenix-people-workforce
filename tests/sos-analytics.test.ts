import assert from "node:assert/strict";

import {
  computeContribution,
  computeDelta,
  computeDeltaPctByCode,
  computeMovers,
  computeNewAndLost,
  computeOutliers,
  computePareto,
  resolvePriorPeriod,
} from "../src/lib/sales/sos-analytics.ts";

export function runSosAnalyticsTests() {
  // ── resolvePriorPeriod ─────────────────────────────────────────────────────
  // Newest period → second-newest, regardless of input ordering.
  assert.equal(resolvePriorPeriod(["2026-06", "2026-05", "2026-04"], "2026-06"), "2026-05");
  assert.equal(resolvePriorPeriod(["2026-04", "2026-06", "2026-05"], "2026-06"), "2026-05", "must not trust input order");
  // A gap month compares against the newest OLDER validated period.
  assert.equal(resolvePriorPeriod(["2026-06", "2026-03"], "2026-06"), "2026-03");
  // Oldest period has no prior; unknown/absent selections resolve to null.
  assert.equal(resolvePriorPeriod(["2026-06", "2026-05"], "2026-05"), null);
  assert.equal(resolvePriorPeriod(["2026-06"], "2026-01"), null);
  assert.equal(resolvePriorPeriod(["2026-06"], null), null);
  assert.equal(resolvePriorPeriod([], "2026-06"), null);
  // Duplicates collapse.
  assert.equal(resolvePriorPeriod(["2026-06", "2026-06", "2026-05"], "2026-06"), "2026-05");

  // ── computeDelta ───────────────────────────────────────────────────────────
  const up = computeDelta(150, 100);
  assert.equal(up.delta, 50);
  assert.equal(up.deltaPct, 0.5);
  const down = computeDelta(80, 100);
  assert.equal(down.delta, -20);
  assert.equal(down.deltaPct, -0.2);
  // Zero / negative base → deltaPct null (no meaningful percentage).
  assert.equal(computeDelta(50, 0).deltaPct, null);
  assert.equal(computeDelta(50, -10).deltaPct, null);
  assert.equal(computeDelta(0, 0).delta, 0);

  // ── computeMovers ──────────────────────────────────────────────────────────
  const current = [
    { code: "A", label: "Alpha", value: 200 }, // +100%
    { code: "B", label: "Beta", value: 90 },   // -10%
    { code: "C", label: "Gamma", value: 100 }, // unchanged → excluded
    { code: "D", label: "Delta", value: 50 },  // new (no prior) → excluded from movers
  ];
  const prior = [
    { code: "A", label: "Alpha", value: 100 },
    { code: "B", label: "Beta", value: 100 },
    { code: "C", label: "Gamma", value: 100 },
    { code: "E", label: "Echo", value: 40 },   // lost → excluded from movers
    { code: "F", label: "Foxtrot", value: 0 }, // zero base → excluded even if present now
  ];
  const movers = computeMovers(current, prior);
  assert.deepEqual(movers.gainers.map((row) => row.code), ["A"]);
  assert.equal(movers.gainers[0].deltaPct, 1);
  assert.equal(movers.gainers[0].prevValue, 100);
  assert.deepEqual(movers.decliners.map((row) => row.code), ["B"]);
  assert.ok(movers.decliners[0].deltaPct < 0);
  // Limit caps each side independently.
  const many = Array.from({ length: 10 }, (_, index) => ({ code: `G${index}`, label: `G${index}`, value: 200 + index }));
  const manyPrior = many.map((row) => ({ ...row, value: 100 }));
  assert.equal(computeMovers(many, manyPrior, 3).gainers.length, 3);
  // Limit caps each side independently.
  // Case-insensitive code matching.
  const ci = computeMovers([{ code: "x1", label: "X", value: 150 }], [{ code: "X1", label: "X", value: 100 }]);
  assert.equal(ci.gainers.length, 1);

  // ── computeDeltaPctByCode (ALL rows, not just the top-5 movers) ─────────────
  // Every member present in both periods with a positive prior base gets a delta — including an
  // UNCHANGED member (C: 100→100), which computeMovers excludes but the full table must show as
  // 0.0% (not "—"). New (D)/lost (E)/zero-base (F) members have no comparable base and are absent
  // (the table renders "—" for those). This is the fix for MoM/YoY Δ columns showing "—" on every
  // row outside the capped movers list.
  const allDeltas = computeDeltaPctByCode(current, prior);
  assert.equal(allDeltas["A"], 1, "A present in both → +100%");
  assert.ok(Math.abs(allDeltas["B"] - -0.1) < 1e-9, "B present in both → -10%");
  assert.equal(allDeltas["C"], 0, "unchanged member is 0.0%, NOT excluded/'—'");
  assert.equal("D" in allDeltas, false, "new member (no prior) has no comparable base → absent");
  assert.equal("E" in allDeltas, false, "lost member (not in current) → absent");
  assert.equal("F" in allDeltas, false, "zero prior base → absent (no meaningful %)");
  // Keys are normalized (upper/trim) so the client's row.code.toUpperCase() lookup always hits.
  const ciAll = computeDeltaPctByCode([{ code: " x1 ", label: "X", value: 150 }], [{ code: "X1", label: "X", value: 100 }]);
  assert.equal(ciAll["X1"], 0.5, "normalized key matches regardless of case/whitespace");

  // ── computeNewAndLost ──────────────────────────────────────────────────────
  const newLost = computeNewAndLost(current, prior);
  assert.deepEqual(newLost.added.map((row) => row.code), ["D"]);
  assert.deepEqual(newLost.removed.map((row) => row.code), ["E", "F"]);
  // Sorted by value desc + capped.
  const addedMany = computeNewAndLost(
    Array.from({ length: 20 }, (_, index) => ({ code: `N${index}`, label: `N${index}`, value: index })),
    [],
    5,
  );
  assert.equal(addedMany.added.length, 5);
  assert.equal(addedMany.added[0].value, 19);

  // ── computePareto ──────────────────────────────────────────────────────────
  const pareto = computePareto([
    { code: "P1", label: "P1", line: "L1", value: 700, units: 70 },
    { code: "P2", label: "P2", line: "L1", value: 200, units: 20 },
    { code: "P3", label: "P3", line: "L2", value: 60, units: 6 },
    { code: "P4", label: "P4", line: null, value: 40, units: 4 },
  ]);
  assert.deepEqual(pareto.map((row) => row.code), ["P1", "P2", "P3", "P4"], "value-descending");
  assert.equal(pareto[0].abcClass, "A"); // 70% cumulative
  assert.equal(pareto[1].abcClass, "B"); // 90% cumulative
  assert.equal(pareto[2].abcClass, "C"); // 96% cumulative
  assert.equal(pareto[3].abcClass, "C");
  // Cumulative share is monotonic and ends at exactly 1.
  for (let index = 1; index < pareto.length; index += 1) {
    assert.ok(pareto[index].cumulativeShare >= pareto[index - 1].cumulativeShare);
  }
  assert.ok(Math.abs(pareto[pareto.length - 1].cumulativeShare - 1) < 1e-9);
  // Boundary: exactly 80% cumulative is still class A; exactly 95% is still B.
  const boundary = computePareto([
    { code: "B1", label: "B1", value: 80, units: 0 },
    { code: "B2", label: "B2", value: 15, units: 0 },
    { code: "B3", label: "B3", value: 5, units: 0 },
  ]);
  assert.equal(boundary[0].abcClass, "A");
  assert.equal(boundary[1].abcClass, "B");
  assert.equal(boundary[2].abcClass, "C");
  // Single row = 100% cumulative → C by threshold? No: a lone product IS the whole value.
  // The classification is cumulative-based, so a single row lands past 95% → class C would be
  // misleading; assert the actual contract (cumulative 1.0) and that it does not throw.
  const single = computePareto([{ code: "S", label: "S", value: 10, units: 1 }]);
  assert.equal(single.length, 1);
  assert.equal(single[0].cumulativeShare, 1);
  // Zero / negative totals → empty.
  assert.deepEqual(computePareto([]), []);
  assert.deepEqual(computePareto([{ code: "Z", label: "Z", value: 0, units: 0 }]), []);
  assert.deepEqual(computePareto([{ code: "N", label: "N", value: -5, units: 0 }]), []);
  // Zero-value rows are dropped from a non-zero distribution.
  const mixed = computePareto([
    { code: "M1", label: "M1", value: 100, units: 0 },
    { code: "M2", label: "M2", value: 0, units: 0 },
  ]);
  assert.equal(mixed.length, 1);

  // ── computeContribution ────────────────────────────────────────────────────
  // Deltas: A +100, B -10, D +50 (new), E -40 (lost); C unchanged, F stays 0. Total abs = 200.
  const contrib = computeContribution(current, prior);
  const contribByCode = new Map(contrib.map((row) => [row.code, row]));
  assert.ok(Math.abs((contribByCode.get("A")?.contribution ?? 0) - 100 / 200) < 1e-9);
  assert.ok(Math.abs((contribByCode.get("D")?.contribution ?? 0) - 50 / 200) < 1e-9);
  assert.equal(contribByCode.get("D")?.prevValue, 0, "new member's prior value is 0");
  assert.equal(contribByCode.get("E")?.value, 0, "lost member's current value is 0");
  // Unchanged member (C) has zero delta → excluded.
  assert.ok(!contribByCode.has("C"));
  // Contributions of all movers sum to 1.
  const contribSum = contrib.reduce((sum, row) => sum + row.contribution, 0);
  assert.ok(Math.abs(contribSum - 1) < 1e-9);
  // Ranked by absolute delta (A=100 first).
  assert.equal(contrib[0].code, "A");

  // ── computeOutliers ────────────────────────────────────────────────────────
  // One value far above a tight cluster → flagged high; the cluster is not flagged. The population
  // must be large enough that a single point CAN exceed z=2 (max |z| = (n-1)/sqrt(n), so n≥6).
  const cluster = Array.from({ length: 12 }, (_, index) => ({ code: `N${index}`, label: `N${index}`, value: 100 }));
  const outliers = computeOutliers([...cluster, { code: "BIG", label: "Big", value: 500 }]);
  assert.ok(outliers.length >= 1, "a value far above a 12-point cluster must flag");
  assert.equal(outliers[0].code, "BIG");
  assert.equal(outliers[0].direction, "high");
  assert.ok(outliers[0].z > 0);
  // The tight cluster members are not flagged.
  assert.ok(!outliers.some((row) => row.code.startsWith("N")));
  // Degenerate populations → no outliers.
  assert.deepEqual(computeOutliers([{ code: "X", label: "X", value: 5 }]), []);
  assert.deepEqual(
    computeOutliers([
      { code: "A", label: "A", value: 10 },
      { code: "B", label: "B", value: 10 },
      { code: "C", label: "C", value: 10 },
    ]),
    [],
    "zero variance yields no outliers",
  );
}
