import assert from "node:assert/strict";

import { classifyCustomerMapRow, customerMapAuditEntry, customerMapUpsertPayload, parseReconciliationPreviewRow, type CustomerMapClassifyContext } from "../src/lib/sales/normalizer/customer-map.ts";

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

  // ── An upload that moves nothing must not relabel where the mapping came from ──────────────────
  //
  // The export → fix in Excel → re-upload loop carries back every row the operator did not touch. A
  // ruling of his that comes back on the same brick must still read as his ruling afterwards.
  const ruling = { address: "12 Ramses St", areaCode: "CA1", brickId: "B1-2", customerName: "Nour Pharmacy", source: "owner-ruling-heliopolis-2026-08-10" };
  const payload = () => ({ area_code: "CA1", brick_id: "B1-2", customer_code: "100", distributor_code: "EG", region_code: "CA", source: "admin-import" });

  // Same brick AND same area → the row keeps its provenance, so `source` is not written at all.
  {
    const p = customerMapUpsertPayload(payload(), ruling);
    assert.equal("source" in p, false, "an unchanged row must not carry a source key at all");
    assert.equal(p.brick_id, "B1-2");
    assert.equal(p.customer_code, "100", "name/address/brick still update — only provenance is held");
  }

  // Casing and padding are not a move: the key comparison is normalized, as the importer's is.
  {
    const p = customerMapUpsertPayload(payload(), { ...ruling, areaCode: " ca1 ", brickId: " b1-2 ", source: "sheet-verified" });
    assert.equal("source" in p, false);
  }

  // A different brick IS a real re-mapping → stamped admin-import honestly, and the database guard
  // then holds it because it overwrites a decision.
  {
    const p = customerMapUpsertPayload(payload(), { ...ruling, brickId: "B135-4" });
    assert.equal(p.source, "admin-import");
  }

  // Same brick but a different area (the pair disagreed before) → still a move, still stamped.
  {
    const p = customerMapUpsertPayload(payload(), { ...ruling, areaCode: "UE4" });
    assert.equal(p.source, "admin-import");
  }

  // A customer the crosswalk has never seen has no provenance to keep → stamped, and the INSERT
  // branch needs the NOT NULL column filled.
  {
    const p = customerMapUpsertPayload(payload(), undefined);
    assert.equal(p.source, "admin-import");
  }

  // ── The per-row history the bulk upload never had ─────────────────────────────────────────────
  //
  // It wrote one summary line of counts, so an upload that re-pointed thousands of pharmacies left
  // nothing saying which ones or what they were before.
  const named = ruling;
  const full = () => ({ ...payload(), address: "12 Ramses St", customer_name: "Nour Pharmacy" });

  // A mapping the crosswalk has never seen → recorded as an addition, with no before.
  {
    const e = customerMapAuditEntry(full(), undefined, "b-10");
    assert.ok(e, "a brand new mapping must be recorded");
    assert.equal(e?.action, "add");
    assert.equal(e?.entityType, "customer_map");
    assert.equal(e?.entityKey, "100");
    assert.equal(e?.distributorCode, "EG");
    assert.equal(e?.actor, "b-10");
    assert.equal(e?.before, undefined, "an addition has nothing before it");
  }

  // The row the upload merely carried back unchanged → NO entry, or the handful that matter drown.
  {
    assert.equal(customerMapAuditEntry(full(), named, "b-10"), null);
  }

  // Casing and padding are not a change here either, matching the upsert helper.
  {
    assert.equal(customerMapAuditEntry(full(), { ...named, brickId: " b1-2 ", areaCode: " ca1 " }, "b-10"), null);
  }

  // A real re-mapping → recorded, and the before names the brick it came from.
  {
    const e = customerMapAuditEntry(full(), { ...named, areaCode: "UE4", brickId: "B135-4" }, "b-10");
    assert.ok(e);
    assert.equal(e?.action, "edit");
    assert.equal((e?.before as Record<string, unknown>).brick_id, "B135-4");
    assert.equal((e?.after as Record<string, unknown>).brick_id, "B1-2");
  }

  // A name or address correction is NOT a re-mapping, and is still recorded — the database guard
  // deliberately never sees this one, so the application is the only place it can be caught.
  {
    const e = customerMapAuditEntry(full(), { ...named, customerName: "Nour Pharamcy" }, "b-10");
    assert.ok(e, "a corrected spelling is still an edit someone made");
    assert.equal(e?.action, "edit");
    assert.equal((e?.before as Record<string, unknown>).customer_name, "Nour Pharamcy");
  }
}
