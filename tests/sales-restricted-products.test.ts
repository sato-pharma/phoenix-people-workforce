import assert from "node:assert/strict";

import {
  computeSalesAccessScope,
  isRestrictedProductCode,
  normalizeProductNameKey,
  RESTRICTED_PRODUCT_CODES,
  stripRestrictedProductNames,
  stripRestrictedRows,
  stripRestrictedRowsByName,
} from "../src/lib/sales/access-scope.ts";
import { resolveMarketingExcludeCodes } from "../src/lib/sales-marketing-intelligence/service.ts";

// The confidential products LA003 / LA004 ("Lacto Basic 1 & 2") must be visible only to CEO /
// Super Admin. The SoS pipeline keys products by CODE; the legacy pipeline keys them by NAME.
// These tests prove each guard catches what the other cannot.

const restrictedNames = new Set(["lacto basic 1", "lacto basic 2"]);

export async function runSalesRestrictedProductsTests() {
  // ── isRestrictedProductCode (code layer) ──
  assert.equal(isRestrictedProductCode("LA003"), true, "LA003 is restricted");
  assert.equal(isRestrictedProductCode("la004"), true, "case-insensitive");
  assert.equal(isRestrictedProductCode(" LA003 "), true, "trimmed");
  assert.equal(isRestrictedProductCode("SS001"), true, "SS001 (Satoslim) is restricted");
  assert.equal(isRestrictedProductCode(" ss001 "), true, "SS001 case-insensitive + trimmed");
  assert.equal(isRestrictedProductCode("LA001"), false, "Lacto Advanced is not restricted");
  assert.equal(isRestrictedProductCode(null), false, "null is not restricted");

  // ── Satoslim NAME layer (legacy/name guard catches "satoslim") ──
  const satoslimNames = new Set(["lacto basic 1", "lacto basic 2", "satoslim"]);
  assert.equal(
    stripRestrictedRowsByName([{ product: "Satoslim" }], satoslimNames, (r) => r.product, true).length,
    0,
    "name layer drops Satoslim",
  );

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

  // ── Sales & Marketing Intelligence aggregate exclusion (p_exclude_codes) ──
  // The RPC computes summary + every breakdown server-side, so the exclusion MUST be driven from
  // the caller's role, not client input. CEO / Super Admin opt into the full picture (empty list);
  // every other dashboard role gets the confidential codes excluded inside the RPC.
  assert.deepEqual(resolveMarketingExcludeCodes("CEO"), [], "CEO sees full aggregates");
  assert.deepEqual(resolveMarketingExcludeCodes("Super Admin"), [], "Super Admin sees full aggregates");
  assert.deepEqual(
    [...resolveMarketingExcludeCodes("Marketing Manager")].sort(),
    ["LA003", "LA004", "SS001"],
    "Marketing Manager aggregates exclude the confidential codes",
  );
  assert.deepEqual(
    [...resolveMarketingExcludeCodes("SFE Manager")].sort(),
    ["LA003", "LA004", "SS001"],
    "SFE Manager aggregates exclude the confidential codes",
  );
  // The exclusion list and the per-product strip both flow from the same constant, so they can
  // never diverge — adding a code in one place hides it everywhere.
  assert.deepEqual(
    [...resolveMarketingExcludeCodes("National Sales Manager")].sort(),
    [...RESTRICTED_PRODUCT_CODES].sort(),
    "non-privileged dashboard roles exclude exactly the restricted set",
  );

  // ── Head-office department head sales scope (Marketing Manager → reports' product lines) ──
  // The MM sits on the Head Office line, which is NOT a product line, so a "same own line" scope
  // resolves to nothing. The scope must instead cover the product lines of the MM's direct reports
  // (PM/GPM). reportLineNames carries those raw employee line names (bridged to official lines here).
  const mmReportsScope = computeSalesAccessScope({
    role: "Marketing Manager",
    businessScope: "LINE",
    viewerLineName: null, // head-office line bridges to no product line
    viewerRegionName: null,
    includeRestricted: false,
    reportLineNames: ["Pedia", "Zeta Line"],
  });
  assert.deepEqual(
    [...(mmReportsScope.allowedLineNames ?? [])].sort(),
    ["Pedia", "Zeta Line"].sort(),
    "MM sales/ROI scope = the bridged product lines of its direct reports",
  );
  assert.deepEqual(
    [...mmReportsScope.excludedProductCodes].sort(),
    [...RESTRICTED_PRODUCT_CODES].sort(),
    "MM (not a restricted-product role) still excludes the confidential products regardless of line scope",
  );
  // Regression guard: without the reports' lines, a head-office MM resolves to NO lines (the bug).
  const mmOwnLineOnly = computeSalesAccessScope({
    role: "Marketing Manager",
    businessScope: "LINE",
    viewerLineName: null,
    viewerRegionName: null,
    includeRestricted: false,
  });
  assert.equal(
    mmOwnLineOnly.allowedLineNames?.size,
    0,
    "without reports' lines the head-office MM resolves to an empty line set (documents the bug the fix closes)",
  );
}
