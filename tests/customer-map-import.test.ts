import assert from "node:assert/strict";

import { classifyCustomerMapRow, parseReconciliationPreviewRow, type CustomerMapClassifyContext } from "../src/lib/sales/normalizer/customer-map.ts";

function makeCtx(): CustomerMapClassifyContext {
  return {
    brickById: new Map([
      ["B1-2", { areaCode: "CA1", brickId: "B1-2", regionCode: "CA" }],
      ["B135-4", { areaCode: "UE4", brickId: "B135-4", regionCode: "UE" }],
    ]),
    distributorCodes: new Set(["EG", "IS"]),
    seen: new Set<string>(),
  };
}

export function runCustomerMapImportTests() {
  // Fully blank row → silently skipped (not counted, not blocked).
  assert.equal(classifyCustomerMapRow({}, makeCtx()).kind, "skip-blank");

  // Distributor-only row (per-distributor template stamps the locked Distrub ID on every blank spare
  // row) → still skip-blank, NOT a false "Customer code is required" block.
  assert.equal(classifyCustomerMapRow({ distributorCode: "EG" }, makeCtx()).kind, "skip-blank");

  // Missing distributor → blocked.
  {
    const r = classifyCustomerMapRow({ brickId: "B1-2", customerCode: "100" }, makeCtx());
    assert.equal(r.kind, "blocked");
    if (r.kind === "blocked") assert.match(r.reason, /Distrub ID/i);
  }

  // Unknown distributor → blocked.
  {
    const r = classifyCustomerMapRow({ brickId: "B1-2", customerCode: "100", distributorCode: "ZZ" }, makeCtx());
    assert.equal(r.kind, "blocked");
    if (r.kind === "blocked") assert.match(r.reason, /distributors master/i);
  }

  // Missing customer code → blocked.
  {
    const r = classifyCustomerMapRow({ brickId: "B1-2", distributorCode: "EG" }, makeCtx());
    assert.equal(r.kind, "blocked");
    if (r.kind === "blocked") assert.match(r.reason, /Customer code/i);
  }

  // Blank brick → skipped (legitimate not-yet-mapped row), NOT blocked.
  assert.equal(classifyCustomerMapRow({ customerCode: "100", distributorCode: "EG" }, makeCtx()).kind, "skipped");

  // Brick not in master → blocked.
  {
    const r = classifyCustomerMapRow({ brickId: "99X", customerCode: "100", distributorCode: "EG" }, makeCtx());
    assert.equal(r.kind, "blocked");
    if (r.kind === "blocked") assert.match(r.reason, /brick master/i);
  }

  // Valid row → ok; distributor canonicalised, customer trimmed, area/region DERIVED from the brick.
  {
    const r = classifyCustomerMapRow({ address: "Y", brickId: "b135-4", customerCode: " 105338 ", customerName: "X", distributorCode: "eg" }, makeCtx());
    assert.equal(r.kind, "ok");
    if (r.kind === "ok") {
      assert.equal(r.payload.distributor_code, "EG");
      assert.equal(r.payload.customer_code, "105338");
      assert.equal(r.payload.brick_id, "B135-4");
      assert.equal(r.payload.area_code, "UE4");
      assert.equal(r.payload.region_code, "UE");
      assert.equal(r.payload.source, "admin-import");
    }
  }

  // Duplicate (distributor, customer) within one run → blocked on the second occurrence.
  {
    const ctx = makeCtx();
    assert.equal(classifyCustomerMapRow({ brickId: "B1-2", customerCode: "100", distributorCode: "EG" }, ctx).kind, "ok");
    const dup = classifyCustomerMapRow({ brickId: "B1-2", customerCode: "100", distributorCode: "EG" }, ctx);
    assert.equal(dup.kind, "blocked");
    if (dup.kind === "blocked") assert.match(dup.reason, /Duplicate/i);
  }

  // normalizeCodeKey tolerance: padded/lower-cased distributor + brick still resolve.
  {
    const r = classifyCustomerMapRow({ brickId: " b1-2 ", customerCode: "C1", distributorCode: " Eg " }, makeCtx());
    assert.equal(r.kind, "ok");
    if (r.kind === "ok") assert.equal(r.payload.brick_id, "B1-2");
  }

  // parseReconciliationPreviewRow — pure transform of the sos_count_reconcilable_import_rows RPC row.
  // No pre-existing mapping (RPC returns nulls/empties): nothing to reconcile.
  {
    const p = parseReconciliationPreviewRow({ affected_rows: 0, affected_batch_ids: [], current_bricks: {}, target_brick_id: null });
    assert.equal(p.affectedRows, 0);
    assert.deepEqual(p.affectedBatchIds, []);
    assert.deepEqual(p.currentBricks, []);
    assert.equal(p.targetBrickId, null);
  }
  // Real disagreement: 12 rows on B1, 3 on B2, both batches, target is B3 — sorted by count descending.
  {
    const p = parseReconciliationPreviewRow({
      affected_rows: 15,
      affected_batch_ids: ["batch-a", "batch-b"],
      current_bricks: { B1: 12, B2: 3 },
      target_brick_id: "B3",
    });
    assert.equal(p.affectedRows, 15);
    assert.deepEqual(p.affectedBatchIds, ["batch-a", "batch-b"]);
    assert.deepEqual(p.currentBricks, [{ brickId: "B1", count: 12 }, { brickId: "B2", count: 3 }]);
    assert.equal(p.targetBrickId, "B3");
  }
  // Null/undefined row (RPC returned no result row at all) never throws — degrades to the empty shape.
  {
    const p = parseReconciliationPreviewRow(null);
    assert.equal(p.affectedRows, 0);
    assert.deepEqual(p.affectedBatchIds, []);
    assert.equal(p.targetBrickId, null);
  }
}
