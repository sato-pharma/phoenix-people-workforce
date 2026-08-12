import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { buildMonthlyClosingWorkbook } from "../src/lib/sales/monthly-closing-export.ts";
import {
  buildMonthlyClosingMatrix,
  officeCellsFromDistributorRows,
  type MonthlyClosingAggregateCell,
  type MonthlyClosingMatrix,
} from "../src/lib/sales/monthly-distributor-import.ts";
import { isOfficeDistributorCode, OFFICE_DISTRIBUTOR_CODE } from "../src/lib/sales/office-distributor.ts";
import type { MonthlyClosingComparison } from "../src/lib/sales/monthly-closing-comparison.ts";

/**
 * "of which Office" — Office units, told apart from real distributor sell-out.
 *
 * Office is not a distributor. Its units carry no customer and no geography of their own; they land
 * in an area only because the owner's value-share rule put them there. On CNS July 2026 that is
 * 42,838 of 105,152 units — 41% of the closing — and until 2026-08-11 it was arithmetically
 * inseparable from distributor sell-out everywhere except the Data sheet's Distributor column.
 *
 * What must hold, at every level of the grid:
 *   • the Office figure never exceeds the total it sits beside;
 *   • area Office sums to the region subtotal, and regions to the national total;
 *   • an area that took no Office units reads 0, and an unreadable grid reads "—", never 0.
 */

const AREAS = [
  { areaCode: "A1", areaName: "Area One", regionCode: "R1", regionName: "Region One" },
  { areaCode: "A2", areaName: "Area Two", regionCode: "R1", regionName: "Region One" },
  { areaCode: "A3", areaName: "Area Three", regionCode: "R2", regionName: "Region Two" },
];
const PRODUCTS = [
  { factoryPrice: 10, family: "CNS", familyCode: "CNS", line: "CNS", productCode: "P1", productName: "Product One", source: "" },
  { factoryPrice: 40, family: "CNS", familyCode: "CNS", line: "CNS", productCode: "P2", productName: "Product Two", source: "" },
];

// Total closing. A3 is deliberately Office-free, so a "just copy the totals" implementation fails.
const TOTAL_CELLS: MonthlyClosingAggregateCell[] = [
  { areaCode: "A1", productCode: "P1", salesUnits: 1_000, salesValue: 10_000 },
  { areaCode: "A1", productCode: "P2", salesUnits: 200, salesValue: 8_000 },
  { areaCode: "A2", productCode: "P1", salesUnits: 600, salesValue: 6_000 },
  { areaCode: "A2", productCode: "P2", salesUnits: 100, salesValue: 4_000 },
  { areaCode: "A3", productCode: "P1", salesUnits: 300, salesValue: 3_000 },
];
// The Office component of exactly those cells — a strict subset, never equal to it.
const OFFICE_CELLS: MonthlyClosingAggregateCell[] = [
  { areaCode: "A1", productCode: "P1", salesUnits: 400, salesValue: 4_000 },
  { areaCode: "A1", productCode: "P2", salesUnits: 50, salesValue: 2_000 },
  { areaCode: "A2", productCode: "P1", salesUnits: 150, salesValue: 1_500 },
];

const build = (cells: MonthlyClosingAggregateCell[]): MonthlyClosingMatrix =>
  buildMonthlyClosingMatrix({
    areas: AREAS,
    availableLines: ["CNS"],
    availablePeriods: ["2026-07"],
    cells,
    line: "CNS",
    period: "2026-07",
    products: PRODUCTS,
  });

// The comparison sheets are not what this test is about — every list is empty so the workbook
// builds with only the two sheets under test carrying data.
const emptyComparison = (): MonthlyClosingComparison => ({
  areaByDistributor: [],
  avgPrice: [],
  byDistributor: [],
  coverage: [],
  data: {
    areaByDist: [], bricks: [], customers: [], distProduct: [],
    masterAreas: AREAS.map((a) => ({ areaCode: a.areaCode, areaName: a.areaName, regionName: a.regionName })),
    masterBricks: [], productByDist: [],
  },
  distributors: [{ code: OFFICE_DISTRIBUTOR_CODE, name: OFFICE_DISTRIBUTOR_CODE }],
  insights: [],
  line: "CNS",
  mix: { distributor: [], product: [], region: [] },
  national: { areaCount: AREAS.length, customerCount: 0, productCount: PRODUCTS.length, units: 2_200, value: 31_000 },
  pareto: { customers: { rows: [], share: 0, topValue: 0, total: 0 } },
  period: "2026-07",
  productByDistributor: [],
  rankings: { areas: [], bricks: [], customers: [], products: [], regions: [] },
  regionByDistributor: [],
  totalAreas: AREAS.length,
  totalBricks: 0,
  whiteSpace: { productGaps: [], singleDistributorAreas: [], zeroSalesAreas: [], zeroSalesBricks: [] },
} as unknown as MonthlyClosingComparison);

export async function runClosingOfficeDifferentiationTests() {
  const total = build(TOTAL_CELLS);
  const office = build(OFFICE_CELLS);

  const areaRow = (m: MonthlyClosingMatrix, code: string) =>
    m.regions.flatMap((r) => r.areas).find((a) => a.areaCode === code);
  const regionRow = (m: MonthlyClosingMatrix, code: string) =>
    m.regions.find((r) => r.regionCode === code);
  const colIndex = (m: MonthlyClosingMatrix, code: string) =>
    m.columns.findIndex((c) => c.productCode === code);

  // ── 1. the grids line up ───────────────────────────────────────────────────
  // The Office grid is built by the SAME builder over the same areas and products, so a cell can be
  // read positionally against the total beside it. If that ever stops being true, every "of which"
  // figure silently describes a different product.
  assert.deepEqual(
    office.columns.map((c) => c.productCode),
    total.columns.map((c) => c.productCode),
    "the Office grid must carry the same product columns, in the same order, as the closing",
  );
  assert.deepEqual(
    office.regions.flatMap((r) => r.areas.map((a) => a.areaCode)),
    total.regions.flatMap((r) => r.areas.map((a) => a.areaCode)),
    "the Office grid must carry the same areas, in the same order, as the closing",
  );

  // ── 2. Office never exceeds the total it annotates ─────────────────────────
  // THE headline assertion. Everything else can be right while this is wrong, and this is the one
  // that makes the column readable as "of which".
  for (const region of total.regions) {
    for (const area of region.areas) {
      const officeArea = areaRow(office, area.areaCode);
      area.cells.forEach((cell, idx) => {
        const officeUnits = officeArea?.cells[idx]?.salesUnits ?? 0;
        assert.ok(
          officeUnits <= cell.salesUnits + 1e-9,
          `${area.areaCode} ${total.columns[idx].productCode}: Office ${officeUnits} exceeds the ${cell.salesUnits} units it is "of which" of`,
        );
      });
    }
  }

  // ── 3. the numbers themselves ──────────────────────────────────────────────
  const p1 = colIndex(total, "P1");
  assert.equal(areaRow(total, "A1")?.cells[p1]?.salesUnits, 1_000);
  assert.equal(areaRow(office, "A1")?.cells[p1]?.salesUnits, 400, "A1 took 400 of its 1,000 P1 units from Office");
  assert.equal(areaRow(office, "A3")?.cells[p1]?.salesUnits, 0, "A3 sold P1 but took no Office units — a real 0");
  assert.equal(areaRow(total, "A3")?.cells[p1]?.salesUnits, 300, "and A3's own sales are untouched by the Office grid");

  // ── 4. it rolls up ─────────────────────────────────────────────────────────
  // R1 = A1 + A2 = (400+50) + (150+0) = 600 units, 7,500 EGP.
  assert.equal(
    regionRow(office, "R1")?.subtotal.cells.reduce((s, c) => s + c.salesUnits, 0),
    600,
    "region subtotal must be the sum of its areas' Office units",
  );
  assert.equal(regionRow(office, "R1")?.subtotal.rowTotal.salesValue, 7_500);
  assert.equal(regionRow(office, "R2")?.subtotal.rowTotal.salesValue, 0, "a region with no Office money totals a real 0");
  assert.equal(
    office.grandTotal.cells.reduce((s, c) => s + c.salesUnits, 0),
    600,
    "national Office units must equal the sum of the regions",
  );
  assert.equal(office.grandTotal.rowTotal.salesValue, 7_500);
  assert.ok(
    office.grandTotal.rowTotal.salesValue < total.grandTotal.rowTotal.salesValue,
    "Office is a component of the closing, never the whole of it",
  );

  // ── 5. the distributor predicate ───────────────────────────────────────────
  // The one marker separating an allocated unit from a real one. Case and stray spaces are what a
  // hand-edited alias row actually looks like.
  assert.ok(isOfficeDistributorCode(OFFICE_DISTRIBUTOR_CODE));
  assert.ok(isOfficeDistributorCode("office"), "distributor codes compare case-insensitively");
  assert.ok(isOfficeDistributorCode(" Office "), "and tolerate stray whitespace");
  assert.ok(!isOfficeDistributorCode("Officer"), "but must not match a different distributor");
  assert.ok(!isOfficeDistributorCode(""), "and an empty code is not Office");
  assert.ok(!isOfficeDistributorCode(null));

  // ── 6. the loader's fold ───────────────────────────────────────────────────
  // `phx_closing_distributor_product` returns EVERY distributor and groups by region as well as
  // area. Both facts are traps: keep the other distributors and "of which Office" becomes the whole
  // closing; overwrite instead of summing and every region but the last is dropped.
  const rpcRows: Record<string, unknown>[] = [
    { distributor_code: "Office", region_code: "R1", area_code: "A1", product_code: "P1", units: 250, value: 2_500 },
    { distributor_code: "Office", region_code: "R2", area_code: "A1", product_code: "P1", units: 150, value: 1_500 },
    { distributor_code: "IS", region_code: "R1", area_code: "A1", product_code: "P1", units: 600, value: 6_000 },
    { distributor_code: "RM", region_code: "R1", area_code: "A2", product_code: "P1", units: 450, value: 4_500 },
    { distributor_code: "office", region_code: "R1", area_code: "A2", product_code: "P1", units: 150, value: 1_500 },
  ];
  const folded = officeCellsFromDistributorRows(rpcRows);
  assert.equal(folded.length, 2, "only the Office rows survive, folded to one cell per area x product");
  const a1p1 = folded.find((c) => c.areaCode === "A1" && c.productCode === "P1");
  assert.equal(a1p1?.salesUnits, 400, "the two regions of A1/P1 must be SUMMED, not overwritten");
  assert.equal(a1p1?.salesValue, 4_000);
  assert.equal(
    folded.reduce((s, c) => s + c.salesUnits, 0),
    550,
    "no distributor row may leak into the Office total (IS 600 + RM 450 must be excluded)",
  );

  // ── 7. the exported workbook ───────────────────────────────────────────────
  const buffer = await buildMonthlyClosingWorkbook(total, emptyComparison(), undefined, { office });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);

  const officeSheet = wb.getWorksheet("Office Allocation");
  assert.ok(officeSheet, "the workbook must carry an Office Allocation sheet when the Office grid is supplied");

  const matrixSheet = wb.getWorksheet("Closing Matrix");
  assert.ok(matrixSheet, "the Closing Matrix sheet must exist");
  const metricRow = matrixSheet.getRow(5);
  const headers: string[] = [];
  metricRow.eachCell({ includeEmpty: true }, (cell) => headers.push(String(cell.value ?? "")));
  const officeHeaders = headers.filter((h) => h === "of wh. Office");
  assert.equal(
    officeHeaders.length,
    PRODUCTS.length + 1,
    `the Closing Matrix needs one "of wh. Office" column per product plus one on the Grand Total — found ${officeHeaders.length}`,
  );
  // Units and its Office column must be adjacent, or the sheet reads as two unrelated numbers.
  const unitsAt = headers.indexOf("Units");
  assert.equal(headers[unitsAt + 1], "of wh. Office", '"of wh. Office" must sit immediately after "Units"');

  // Without the Office grid the workbook is byte-for-byte the report it always was: no column, no
  // sheet. A surface that never asked for the breakdown must not grow one.
  const plain = new ExcelJS.Workbook();
  await plain.xlsx.load(
    (await buildMonthlyClosingWorkbook(total, emptyComparison(), undefined, {})) as unknown as ArrayBuffer,
  );
  assert.equal(plain.getWorksheet("Office Allocation"), undefined, "no Office grid ⇒ no Office sheet");
  const plainHeaders: string[] = [];
  plain.getWorksheet("Closing Matrix")?.getRow(5).eachCell({ includeEmpty: true }, (cell) => plainHeaders.push(String(cell.value ?? "")));
  assert.ok(!plainHeaders.includes("of wh. Office"), "no Office grid ⇒ no Office column");
}
