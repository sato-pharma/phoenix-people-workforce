import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { generateTargetsTemplate, parseTargetsWorkbook } from "../src/lib/sales/targets-template.ts";

// The smart template is generated with a brand banner (rows 1-2), the column header on row 3,
// friendly-name dropdown columns, and ~200 pre-wired formula rows. This guards that a filled
// copy still round-trips cleanly through parseTargetsWorkbook (which the upload route uses):
//   • the header row is found under the banner,
//   • the two example rows resolve to canonical codes + computed value,
//   • the empty pre-wired formula rows are treated as blank (NOT parsed as junk),
//   • and the legacy row-1 header format still parses unchanged.
export async function runTargetsTemplateRoundtripTests(): Promise<void> {
  const products = [
    { productCode: "GU001", productName: "Guamusin", factoryPrice: 60.75 },
    { productCode: "IV001", productName: "Ivyronc", factoryPrice: 30.375 },
    { productCode: "LA001", productName: "Lacto Advanced 1", factoryPrice: 270 },
  ];
  const areas = [
    { areaCode: "AB1", areaName: "Alex East", regionCode: "AB" },
    { areaCode: "D14", areaName: "Gharbia 1 (Tanta)", regionCode: "D1" },
    { areaCode: "UE11", areaName: "Minia 1", regionCode: "UE-1" },
  ];
  const buffer = await generateTargetsTemplate({ lineLabel: "Pedia", products, areas, now: new Date(2026, 6, 1) });

  // Sheet layout is what the smart template promises.
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  assert.deepEqual(
    wb.worksheets.map((w) => w.name),
    ["Targets", "Products (Pedia)", "Areas (Pedia)", "Lists", "Read Me"],
    "expected the branded sheet set with Targets first",
  );
  const ws = wb.getWorksheet("Targets");
  assert.ok(ws, "Targets sheet present");
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => ws!.getCell(3, c).value),
    ["Period", "Product Name", "Product Code", "Line", "Area Name", "Area Code", "Target Units", "Unit Price", "Target Value"],
    "column header must sit on row 3 (under the brand banner)",
  );

  // Areas reference sheet: the Region column must resolve a line-specific district split (Anti
  // Infective's "UE-1") to its full name, not the raw code — REGION_LABELS has no "UE-1" entry,
  // so this proves regionLabelFor reconstructs it from the "UE" family instead of falling through.
  const areasWs = wb.getWorksheet("Areas (Pedia)");
  assert.ok(areasWs, "Areas (Pedia) sheet present");
  assert.deepEqual(
    [2, 3, 4].map((r) => areasWs!.getCell(r, 3).value),
    ["Alex-BHR", "Delta 1", "Upper Egypt 1"],
    "UE-1 must resolve to 'Upper Egypt 1', not the raw code or a blank",
  );

  // Only the two example rows parse — the ~198 empty pre-wired formula rows are blank, not junk.
  const rows = await parseTargetsWorkbook(buffer);
  assert.equal(rows.length, 2, `expected exactly 2 example rows, got ${rows.length}`);

  const [first, second] = rows;
  assert.deepEqual(
    { period: first.period, line: first.line, area: first.area, product: first.product, units: first.targetUnits, value: first.targetValue },
    { period: "2026-07", line: "Pedia", area: "AB1", product: "GU001", units: 1000, value: 60750 },
    "example row 1 resolves to canonical codes + Units × Unit Price",
  );
  assert.equal(second.product, "IV001");
  assert.equal(second.area, "D14");
  assert.equal(second.targetUnits, 500);
  assert.equal(second.targetValue, 500 * 30.375); // 15187.5

  // Backward compatibility: the legacy row-1 header (already-distributed templates) still parses.
  const legacy = new ExcelJS.Workbook();
  const legacyWs = legacy.addWorksheet("Targets");
  legacyWs.getRow(1).values = ["Period", "Line", "Area Code", "Product Code", "Target Value", "Target Units"];
  legacyWs.getRow(2).values = ["2026-07", "CNS", "AB1", "TE002", 250000, 2000];
  const legacyRows = await parseTargetsWorkbook(await legacy.xlsx.writeBuffer());
  assert.equal(legacyRows.length, 1, "legacy row-1 header must still parse");
  assert.deepEqual(
    { area: legacyRows[0].area, product: legacyRows[0].product, units: legacyRows[0].targetUnits, value: legacyRows[0].targetValue },
    { area: "AB1", product: "TE002", units: 2000, value: 250000 },
  );
}
