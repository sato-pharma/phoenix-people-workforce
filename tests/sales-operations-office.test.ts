import assert from "node:assert/strict";

import { getDistributorTemplate } from "../src/lib/sales-operations/dictionary.ts";
import { normalizeAliasKey, type CellRow } from "../src/lib/sales-operations/normalize.ts";
import { computeOfficeAllocation, parseOfficePivot, type OfficeBrickShare, type OfficeRegionShare } from "../src/lib/sales-operations/office.ts";
import type { Crosswalks } from "../src/lib/sales-operations/types.ts";

function baseMaps(): Crosswalks {
  return {
    brickById: new Map([
      ["B1", { areaCode: "A1", areaName: "Area One", blockCode: "BL1", brickId: "B1", brickName: "Brick One", regionCode: "CA", regionName: "Cairo" }],
      ["B2", { areaCode: "A1", areaName: "Area One", blockCode: "BL1", brickId: "B2", brickName: "Brick Two", regionCode: "CA", regionName: "Cairo" }],
      ["B3", { areaCode: "A2", areaName: "Area Two", blockCode: "BL2", brickId: "B3", brickName: "Brick Three", regionCode: "GZ", regionName: "Giza" }],
    ]),
    areaByCode: new Map([
      ["A1", { areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" }],
      ["A2", { areaCode: "A2", areaName: "Area Two", regionCode: "GZ", regionName: "Giza" }],
    ]),
    regionByCode: new Map([
      ["CA", { regionCode: "CA", regionName: "Cairo" }],
      ["GZ", { regionCode: "GZ", regionName: "Giza" }],
    ]),
    productByCode: new Map([
      ["1001", { productCode: "1001", productName: "Panadol", factoryPrice: 10, family: "Analgesics", line: "OTC" }],
      ["2002", { productCode: "2002", productName: "Augmentin", factoryPrice: 20, family: "Antibiotics", line: "Rx" }],
    ]),
    productByName: new Map([
      [normalizeAliasKey("Panadol"), "1001"],
      [normalizeAliasKey("Augmentin"), "2002"],
    ]),
    productByCanonicalCode: new Map(),
    productAliasByKey: new Map(),
    territoryAliasByKey: new Map(),
    areaAliasByKey: new Map(),
    customerBrickByKey: new Map(),
    customerBrickByCanonicalKey: new Map(),
  };
}

export async function runSalesOperationsOfficeTests() {
  const maps = baseMaps();

  // ── parseOfficePivot: reads product NAME + units, stops at the first blank row ───────────────
  const office = getDistributorTemplate("Office")!;
  const pivotGrid: CellRow[] = [
    ["Row Labels", "BUM", "Sum of المبيعات"],
    ["Panadol", "Manager A", 100],
    ["Augmentin", "Manager B", 30],
    [],
    ["Grand Total", "", 130], // junk below the blank row — must be ignored
  ];
  const pivot = parseOfficePivot(pivotGrid, office);
  assert.equal(pivot.length, 2, "stops at the blank row; junk below ignored");
  assert.equal(pivot[0].productName, "Panadol");
  assert.equal(pivot[0].units, 100);

  // ── two-step allocation: region share then brick share, Σ allocated == office units ─────────
  // Panadol (100 office units). Region share: CA 60, GZ 40. Brick share: CA -> B1 30, B2 10; GZ -> B3 40.
  // Expect CA gets 60 (B1 45, B2 15), GZ gets 40 (B3 40). Total 100.
  const regionShare: OfficeRegionShare[] = [
    { productCode: "1001", regionCode: "CA", units: 60 },
    { productCode: "1001", regionCode: "GZ", units: 40 },
  ];
  const brickShare: OfficeBrickShare[] = [
    { productCode: "1001", brickId: "B1", areaCode: "A1", regionCode: "CA", units: 30 },
    { productCode: "1001", brickId: "B2", areaCode: "A1", regionCode: "CA", units: 10 },
    { productCode: "1001", brickId: "B3", areaCode: "A2", regionCode: "GZ", units: 40 },
  ];
  const res = computeOfficeAllocation({ pivotRows: [pivot[0]], maps, regionShare, brickShare, period: "2026-04" });
  assert.equal(res.exceptions.length, 0);
  const totalUnits = res.coded.reduce((a, r) => a + r.qty, 0);
  assert.equal(Math.round(totalUnits * 1e6) / 1e6, 100, "Σ allocated units == office units (no drift)");
  assert.equal(res.nationalUnits, 0, "fully placed on bricks → no NATIONAL units");
  const byBrick = Object.fromEntries(res.coded.map((r) => [r.brickId, r.qty]));
  assert.equal(byBrick["B1"], 45, "CA(60) × B1 share 30/40 = 45");
  assert.equal(byBrick["B2"], 15, "CA(60) × B2 share 10/40 = 15");
  assert.equal(byBrick["B3"], 40, "GZ(40) × B3 share 40/40 = 40");
  // value = qty × factory price (10); geography + family from master.
  assert.equal(res.coded.find((r) => r.brickId === "B1")!.value, 450);
  assert.equal(res.coded.find((r) => r.brickId === "B1")!.regionName, "Cairo");
  assert.equal(res.coded.find((r) => r.brickId === "B1")!.family, "Analgesics");
  assert.equal(res.coded.every((r) => r.invoiceDate === "2026-04"), true, "Office period comes from the picker");

  // ── NATIONAL fallback: a product with no share anywhere goes to the NATIONAL bucket ─────────
  const natRes = computeOfficeAllocation({
    pivotRows: [{ productName: "Augmentin", units: 30, rawRowNumber: 3 }],
    maps,
    regionShare: [],
    brickShare: [],
    period: "2026-04",
  });
  assert.equal(natRes.coded.length, 1);
  assert.equal(natRes.coded[0].regionCode, "NATIONAL");
  assert.equal(natRes.coded[0].brickId, "");
  assert.equal(natRes.coded[0].qty, 30);
  assert.equal(natRes.coded[0].value, 600, "30 × 20 factory price");
  assert.deepEqual(natRes.nationalProducts, ["Augmentin"]);
  assert.equal(natRes.nationalUnits, 30, "unplaceable units are reported as NATIONAL units (residual check is live)");

  // ── unmapped office product name → exception (blocks upstream), nothing coded ───────────────
  const unmapped = computeOfficeAllocation({
    pivotRows: [{ productName: "Unknownium", units: 50, rawRowNumber: 2 }],
    maps,
    regionShare,
    brickShare,
    period: "2026-04",
  });
  assert.equal(unmapped.coded.length, 0);
  assert.equal(unmapped.exceptions.length, 1);
  assert.equal(unmapped.exceptions[0].reason, "product");
  assert.equal(unmapped.exceptions[0].rawProductName, "Unknownium");
}
