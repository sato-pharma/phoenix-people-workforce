import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import { normalizeRawWorkbook } from "../src/lib/sales/normalizer/engine.ts";
import { distinctUnknowns, suggestProduct, type ProductRef } from "../src/lib/sales/normalizer/mapping.ts";
import { deriveHierarchy, normalizeAliasKey, normalizeCodeKey, resolveBrick, resolveProduct } from "../src/lib/sales/normalizer/resolvers.ts";
import type { Crosswalks, DistributorProfile, NormalizeException } from "../src/lib/sales/normalizer/types.ts";
import { exceptionToIssue } from "../src/lib/sales/source-of-sales-upload.ts";

const maps: Crosswalks = {
  brickById: new Map([
    ["B1", { areaCode: "A1", areaName: "Area One", blockCode: "BL1", brickId: "B1", brickName: "Brick One", regionCode: "CA", regionName: "Cairo" }],
    ["B2", { areaCode: "A2", areaName: "Area Two", blockCode: "BL2", brickId: "B2", brickName: "Brick Two", regionCode: "CA", regionName: "Cairo" }],
  ]),
  areaByCode: new Map([["A1", { areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" }]]),
  regionByCode: new Map([["CA", { regionCode: "CA", regionName: "Cairo" }]]),
  productByCode: new Map([["LA001", { productCode: "LA001", productName: "Lacto 1", factoryPrice: 10, line: "Pedia" }]]),
  // Product aliases are PER-DISTRIBUTOR: keyed `${distributor} ${normalized alias}` (profile is "IS").
  productAliasByKey: new Map([[`${normalizeCodeKey("IS")} ${normalizeAliasKey("لاكتو 1 لبن")}`, "LA001"], [`${normalizeCodeKey("IS")} ${normalizeAliasKey("VENOMOP")}`, "IGNORE"]]),
  territoryAliasByKey: new Map([
    [normalizeAliasKey("الدقى/بين السريات"), { targetType: "brick", targetCode: "B1" }],
    [normalizeAliasKey("new brick text"), { targetType: "brick", targetCode: "B2" }],
  ]),
  areaAliasByKey: new Map(),
  regionAliasByKey: new Map(),
  // "IS C123" and "IS CSTALE" are pre-existing stored mappings; CSTALE is deliberately stale (points
  // at B1) so the priority-order + self-heal tests can prove the sheet's own territory text overrides it.
  customerBrickByKey: new Map([["IS C123", "B1"], ["IS CSTALE", "B1"]]),
  customerBrickByCanonicalKey: new Map(),
  productByCanonicalCode: new Map(),
};

const profile: DistributorProfile = {
  distributorCode: "IS",
  distributorName: "Ibn sina",
  productColumns: ["Item Code", "Item Name"],
  qtyColumns: ["Quantity"],
  valueColumns: ["Net"],
  valueSource: "recompute",
  dateColumns: ["Date"],
  customerCodeColumns: ["Client Code"],
  customerNameColumns: ["Client Name"],
  territoryColumns: ["Territory Name"],
  discountColumns: ["Discount%"],
};

async function buildRaw(rows: unknown[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["Item Code", "Item Name", "Quantity", "Free Unit", "Net", "Date", "Client Code", "Client Name", "Territory Name", "Discount%"]);
  rows.forEach((r) => ws.addRow(r));
  return wb.xlsx.writeBuffer();
}

export async function runSosNormalizerTests() {
  // normalizeAliasKey — Arabic alef/ya/tatweel + separators fold to one key.
  assert.equal(normalizeAliasKey("الدقى / بين السريات"), normalizeAliasKey("الدقي/بين السريات"));
  assert.equal(normalizeAliasKey("  Foo   Bar  "), "foo bar");

  // resolveProduct — direct code (global, no distributor needed), alias-by-name (per-distributor), miss.
  assert.equal(resolveProduct(["LA001"], maps), "LA001");
  assert.equal(resolveProduct(["لاكتو 1 لبن"], maps, "IS"), "LA001");
  assert.equal(resolveProduct(["", "لاكتو 1 لبن"], maps, "IS"), "LA001"); // first blank, second resolves
  assert.equal(resolveProduct(["لاكتو 1 لبن"], maps, "RM"), null); // another distributor's alias does NOT leak
  assert.equal(resolveProduct(["لاكتو 1 لبن"], maps), null); // no distributor → alias does not resolve
  assert.equal(resolveProduct(["ZZ-NOPE"], maps, "IS"), null);

  // resolveBrick — priority (owner rule, 2026-07-07): direct > territory > area > customer (fallback
  // only). Territory match across ya/alef variants. Customer-only input still resolves via the
  // stored crosswalk when the sheet gives no brick/territory signal at all.
  assert.equal(resolveBrick({ customerKey: "IS C123" }, maps)?.source, "customer");
  assert.equal(resolveBrick({ brickIdValues: ["B1"] }, maps)?.source, "direct");
  const terr = resolveBrick({ territoryValues: ["الدقي/بين السريات"] }, maps);
  assert.equal(terr?.brickId, "B1");
  assert.equal(terr?.source, "territory");
  assert.equal(resolveBrick({ territoryValues: ["nowhere"] }, maps), null);

  // The sheet's own brick/territory value ALWAYS wins over a stale stored customer mapping — never
  // the reverse. "IS CSTALE" is stored as B1, but this row's sheet carries direct evidence for B2.
  const override = resolveBrick({ customerKey: "IS CSTALE", brickIdValues: ["B2"] }, maps);
  assert.equal(override?.brickId, "B2");
  assert.equal(override?.source, "direct");
  const overrideByTerritory = resolveBrick({ customerKey: "IS CSTALE", territoryValues: ["new brick text"] }, maps);
  assert.equal(overrideByTerritory?.brickId, "B2");
  assert.equal(overrideByTerritory?.source, "territory");
  // With no sheet signal at all, the stored (stale) mapping is still the correct fallback.
  assert.equal(resolveBrick({ customerKey: "IS CSTALE" }, maps)?.brickId, "B1");

  // deriveHierarchy — brick -> area + region (never typed).
  const h = deriveHierarchy(terr, maps);
  assert.equal(h?.areaCode, "A1");
  assert.equal(h?.regionCode, "CA");
  assert.equal(h?.regionName, "Cairo");

  // Engine on a synthetic raw sheet: one codeable row + one unknown-product exception.
  const buffer = await buildRaw([
    ["LA001", "لاكتو 1 لبن", 6, 1, 999, "2026/04/30", "C999", "Pharmacy X", "الدقي/بين السريات", ""],
    ["ZZ999", "Unknown item", 3, 0, 50, "2026/04/30", "C1", "Y", "الدقي/بين السريات", ""],
    ["IGN999", "VENOMOP", 4, 0, 10, "2026/04/30", "C2", "Z", "الدقي/بين السريات", ""], // discontinued → ignored
  ]);
  const result = await normalizeRawWorkbook(buffer as unknown as ArrayBuffer, profile, maps);
  assert.equal(result.summary.totalRows, 3);
  assert.equal(result.coded.length, 1);
  assert.equal(result.exceptions.length, 1);
  assert.equal(result.summary.ignored, 1); // the VENOMOP row is dropped, not coded, not an exception
  const coded = result.coded[0]!;
  assert.equal(coded.productCode, "LA001");
  assert.equal(coded.brickId, "B1");
  assert.equal(coded.areaCode, "A1");
  assert.equal(coded.regionCode, "CA");
  assert.equal(coded.qty, 6);
  assert.equal(coded.value, 60); // 6 × 10 × (1 − 0); the sheet "Net" 999 is IGNORED (recompute)
  assert.equal(coded.invoiceDate, "2026-04");
  assert.equal(coded.clientCode, "C999");
  assert.equal(result.exceptions[0]!.reason, "product"); // brick resolved, product did not
  // C999 has no pre-existing stored mapping, so the engine queues a fresh (previousBrickId: null)
  // self-heal correction from the territory-resolved brick — never silently skipped.
  const c999Correction = result.customerBrickCorrections.find((c) => c.customerCode === "C999");
  assert.equal(c999Correction?.brickId, "B1");
  assert.equal(c999Correction?.previousBrickId, null);
  assert.equal(c999Correction?.distributorCode, "IS");

  // ── self-heal: sheet's territory text overrides a STALE stored customer mapping ──
  // "CSTALE" is stored as B1 (see maps fixture) but this row's sheet carries "new brick text" -> B2.
  const staleBuffer = await buildRaw([
    ["LA001", "لاكتو 1 لبن", 2, 0, 20, "2026/04/30", "CSTALE", "Stale Corp", "new brick text", ""],
  ]);
  const staleResult = await normalizeRawWorkbook(staleBuffer as unknown as ArrayBuffer, profile, maps);
  assert.equal(staleResult.coded.length, 1);
  assert.equal(staleResult.coded[0]!.brickId, "B2"); // sheet wins, not the stale B1 stored mapping
  assert.equal(staleResult.customerBrickCorrections.length, 1);
  const staleCorrection = staleResult.customerBrickCorrections[0]!;
  assert.equal(staleCorrection.customerCode, "CSTALE");
  assert.equal(staleCorrection.brickId, "B2");
  assert.equal(staleCorrection.previousBrickId, "B1"); // proves it detected the disagreement

  // ── date format: DD-MM-YYYY with day <= 12 must NOT be misread as a month (the Sofico bug). The
  // column carries a value with day > 12 (30-04) so the engine detects day-first and parses ALL as April. ──
  const ddmm = await buildRaw([
    ["LA001", "x", 1, 0, 10, "01-04-2026", "C1", "P", "الدقي/بين السريات", ""], // 1 April  (day 1  <= 12)
    ["LA001", "x", 1, 0, 10, "08-04-2026", "C2", "P", "الدقي/بين السريات", ""], // 8 April  (day 8  <= 12)
    ["LA001", "x", 1, 0, 10, "14-04-2026", "C3", "P", "الدقي/بين السريات", ""], // 14 April (day 14 > 12 -> day-first)
    ["LA001", "x", 1, 0, 10, "30-04-2026", "C4", "P", "الدقي/بين السريات", ""], // 30 April
  ]);
  const ddmmResult = await normalizeRawWorkbook(ddmm as unknown as ArrayBuffer, profile, maps);
  assert.equal(ddmmResult.coded.length, 4);
  for (const r of ddmmResult.coded) assert.equal(r.invoiceDate, "2026-04", `DD-MM date must parse to April, got ${r.invoiceDate}`);

  // ── bulk mapping: suggestProduct (token overlap) + distinctUnknowns (collapse repeats) ──
  const products: ProductRef[] = [
    { code: "TE002", family: "Tebofortin", name: "Tebofortin 40mg 30 tab" },
    { code: "LA001", family: "Lacto", name: "Lacto 1 Advance" },
  ];
  assert.equal(suggestProduct("TEBOFORTIN FORTE 30TAB", products)?.code, "TE002");
  assert.equal(suggestProduct("LACTO 1 LABAN", products)?.code, "LA001");
  assert.equal(suggestProduct("zzz unrelated gibberish", products), null);

  const exceptions: NormalizeException[] = [
    { rawProduct: "583450", rawProductName: "TEBOFORTIN FORTE", rawTerritory: "NASR CITY", rawCustomerCode: "C1", rawCustomerName: "Pharma A", rawCustomerAddress: "", rawRowNumber: 2, reason: "product" },
    { rawProduct: "583450", rawProductName: "TEBOFORTIN FORTE", rawTerritory: "NADI", rawCustomerCode: "C2", rawCustomerName: "Pharma B", rawCustomerAddress: "", rawRowNumber: 3, reason: "product" },
    { rawProduct: "", rawProductName: "", rawTerritory: "العصافرة قبلي", rawCustomerCode: "C3", rawCustomerName: "Pharma C", rawCustomerAddress: "", rawRowNumber: 4, reason: "brick" },
    { rawProduct: "", rawProductName: "", rawTerritory: "Eskndrya", rawCustomerCode: "C3", rawCustomerName: "Pharma C", rawCustomerAddress: "", rawRowNumber: 5, reason: "brick" },
  ];
  const du = distinctUnknowns(exceptions, products);
  assert.equal(du.products.length, 1); // 2 rows collapse to ONE distinct code
  assert.equal(du.products[0]!.raw, "583450");
  assert.equal(du.products[0]!.count, 2);
  assert.equal(du.products[0]!.suggestionCode, "TE002"); // auto-suggested
  assert.equal(du.territories.length, 2); // العصافرة + Eskndrya
  // brick-reason rows surface the distinct PHARMACY (C3 appears twice → one customer, count 2)
  assert.equal(du.customers.length, 1);
  assert.equal(du.customers[0]!.raw, "C3");
  assert.equal(du.customers[0]!.count, 2);
  assert.equal(du.customers[0]!.rawName, "Pharma C");

  // An unmapped product is now a hard failure — the same weight as an unmapped brick/territory —
  // so it blocks the whole batch instead of silently dropping the row (owner rule, 2026-08-14).
  const productOnlyIssue = exceptionToIssue(exceptions[0]!);
  assert.equal(productOnlyIssue.severity, "failure");
  assert.match(productOnlyIssue.message, /not mapped to a Phoenix product/);
  const brickOnlyIssue = exceptionToIssue(exceptions[2]!);
  assert.equal(brickOnlyIssue.severity, "failure");

  const workspaceSource = readFileSync("src/components/sales/normalizer-workspace.tsx", "utf8");
  assert.match(workspaceSource, /quietFailure/, "post-save coverage refresh must not overwrite a successful save with a generic fetch error");
  assert.match(workspaceSource, /Automatic coverage refresh could not complete/, "post-save refresh fallback must keep the successful save visible");

  // importSourceOfSalesFile talks to the DB (distributor profiles, product/brick reference data),
  // so it isn't unit-testable directly — pin its source text instead, the same way the workspace
  // check above does for an equally DB/UI-bound path. This guards Phase C (2026-08-14): a
  // product-only exception must block the raw/Normalizer upload path exactly like brick/territory
  // already did, not get filtered out and downgraded to an advisory.
  const uploadSource = readFileSync("src/lib/sales/source-of-sales-upload.ts", "utf8");
  assert.doesNotMatch(
    uploadSource,
    /reason\s*!==\s*["']product["']/,
    'the blocking set must not carve "product" exceptions back out — that reintroduces the silent-skip bug',
  );
  assert.match(
    uploadSource,
    /if \(exceptions\.length > 0\)/,
    "every normalizer exception (product, brick, territory, customer) must block — the check must not filter by reason first",
  );
  assert.match(
    uploadSource,
    /issues = exceptions\.map\(exceptionToIssue\)/,
    "blocked issues must come from the FULL exceptions list via exceptionToIssue, not a warning-only builder",
  );
  for (const removed of ["productExceptionToWarningIssue", "skippedProductRowsAdvisory", "ValidationResultWithNullableBatch"]) {
    assert.doesNotMatch(uploadSource, new RegExp(removed), `${removed} was retired with the product-block fix and must not reappear`);
  }
}
