import assert from "node:assert/strict";

import { narrowBatchesToCycleMonths } from "../src/lib/sales/weekly/batch-scope.ts";
import { decumulateRows, type DecumulableRow } from "../src/lib/sales/weekly/decumulate.ts";

const MAY = "2026-05-01";
const JUN = "2026-06-01";
const JUL = "2026-07-01";

type Batch = { id: string; cycle_month: string | null; distributor_code: string };

const batch = (id: string, cycle_month: string | null, distributor_code = "IS-S"): Batch => ({
  id,
  cycle_month,
  distributor_code,
});

// A full month of cumulative sheets for one distributor: W1..W4, one product at one branch.
function cumulativeMonth(cycleMonth: string, distributorCode: string, weekStarts: string[], running: number[]): DecumulableRow[] {
  return weekStarts.map((weekStart, index) => ({
    weekStart,
    cycleMonth,
    weekNumber: index + 1,
    distributorCode,
    productCode: "LA001",
    branchCode: "CAIRO",
    branchName: "Cairo",
    salesValue: running[index],
    salesQty: running[index] / 10,
    netQty: running[index] / 10,
    stockQty: 40,
  }));
}

const cellKey = (row: DecumulableRow) =>
  `${row.distributorCode}||${row.cycleMonth}||${row.weekStart}||${row.productCode}||${row.branchCode}`;

export function runWeeklyBatchScopeTests() {
  // 1) No narrowing requested → the batch set is returned untouched. This is the path every existing
  //    caller takes, so it must stay byte-identical to the previous behaviour.
  {
    const batches = [batch("a", MAY), batch("b", JUN), batch("c", null)];
    for (const empty of [undefined, null, [], [""], ["   "]]) {
      assert.deepEqual(
        narrowBatchesToCycleMonths(batches, empty).map((b) => b.id),
        ["a", "b", "c"],
        `empty narrowing (${JSON.stringify(empty)}) must not drop any batch`,
      );
    }
  }

  // 2) HEADLINE: narrowing to one month fetches only that month's batches. This is the whole point —
  //    the comparison call used to pull every validated row of every month.
  {
    const batches = [
      batch("may-1", MAY),
      batch("may-2", MAY, "MULTI"),
      batch("jun-1", JUN),
      batch("jul-1", JUL),
      batch("untagged", null),
    ];
    const kept = narrowBatchesToCycleMonths(batches, [MAY]).map((b) => b.id);
    assert.deepEqual(kept, ["may-1", "may-2"], "only the requested month's batches survive narrowing");
    assert.equal(kept.length < batches.length, true, "narrowing must actually reduce the fetch");
  }

  // 3) Multiple months, whitespace tolerance, and unknown months.
  {
    const batches = [batch("may", MAY), batch("jun", JUN), batch("jul", JUL)];
    assert.deepEqual(
      narrowBatchesToCycleMonths(batches, [` ${MAY} `, JUL]).map((b) => b.id),
      ["may", "jul"],
      "months are matched after trimming",
    );
    assert.deepEqual(
      narrowBatchesToCycleMonths(batches, ["2020-01-01"]).map((b) => b.id),
      [],
      "a month with no batches yields no fetch at all",
    );
    assert.deepEqual(
      narrowBatchesToCycleMonths([batch("untagged", null)], [MAY]).map((b) => b.id),
      [],
      "an untagged batch never satisfies a month request",
    );
  }

  // 4) Narrowing keeps WHOLE months, never part of one. A partial month would strip the earlier
  //    cumulative sheet that later weeks are subtracted against.
  {
    const weeks = ["2026-05-02", "2026-05-09", "2026-05-16", "2026-05-23"];
    const batches = weeks.map((week, index) => batch(`may-w${index + 1}`, MAY) as Batch & { week: string });
    assert.equal(
      narrowBatchesToCycleMonths(batches, [MAY]).length,
      weeks.length,
      "every week-batch of a requested month is kept",
    );
  }

  // 5) THE SAFETY PROOF: de-cumulated numbers for a month are identical whether that month was
  //    computed alongside every other month or fetched on its own. decumulateRows() buckets by
  //    (distributorCode, cycleMonth), so dropping other months cannot perturb the survivors.
  {
    const mayWeeks = ["2026-05-02", "2026-05-09", "2026-05-16", "2026-05-23"];
    const junWeeks = ["2026-06-06", "2026-06-13", "2026-06-20", "2026-06-27"];
    const everyMonth = [
      ...cumulativeMonth(MAY, "IS-S", mayWeeks, [100, 250, 400, 450]),
      ...cumulativeMonth(MAY, "MULTI", mayWeeks, [80, 160, 240, 300]),
      ...cumulativeMonth(JUN, "IS-S", junWeeks, [500, 900, 1500, 1900]),
    ];
    const juneOnly = everyMonth.filter((row) => row.cycleMonth === JUN);

    const fromEverything = new Map(
      decumulateRows(everyMonth)
        .filter((row) => row.cycleMonth === JUN)
        .map((row) => [cellKey(row), row]),
    );
    const fromJuneAlone = new Map(decumulateRows(juneOnly).map((row) => [cellKey(row), row]));

    assert.equal(fromJuneAlone.size, fromEverything.size, "narrowing must not change the row count");
    assert.equal(fromJuneAlone.size > 0, true, "guard: the fixture must actually produce June rows");
    for (const [key, narrowed] of fromJuneAlone) {
      const full = fromEverything.get(key);
      assert.ok(full, `cell ${key} must exist in both`);
      assert.equal(narrowed.salesValue, full.salesValue, `salesValue identical for ${key}`);
      assert.equal(narrowed.netQty, full.netQty, `netQty identical for ${key}`);
      assert.equal(narrowed.stockQty, full.stockQty, `stockQty identical for ${key}`);
    }
    // Sanity-check the fixture really is cumulative, so the equality above is meaningful rather than
    // both sides being trivially zero.
    const june = [...fromJuneAlone.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
    assert.deepEqual(
      june.map((row) => row.salesValue),
      [500, 400, 600, 400],
      "June de-cumulates to real per-week values (500, 900-500, 1500-900, 1900-1500)",
    );
  }
}
