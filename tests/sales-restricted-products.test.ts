import assert from "node:assert/strict";

import {
  computeSalesAccessScope,
  isHeadOfficeLine,
  isRestrictedProductCode,
  normalizeProductNameKey,
  OFFICIAL_LINE_VALUES,
  resolveOfficialLineValue,
  RESTRICTED_PRODUCT_CODES,
  stripRestrictedMasterProductRows,
  stripRestrictedProductNames,
  stripRestrictedRows,
  stripRestrictedRowsByName,
} from "../src/lib/sales/access-scope.ts";
import { resolveMarketingExcludeCodes } from "../src/lib/sales-marketing-intelligence/service.ts";
import { MASTER_DEFINITIONS } from "../src/lib/sales/master-data/definitions.ts";
import { summarizePreview } from "../src/lib/sales/recognize.ts";
import type { CodedRow, NormalizeResult } from "../src/lib/sales/normalizer/types.ts";

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

  // ── stripRestrictedMasterProductRows (Database Mapping master-data routes: raw snake_case
  //    `product_code`, e.g. listMasterRows("products") over source_of_sales_products) ──
  const masterProductRows = [
    { product_code: "LA001", product_name: "Lacto Advanced 1" },
    { product_code: "LA003", product_name: "Lacto Basic 1" },
    { product_code: "la004", product_name: "Lacto Basic 2" },
    { product_code: " SS001 ", product_name: "Satoslim" },
    { product_code: null, product_name: "No code" },
  ];
  assert.deepEqual(
    stripRestrictedMasterProductRows(masterProductRows, "District Manager").map((r) => r.product_code),
    ["LA001", null],
    "District Manager loses every restricted-code master row, including lowercase/whitespace variants",
  );
  assert.deepEqual(
    stripRestrictedMasterProductRows(masterProductRows, "Regional Manager").map((r) => r.product_code),
    ["LA001", null],
    "Regional Manager loses every restricted-code master row",
  );
  assert.deepEqual(
    stripRestrictedMasterProductRows(masterProductRows, "National Sales Manager").map((r) => r.product_code),
    ["LA001", null],
    "National Sales Manager loses every restricted-code master row",
  );
  assert.equal(
    stripRestrictedMasterProductRows(masterProductRows, "CEO").length,
    masterProductRows.length,
    "CEO keeps every master row",
  );
  assert.equal(
    stripRestrictedMasterProductRows(masterProductRows, "Super Admin").length,
    masterProductRows.length,
    "Super Admin keeps every master row",
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

  // ── Head-office department head sales scope (Marketing Manager → marketing product lines) ──
  // The MM sits on the Head Office line, which is NOT a product line. Its scope is the FIXED set of
  // marketing department product lines (Anti infective / Pedia / CNS), passed as overseenLineNames,
  // which REPLACES the non-product own line — covering CNS even with no PM currently assigned to it.
  const mmScope = computeSalesAccessScope({
    role: "Marketing Manager",
    businessScope: "LINE",
    viewerLineName: "Head Office", // a head-office line is not a product line
    viewerRegionName: null,
    includeRestricted: false,
    overseenLineNames: ["Anti infective", "Pedia", "CNS"],
  });
  assert.deepEqual(
    [...(mmScope.allowedLineNames ?? [])].sort(),
    ["Anti infective", "CNS", "Pedia"],
    "MM sales/ROI scope = the marketing product lines (overseenLineNames replaces the non-product own line)",
  );
  assert.deepEqual(
    [...mmScope.excludedProductCodes].sort(),
    [...RESTRICTED_PRODUCT_CODES].sort(),
    "MM (not a restricted-product role) still excludes the confidential products regardless of line scope",
  );
  // Regression guard: without overseenLineNames the MM falls back to its own Head Office line, which
  // carries no product sales (the empty-dashboard bug the explicit marketing-line scope closes).
  const mmNoOverseen = computeSalesAccessScope({
    role: "Marketing Manager",
    businessScope: "LINE",
    viewerLineName: "Head Office",
    viewerRegionName: null,
    includeRestricted: false,
  });
  assert.deepEqual(
    [...(mmNoOverseen.allowedLineNames ?? [])],
    ["Head Office"],
    "without overseen lines the MM falls back to the (product-less) Head Office line — documents the bug",
  );

  // ── Head Office write-time backstop (Product Master "Line" allow-list) ──
  // Confidentiality (isHeadOfficeLine) is a hardcoded key set with no DB-driven guarantee that
  // every "Head Office" product actually carries that exact label. The write-time gate on the
  // Product Master import is what closes that gap: this locks the canonical set and the wiring.
  assert.deepEqual(
    [...OFFICIAL_LINE_VALUES].sort(),
    ["Anti infective", "CNS", "Head Office", "Pedia"],
    "the canonical official-line set is exactly the 4 known lines",
  );
  for (const line of OFFICIAL_LINE_VALUES) {
    assert.equal(isHeadOfficeLine(line) || line !== "Head Office", true, "sanity: only Head Office is HO");
  }
  assert.equal(resolveOfficialLineValue("head office"), "Head Office", "case-insensitive match resolves to canonical casing");
  assert.equal(resolveOfficialLineValue("  CNS  "), "CNS", "whitespace-insensitive match");
  assert.equal(resolveOfficialLineValue("office"), "Head Office", "legacy abbreviation still resolves");
  assert.equal(resolveOfficialLineValue("H.O."), null, "an unrecognized label is rejected, not silently accepted");
  assert.equal(resolveOfficialLineValue("Head-Office"), null, "a differently-punctuated label is rejected");
  assert.equal(resolveOfficialLineValue(""), null, "empty resolves to null");

  // The Product Master's "line" column is wired to this exact allow-list — if a future edit
  // removes `allowedValues` from that column, this catches the regression (the write-time gate
  // silently disappearing, re-opening the leak this backstop was added to close).
  const lineColumn = MASTER_DEFINITIONS.products.columns.find((column) => column.key === "line");
  assert.ok(lineColumn?.allowedValues, "Product Master 'line' column has an allow-list configured");
  assert.deepEqual(
    [...(lineColumn?.allowedValues ?? [])].sort(),
    [...OFFICIAL_LINE_VALUES].sort(),
    "Product Master 'line' allow-list matches the canonical official-line set (single source of truth)",
  );

  // ── summarizePreview must never leak a restricted product via its raw row sample (sampleCoded) ──
  // Regression test for the confirmed leak: sampleCoded is a raw row sample (product + customer
  // identity included), so it needs the same stripping buildPreviewBreakdowns already applies to
  // the aggregated tables — a viewer who can't see LA003/LA004/SS001 must never see them here either.
  function makeCodedRow(overrides: Partial<CodedRow>): CodedRow {
    return {
      areaCode: "A1", areaName: "Area 1", brickId: "B1", brickName: "Brick 1", bonusQty: 0,
      clientCode: "C1", clientName: "Client One", clientAddress: null, discount: 0,
      distributorCode: "SF", invoiceDate: "2026-07-01", invoiceNumber: null, isDirect: false,
      officialLine: "CNS", productCode: "LA001", productName: "Lacto Advanced 1", qty: 10,
      rawRowNumber: 1, regionCode: "R1", regionName: "Region 1", value: 1000,
      ...overrides,
    };
  }
  const mixedResult: NormalizeResult = {
    coded: [
      makeCodedRow({ rawRowNumber: 1, productCode: "LA001", productName: "Lacto Advanced 1" }),
      makeCodedRow({ rawRowNumber: 2, productCode: "LA003", productName: "Lacto Basic 1", clientName: "Confidential Client" }),
      makeCodedRow({ rawRowNumber: 3, productCode: "SS001", productName: "Satoslim" }),
    ],
    distributorCode: "SF",
    exceptions: [],
    ignoredRows: [],
    blankCustomerRows: [],
    customerBrickCorrections: [],
    summary: { brickResolved: 3, blankCustomerSkipped: 0, fullyCoded: 3, ignored: 0, productResolved: 3, totalRows: 3 },
  };
  const products = [{ code: "LA001", name: "Lacto Advanced 1" }, { code: "LA003", name: "Lacto Basic 1" }, { code: "SS001", name: "Satoslim" }];

  const restrictedViewerPreview = summarizePreview("SF", "Sofico", mixedResult, products, [...RESTRICTED_PRODUCT_CODES]);
  assert.deepEqual(
    restrictedViewerPreview.sampleCoded.map((r) => r.productCode),
    ["LA001"],
    "a non-privileged viewer's sampleCoded never contains a restricted-product row",
  );
  assert.equal(
    restrictedViewerPreview.sampleCoded.some((r) => r.clientName === "Confidential Client"),
    false,
    "the confidential row's customer identity is not exposed either",
  );

  const privilegedViewerPreview = summarizePreview("SF", "Sofico", mixedResult, products, []);
  assert.deepEqual(
    privilegedViewerPreview.sampleCoded.map((r) => r.productCode),
    ["LA001", "LA003", "SS001"],
    "CEO / Super Admin (empty exclude list) still see every row",
  );

  const defaultCallPreview = summarizePreview("SF", "Sofico", mixedResult, products);
  assert.deepEqual(
    defaultCallPreview.sampleCoded.map((r) => r.productCode),
    ["LA001", "LA003", "SS001"],
    "omitting excludeProductCodes defaults to no stripping (callers must opt in) — every existing " +
      "call site was updated to pass a role-derived list",
  );
}
