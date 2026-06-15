import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { buildHeaderMap } from "../src/lib/sales/normalizer/engine.ts";
import type { DistributorProfile } from "../src/lib/sales/normalizer/types.ts";

function sheet(rows: string[][]): ExcelJS.Worksheet {
  const ws = new ExcelJS.Workbook().addWorksheet("S");
  rows.forEach((row) => ws.addRow(row));
  return ws;
}

const IS_S: DistributorProfile = {
  distributorCode: "IS-S",
  distributorName: "Ibn Sina-Sato",
  productColumns: ["Item Code", "Item Name"],
  qtyColumns: ["Quantity"],
  valueColumns: ["Net"],
  valueSource: "recompute",
  dateColumns: ["Date"],
  customerCodeColumns: ["Client Code"],
  territoryColumns: ["Brick Name", "Territory Name"],
};

const PS_T: DistributorProfile = {
  distributorCode: "PS-T",
  distributorName: "Overseas Tender",
  productColumns: ["Material", "Short Description"],
  qtyColumns: ["Sales\\Returns Qty"],
  valueColumns: ["Sales\\Returns Value"],
  valueSource: "recompute",
  dateColumns: ["Delivery Date"],
  customerCodeColumns: ["Ship-To"],
  customerNameColumns: ["Ship-to party", "Name"],
  territoryColumns: ["Plant", "Name"],
};

// buildHeaderMap must skip banner/title rows above the real header, WITHOUT being fooled by a sparse
// pre-header row that happens to contain a single stray cell equal to a known column name.
export function runSosHeaderDetectionTests() {
  // 1) Long title row (no known header token) is skipped; the real header on row 2 wins (IS-S PAS report).
  const titled = sheet([
    ["Monthly Sales by Client for SATO PHARMA (PAS) Sales By Client"],
    ["Item Code", "Item Name", "Quantity", "Net", "Date", "Client Code"],
    ["585580", "TEBOFORTIN", "5", "100", "2026/05/01", "330729"],
  ]);
  assert.equal(buildHeaderMap(titled, IS_S).headerRow, 2, "title row must be skipped (real header on row 2)");

  // 2) Regression guard: a SPARSE pre-header row carrying a single stray cell that equals a known column
  //    name ("Name") must NOT hijack detection — the richer header row (>=2 known hits) on row 2 wins.
  const banner = sheet([
    ["Report", "Name"],
    ["Ship-to party", "Sales\\Returns Qty", "Material", "Sales\\Returns Value", "Delivery Date", "Ship-To"],
    ["Hospital", "10", "32328", "13440", "2026-05-13", "3000183"],
  ]);
  assert.equal(buildHeaderMap(banner, PS_T).headerRow, 2, "a single stray known token in a sparse banner row must not win");

  // 3) No regression: a normal header on row 1 is chosen.
  const normal = sheet([
    ["Item Code", "Item Name", "Quantity", "Net", "Date", "Client Code"],
    ["585580", "TEBOFORTIN", "5", "100", "2026/05/01", "330729"],
  ]);
  assert.equal(buildHeaderMap(normal, IS_S).headerRow, 1, "row-1 header must win when it carries the known columns");

  // 4) Without a profile, fall back to the legacy "first row with >=3 filled cells".
  const noProfile = sheet([["title"], ["a", "b", "c", "d"]]);
  assert.equal(buildHeaderMap(noProfile).headerRow, 2, "no profile -> first row with >=3 cells");
}
