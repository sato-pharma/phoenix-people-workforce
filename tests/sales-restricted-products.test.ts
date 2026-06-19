import assert from "node:assert/strict";

import {
  isRestrictedProductCode,
  normalizeProductNameKey,
  stripRestrictedProductNames,
  stripRestrictedRows,
  stripRestrictedRowsByName,
} from "../src/lib/sales/access-scope.ts";

// The confidential products LA003 / LA004 ("Lacto Basic 1 & 2") must be visible only to CEO /
// Super Admin. The SoS pipeline keys products by CODE; the legacy pipeline keys them by NAME.
// These tests prove each guard catches what the other cannot.

const restrictedNames = new Set(["lacto basic 1", "lacto basic 2"]);

export async function runSalesRestrictedProductsTests() {
  // ── isRestrictedProductCode (code layer) ──
  assert.equal(isRestrictedProductCode("LA003"), true, "LA003 is restricted");
  assert.equal(isRestrictedProductCode("la004"), true, "case-insensitive");
  assert.equal(isRestrictedProductCode(" LA003 "), true, "trimmed");
  assert.equal(isRestrictedProductCode("LA001"), false, "Lacto Advanced is not restricted");
  assert.equal(isRestrictedProductCode(null), false, "null is not restricted");

  // ── normalizeProductNameKey ──
  assert.equal(normalizeProductNameKey("  Lacto   Basic  1 "), "lacto basic 1", "trim + collapse + lower");
  assert.equal(normalizeProductNameKey(null), "", "null → empty");

  // ── stripRestrictedRowsByName (name layer, legacy pipeline) ──
  type LegacyRow = { product: string; sales: number };
  const legacyRows: LegacyRow[] = [
    { product: "Lacto Advanced 1", sales: 10 },
    { product: "LACTO  BASIC 1", sales: 99 }, // restricted (odd casing/spacing)
    { product: "Lacto Basic 2", sales: 50 }, // restricted
    { product: "Spasmo", sales: 5 },
    { product: "", sales: 1 }, // no name → passes through
  ];
  const strippedLegacy = stripRestrictedRowsByName(legacyRows, restrictedNames, (r) => r.product, true);
  assert.deepEqual(
    strippedLegacy.map((r) => r.product),
    ["Lacto Advanced 1", "Spasmo", ""],
    "name layer drops both Lacto Basic rows regardless of casing/spacing",
  );

  // enabled === false (an allowed CEO / Super Admin viewer) keeps everything.
  assert.equal(
    stripRestrictedRowsByName(legacyRows, restrictedNames, (r) => r.product, false).length,
    legacyRows.length,
    "allowed viewer keeps every row",
  );

  // ── stripRestrictedProductNames (filter dropdown) ──
  assert.deepEqual(
    stripRestrictedProductNames(["Lacto Advanced 1", "Lacto Basic 1", "Spasmo"], restrictedNames, true),
    ["Lacto Advanced 1", "Spasmo"],
    "dropdown loses the confidential name",
  );

  // ── two-pipeline mismatch guard ──
  // A row carrying the restricted NAME but a non-restricted/blank CODE is caught by the NAME layer.
  const nameOnly = [{ productCode: "SA001", product: "Lacto Basic 1" }];
  assert.equal(
    stripRestrictedRows(nameOnly, ["LA003", "LA004"]).length,
    1,
    "code layer alone misses a name-only restricted row",
  );
  assert.equal(
    stripRestrictedRowsByName(nameOnly, restrictedNames, (r) => r.product, true).length,
    0,
    "name layer catches the name-only restricted row",
  );
  // A row carrying the restricted CODE but an unrelated NAME is caught by the CODE layer.
  const codeOnly = [{ productCode: "LA003", product: "Mislabeled Product" }];
  assert.equal(
    stripRestrictedRows(codeOnly, ["LA003", "LA004"]).length,
    0,
    "code layer catches the code-only restricted row",
  );
  assert.equal(
    stripRestrictedRowsByName(codeOnly, restrictedNames, (r) => r.product, true).length,
    1,
    "name layer alone misses a code-only restricted row",
  );
}
