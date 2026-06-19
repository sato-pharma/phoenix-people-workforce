import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { validateSheetHeaders } from "../src/lib/sales/normalizer/engine.ts";
import { RAW_DISTRIBUTOR_PROFILES, rawProfileForDistributor } from "../src/lib/sales/normalizer/profiles.ts";
import { resolveProduct } from "../src/lib/sales/normalizer/resolvers.ts";
import type { Crosswalks } from "../src/lib/sales/normalizer/types.ts";

function sheet(rows: string[][]): ExcelJS.Worksheet {
  const ws = new ExcelJS.Workbook().addWorksheet("S");
  rows.forEach((r) => ws.addRow(r));
  return ws;
}

function emptyMaps(over: Partial<Crosswalks> = {}): Crosswalks {
  return {
    brickById: new Map(),
    areaByCode: new Map(),
    regionByCode: new Map(),
    productByCode: new Map(),
    productByName: new Map(),
    productAliasByKey: new Map(),
    territoryAliasByKey: new Map(),
    areaAliasByKey: new Map(),
    regionAliasByKey: new Map(),
    customerBrickByKey: new Map(),
    customerBrickByCanonicalKey: new Map(),
    productByCanonicalCode: new Map(),
    ...over,
  };
}

export function runSalesStrictConformanceTests() {
  const PS = rawProfileForDistributor("PS")!;
  const CP = rawProfileForDistributor("CP")!;

  // ── STRICT header conformance ("no deviation") ───────────────────────────────────────────────
  // A sheet with the exact canonical PS headers passes.
  const ok = sheet([["Customer", "Customer Name", "Customer Address", "Sal. District", "Sal. Dist. Desc.", "Invoice Date", "Mat. Code", "Mat. Desc.", "Qty"]]);
  assert.equal(validateSheetHeaders(ok, PS, RAW_DISTRIBUTOR_PROFILES).valid, true, "exact PS headers pass");

  // Extra / unmapped columns are IGNORED (owner choice) — still valid.
  const extra = sheet([["Customer", "Mat. Code", "Mat. Desc.", "Qty", "Invoice Date", "Totals", "Internal Notes"]]);
  assert.equal(validateSheetHeaders(extra, PS, RAW_DISTRIBUTOR_PROFILES).valid, true, "extra columns are ignored, not blocking");

  // A RENAMED required column (product name "Mat. Desc." -> "Product") is rejected, naming the exact expected header.
  const renamed = sheet([["Customer", "Product", "Qty", "Invoice Date"]]);
  const r1 = validateSheetHeaders(renamed, PS, RAW_DISTRIBUTOR_PROFILES);
  assert.equal(r1.valid, false, "renamed product-name column is rejected");
  assert.ok(r1.missingGroups.some((g) => g.label === "Product name" && g.expected.includes("Mat. Desc.")), "rejection names the exact expected header 'Mat. Desc.'");

  // A MISSING required column (qty) is rejected.
  const noQty = sheet([["Customer", "Mat. Desc.", "Invoice Date"]]);
  assert.equal(validateSheetHeaders(noQty, PS, RAW_DISTRIBUTOR_PROFILES).valid, false, "missing quantity is rejected");

  // A date-less / brick-name-keyed distributor (CP) needs NO date column and is keyed by "Area name A".
  const cpOk = sheet([["Area name A", "Attribute", "Value"]]);
  assert.equal(validateSheetHeaders(cpOk, CP, RAW_DISTRIBUTOR_PROFILES).valid, true, "CP passes with no date column (brick by Area name A)");
  const cpBad = sheet([["Attribute", "Value"]]);
  assert.equal(validateSheetHeaders(cpBad, CP, RAW_DISTRIBUTOR_PROFILES).valid, false, "CP missing the 'Area name A' brick key is rejected");

  // ── NAME-FIRST product resolution ────────────────────────────────────────────────────────────
  const maps = emptyMaps({
    productByCode: new Map([["9999", { productCode: "9999", productName: "Generic", factoryPrice: 1, line: "x" }]]),
    productByName: new Map([["panadol", "1001"]]),
  });
  // The NAME column wins over a column that is a valid CODE (code-first would have returned "9999").
  assert.equal(resolveProduct(["9999", "Panadol"], maps, "PS"), "1001", "name-first: the product NAME resolves over a valid code");
  // Code fallback still works when no value matches a product name.
  assert.equal(resolveProduct(["9999"], maps, "PS"), "9999", "code fallback when no name matches");
  assert.equal(resolveProduct(["ZZZ"], maps, "PS"), null, "unknown product -> null");
  // Resolver tolerates an absent/empty productByName map (defensive).
  const codeOnly = emptyMaps({ productByCode: new Map([["1001", { productCode: "1001", productName: "Panadol", factoryPrice: 5, line: "OTC" }]]) });
  assert.equal(resolveProduct(["1001"], codeOnly, "PS"), "1001", "resolves by code when productByName is empty");
}
