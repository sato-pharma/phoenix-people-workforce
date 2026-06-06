import assert from "node:assert/strict";

import { classifyCustomerMapRow, type CustomerMapClassifyContext } from "../src/lib/sales/normalizer/customer-map.ts";

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
}
