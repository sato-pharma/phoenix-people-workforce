import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { BRICK_COVERAGE_WARN_PCT, computeBrickCoverage } from "../src/lib/sales/import-coverage.ts";

// The June 2026 import committed with 3,184 rows carrying no brick — 15,443 units of real sales
// with nowhere to sit — and every alarm stayed quiet. Two independent reasons, both fixed here:
//
//   1. The metric could not fail. `resolvedRowsPct = importableRows / totalRows`, and
//      persistNormalizedBatch sets BOTH to `rows.length`. It is 100% by construction on the path
//      every distributor upload actually takes. Every snapshot in production reads 100.0 —
//      including ones recording mapped_customers: 0.
//   2. That path never wrote a snapshot at all. The newest row in the table on 2026-07-29
//      predated the June import entirely.
//
// computeBrickCoverage measures the thing that actually matters: of the rows that NEEDED a brick,
// how many got one.
export function runSosBrickCoverageTests() {
  const row = (over: Partial<Parameters<typeof computeBrickCoverage>[0][number]> = {}) => ({
    bonusQty: 0,
    brickId: "B1-1",
    clientCode: "C1",
    isDirect: false,
    qty: 10,
    ...over,
  });

  // ── 1. The failure that started all this must now be visible ──────────────
  const june = computeBrickCoverage([
    ...Array.from({ length: 97 }, (_, i) => row({ clientCode: `OK${i}` })),
    ...Array.from({ length: 3 }, (_, i) => row({ brickId: "", clientCode: `BAD${i}` })),
  ]);
  assert.equal(june.coveragePct, 97, "3 brick-less rows in 100 must read as 97%, never 100%");
  assert.ok(june.coveragePct < BRICK_COVERAGE_WARN_PCT, "97% must trip the warn threshold");
  assert.equal(june.rowsWithBrick, 97);
  assert.equal(june.rowsNeedingBrick, 100);
  assert.deepEqual(june.unmappedCustomerCodes, ["BAD0", "BAD1", "BAD2"]);
  assert.equal(june.customersWithBrick, 97);
  assert.equal(june.customersNeedingBrick, 100);

  // ── 2. A blank/whitespace brick counts as MISSING, not present ────────────
  // import_rows stores '' (empty string), not NULL, for an unresolved brick — the exact shape that
  // made 3,184 rows look fine.
  for (const empty of ["", "   ", null, undefined]) {
    const r = computeBrickCoverage([row(), row({ brickId: empty as string | null })]);
    assert.equal(r.coveragePct, 50, `brickId ${JSON.stringify(empty)} must count as missing`);
  }

  // ── 3. DIRECT is excluded from the denominator, not counted as a failure ──
  // DIRECT sells at brick level and carries no customer code by design. Counting it as unmapped
  // would park coverage permanently below any threshold and train everyone to ignore the alarm.
  const withDirect = computeBrickCoverage([
    row(),
    row(),
    row({ brickId: "", clientCode: null, isDirect: true }),
    row({ brickId: "", clientCode: null, isDirect: true }),
  ]);
  assert.equal(withDirect.coveragePct, 100, "DIRECT rows must not drag coverage down");
  assert.equal(withDirect.rowsNeedingBrick, 2, "DIRECT rows must leave the denominator");

  // ── 4. Units are tracked, not just row counts ────────────────────────────
  // Row counts understate the damage: June's 3,184 rows were 15,443 units.
  const units = computeBrickCoverage([
    row({ qty: 100, bonusQty: 5 }),
    row({ brickId: "", clientCode: "X", qty: 900, bonusQty: 0 }),
  ]);
  assert.equal(units.unitsNeedingBrick, 1005);
  assert.equal(units.unitsWithBrick, 105);
  assert.equal(units.coveragePct, 50, "coverage is by rows…");
  assert.ok(
    units.unitsNeedingBrick - units.unitsWithBrick === 900,
    "…but the unit gap is reported too, because 50% of rows can be 90% of volume",
  );

  // ── 5. Degenerate inputs must not produce NaN or a false alarm ───────────
  assert.equal(computeBrickCoverage([]).coveragePct, 100, "no rows is not a failure");
  assert.equal(
    computeBrickCoverage([row({ isDirect: true, brickId: "" })]).coveragePct,
    100,
    "an all-DIRECT batch has nothing to map and must not alarm",
  );
  const noQty = computeBrickCoverage([row({ qty: null as unknown as number, bonusQty: undefined })]);
  assert.equal(noQty.unitsNeedingBrick, 0, "missing quantities must be 0, never NaN");
  assert.ok(Number.isFinite(noQty.coveragePct));

  // A perfect batch stays silent.
  assert.equal(computeBrickCoverage([row(), row()]).coveragePct, 100);
  assert.ok(100 >= BRICK_COVERAGE_WARN_PCT, "a clean import must not trip the threshold");

  // ── 6. The commit path must actually record it ───────────────────────────
  // Reason (2) above: measuring correctly is useless if nothing calls it. persistNormalizedBatch is
  // the path every distributor upload takes.
  const service = readFileSync("src/lib/sales/normalizer/service.ts", "utf8");
  assert.ok(
    /saveBrickCoverageSnapshot\(/.test(service),
    "persistNormalizedBatch must record a brick-coverage snapshot",
  );
  assert.ok(
    /computeBrickCoverage\(rows\)/.test(service),
    "coverage must be computed from the rows actually persisted",
  );

  // ── 7. The row-reconciliation gate ───────────────────────────────────────
  // Coverage catches MAPPING loss. This catches ROW loss: the chunked inserts throw on error, but
  // not on a chunk that succeeds while storing fewer rows than it was handed. The batch records
  // total_rows from the in-memory array, so a short table still reports a full, healthy import.
  assert.ok(
    /count: "exact", head: true[\s\S]{0,200}?\.eq\("batch_id", batchId\)/.test(service),
    "persistNormalizedBatch must count the rows that actually landed for this batch",
  );
  assert.ok(
    /!== inserts\.length/.test(service),
    "the stored count must be compared against what was sent",
  );
  assert.ok(
    /status: "blocked"/.test(service),
    "a reconciliation mismatch must block the batch, not complete it",
  );
  assert.ok(
    /sos_import_row_reconciliation_failed/.test(service),
    "a reconciliation mismatch must be logged, not swallowed",
  );
  // The gate has to run BEFORE the batch is promoted/superseded, or a short import still goes live.
  // Match the CALL, not the identifier — the import statement at the top of the file would
  // otherwise satisfy this ordering check trivially.
  const gateAt = service.indexOf("!== inserts.length");
  const finalizeCallAt = service.indexOf("await finalizeSosBatchAndAuditSupersede({");
  assert.ok(gateAt > 0, "the reconciliation comparison must exist");
  assert.ok(finalizeCallAt > 0, "the finalize call must still exist");
  assert.ok(
    gateAt < finalizeCallAt,
    "the gate must run before the batch is finalized into the live rollups",
  );

  console.log("sos brick coverage tests passed");
}
