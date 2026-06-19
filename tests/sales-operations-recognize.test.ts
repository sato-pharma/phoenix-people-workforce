import assert from "node:assert/strict";

import { getDistributorTemplate } from "../src/lib/sales-operations/dictionary.ts";
import { normalizeAliasKey, type CellRow } from "../src/lib/sales-operations/normalize.ts";
import { detectCodedSheet, recognizeGrid, validateHeaders } from "../src/lib/sales-operations/recognize.ts";
import type { Crosswalks } from "../src/lib/sales-operations/types.ts";

function maps(): Crosswalks {
  return {
    brickById: new Map([["B1", { areaCode: "A1", areaName: "Area One", blockCode: "BL1", brickId: "B1", brickName: "Brick One", regionCode: "CA", regionName: "Cairo" }]]),
    areaByCode: new Map([["A1", { areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" }]]),
    regionByCode: new Map([["CA", { regionCode: "CA", regionName: "Cairo" }]]),
    productByCode: new Map([["1001", { productCode: "1001", productName: "Panadol", factoryPrice: 10, family: "Analgesics", line: "OTC" }]]),
    productByName: new Map([[normalizeAliasKey("Panadol"), "1001"]]),
    productByCanonicalCode: new Map(),
    productAliasByKey: new Map(),
    territoryAliasByKey: new Map([[normalizeAliasKey("Cairo East"), { targetType: "brick", targetCode: "B1" }]]),
    areaAliasByKey: new Map(),
    customerBrickByKey: new Map([["PS C1", "B1"]]),
    customerBrickByCanonicalKey: new Map(),
  };
}

export async function runSalesOperationsRecognizeTests() {
  const ps = getDistributorTemplate("PS")!;

  // ── coded-sheet rejection ───────────────────────────────────────────────────────────────────
  assert.equal(detectCodedSheet([["Product ID", "Brick ID", "Qty"]]), true);
  assert.equal(detectCodedSheet([["Customer", "Mat. Desc.", "Qty"]]), false);

  const codedGrid: CellRow[] = [["Product ID", "Region ID", "Qty"], ["1001", "CA", 5]];
  assert.equal(recognizeGrid({ rows: codedGrid, template: ps, maps: maps() }).status, "coded_sheet");

  // ── happy path: a valid PS sheet recognizes + normalizes ────────────────────────────────────
  const psGrid: CellRow[] = [
    ["Customer", "Mat. Code", "Mat. Desc.", "Qty", "Invoice Date"],
    ["C1", "9999", "Panadol", 5, "2026-04-15"],
  ];
  const ok = recognizeGrid({ rows: psGrid, template: ps, maps: maps() });
  assert.equal(ok.status, "ok");
  if (ok.status === "ok") {
    assert.equal(ok.result.coded.length, 1);
    assert.equal(ok.result.coded[0].productCode, "1001", "name-first wins over the unknown code");
    assert.equal(ok.period, "2026-04");
    assert.equal(ok.hasDateColumn, true);
  }

  // ── header error: missing the qty column ────────────────────────────────────────────────────
  const noQty: CellRow[] = [
    ["Customer", "Mat. Code", "Mat. Desc.", "Invoice Date"],
    ["C1", "9999", "Panadol", "2026-04-15"],
  ];
  const hv = validateHeaders(noQty, ps, [ps]);
  assert.equal(hv.valid, false);
  assert.ok(hv.missingGroups.includes("qty"));
  assert.equal(recognizeGrid({ rows: noQty, template: ps, maps: maps() }).status, "header_error");

  // ── fingerprint: a sheet that looks like EGD while PS is selected warns ──────────────────────
  const eg = getDistributorTemplate("EG")!;
  const egLikeGrid: CellRow[] = [
    ["CUSTOMER_CODE", "ITEM_CODE", "ITEM_NAME", "QTY_INVOICE", "INVOICE_DATE"],
    ["C1", "9999", "Panadol", 5, "2026-04-15"],
  ];
  const fp = validateHeaders(egLikeGrid, ps, [ps, eg]);
  assert.equal(fp.fingerprintWarning?.likelyCode, "EG", "fingerprint flags the EGD-looking file");

  // ── ChemiPharm: brick-name strategy, date-less, period from the picker ──────────────────────
  const cp = getDistributorTemplate("CP")!;
  const cpGrid: CellRow[] = [["Area name A", "Attribute", "Value"], ["Cairo East", "Panadol", 7]];
  const cpRes = recognizeGrid({ rows: cpGrid, template: cp, maps: maps(), period: "2026-05" });
  assert.equal(cpRes.status, "ok");
  if (cpRes.status === "ok") {
    assert.equal(cpRes.result.coded.length, 1);
    assert.equal(cpRes.result.coded[0].brickId, "B1");
    assert.equal(cpRes.period, "2026-05");
    assert.equal(cpRes.hasDateColumn, false);
  }

  // ── Office: pivot dispatched through the allocator (NATIONAL with no shares) ─────────────────
  const office = getDistributorTemplate("Office")!;
  const officeGrid: CellRow[] = [["Row Labels", "Sum of المبيعات"], ["Panadol", 50]];
  const offRes = recognizeGrid({ rows: officeGrid, template: office, maps: maps(), period: "2026-04" });
  assert.equal(offRes.status, "ok");
  if (offRes.status === "ok") {
    assert.equal(offRes.result.coded.length, 1);
    assert.equal(offRes.result.coded[0].regionCode, "NATIONAL", "no shares yet → NATIONAL bucket");
    assert.equal(offRes.result.coded[0].qty, 50);
  }
}
