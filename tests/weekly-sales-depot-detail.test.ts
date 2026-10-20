import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveEmployeeIdentityId } from "../src/lib/auth/permissions.ts";
import { sharedIdentityKeys } from "../src/lib/auth/identity-aliases.ts";
import { buildWeeklyAreaSplitIndex } from "../src/lib/sales/weekly/branch-area-split.ts";
import { managerDepotRows, parseWeeklySalesDetailManagerParams } from "../src/lib/sales/weekly/depot-detail-service.ts";
import {
  buildWeeklySalesDepotDetailFilename,
  buildWeeklySalesDepotDetailWorkbook,
  weeklySalesDepotDetailNotes,
} from "../src/lib/sales/weekly/depot-detail-workbook.ts";
import {
  buildPortalWeeklyFieldForce,
  selectFieldForceSeats,
  type FieldForceSeatRow,
} from "../src/lib/sales/weekly/portal-weekly-field-force.ts";
import { weeklyScopeOwnAreaKeys } from "../src/lib/sales/weekly/own-area-scope.ts";
import { mayLiftWeeklyGeography, narrowWeeklyRowsToOwnAreaShare } from "../src/lib/sales/weekly/own-area-share.ts";
import { selectOwnRepSeats, selectRepWeeklySales } from "../src/lib/sales/weekly/portal-weekly-rep.ts";
import {
  parseRepWeeklyDepotDetailParams,
  repDepotDetailScopeSummary,
  selectOwnRepDepotParts,
} from "../src/lib/sales/weekly/portal-weekly-rep-depot-detail.ts";
import {
  WEEKLY_SALES_DETAIL_NOTHING,
  WEEKLY_SALES_DETAIL_UNMAPPED_AREA,
  WEEKLY_SALES_DETAIL_UNMAPPED_AREA_LABEL,
  WEEKLY_SALES_DETAIL_UNMAPPED_REGION_LABEL,
  buildWeeklySalesDepotDetail,
  salesDepotKey,
  weeklySalesDetailShowsBasis,
  weeklySalesMonthLabel,
  weeklySalesPeriodLabel,
  weeklySalesUploadCalendar,
  type WeeklySalesDepotDetailPayload,
  type WeeklySalesDetailSourceRow,
  type WeeklySalesDetailUpload,
  type WeeklySalesDetailView,
} from "../src/lib/sales/weekly/sales-depot-detail.ts";
import { accessRegistry } from "../src/lib/security/access-registry.ts";
import type { WeeklyFactExportRow } from "../src/lib/sales/weekly/types.ts";

// Weekly Sales — Depot Detail (owner, 2026-09-16: "make weekly sales detailed exactly as weekly stock",
// on both portal pages; a Medical Rep sees his own area only, and his export is exactly his screen).
//
// Seven things here are load-bearing and none is visible when it breaks:
//
//   1. THE AVERAGE PER WEEK IS A TRUE AVERAGE. Most distributors restate the month to date, so a sheet
//      after a missed upload carries two weeks, a month's first sheet carries weeks 1..n, and a sheet
//      uploaded twice carries nothing new. Count uploads instead of week slots and every average after a
//      gap reads double.
//   2. UNITS ARE NEVER ADDED ACROSS PRODUCTS. A unit figure exists on one product at one depot and on one
//      product across depots — never on a depot, area, region, distributor or the whole view.
//   3. A DEPOT WITH NO AREA IS NEVER DROPPED. It is listed under "Area not mapped", one line per region.
//   4. A REP'S DETAIL IS HIS OWN SHARE AND NOTHING WIDER, and it adds up to the figure on his own Weekly
//      Sales page — the two are filed by the same seat lookup, so they cannot disagree.
//   5. THE DOWNLOAD IS THE SCREEN. Same loader, same query, no hand-written total that counts money twice,
//      and no SUM under a unit column.
//   6. EVERY TOTAL IS ADDED BEFORE IT IS ROUNDED. Parts rounded first add up to a different figure from the
//      Weekly Sales page this tab sits on, and from a rep's own page.
//   7. A LIFTED MANAGER READS WHAT HIS FIELD FORCE TAB READS. Depot rows still say "Upper Egypt", so an
//      Upper Egypt 1 manager's region bound never fetched the depots the owner's split shares with his
//      areas. His load is lifted and narrowed straight back: his own depots whole, any other depot only
//      for the share in his own areas, labelled as an allocation — and never another district's share.

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const SEPTEMBER = "2026-09-01";
const OCTOBER = "2026-10-01";

function upload(
  batchId: string,
  distributorCode: string,
  cycleMonth: string | null,
  weekNumber: number | null,
  weekStart: string | null,
): WeeklySalesDetailUpload {
  return { batchId, distributorCode, cycleMonth, weekNumber, weekStart };
}

const spansOf = (uploads: WeeklySalesDetailUpload[]) => Object.fromEntries(weeklySalesUploadCalendar(uploads).spans);

function sourceRow(overrides: Partial<WeeklySalesDetailSourceRow>): WeeklySalesDetailSourceRow {
  return {
    batchId: "pos-w1",
    distributorCode: "POS",
    distributorName: "POS Purchasing Sales",
    regionCode: "UE",
    regionName: "Upper Egypt",
    areaCode: "UE3",
    branchCode: "BR1",
    branchName: "Minia Branch",
    productCode: "P1",
    productName: "Augmentin 1g",
    line: "Anti Infective",
    cycleMonth: SEPTEMBER,
    weekNumber: 1,
    weekStart: "2026-09-06",
    salesValue: 0,
    salesUnits: 0,
    basis: "whole",
    ...overrides,
  };
}

// ── the managers' fixture ────────────────────────────────────────────────────────────────────────
// POS uploaded weeks 1 and 3 of September (week 2 never arrived) and sent its week 3 sheet twice on the
// same date. Ibn Sina uploaded week 1. Overseas uploaded all four weeks but none of its rows reach this
// viewer. POS's August sheet is outside the period.
const UPLOADS: WeeklySalesDetailUpload[] = [
  upload("pos-aug-w4", "POS", "2026-08-01", 4, "2026-08-23"),
  upload("pos-w1", "POS", SEPTEMBER, 1, "2026-09-06"),
  upload("pos-w3", "POS", SEPTEMBER, 3, "2026-09-20"),
  upload("pos-w3-again", "POS", SEPTEMBER, 3, "2026-09-20"),
  upload("is-w1", "IS", SEPTEMBER, 1, "2026-09-06"),
  upload("ps-w1", "PS", SEPTEMBER, 1, "2026-09-06"),
  upload("ps-w2", "PS", SEPTEMBER, 2, "2026-09-13"),
  upload("ps-w3", "PS", SEPTEMBER, 3, "2026-09-20"),
  upload("ps-w4", "PS", SEPTEMBER, 4, "2026-09-27"),
];

const MANAGER_ROWS: WeeklySalesDetailSourceRow[] = [
  sourceRow({ batchId: "pos-w1", salesUnits: 10, salesValue: 1000 }),
  sourceRow({ batchId: "pos-w3", weekNumber: 3, weekStart: "2026-09-20", salesUnits: 20, salesValue: 2000 }),
  // De-cumulation merged the duplicate sheet into rows that can carry EITHER batch id.
  sourceRow({ batchId: "pos-w3-again", weekNumber: 3, weekStart: "2026-09-20", salesUnits: 4, salesValue: 400 }),
  sourceRow({
    batchId: "pos-w3-again",
    weekNumber: 3,
    weekStart: "2026-09-20",
    productCode: "P2",
    productName: "Flagyl 500mg",
    salesUnits: 6,
    salesValue: 600,
  }),
  sourceRow({ productCode: "P3", productName: "Unasyn 375mg", salesUnits: -3, salesValue: -300 }),
  // Two depots that serve several areas, in two regions.
  sourceRow({ areaCode: null, branchCode: "KA1", branchName: "UE Key Accounts", salesUnits: 5, salesValue: 500 }),
  sourceRow({
    batchId: "is-w1",
    distributorCode: "IS",
    distributorName: "Ibn Sina",
    regionCode: "CA",
    regionName: "Cairo",
    areaCode: null,
    branchCode: "CW1",
    branchName: "Cairo Wholesale",
    salesUnits: 7,
    salesValue: 700,
  }),
];

const AREA_NAMES = new Map([["UE3", "Assuit 1"]]);
const SEPTEMBER_PERIOD = { cycleMonths: [SEPTEMBER], cycleMonthMode: "include" as const };

function managerView(filters?: Parameters<typeof buildWeeklySalesDepotDetail>[0]["filters"]): WeeklySalesDetailView {
  return buildWeeklySalesDepotDetail({
    audience: "manager",
    rows: MANAGER_ROWS,
    areaNames: AREA_NAMES,
    uploads: UPLOADS,
    period: SEPTEMBER_PERIOD,
    filters,
  });
}

const sumValue = (rows: { value: number }[]) => Number(rows.reduce((total, row) => total + row.value, 0).toFixed(2));

// ── the rep's fixture ────────────────────────────────────────────────────────────────────────────
// Four Anti Infective areas under one district manager: his own (Minia 1), a colleague's (Minia 2), a
// vacancy (Assuit 1), and an area with no rep seat at all (Assuit 2), which is the residue.
const SEATS: FieldForceSeatRow[] = [
  {
    seat_id: "SEAT-AI-DM-UE",
    seat_tier: "DM",
    line_code: "anti_infective",
    line_name: "Anti infective",
    region_code: "UE-1",
    region_name: "Upper Egypt 1",
    occupant_hr_id: "D-300",
    is_vacant: false,
  },
  {
    seat_id: "SEAT-AI-REP-UE1",
    seat_tier: "REP",
    line_code: "anti_infective",
    line_name: "Anti infective",
    region_code: "UE-1",
    region_name: "Upper Egypt 1",
    area_code: "UE1",
    area_name: "Minia 1",
    occupant_hr_id: "B-135",
    is_vacant: false,
    parent_seat_id: "SEAT-AI-DM-UE",
  },
  {
    seat_id: "SEAT-AI-REP-UE2",
    seat_tier: "REP",
    line_code: "anti_infective",
    line_name: "Anti infective",
    region_code: "UE-1",
    region_name: "Upper Egypt 1",
    area_code: "UE2",
    area_name: "Minia 2",
    occupant_hr_id: "P-200",
    is_vacant: false,
    parent_seat_id: "SEAT-AI-DM-UE",
  },
  {
    seat_id: "SEAT-AI-REP-UE3",
    seat_tier: "REP",
    line_code: "anti_infective",
    line_name: "Anti infective",
    region_code: "UE-1",
    region_name: "Upper Egypt 1",
    area_code: "UE3",
    area_name: "Assuit 1",
    occupant_hr_id: null,
    is_vacant: true,
    parent_seat_id: "SEAT-AI-DM-UE",
  },
];

const NAMES: Record<string, string> = {
  "b-135": "Mahmoud Fathy",
  "p-200": "Nourhan Adel",
  "d-300": "Karim Selim",
};
const nameOf = (hrId: string | null) => (hrId ? (NAMES[hrId] ?? null) : null);

// The owner's depot-split rule (2026-08-27): "Minia and Assiut" pays half to each governorate, then evenly
// inside each — a quarter to each of Minia 1, Minia 2, Assuit 1 and Assuit 2.
const SPLIT_AREAS = [
  ["UE1", "Minia 1"],
  ["UE2", "Minia 2"],
  ["UE3", "Assuit 1"],
  ["UE4", "Assuit 2"],
  ["UE5", "Sohag1"],
  ["UE6", "Sohag2"],
  ["UE9", "Beni Suef"],
].map(([area_code, area_name]) => ({ area_code, area_name }));
const SPLIT_MAP = SPLIT_AREAS.map((area) => ({
  line_code: "anti_infective",
  area_code: area.area_code,
  operational_region_code: "UE",
  effective_from: "2026-07-13",
  effective_to: null,
}));
const MINYA_ASSIUT = "ك.ع.المنيا واسيوط";

function factRow(overrides: Partial<WeeklyFactExportRow>): WeeklyFactExportRow {
  return {
    distributorCode: "POS",
    distributorName: "POS Purchasing Sales",
    productCode: "P1",
    productName: "Augmentin 1g",
    line: "Anti Infective",
    regionCode: "UE",
    regionName: "Upper Egypt",
    areaCode: null,
    branchCode: "BR-M1",
    branchName: "Minia Branch",
    cycleMonth: SEPTEMBER,
    weekNumber: 1,
    weekStart: "2026-09-06",
    batchId: "pos-w1",
    family: "Augmentin",
    salesValue: 0,
    salesUnits: 0,
    stockUnits: 0,
    ...overrides,
  };
}

const REP_ROWS: WeeklyFactExportRow[] = [
  // Mapped to his area by hand.
  factRow({ areaCode: "UE1", salesValue: 1000, salesUnits: 10 }),
  // "Minia and Assiut": a quarter is his, as an allocation.
  factRow({ branchCode: "UE-KA-01", branchName: MINYA_ASSIUT, salesValue: 4000, salesUnits: 40 }),
  factRow({
    branchCode: "UE-KA-01",
    branchName: MINYA_ASSIUT,
    productCode: "P2",
    productName: "Flagyl 500mg",
    family: "Flagyl",
    salesValue: 800,
    salesUnits: 8,
  }),
  // The same depot, mapped to his area by hand from week 2: that product's cell is part allocated.
  factRow({
    branchCode: "UE-KA-01",
    branchName: MINYA_ASSIUT,
    areaCode: "UE1",
    batchId: "pos-w2",
    weekNumber: 2,
    weekStart: "2026-09-13",
    salesValue: 2000,
    salesUnits: 20,
  }),
  // A colleague's area, a vacancy, a depot no rule places, and his own area on a line he holds no seat on.
  factRow({ areaCode: "UE2", branchCode: "BR-M2", branchName: "Mallawi Branch", salesValue: 98765, salesUnits: 987 }),
  factRow({ areaCode: "UE3", branchCode: "BR-A1", branchName: "Assiut Branch", salesValue: 33333, salesUnits: 333 }),
  factRow({ branchCode: "KA-9", branchName: "Unallocated POS", regionCode: "", regionName: "", salesValue: 43210, salesUnits: 432 }),
  factRow({
    line: "CNS",
    areaCode: "UE1",
    productCode: "C9",
    productName: "Tegretol 200mg",
    family: "Tegretol",
    salesValue: 55555,
    salesUnits: 555,
  }),
];

const REP_LEAKS = [
  "Nourhan Adel",
  "Karim Selim",
  "p-200",
  "P-200",
  "b-135",
  "B-135",
  "Minia 2",
  "UE2",
  "Mallawi Branch",
  "98765",
  "Assuit 1",
  "UE3",
  "Assiut Branch",
  "33333",
  "Assuit 2",
  "UE4",
  "Unallocated POS",
  "43210",
  "Tegretol",
  "55555",
];

// ── workbook helpers ─────────────────────────────────────────────────────────────────────────────
type Workbook = ReturnType<typeof buildWeeklySalesDepotDetailWorkbook>;
type Sheet = NonNullable<ReturnType<Workbook["getWorksheet"]>>;

function sheetOf(workbook: Workbook, name: string): Sheet {
  const sheet = workbook.getWorksheet(name);
  assert.ok(sheet, `the workbook has a "${name}" tab`);
  return sheet;
}

function headers(sheet: Sheet): string[] {
  const labels: string[] = [];
  for (let col = 1; col <= 40; col += 1) {
    const value = sheet.getRow(3).getCell(col).value;
    if (value === null || value === undefined || value === "") break;
    labels.push(String(value));
  }
  return labels;
}

function columnOf(sheet: Sheet, label: string): number {
  const index = headers(sheet).indexOf(label);
  assert.ok(index >= 0, `"${sheet.name}" has a "${label}" column`);
  return index + 1;
}

function formulaOf(sheet: Sheet, row: number, col: number): string | null {
  const value = sheet.getRow(row).getCell(col).value;
  return value !== null && typeof value === "object" && "formula" in value ? String(value.formula) : null;
}

function workbookText(workbook: Workbook): string {
  const parts: string[] = [];
  workbook.eachSheet((sheet) => {
    parts.push(sheet.name);
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        parts.push(typeof cell.value === "object" && cell.value !== null ? JSON.stringify(cell.value) : String(cell.value));
      });
    });
  });
  return parts.join("\n");
}

export async function runWeeklySalesDepotDetailTests() {
  // ── 1. the upload calendar ───────────────────────────────────────────────────────────────────
  assert.deepEqual(
    spansOf([upload("w1", "POS", SEPTEMBER, 1, "2026-09-06"), upload("w3", "POS", SEPTEMBER, 3, "2026-09-20")]),
    { w1: 1, w3: 2 },
    "a sheet after a missed upload covers the missed week too",
  );
  assert.deepEqual(
    spansOf([upload("w3", "POS", SEPTEMBER, 3, "2026-09-20"), upload("w1", "POS", SEPTEMBER, 1, "2026-09-06")]),
    { w1: 1, w3: 2 },
    "uploads are taken in date order, whatever order they are listed in",
  );
  assert.deepEqual(
    spansOf([upload("w3", "POS", OCTOBER, 3, "2026-10-18")]),
    { w3: 3 },
    "a month whose first upload is week 3 covers weeks 1 to 3",
  );
  assert.deepEqual(
    spansOf([upload("e2", "EG", SEPTEMBER, 2, "2026-09-13"), upload("e4", "EG", SEPTEMBER, 4, "2026-09-27")]),
    { e2: 2, e4: 2 },
    "a twice-monthly distributor's sheets cover two weeks each",
  );
  assert.deepEqual(
    spansOf([
      upload("d1", "Direct", SEPTEMBER, 1, "2026-09-06"),
      upload("d3", "Direct", SEPTEMBER, 3, "2026-09-20"),
      upload("d3-again", "Direct", SEPTEMBER, 3, "2026-09-20"),
    ]),
    { d1: 1, d3: 1, "d3-again": 0 },
    "Direct is not cumulative: one week per date, and a second sheet on the same date adds none",
  );
  assert.deepEqual(
    spansOf([upload("u", "POS", null, null, "2026-09-06")]),
    { u: 1 },
    "an upload with no month or week covers one week",
  );
  {
    const calendar = weeklySalesUploadCalendar([
      upload("a", "POS", SEPTEMBER, 1, "2026-09-06"),
      upload("b", "POS", SEPTEMBER, 2, "2026-09-13"),
      upload("b-again", "POS", SEPTEMBER, 2, "2026-09-13"),
      upload("b-fix", "POS", SEPTEMBER, 2, "2026-09-15"),
    ]);
    assert.equal(calendar.spans.get("b-again"), 0, "a sheet uploaded twice on the same date adds no week");
    assert.equal(calendar.spans.get("b-fix"), 0, "a later sheet restating a week already uploaded adds no week");
    assert.equal(calendar.lead.get("b-again"), "b", "a same-date duplicate counts under the first upload of its slot");
    assert.equal(calendar.lead.get("b-fix"), "b", "a restatement counts under the upload that first held the week");
    assert.equal(calendar.lead.get("b"), "b", "the first upload of a slot leads itself");
  }
  {
    const messy = [
      upload("w1", "POS", SEPTEMBER, 1, "2026-09-06"),
      upload("w1-again", "POS", SEPTEMBER, 1, "2026-09-06"),
      upload("w3", "POS", SEPTEMBER, 3, "2026-09-20"),
      upload("w3-fix", "POS", SEPTEMBER, 3, "2026-09-22"),
      upload("w4", "POS", SEPTEMBER, 4, "2026-09-27"),
      upload("aug-w4", "POS", "2026-08-01", 4, "2026-08-23"),
    ];
    const spans = weeklySalesUploadCalendar(messy).spans;
    const september = ["w1", "w1-again", "w3", "w3-fix", "w4"].reduce((total, id) => total + (spans.get(id) ?? 0), 0);
    assert.equal(september, 4, "a month's spans add up to its highest week, however many sheets arrived");
    assert.equal(spans.get("aug-w4"), 4, "another month is its own calendar");
  }

  // ── 2. the managers' view: averages, weeks sold and the duplicate sheet ──────────────────────
  const view = managerView();
  const cell = (branchName: string, productName: string) => {
    const found = view.cells.find((item) => item.branchName === branchName && item.productName === productName);
    assert.ok(found, `fixture: a ${productName} cell at ${branchName}`);
    return found;
  };
  const augmentin = cell("Minia Branch", "Augmentin 1g");
  assert.equal(augmentin.units, 34);
  assert.equal(augmentin.value, 3400);
  assert.equal(augmentin.weeksCovered, 3, "POS covers weeks 1 to 3 of September: week 1, then weeks 2-3 in one sheet");
  assert.equal(augmentin.avgWeeklyValue, 1133.33, "the average divides by the weeks covered, never by the sheets uploaded");
  assert.equal(augmentin.avgWeeklyUnits, 11.33);
  assert.equal(augmentin.weeksSold, 3, "sold in week 1 and in the sheet covering weeks 2-3");
  const flagyl = cell("Minia Branch", "Flagyl 500mg");
  assert.equal(
    flagyl.weeksSold,
    2,
    "a sale in rows carrying the DUPLICATE sheet's id is credited to its slot's weeks, never to a sheet worth no week",
  );
  assert.equal(flagyl.avgWeeklyValue, 200);
  const unasyn = cell("Minia Branch", "Unasyn 375mg");
  assert.equal(unasyn.movement, "returns", "more came back than went out");
  assert.equal(unasyn.weeksSold, 0, "a week of returns is not a week sold");
  assert.equal(cell("Cairo Wholesale", "Augmentin 1g").weeksCovered, 1, "each distributor keeps its own calendar");
  assert.equal(
    view.kpis.weeksCovered,
    3,
    "the period's length is read from the distributors in view — Overseas uploaded four weeks but none of its rows are here",
  );
  for (const item of view.cells) assert.equal(item.basis, "whole", "a manager reads every depot whole");

  // ── 3. every total reconciles, and units never leave a single product ──────────────────────────
  assert.equal(view.kpis.value, 4900);
  assert.equal(sumValue(view.cells), 4900, "the cells add up to the headline");
  assert.equal(sumValue(view.products), 4900, "the products add up to the headline");
  assert.equal(sumValue(view.depots), 4900, "the depots add up to the headline");
  assert.equal(sumValue(view.areas), 4900, "the areas add up to the headline — Area not mapped included");
  assert.equal(sumValue(view.regions), 4900, "the regions add up to the headline");
  assert.equal(sumValue(view.distributors), 4900, "the distributors add up to the headline");
  assert.equal(view.kpis.avgWeeklyValue, 2100, "the average per week is the sum of each cell's own average");
  assert.deepEqual(
    [view.kpis.depotCount, view.kpis.productCount, view.kpis.areaCount, view.kpis.regionCount, view.kpis.distributorCount],
    [3, 3, 1, 2, 2],
  );
  assert.deepEqual([view.kpis.returnsCount, view.kpis.returnsValue], [1, -300]);
  for (const group of [...view.depots, ...view.areas, ...view.regions, ...view.distributors]) {
    assert.equal(
      Object.keys(group).some((key) => /unit/i.test(key)),
      false,
      `"${group.name}" spans several products, so it carries value only — units of different products are never added`,
    );
  }
  assert.equal(
    Object.keys(view.kpis).some((key) => /unit/i.test(key)),
    false,
    "the headline carries no unit total (owner rule)",
  );
  assert.deepEqual(
    view.products.map((product) => [product.productName, product.units, product.value, product.depotCount]),
    [
      ["Augmentin 1g", 46, 4600, 3],
      ["Flagyl 500mg", 6, 600, 1],
      ["Unasyn 375mg", -3, -300, 1],
    ],
    "one product code across depots is the one place a unit total is valid",
  );

  // Totals are added from unrounded figures and rounded once. Three depots each selling a third of a unit for
  // EGP 3.33 make one unit and EGP 10, not 0.99 and 9.99. A rep's allocated quarters and a month of
  // de-cumulated rows are fractions like these, and a total added from rounded parts disagrees with the page
  // this tab sits on (production, 2026-09-16: EGP 8 on every month, 0.01 of a unit on a rep's products).
  const thirdRows = ["T1", "T2", "T3"].map((branchCode) =>
    sourceRow({ branchCode, branchName: `Depot ${branchCode}`, salesUnits: 1 / 3, salesValue: 10 / 3 }),
  );
  const thirds = buildWeeklySalesDepotDetail({
    audience: "manager",
    rows: thirdRows,
    areaNames: AREA_NAMES,
    uploads: UPLOADS,
    period: SEPTEMBER_PERIOD,
  });
  assert.deepEqual(
    thirds.cells.map((cell) => [cell.units, cell.value]),
    [
      [0.33, 3.33],
      [0.33, 3.33],
      [0.33, 3.33],
    ],
    "fixture: each depot shows its own third, rounded",
  );
  assert.deepEqual(
    thirds.products.map((product) => [product.units, product.value]),
    [[1, 10]],
    "a product's units and value are added before rounding: three thirds make one unit, not 0.99",
  );
  assert.equal(thirds.kpis.value, 10, "the headline is added before rounding, so it equals the Weekly Sales headline");
  assert.deepEqual(
    [thirds.areas, thirds.regions, thirds.distributors].map((rows) => rows.map((row) => row.value)),
    [[10], [10], [10]],
    "an area, region or distributor is added before rounding",
  );
  const allocatedThirds = buildWeeklySalesDepotDetail({
    audience: "rep",
    rows: thirdRows.map((row) => ({ ...row, basis: "allocated" as const })),
    areaNames: AREA_NAMES,
    uploads: UPLOADS,
    period: SEPTEMBER_PERIOD,
  });
  assert.deepEqual(
    [allocatedThirds.kpis.value, allocatedThirds.kpis.allocatedValue, allocatedThirds.kpis.mappedValue],
    [10, 10, 0],
    "a rep's allocated total is added before rounding, as his own page adds it",
  );

  // ── 4. a depot with no area is kept, labelled, and filed per region ──────────────────────────
  assert.equal(view.kpis.unmappedValue, 1200, "the two multi-area depots are counted, not dropped");
  assert.deepEqual(
    view.areas.map((area) => [area.name, area.parentName, area.value]),
    [
      ["Assuit 1", "Upper Egypt", 3700],
      [WEEKLY_SALES_DETAIL_UNMAPPED_AREA_LABEL, "Cairo", 700],
      [WEEKLY_SALES_DETAIL_UNMAPPED_AREA_LABEL, "Upper Egypt", 500],
    ],
    "Area not mapped is one line per region, never one place spanning the country",
  );
  assert.deepEqual(
    view.depots.map((depot) => [depot.name, depot.parentName, depot.value]),
    [
      ["Minia Branch", "Upper Egypt · POS Purchasing Sales", 3700],
      ["Cairo Wholesale", "Cairo · Ibn Sina", 700],
      ["UE Key Accounts", "Upper Egypt · POS Purchasing Sales", 500],
    ],
  );
  assert.deepEqual(
    [view.depots[0].productCount, view.depots[0].soldCount, view.depots[0].returnsCount, view.depots[0].returnsValue],
    [3, 2, 1, -300],
  );
  assert.equal(
    managerView({ areaCodes: [WEEKLY_SALES_DETAIL_UNMAPPED_AREA] }).kpis.value,
    1200,
    "the Area filter can pick the unmapped depots",
  );
  {
    // The overseas distributor's "Unallocated POS" names no region. In production it read as a Regions row with
    // no name. It is labelled on every tab and in the book, and keeps an empty code: the page has no region to
    // filter to, so the row is not a drill.
    const noRegion = buildWeeklySalesDepotDetail({
      audience: "manager",
      rows: [
        ...MANAGER_ROWS,
        sourceRow({
          batchId: "ps-w1",
          distributorCode: "PS",
          distributorName: "Overseas",
          regionCode: "",
          regionName: "",
          areaCode: null,
          branchCode: "UNALLOCATED_POS",
          branchName: "Unallocated POS",
          salesUnits: 2,
          salesValue: 80,
        }),
      ],
      areaNames: AREA_NAMES,
      uploads: UPLOADS,
      period: SEPTEMBER_PERIOD,
    });
    assert.deepEqual(
      noRegion.regions.map((region) => [region.name, region.code, region.value]),
      [
        ["Upper Egypt", "UE", 4200],
        ["Cairo", "CA", 700],
        [WEEKLY_SALES_DETAIL_UNMAPPED_REGION_LABEL, "", 80],
      ],
      "a depot whose upload names no region is listed under Region not mapped, never as a row with no name",
    );
    assert.deepEqual(
      noRegion.areas.map((area) => [area.name, area.parentName, area.value]),
      [
        ["Assuit 1", "Upper Egypt", 3700],
        [WEEKLY_SALES_DETAIL_UNMAPPED_AREA_LABEL, "Cairo", 700],
        [WEEKLY_SALES_DETAIL_UNMAPPED_AREA_LABEL, "Upper Egypt", 500],
        [WEEKLY_SALES_DETAIL_UNMAPPED_AREA_LABEL, WEEKLY_SALES_DETAIL_UNMAPPED_REGION_LABEL, 80],
      ],
    );
    assert.equal(
      noRegion.depots.find((depot) => depot.name === "Unallocated POS")?.parentName,
      `${WEEKLY_SALES_DETAIL_UNMAPPED_REGION_LABEL} · Overseas`,
    );
    const book = buildWeeklySalesDepotDetailWorkbook(
      {
        view: noRegion,
        scope: { summary: "All tracked lines · all regions · Super Admin", periodLabel: weeklySalesPeriodLabel(SEPTEMBER_PERIOD) },
        status: "ok",
        allocationUnavailable: false,
      },
      { generatedAtCairo: "16 Sep 2026, 21:30" },
    );
    for (const [name, rowCount] of [
      ["Sales by Branch", noRegion.cells.length],
      ["By Area", noRegion.areas.length],
      ["By Region", noRegion.regions.length],
    ] as const) {
      const sheet = sheetOf(book, name);
      const column = columnOf(sheet, "Region");
      const regions = Array.from({ length: rowCount }, (_, index) => String(sheet.getRow(4 + index).getCell(column).value ?? ""));
      assert.ok(regions.includes(WEEKLY_SALES_DETAIL_UNMAPPED_REGION_LABEL), `"${name}" names the missing region, as the screen does`);
      assert.equal(regions.includes(""), false, `"${name}" has no row without a region`);
    }
  }

  // ── 5. the filter cascade, in Weekly Stock's order ───────────────────────────────────────────
  {
    const ibnSina = managerView({ distributorCodes: ["IS"] });
    assert.deepEqual(ibnSina.cells.map((item) => item.branchName), ["Cairo Wholesale"]);
    assert.deepEqual(
      ibnSina.availableDistributors.map((option) => option.code),
      ["IS", "POS"],
      "picking one distributor never hides the others from the same list",
    );
    assert.deepEqual(
      ibnSina.availableAreas,
      [{ code: WEEKLY_SALES_DETAIL_UNMAPPED_AREA, name: WEEKLY_SALES_DETAIL_UNMAPPED_AREA_LABEL }],
      "the lists below it narrow to what that distributor reaches",
    );
    assert.equal(ibnSina.kpis.weeksCovered, 1);
  }
  {
    const nothing = managerView({ branchKeys: [WEEKLY_SALES_DETAIL_NOTHING] });
    assert.equal(nothing.cells.length, 0, "a filter that resolved to nothing returns nothing, never everything");
    assert.equal(nothing.kpis.value, 0);
    assert.equal(nothing.availableBranches.length, 3, "the depot list still offers every depot to choose again");
    assert.equal(managerView({ movements: [WEEKLY_SALES_DETAIL_NOTHING] }).cells.length, 0);
  }
  {
    const returns = managerView({ movements: ["returns"] });
    assert.deepEqual(returns.cells.map((item) => item.productName), ["Unasyn 375mg"]);
    assert.equal(returns.kpis.value, -300);
    assert.equal(managerView({ movements: ["sold"] }).kpis.value, 5200);
  }
  {
    const weekThree = managerView({ weekNumbers: [3] });
    assert.equal(weekThree.kpis.value, 3000, "the week filter keeps week 3's rows");
    assert.equal(weekThree.kpis.weeksCovered, 2, "and week 3's sheet covers weeks 2-3, so the average stays a true one");
    assert.equal(weekThree.cells.find((item) => item.productName === "Augmentin 1g")?.avgWeeklyValue, 1200);
    assert.equal(managerView({ weekNumbers: [-1] }).cells.length, 0, "a week list holding no real week matches nothing");
  }
  {
    // A depot with no code is keyed by its NAME, and a name can hold a comma.
    const key = salesDepotKey({ distributorCode: "POS", branchCode: "", branchName: "Minia, East" });
    assert.equal(key, "POS|MINIA, EAST");
    const query = new URLSearchParams();
    query.append("depot", key);
    query.append("depot", "IS|CW1");
    const parsed = parseWeeklySalesDetailManagerParams(new URLSearchParams(query.toString()));
    assert.deepEqual(parsed.local.branchKeys, ["POS|MINIA, EAST", "IS|CW1"], "a depot name with a comma survives the URL");
    const commaView = buildWeeklySalesDepotDetail({
      audience: "manager",
      rows: [...MANAGER_ROWS, sourceRow({ branchCode: "", branchName: "Minia, East", salesUnits: 1, salesValue: 90 })],
      areaNames: AREA_NAMES,
      uploads: UPLOADS,
      period: SEPTEMBER_PERIOD,
      filters: { branchKeys: parsed.local.branchKeys },
    });
    assert.equal(commaView.kpis.value, 790, "and still selects exactly that depot");
  }

  // ── 6. the query contracts ───────────────────────────────────────────────────────────────────
  {
    const parsed = parseWeeklySalesDetailManagerParams(
      new URLSearchParams("months=2026-09-01&monthsMode=exclude&weeks=2,x&regions=UE&regionsMode=exclude&areas=__unmapped__&movements=sold"),
    );
    assert.deepEqual(parsed.page.cycleMonths, [SEPTEMBER]);
    assert.equal(parsed.page.cycleMonthMode, "exclude");
    assert.deepEqual(parsed.page.weekNumbers, [2], "a week that is not a number is ignored");
    assert.equal(parsed.page.weekNumberMode, "include");
    assert.deepEqual([parsed.page.regionCodes, parsed.page.regionFilterMode], [["UE"], "exclude"]);
    assert.deepEqual(parsed.local.areaCodes, [WEEKLY_SALES_DETAIL_UNMAPPED_AREA]);
    assert.deepEqual(parsed.local.movements, ["sold"]);
  }
  {
    const parsed = parseRepWeeklyDepotDetailParams(
      new URLSearchParams("month=2026-09-01&weeks=1,3&distributors=POS&depot=POS%7CMINIA%2C%20EAST&products=P1&movements=returns&hrId=P-200"),
    );
    assert.deepEqual(Object.keys(parsed), ["month", "filters"], "a rep's query names no person: his seat comes from his session");
    assert.equal(parsed.month, SEPTEMBER);
    assert.deepEqual(parsed.filters, {
      weekNumbers: [1, 3],
      distributorCodes: ["POS"],
      areaCodes: [],
      branchKeys: ["POS|MINIA, EAST"],
      productCodes: ["P1"],
      movements: ["returns"],
    });
    assert.deepEqual(
      parseRepWeeklyDepotDetailParams(new URLSearchParams(`weeks=${WEEKLY_SALES_DETAIL_NOTHING}`)).filters.weekNumbers,
      [-1],
      "an exclude choice that leaves no week reaches the server as a week nothing matches",
    );
    assert.equal(parseRepWeeklyDepotDetailParams(new URLSearchParams("month=September")).month, null);
  }

  // ── 7. the period in words ───────────────────────────────────────────────────────────────────
  assert.equal(weeklySalesMonthLabel(SEPTEMBER), "September 2026");
  assert.equal(weeklySalesPeriodLabel({}), "All months · all weeks");
  assert.equal(
    weeklySalesPeriodLabel({ cycleMonths: [SEPTEMBER, "2026-08-01"], cycleMonthMode: "include", weekNumbers: [2, 1] }),
    "August 2026, September 2026 · Week 1, Week 2",
  );
  assert.equal(
    weeklySalesPeriodLabel({ cycleMonths: ["2026-08-01"], cycleMonthMode: "exclude", weekNumbers: [4], weekNumberMode: "exclude" }),
    "All months except August 2026 · all weeks except Week 4",
  );
  assert.equal(weeklySalesPeriodLabel(SEPTEMBER_PERIOD, [3]), "September 2026 · Week 3", "a rep's own week filter");
  assert.equal(weeklySalesPeriodLabel(SEPTEMBER_PERIOD, [-1]), "September 2026 · no weeks");

  // ── 8. a rep's labels: how each figure reached him ───────────────────────────────────────────
  const twoAreaRep = buildWeeklySalesDepotDetail({
    audience: "rep",
    rows: [
      sourceRow({ areaCode: "UE1", areaName: "Minia 1", regionName: "Upper Egypt 1", basis: "mapped", salesUnits: 10, salesValue: 1000 }),
      sourceRow({
        areaCode: "UE5",
        areaName: "Sohag1",
        regionName: "Upper Egypt 2",
        branchCode: "BR-S1",
        branchName: "Sohag Branch",
        basis: "allocated",
        salesUnits: 3,
        salesValue: 300,
      }),
    ],
    areaNames: new Map(),
    uploads: [],
  });
  assert.deepEqual(
    twoAreaRep.cells.map((item) => [item.areaName, item.basis, item.allocatedValue]),
    [
      ["Minia 1", "mapped", 0],
      ["Sohag1", "allocated", 300],
    ],
  );
  assert.equal(twoAreaRep.regions.length, 0, "a rep sees no region total, not even one that would only restate his own");
  assert.equal(twoAreaRep.depots[0].parentName, "POS Purchasing Sales", "a rep's depot sits under its distributor alone");

  // ── 9. a rep's detail is his own share, and it is the figure on his own page ──────────────────
  const index = selectFieldForceSeats(SEATS, nameOf);
  const viewerKeys = sharedIdentityKeys(resolveEmployeeIdentityId({ hrId: "B-135", loginId: null }));
  const ownSeats = selectOwnRepSeats(index.seats, viewerKeys, new Set(["Anti Infective"]));
  assert.deepEqual(ownSeats.map((seat) => seat.areaName), ["Minia 1"], "fixture: the viewer holds Minia 1 only");
  const splitIndex = buildWeeklyAreaSplitIndex(SPLIT_MAP, SPLIT_AREAS, "2026-09-16");

  const parts = selectOwnRepDepotParts({ rows: REP_ROWS, areaSplit: splitIndex, seatIndex: index, ownSeats });
  assert.deepEqual(
    parts.map((part) => [part.branchName, part.productName, part.weekNumber, part.salesValue, part.salesUnits, part.basis]),
    [
      ["Minia Branch", "Augmentin 1g", 1, 1000, 10, "mapped"],
      [MINYA_ASSIUT, "Augmentin 1g", 1, 1000, 10, "allocated"],
      [MINYA_ASSIUT, "Flagyl 500mg", 1, 200, 2, "allocated"],
      [MINYA_ASSIUT, "Augmentin 1g", 2, 2000, 20, "mapped"],
    ],
    "his parts are exactly his hand-mapped depots whole, plus his quarter of Minia and Assiut, labelled as an allocation",
  );
  for (const part of parts) {
    assert.deepEqual(
      [part.areaCode, part.areaName, part.regionCode, part.regionName],
      ["UE1", "Minia 1", "UE-1", "Upper Egypt 1"],
      "every part is labelled from HIS seat, never from the depot row's region",
    );
  }

  const repView = buildWeeklySalesDepotDetail({ audience: "rep", rows: parts, areaNames: new Map(), uploads: [] });
  // Keyed, not ordered: the screen sorts depot names with localeCompare, and an Arabic name's place among
  // Latin ones is the collation's business, not this test's.
  assert.deepEqual(
    new Map(repView.cells.map((item) => [`${item.branchName} / ${item.productName}`, [item.value, item.basis, item.allocatedValue]])),
    new Map([
      [`${MINYA_ASSIUT} / Augmentin 1g`, [3000, "mixed", 1000]],
      [`${MINYA_ASSIUT} / Flagyl 500mg`, [200, "allocated", 200]],
      ["Minia Branch / Augmentin 1g", [1000, "mapped", 0]],
    ]),
    "a depot whose mapping changed inside the month is labelled part allocated, with the allocated part stated",
  );
  assert.deepEqual([repView.kpis.value, repView.kpis.mappedValue, repView.kpis.allocatedValue], [4200, 3000, 1200]);
  assert.equal(repView.regions.length, 0);

  const mine = selectRepWeeklySales({
    fieldForce: buildPortalWeeklyFieldForce({ rows: REP_ROWS, areaSplit: splitIndex, seatIndex: index }),
    ownSeats,
    month: { code: SEPTEMBER, name: "September 2026" },
    months: [{ code: SEPTEMBER, name: "September 2026" }],
  });
  assert.equal(repView.kpis.value, mine.totals.value, "his Depot detail adds up to the total on his own Weekly Sales page");
  assert.equal(repView.kpis.allocatedValue, mine.totals.allocatedValue, "and allocates exactly what his page says was allocated");
  assert.equal(repView.kpis.mappedValue, mine.totals.exactValue);

  const repPayload: WeeklySalesDepotDetailPayload = {
    view: repView,
    scope: { summary: repDepotDetailScopeSummary(ownSeats), periodLabel: weeklySalesPeriodLabel(SEPTEMBER_PERIOD) },
    status: "ok",
    allocationUnavailable: true,
  };
  assert.equal(repPayload.scope.summary, "Minia 1 · Anti Infective · Medical Rep", "his scope line names his area and line only");
  const repJson = JSON.stringify({ parts, repPayload });
  for (const leak of REP_LEAKS) {
    assert.equal(
      repJson.includes(leak),
      false,
      `a rep's detail never carries "${leak}" — no colleague, manager, vacancy, residue, other line or HR id`,
    );
  }

  // ── 9b. a district manager reads his own areas' share, and adds up to his Field Force tab ───────
  // The depot rows say "Upper Egypt", never Upper Egypt 1, so the Upper Egypt 1 district manager's region
  // bound never fetched Minia and Assiut — although the owner's split gives three of its four quarters to
  // his areas, and his Field Force tab counts them. The owner ruled on 2026-09-17 that every figure on his
  // screens follows his own areas, and that a depot serving several areas reaches him as his share only.
  const DM_SCOPE = {
    tier: "territory" as const,
    allowedLineNames: new Set(["Anti Infective"]),
    allowedRegionCodes: new Set(["UE-1"]),
    allowedAreaCodes: new Set(["UE1", "UE2", "UE3"]),
    canViewHeadOffice: false,
  };
  const dmKeys = weeklyScopeOwnAreaKeys(DM_SCOPE);
  assert.equal(mayLiftWeeklyGeography(DM_SCOPE, dmKeys), true, "fixture: the Upper Egypt 1 manager follows his own areas");
  const DM_ROWS = [
    ...REP_ROWS.filter((row) => row.line === "Anti Infective"),
    // THE CASE THE OWNER RULED ON: a depot filed under HIS region, whose split gives a quarter to Assuit 2.
    factRow({
      branchCode: "UE-KA-01",
      branchName: MINYA_ASSIUT,
      regionCode: "UE-1",
      regionName: "Upper Egypt 1",
      productCode: "P3",
      productName: "Zinnat 250mg",
      family: "Zinnat",
      salesValue: 400,
      salesUnits: 4,
    }),
  ];
  // The weekly loader holds these as its own rows, narrows them, and hands the Depot Detail the row grain.
  type DmLoadRow = WeeklyFactExportRow & { officialLine: string; netQty: number; salesQty: number; stockQty: number };
  const toLoadRow = (row: WeeklyFactExportRow): DmLoadRow => ({
    ...row,
    officialLine: row.line,
    netQty: row.salesUnits,
    salesQty: row.salesUnits,
    stockQty: row.stockUnits,
  });
  const toGrainRow = (row: DmLoadRow): WeeklyFactExportRow => ({
    ...row,
    line: row.officialLine,
    salesUnits: row.netQty,
    stockUnits: row.stockQty,
  });
  const dmGrain = narrowWeeklyRowsToOwnAreaShare(DM_ROWS.map(toLoadRow), DM_SCOPE, {
    ownAreaKeys: dmKeys,
    areaSplit: splitIndex,
    seatIndex: index,
  }).map(toGrainRow);
  const dmRows = managerDepotRows(dmGrain);
  const rowTuple = (row: WeeklySalesDetailSourceRow) =>
    [row.branchName, row.productName, row.areaCode, row.weekNumber, row.salesValue, row.basis].join(" / ");
  assert.deepEqual(
    dmRows.map(rowTuple).sort(),
    [
      ["Minia Branch", "Augmentin 1g", "UE1", 1, 1000, "whole"],
      [MINYA_ASSIUT, "Augmentin 1g", "UE1", 2, 2000, "whole"],
      ["Mallawi Branch", "Augmentin 1g", "UE2", 1, 98765, "whole"],
      ["Assiut Branch", "Augmentin 1g", "UE3", 1, 33333, "whole"],
      [MINYA_ASSIUT, "Augmentin 1g", "UE1", 1, 1000, "allocated"],
      [MINYA_ASSIUT, "Augmentin 1g", "UE2", 1, 1000, "allocated"],
      [MINYA_ASSIUT, "Augmentin 1g", "UE3", 1, 1000, "allocated"],
      [MINYA_ASSIUT, "Flagyl 500mg", "UE1", 1, 200, "allocated"],
      [MINYA_ASSIUT, "Flagyl 500mg", "UE2", 1, 200, "allocated"],
      [MINYA_ASSIUT, "Flagyl 500mg", "UE3", 1, 200, "allocated"],
      [MINYA_ASSIUT, "Zinnat 250mg", "UE1", 1, 100, "allocated"],
      [MINYA_ASSIUT, "Zinnat 250mg", "UE2", 1, 100, "allocated"],
      [MINYA_ASSIUT, "Zinnat 250mg", "UE3", 1, 100, "allocated"],
    ]
      .map((tuple) => tuple.join(" / "))
      .sort(),
    "depots mapped to his areas stay whole; Minia and Assiut reaches him only as the quarters in his own areas — never Assuit 2's, not even from a depot filed under his own region, and never a depot no rule places",
  );
  for (const row of dmRows) {
    assert.deepEqual(
      [row.regionCode, row.regionName],
      ["UE-1", "Upper Egypt 1"],
      "every row is filed under the organogram's region for its area, which is what the page's Region filter reads",
    );
  }
  assert.deepEqual(
    managerDepotRows(DM_ROWS).map((row) => row.basis),
    DM_ROWS.map(() => "whole"),
    "a manager whose load does not follow his areas reads every row whole, exactly as before",
  );
  assert.equal(
    managerDepotRows(DM_ROWS)[0].salesValue,
    DM_ROWS[0].salesValue,
    "and reads each row's own figures",
  );

  const dmView = buildWeeklySalesDepotDetail({
    audience: "manager",
    rows: dmRows,
    areaNames: new Map([
      ["UE1", "Minia 1"],
      ["UE2", "Minia 2"],
      ["UE3", "Assuit 1"],
    ]),
    uploads: [],
  });
  assert.deepEqual(
    new Map(
      dmView.cells.map((item) => [`${item.branchName} / ${item.productName} / ${item.areaName}`, [item.value, item.basis, item.allocatedValue]]),
    ),
    new Map([
      ["Minia Branch / Augmentin 1g / Minia 1", [1000, "whole", 0]],
      [`${MINYA_ASSIUT} / Augmentin 1g / Minia 1`, [3000, "mixed", 1000]],
      [`${MINYA_ASSIUT} / Augmentin 1g / Minia 2`, [1000, "allocated", 1000]],
      [`${MINYA_ASSIUT} / Augmentin 1g / Assuit 1`, [1000, "allocated", 1000]],
      [`${MINYA_ASSIUT} / Flagyl 500mg / Minia 1`, [200, "allocated", 200]],
      [`${MINYA_ASSIUT} / Flagyl 500mg / Minia 2`, [200, "allocated", 200]],
      [`${MINYA_ASSIUT} / Flagyl 500mg / Assuit 1`, [200, "allocated", 200]],
      [`${MINYA_ASSIUT} / Zinnat 250mg / Minia 1`, [100, "allocated", 100]],
      [`${MINYA_ASSIUT} / Zinnat 250mg / Minia 2`, [100, "allocated", 100]],
      [`${MINYA_ASSIUT} / Zinnat 250mg / Assuit 1`, [100, "allocated", 100]],
      ["Mallawi Branch / Augmentin 1g / Minia 2", [98765, "whole", 0]],
      ["Assiut Branch / Augmentin 1g / Assuit 1", [33333, "whole", 0]],
    ]),
    "a manager's share is labelled an allocation, and a cell that also holds the depot's whole sale reads part allocated",
  );
  assert.deepEqual(
    [dmView.kpis.value, dmView.kpis.allocatedValue, dmView.kpis.mappedValue],
    [138998, 3900, 0],
    "his total is the depots mapped to his areas plus the shares in his own areas, and nothing of a manager's is 'mapped by hand'",
  );
  const dmFieldForce = buildPortalWeeklyFieldForce({ rows: dmGrain, areaSplit: splitIndex, seatIndex: index });
  assert.equal(dmView.kpis.value, dmFieldForce.totals.value, "his Depot Detail adds up to his Field Force tab");
  assert.equal(
    dmView.kpis.value,
    dmGrain.reduce((sum, row) => sum + row.salesValue, 0),
    "and to the Sales Value his Weekly Sales screen builds from the same rows",
  );
  assert.deepEqual(
    [dmFieldForce.totals.exactValue, dmFieldForce.totals.allocatedValue],
    [dmView.kpis.value - dmView.kpis.allocatedValue, dmView.kpis.allocatedValue],
    "the tab calls allocated exactly what the Depot Detail calls allocated",
  );
  assert.equal(weeklySalesDetailShowsBasis(dmView), true, "his screen and book say how each figure reached him");
  assert.equal(weeklySalesDetailShowsBasis(view), false, "a manager with no share in view keeps the whole-depot screen");

  const dmPayload: WeeklySalesDepotDetailPayload = {
    view: dmView,
    scope: { summary: "Anti Infective · Upper Egypt 1 · District Manager", periodLabel: weeklySalesPeriodLabel(SEPTEMBER_PERIOD) },
    status: "ok",
    allocationUnavailable: false,
  };
  {
    const dmBook = buildWeeklySalesDepotDetailWorkbook(dmPayload, { generatedAtCairo: "17 Sep 2026, 10:00" });
    const sheet = sheetOf(dmBook, "Sales by Branch");
    const labels = headers(sheet);
    assert.ok(
      labels.includes("Region") && labels.includes("How It Reached You") && labels.includes("Of Which Allocated (EGP)"),
      "a district manager's book states what was allocated, as his screen labels it",
    );
    assert.notEqual(
      formulaOf(sheet, 4 + dmView.cells.length, columnOf(sheet, "Of Which Allocated (EGP)")),
      null,
      "and totals the allocated part",
    );
    const bookText = workbookText(dmBook);
    assert.ok(bookText.includes("Allocated share") && bookText.includes("Part allocated") && bookText.includes("Whole branch"));
    const notes = weeklySalesDepotDetailNotes(dmPayload, "17 Sep 2026, 10:00");
    assert.deepEqual(
      notes.map((note) => note.topic).filter((topic) => ["How it reached you", "Area not mapped", "Allocation missing"].includes(topic)),
      ["How it reached you", "Area not mapped"],
      "his notes explain the allocation and keep the managers' Area not mapped note",
    );
    const basisRule = notes.find((note) => note.topic === "How it reached you")?.rule ?? "";
    assert.match(basisRule, /your own areas/, "in a manager's words");
    assert.match(basisRule, /parts in other managers' areas are not counted/, "and told that other managers' parts leave");
    assert.doesNotMatch(basisRule, /Mapped by hand/, "never a rep's");
    const missing = weeklySalesDepotDetailNotes({ ...dmPayload, allocationUnavailable: true }, "17 Sep 2026, 10:00").find(
      (note) => note.topic === "Allocation missing",
    );
    assert.ok(missing, "a district manager is warned when the depot map did not load");
    assert.match(missing.rule, /filed under your own region counts whole/, "and told what he reads instead");
    assert.doesNotMatch(missing.rule, /mapped to your area by hand/, "in a manager's words, not a rep's");
  }

  // ── 10. the workbook is the screen ───────────────────────────────────────────────────────────
  const managerPayload: WeeklySalesDepotDetailPayload = {
    view,
    scope: { summary: "All tracked lines · all regions · Super Admin", periodLabel: weeklySalesPeriodLabel(SEPTEMBER_PERIOD) },
    status: "ok",
    allocationUnavailable: false,
  };
  const generatedAtCairo = "16 Sep 2026, 21:30";
  const managerBook = buildWeeklySalesDepotDetailWorkbook(managerPayload, { generatedAtCairo });
  assert.deepEqual(
    managerBook.worksheets.map((sheet) => sheet.name),
    ["Sales by Branch", "By Product", "By Branch", "By Area", "By Region", "By Distributor", "Notes"],
    "the managers' book mirrors the screen's tabs",
  );
  {
    const sheet = sheetOf(managerBook, "Sales by Branch");
    const labels = headers(sheet);
    assert.ok(labels.includes("Region"), "a manager's grain row names its region");
    assert.equal(labels.includes("How It Reached You"), false, "a manager's rows are whole depots, so there is no basis column");
    const totalRow = 4 + view.cells.length;
    assert.equal(sheet.getRow(totalRow).getCell(1).value, "TOTAL");
    const valueCol = columnOf(sheet, "Sales Value (EGP)");
    assert.match(String(formulaOf(sheet, totalRow, valueCol)), /^SUM\([A-Z]+4:[A-Z]+8\)$/, "value is summed live");
    for (const label of ["Net Units", "Avg Weekly Units", "Weeks Sold", "Weeks Covered"]) {
      const col = columnOf(sheet, label);
      assert.equal(formulaOf(sheet, totalRow, col), null, `"${label}" is never summed: units of different products are never added`);
      assert.deepEqual(
        sheet.getRow(3).getCell(col).alignment,
        { vertical: "middle", horizontal: "right", wrapText: true },
        `the "${label}" header sits right, over its numbers`,
      );
      assert.equal(sheet.getRow(4).getCell(col).alignment?.horizontal, "right");
    }
    let totalRows = 0;
    sheet.eachRow((row) => {
      const first = String(row.getCell(1).value ?? "");
      if (/total/i.test(first)) totalRows += 1;
    });
    assert.equal(totalRows, 1, "one TOTAL row only — a hand-written total on top of it would count the money twice");
    assert.equal(sheet.getRow(4).getCell(columnOf(sheet, "Share of Value")).numFmt, "0.0%");
  }
  {
    const sheet = sheetOf(managerBook, "By Product");
    const totalRow = 4 + view.products.length;
    for (const label of ["Net Units", "Avg Weekly Units", "Branches"]) {
      assert.equal(formulaOf(sheet, totalRow, columnOf(sheet, label)), null, `By Product never sums "${label}"`);
    }
    assert.notEqual(formulaOf(sheet, totalRow, columnOf(sheet, "Sales Value (EGP)")), null);
  }
  for (const name of ["By Branch", "By Area", "By Region", "By Distributor"]) {
    const labels = headers(sheetOf(managerBook, name));
    assert.equal(
      labels.some((label) => /unit/i.test(label)),
      false,
      `"${name}" spans several products, so it has no unit column`,
    );
  }
  assert.deepEqual(
    weeklySalesDepotDetailNotes(managerPayload, generatedAtCairo).map((note) => note.topic),
    ["Scope", "Period", "Generated", "Sales", "Value", "Units", "Average per week", "Weeks sold", "Movement", "Area not mapped", "Unmapped products", "Lines", "Official figure"],
  );

  const repBook = buildWeeklySalesDepotDetailWorkbook(repPayload, { generatedAtCairo });
  assert.deepEqual(
    repBook.worksheets.map((sheet) => sheet.name),
    ["Sales by Branch", "By Product", "By Branch", "By Distributor", "Notes"],
    "a rep's book is his screen: no region tab, and no area tab while he holds one area",
  );
  {
    const labels = headers(sheetOf(repBook, "Sales by Branch"));
    assert.equal(labels.includes("Region"), false);
    assert.ok(labels.includes("How It Reached You") && labels.includes("Of Which Allocated (EGP)"), "his book states what was allocated");
  }
  const repBookText = workbookText(repBook);
  for (const leak of REP_LEAKS) {
    assert.equal(repBookText.includes(leak), false, `a rep's workbook never carries "${leak}"`);
  }
  assert.ok(repBookText.includes("Allocated share") && repBookText.includes("Part allocated"));
  assert.deepEqual(
    weeklySalesDepotDetailNotes(repPayload, generatedAtCairo)
      .map((note) => note.topic)
      .filter((topic) => ["How it reached you", "Allocation missing", "Area not mapped"].includes(topic)),
    ["How it reached you", "Allocation missing"],
    "a rep's notes explain allocation, and warn when the depot map did not load",
  );
  assert.deepEqual(
    buildWeeklySalesDepotDetailWorkbook(
      { view: twoAreaRep, scope: repPayload.scope, status: "ok", allocationUnavailable: false },
      { generatedAtCairo },
    ).worksheets.map((sheet) => sheet.name),
    ["Sales by Branch", "By Product", "By Branch", "By Area", "By Distributor", "Notes"],
    "a rep who holds two areas gets the area tab his screen shows him",
  );
  for (const book of [managerBook, repBook]) {
    const buffer = await book.xlsx.writeBuffer();
    assert.ok(buffer.byteLength > 1000, "the workbook serialises");
  }
  assert.equal(buildWeeklySalesDepotDetailFilename("manager", [SEPTEMBER]), "phoenix-weekly-sales-branch-detail-2026-09.xlsx");
  assert.equal(buildWeeklySalesDepotDetailFilename("rep", [SEPTEMBER]), "phoenix-weekly-sales-my-branches-2026-09.xlsx");
  assert.equal(buildWeeklySalesDepotDetailFilename("manager", []), "phoenix-weekly-sales-branch-detail-all-months.xlsx");

  // ── 11. the server gates ─────────────────────────────────────────────────────────────────────
  const managerRoutes = [
    "../app/api/employee-portals/weekly-sales/depot-detail/route.ts",
    "../app/api/employee-portals/weekly-sales/depot-detail/export/route.ts",
  ];
  const repRoutes = [
    "../app/api/employee-portals/weekly-sales/rep-depot-detail/route.ts",
    "../app/api/employee-portals/weekly-sales/rep-depot-detail/export/route.ts",
  ];
  for (const route of [...managerRoutes, ...repRoutes]) {
    const source = readSource(route);
    assert.match(source, /assertPermission\(access, "sales", "read"\)/, `${route} checks sales on the server`);
  }
  for (const route of managerRoutes) {
    const source = readSource(route);
    assert.match(
      source,
      /if \(!mayReadManagersWeeklySales\(access\.role\)\) \{\s+return NextResponse\.json\(\{ success: false, error: "Forbidden\." \}, \{ status: 403 \}\);/,
      `${route} keeps the managers' Weekly Sales gate, so a Medical Rep is refused`,
    );
    assert.match(source, /loadWeeklySalesDepotDetail\(/, `${route} reads through the scoped managers' loader`);
  }
  for (const route of repRoutes) {
    const source = readSource(route);
    assert.match(
      source,
      /if \(!isPortalWeeklyRepRole\(access\.role\)\) \{\s+return NextResponse\.json\(\{ success: false, error: "Forbidden\." \}, \{ status: 403 \}\);/,
      `${route} admits a Medical Rep only`,
    );
    assert.doesNotMatch(source, /isPortalWeeklyRole\(|loadWeeklySalesDepotDetail/, `${route} never reaches the managers' data`);
    assert.match(source, /getPortalWeeklyRepDepotDetail\(\s*access,/, `${route} resolves his seat from the session`);
  }
  for (const route of [managerRoutes[1], repRoutes[1]]) {
    const source = readSource(route);
    assert.match(source, /assertExportRateLimit\(/, `${route} is rate limited like every other export`);
    assert.match(source, /respondWithWeeklySalesDepotDetailWorkbook\(payload,/, `${route} builds the book from the feed's own payload`);
  }
  const managerService = readSource("../src/lib/sales/weekly/depot-detail-service.ts");
  assert.match(managerService, /resolvePortalWeeklyScope\(ctx\)/, "the managers' scope resolves from the session");
  assert.match(managerService, /accessScope: scope\.accessScope,/, "and is handed to the weekly engine, which enforces it");
  assert.match(managerService, /excludeUnmapped: true/, "unmapped products never reach a managers' total");
  assert.match(
    managerService,
    /factRowsFullPrecision: true/,
    "the managers' detail reads unrounded rows, so its headline equals the Weekly Sales headline beside it",
  );
  assert.match(
    managerService,
    /const ownAreaKeys = weeklyScopeOwnAreaKeys\(scope\.accessScope\);\s+const followsOwnAreas = mayLiftWeeklyGeography\(scope\.accessScope, ownAreaKeys\);/,
    "a district or regional manager's own areas come from his own scope, and only such a manager follows them",
  );
  assert.match(
    managerService,
    /excludeUnmapped: true,\s+ownAreaShare,\s+\}\)/,
    "his load reads his own areas' share, exactly as his Weekly Sales screen and Field Force tab do",
  );
  assert.doesNotMatch(managerService, /liftRowGrainGeography/, "never a lifted grain narrowed a second way");
  assert.match(
    managerService,
    /rows: managerDepotRows\(data\.factRows \?\? \[\]\),/,
    "the rows are built into figures exactly as the load returned them",
  );
  assert.match(
    managerService,
    /allocationUnavailable:\s+followsOwnAreas &&/,
    "and only a manager who follows his areas is warned when the depot map did not load",
  );
  const weeklyEngine = readSource("../src/lib/sales/weekly/service.ts");
  assert.match(
    weeklyEngine,
    /salesValue: filters\?\.factRowsFullPrecision \? row\.salesValue : Number\(row\.salesValue\.toFixed\(2\)\),\s+salesUnits: filters\?\.factRowsFullPrecision \? row\.netQty : Number\(row\.netQty\.toFixed\(2\)\),/,
    "the weekly engine hands unrounded rows to the caller that asks, and the BI workbook's rounded rows to every other",
  );
  const repService = readSource("../src/lib/sales/weekly/portal-weekly-rep-depot-detail.ts");
  assert.match(repService, /accessScope: repWeeklyLoadScope\(scope\),/, "a rep's load lifts geography but keeps his line");
  assert.match(repService, /excludeUnmapped: true/, "unmapped products never reach a rep's total");
  assert.doesNotMatch(
    repService,
    /factRowsFullPrecision/,
    "a rep's detail reads the same rounded rows as his own Weekly Sales page, so the two cannot disagree",
  );
  assert.match(repService, /selectOwnRepSeats\(seatIndex\.seats, viewerKeys, allowedLineNames\)/, "his seats are matched to his own identity");

  for (const [pattern, isExport] of [
    ["/api/employee-portals/weekly-sales/depot-detail", false],
    ["/api/employee-portals/weekly-sales/depot-detail/export", true],
    ["/api/employee-portals/weekly-sales/rep-depot-detail", false],
    ["/api/employee-portals/weekly-sales/rep-depot-detail/export", true],
  ] as const) {
    const entry = accessRegistry.find((item) => item.pattern === pattern);
    assert.ok(entry, `${pattern} is declared in the access registry`);
    assert.deepEqual(entry.permission, { resource: "sales", action: "read" });
    assert.deepEqual([...entry.methods], ["GET"]);
    assert.deepEqual(
      entry.audit,
      isExport ? { classification: "export", required: true } : { required: false },
      `${pattern} ${isExport ? "is audited as an export" : "is a read"}`,
    );
  }

  // ── 12. the screen fits, and wears square corners ───────────────────────────────────────────
  const detail = readSource("../src/components/sales/weekly/weekly-sales-depot-detail.tsx");
  assert.doesNotMatch(detail, /rounded/, "square corners everywhere (owner golden rule)");
  assert.doesNotMatch(detail, /overflow-x-auto|min-w-\[/, "never a horizontal scroll (owner golden rule)");
  assert.doesNotMatch(detail, /\btruncate\b/, "long names wrap, never an ellipsis");
  assert.equal((detail.match(/<table className="w-full table-fixed/g) ?? []).length, 3, "every table is fixed-layout");
  assert.equal((detail.match(/<colgroup>/g) ?? []).length, 3, "and sized by its colgroup");
  // At 1024 px the portal leaves a desktop table about 620 px, where a Movement or a Weeks column clipped its
  // own header and let the badge stick out. The tables fit by merging columns instead.
  const desktopTables = detail
    .split('<table className="w-full table-fixed')
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf("</table>")));
  for (const table of desktopTables) {
    const widths = [...table.matchAll(/<col className="w-\[(\d+)%\]" \/>/g)].map((match) => Number(match[1]));
    assert.equal(widths.length, (table.match(/<th className=/g) ?? []).length, "every column header has its own col");
    assert.equal(widths.reduce((sum, width) => sum + width, 0), 100, "every colgroup adds up to the table's width");
    assert.doesNotMatch(table, />(?:Movement|Weeks)<\/th>/, "the movement badge sits under the name and the weeks under the average");
  }
  assert.match(detail, /<div className="hidden md:block">/, "desktop and tablet (from md) read full tables");
  assert.match(detail, /<div className="space-y-2 p-3 md:hidden">/, "a phone reads cards");
  assert.match(detail, /const exportHref = `\$\{exportPath\}\$\{query \? `\?\$\{query\}` : ""\}`;/, "Export sends the screen's own query");
  assert.equal(
    (detail.match(/<DrillName name=\{row\.name\} onClick=\{onDrill && row\.code \? /g) ?? []).length,
    2,
    "a group row with no code of its own (Region not mapped) is not a drill, on desktop or on a phone",
  );
  assert.equal(
    (detail.match(/\{isRep \|\| cell\.basis !== "whole" \? <BasisNote basis=\{cell\.basis\} \/> : null\}/g) ?? []).length,
    2,
    "a manager's allocated share is labelled on desktop and on a phone, as a rep's is",
  );

  const managers = readSource("../src/components/sales/weekly/portal-weekly-dashboard-impl.tsx");
  assert.match(
    managers,
    /<WeeklySalesDepotDetail\s+audience="manager"\s+feedPath="\/api\/employee-portals\/weekly-sales\/depot-detail"\s+exportPath="\/api\/employee-portals\/weekly-sales\/depot-detail\/export"/,
    "the managers' Weekly Sales page mounts the managers' detail",
  );
  const repScreen = readSource("../src/components/sales/weekly/portal-weekly-rep-view.tsx");
  assert.match(
    repScreen,
    /<WeeklySalesDepotDetail\s+audience="rep"\s+feedPath="\/api\/employee-portals\/weekly-sales\/rep-depot-detail"\s+exportPath="\/api\/employee-portals\/weekly-sales\/rep-depot-detail\/export"/,
    "a rep's Weekly Sales page mounts his own detail, never the managers' feed",
  );
  assert.doesNotMatch(repScreen, /rounded/, "the rep's screen, tab bar included, has square corners");
}
