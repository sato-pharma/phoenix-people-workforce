import assert from "node:assert/strict";

import { dedupeHistoricalExpensesByTrip } from "../src/lib/payroll/expenses.ts";

// Behavioral coverage for the shared trip-dedup helper (extracted in the accuracy
// cleanup PR). Live/request outstation expenses are authoritative over historical
// Excel rows for the same trip, so a single trip is never double-counted. The three
// call sites (unified payroll list, portal shell, DSM report) all rely on this exact
// behaviour; previously it was only source-locked, never exercised.
export function runExpenseTripDedupTests() {
  type Row = { tripId: string; label: string };
  const h = (tripId: string, label: string): Row => ({ tripId, label });

  // 1. A live trip shadows the historical row with the same tripId.
  {
    const historical = [h("T1", "hist-1"), h("T2", "hist-2"), h("T3", "hist-3")];
    const live = [h("T2", "live-2")];
    const kept = dedupeHistoricalExpensesByTrip(historical, live);
    assert.deepEqual(
      kept.map((r) => r.label),
      ["hist-1", "hist-3"],
      "historical row whose tripId also appears live is dropped; the rest survive",
    );
  }

  // 2. Order of the surviving historical rows is preserved (callers concatenate).
  {
    const historical = [h("A", "a"), h("B", "b"), h("C", "c"), h("D", "d")];
    const live = [h("C", "x"), h("A", "y")];
    const kept = dedupeHistoricalExpensesByTrip(historical, live);
    assert.deepEqual(kept.map((r) => r.label), ["b", "d"], "surviving rows keep their original order");
  }

  // 3. Empty live set → every historical row is kept (returns a filtered copy).
  {
    const historical = [h("T1", "one"), h("T2", "two")];
    const kept = dedupeHistoricalExpensesByTrip(historical, []);
    assert.deepEqual(kept.map((r) => r.label), ["one", "two"], "nothing live means nothing shadowed");
  }

  // 4. Empty historical → empty result regardless of live.
  {
    assert.deepEqual(dedupeHistoricalExpensesByTrip([] as Row[], [h("T1", "live")]), []);
  }

  // 5. Empty-string tripId (a row with no trip) collapses into a single "no trip"
  //    bucket — matching the prior inline behaviour at every call site exactly.
  {
    const historical = [h("", "no-trip-hist"), h("T9", "real")];
    const live = [h("", "no-trip-live")];
    const kept = dedupeHistoricalExpensesByTrip(historical, live);
    assert.deepEqual(
      kept.map((r) => r.label),
      ["real"],
      "an empty-string live tripId shadows empty-string historical rows",
    );
  }

  // 6. Duplicate live tripIds are harmless (Set dedupes them).
  {
    const historical = [h("T1", "keep"), h("T2", "drop")];
    const live = [h("T2", "l1"), h("T2", "l2"), h("T2", "l3")];
    const kept = dedupeHistoricalExpensesByTrip(historical, live);
    assert.deepEqual(kept.map((r) => r.label), ["keep"], "repeated live tripIds still drop the one historical match");
  }
}
