import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mapSnapshot, SNAPSHOT_WINDOW } from "../src/lib/sales/import-coverage.ts";

/**
 * `sos_import_coverage_snapshots` has two writers and they used to fill the same columns with
 * different meanings:
 *
 *   - `importable_value` is EGP for the preview writer, but the brick-coverage writer stored
 *     `unitsWithBrick` — a unit COUNT in a money column, for 100 of the 134 live snapshots.
 *   - `new_customers` is new customers for the preview writer, but the brick writer stored
 *     `customersNeedingBrick - customersWithBrick`, the BRICK-LESS count: a different question,
 *     already recoverable from the distinct/mapped columns beside it.
 *
 * The brick writer now writes NULL for both, which is the truthful answer, so the mapper must keep
 * that null rather than collapse it to a plausible zero.
 */

const SRC = readFileSync(new URL("../src/lib/sales/import-coverage.ts", import.meta.url), "utf8");

export function runImportCoverageColumnMeaningTests() {
  // 1. A null money column stays null — it must never read as "0 EGP importable".
  const unmeasured = mapSnapshot({ batch_id: "b1", importable_value: null, new_customers: null });
  assert.equal(unmeasured.importableValue, null, "a writer that never measured money must not report 0 EGP");
  assert.equal(unmeasured.newCustomers, null, "a writer that never measured new customers must not report 0");

  // 2. A real zero is still a zero — "measured, and it was none" must stay distinguishable.
  const measuredZero = mapSnapshot({ batch_id: "b2", importable_value: 0, new_customers: 0 });
  assert.equal(measuredZero.importableValue, 0, "a measured 0 is a real value, not a missing one");
  assert.equal(measuredZero.newCustomers, 0, "a measured 0 new customers is a real answer");

  // 3. Real values survive unchanged.
  const measured = mapSnapshot({ batch_id: "b3", importable_value: 1234.5, new_customers: 7 });
  assert.equal(measured.importableValue, 1234.5, "a real EGP value must pass through untouched");
  assert.equal(measured.newCustomers, 7, "a real new-customer count must pass through untouched");

  // 4. The brick writer must not put units in the money column, nor brick-less counts in
  //    new_customers. Those two literals ARE the defect.
  assert.ok(
    !SRC.includes("importable_value: coverage.unitsWithBrick"),
    "the brick writer must not store a unit count in importable_value — that column is EGP",
  );
  assert.ok(
    !SRC.includes("new_customers: coverage.customersNeedingBrick - coverage.customersWithBrick"),
    "the brick writer must not store the brick-less count in new_customers — that is a different question",
  );

  // 5. Orphaned snapshots (batch deleted) must be excluded. batch_id is TEXT and batches.id is
  //    UUID, so no FK can cascade — 42 of 134 live snapshots pointed at a batch that is gone.
  //    NB: asserting that `liveBatchIds(` merely APPEARS is vacuous — the function DEFINITION
  //    satisfies it even when nobody calls it. Pin the filter and the call separately.
  assert.ok(
    SRC.includes("rows.filter((r) => live.has(r.batchId))"),
    "listCoverageSnapshots must actually FILTER by live batch ids, not merely define the helper",
  );
  assert.ok(
    SRC.includes("await liveBatchIds("),
    "listCoverageSnapshots must CALL liveBatchIds, not just declare it",
  );
  assert.ok(
    SRC.includes("BATCH_ID_CHUNK"),
    "the batch-existence lookup must be chunked — a PostgREST .in() of several hundred ids returns ZERO rows and no error",
  );

  // 6. The window is disclosed rather than presented as a total.
  assert.equal(typeof SNAPSHOT_WINDOW, "number", "the read cap must be a named, exported constant");
  assert.ok(SNAPSHOT_WINDOW > 0, "the read cap must be positive");
  assert.ok(SRC.includes("snapshotWindow"), "the summary must expose its window so a capped view cannot read as a total");
}
