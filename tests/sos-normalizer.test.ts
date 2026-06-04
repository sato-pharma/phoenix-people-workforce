import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { normalizeRawWorkbook } from "../src/lib/sales/normalizer/engine.ts";
import { distinctUnknowns, suggestProduct, type ProductRef } from "../src/lib/sales/normalizer/mapping.ts";
import { deriveHierarchy, normalizeAliasKey, resolveBrick, resolveProduct } from "../src/lib/sales/normalizer/resolvers.ts";
import type { Crosswalks, DistributorProfile, NormalizeException } from "../src/lib/sales/normalizer/types.ts";

const maps: Crosswalks = {
  brickById: new Map([["B1", { areaCode: "A1", areaName: "Area One", blockCode: "BL1", brickId: "B1", brickName: "Brick One", regionCode: "CA", regionName: "Cairo" }]]),
  areaByCode: new Map([["A1", { areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" }]]),
  regionByCode: new Map([["CA", { regionCode: "CA", regionName: "Cairo" }]]),
  productByCode: new Map([["LA001", { productCode: "LA001", productName: "Lacto 1", factoryPrice: 10, line: "Pedia" }]]),
  productAliasByKey: new Map([[normalizeAliasKey("لاكتو 1 لبن"), "LA001"], [normalizeAliasKey("VENOMOP"), "IGNORE"]]),
  territoryAliasByKey: new Map([[normalizeAliasKey("الدقى/بين السريات"), { targetType: "brick", targetCode: "B1" }]]),
  areaAliasByKey: new Map(),
  regionAliasByKey: new Map(),
  customerBrickByKey: new Map([["IS C123", "B1"]]),
};

const profile: DistributorProfile = {
  distributorCode: "IS",
  distributorName: "Ibn sina",
  productColumns: ["Item Code", "Item Name"],
  qtyColumns: ["Quantity"],
  bonusColumns: ["Free Unit"],
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

  // resolveProduct — direct code, alias-by-name, miss.
  assert.equal(resolveProduct(["LA001"], maps), "LA001");
  assert.equal(resolveProduct(["لاكتو 1 لبن"], maps), "LA001");
  assert.equal(resolveProduct(["", "لاكتو 1 لبن"], maps), "LA001"); // first blank, second resolves
  assert.equal(resolveProduct(["ZZ-NOPE"], maps), null);

  // resolveBrick — priority customer > direct > territory; territory match across ya/alef variants.
  assert.equal(resolveBrick({ customerKey: "IS C123" }, maps)?.source, "customer");
  assert.equal(resolveBrick({ brickIdValues: ["B1"] }, maps)?.source, "direct");
  const terr = resolveBrick({ territoryValues: ["الدقي/بين السريات"] }, maps);
  assert.equal(terr?.brickId, "B1");
  assert.equal(terr?.source, "territory");
  assert.equal(resolveBrick({ territoryValues: ["nowhere"] }, maps), null);

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

  // ── bulk mapping: suggestProduct (token overlap) + distinctUnknowns (collapse repeats) ──
  const products: ProductRef[] = [
    { code: "TE002", family: "Tebofortin", name: "Tebofortin 40mg 30 tab" },
    { code: "LA001", family: "Lacto", name: "Lacto 1 Advance" },
  ];
  assert.equal(suggestProduct("TEBOFORTIN FORTE 30TAB", products)?.code, "TE002");
  assert.equal(suggestProduct("LACTO 1 LABAN", products)?.code, "LA001");
  assert.equal(suggestProduct("zzz unrelated gibberish", products), null);

  const exceptions: NormalizeException[] = [
    { rawProduct: "583450", rawProductName: "TEBOFORTIN FORTE", rawTerritory: "NASR CITY", rawCustomerCode: "C1", rawRowNumber: 2, reason: "product" },
    { rawProduct: "583450", rawProductName: "TEBOFORTIN FORTE", rawTerritory: "NADI", rawCustomerCode: "C2", rawRowNumber: 3, reason: "product" },
    { rawProduct: "", rawProductName: "", rawTerritory: "العصافرة قبلي", rawCustomerCode: "C3", rawRowNumber: 4, reason: "brick" },
  ];
  const du = distinctUnknowns(exceptions, products);
  assert.equal(du.products.length, 1); // 2 rows collapse to ONE distinct code
  assert.equal(du.products[0]!.raw, "583450");
  assert.equal(du.products[0]!.count, 2);
  assert.equal(du.products[0]!.suggestionCode, "TE002"); // auto-suggested
  assert.equal(du.territories.length, 1);
  assert.equal(du.territories[0]!.count, 1);
}
