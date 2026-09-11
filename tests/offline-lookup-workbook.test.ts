import assert from "node:assert/strict";

import { buildOfflineLookupWorkbook } from "../src/lib/sales/offline-lookup-workbook.ts";

// Every assertion here reads the BUILT WORKBOOK, never the source that produced it. Three defects in
// this builder were invisible in the source and obvious in the artifact: a double quote that broke
// every territory formula into Err:501, a sheet reorder that silently did nothing, and a verdict
// that compared areas where the online lookup compares bricks.

const areas = [
  { area_code: "UE9", area_name: "Beni Suef", region_code: "GZ" },
  { area_code: "UE2", area_name: "Minia 2", region_code: "UE" },
  { area_code: "UE3", area_name: "Assuit 1", region_code: "UE" },
];
const bricks = [
  { area_code: "UE9", block_code: "BL1", brick_id: "B128-4", brick_name: "Ehnasia", region_code: "GZ" },
  { area_code: "UE2", block_code: "BL2", brick_id: "B204-1", brick_name: "Minia City", region_code: "UE" },
  { area_code: "UE3", block_code: "BL3", brick_id: "B133-5", brick_name: "Manfalout", region_code: "UE" },
];
const customers = [
  { address: "a", area_code: "UE9", brick_id: "B128-4", confidence: 100, customer_code: "2029", customer_name: "Shifa", distributor_code: "EG", region_code: "GZ", source: "manual" },
  { address: "b", area_code: "UE2", brick_id: "B204-1", confidence: 100, customer_code: "2029", customer_name: "Tesla", distributor_code: "QM", region_code: "UE", source: "manual" },
  { address: "", area_code: "", brick_id: "", confidence: null, customer_code: "9", customer_name: "Unmapped", distributor_code: "PS", region_code: "", source: "auto" },
];
const territoryAliases = [{ alias: "البـاجور", target_code: "B133-5", target_type: "brick" }];
const areaAliases = [{ alias: "kafr", area_code: "UE9" }];

const build = () => buildOfflineLookupWorkbook({ areaAliases, areas, bricks, customers, territoryAliases });

export function runOfflineLookupWorkbookTests() {
  const { stats, workbook } = build();

  // 1) TAB ORDER. `orderNo` is not an ExcelJS API and `workbook.worksheets` is a derived array, so
  //    the original sort compiled, ran, and shipped a workbook that opened on 68,000 raw rows
  //    instead of the instructions. Creation order IS tab order — pin it.
  assert.deepEqual(
    workbook.worksheets.map((ws) => ws.name),
    ["Start here", "Lookup", "Batch", "Bricks", "Areas", "TerritoryAliases", "AreaAliases", "CustomerMap"],
    "the workbook must open on Start here, not on the raw customer map",
  );

  const lookup = workbook.getWorksheet("Lookup");
  assert.ok(lookup, "Lookup sheet must exist");
  const formula = (cell: string): string => {
    const value = lookup.getCell(cell).value as { formula?: string } | null;
    return typeof value?.formula === "string" ? value.formula : "";
  };

  // 2) THE VERDICT COMPARES BRICKS, not areas. The brick is what gets written to a mapping, and it
  //    is what classifyCustomerCodeCandidates() compares. Comparing areas would call two different
  //    bricks in one area "safe" — and the brick is exactly what a person then copies out wrongly.
  const verdict = formula("C22");
  assert.match(verdict, /\$E\$13=\$E\$19/, "the code verdict must compare the two BRICK helper cells");
  assert.match(verdict, /SAME BRICK/, "the agreeing case must say brick, not area");
  assert.match(verdict, /CHOOSE/, "the refusal must survive in the offline copy too");
  assert.ok(!/SAME (AREA|TERRITORY) —/.test(verdict), "comparing areas instead of bricks is the bug this pins");
  assert.match(formula("E13"), /INDEX\(CustomerMap!\$F\$/, "helper E13 must read the brick column F");
  assert.match(formula("E19"), /LOOKUP\(2,1\//, "helper E19 must take the LAST match, not the row after the first");

  // 3) THE QUOTE. A double quote inside an Excel string literal must be doubled. Emitted raw it
  //    produced SUBSTITUTE(x,""," ") — an empty argument — and every territory cell rendered
  //    Err:501. The emitted formula is the only place this is visible.
  const territoryVerdict = formula("C32");
  assert.ok(territoryVerdict.includes('""""'), "a literal double quote must be escaped as \"\"\"\" in the SUBSTITUTE chain");
  assert.ok(!/SUBSTITUTE\([^)]*,"",/.test(territoryVerdict), "an empty SUBSTITUTE argument is the Err:501 defect");

  // 4) THE ARABIC CONTRACT. tatweel, the alef forms and ى ARE folded, because normalizeAliasKey
  //    folds them and the stored key is already folded. ة is NOT folded, because the pipeline does
  //    not fold it — folding would manufacture matches production never returns.
  for (const folded of ["ـ", "إ", "أ", "آ", "ى"]) {
    assert.ok(territoryVerdict.includes(`"${folded}"`), `the territory key must fold ${folded} to match the stored alias key`);
  }
  assert.ok(!territoryVerdict.includes('"ة"'), "ة must NEVER be folded — that is the trap that invents a hit");
  assert.match(territoryVerdict, /AMBIGUOUS/, "a name used by two territories is ambiguous, never unknown");
  assert.match(territoryVerdict, /AREA ONLY/, "an area-alias-only hit must not invent a brick");

  // 5) THE CUSTOMER ROWS carry the brick ID *and* its name. The name is not on the customer row —
  //    it is joined from the brick master. Without it the sheet shows only an opaque id.
  const cm = workbook.getWorksheet("CustomerMap");
  assert.ok(cm, "CustomerMap sheet must exist");
  assert.deepEqual(
    (cm.getRow(2).values as unknown[]).slice(1, 8),
    ["EG", "2029", "EG|2029", "Shifa", "a", "B128-4", "Ehnasia"],
    "a mapped row must carry both the brick id and the brick NAME",
  );
  // An unmapped row carries EMPTY STRINGS, not nulls — reading brick_id as populated because it is
  // non-null is a mistake that has produced a wrong forecast here before.
  assert.deepEqual((cm.getRow(4).values as unknown[]).slice(6, 8), ["", ""], "an unmapped row must show blank, never a stale brick");

  // 6) THE STAMP. A snapshot with no build date gets mailed around for a month.
  assert.equal(stats.customers, customers.length);
  assert.match(stats.builtAt, /^\d{4}-\d{2}-\d{2}T/, "every build must carry an ISO stamp");
  const start = workbook.getWorksheet("Start here");
  assert.ok(start, "Start here sheet must exist");
  const startText = (start.getSheetValues() as unknown[][]).flat().filter((v) => typeof v === "string").join(" ");
  assert.match(startText, /THIS IS A SNAPSHOT/, "the first sheet must say plainly that it goes stale");
  assert.match(startText, new RegExp(stats.builtAt.slice(0, 10)), "the build date must appear on the first sheet");
}
