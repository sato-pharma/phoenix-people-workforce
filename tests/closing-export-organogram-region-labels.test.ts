import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import {
  type AssembleComparisonInput,
  assembleComparison,
  comparisonLeavesFromRows,
  type ComparisonRegionOfArea,
  organogramRegionOfArea,
  relabelComparisonRegions,
  scopeComparisonInput,
} from "../src/lib/sales/monthly-closing-comparison.ts";
import {
  buildFilterOptions,
  type ClosingDetailRow,
  type ClosingDetailsResult,
  summarize,
} from "../src/lib/sales/monthly-closing-details.ts";
import {
  buildMonthlyClosingWorkbook,
  fileDirectCellsUnderMatrixRegions,
} from "../src/lib/sales/monthly-closing-export.ts";
import {
  injectDirectIntoMatrix,
  type MonthlyClosingCell,
  type MonthlyClosingDirectCell,
  type MonthlyClosingMatrix,
} from "../src/lib/sales/monthly-distributor-import.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The black "Export XLSX" names the Closing Matrix's region on EVERY sheet (owner, 2026-09-16).
//
// The Closing Matrix groups an area under its ORGANOGRAM region: the district manager territory
// that owns it on this line in this month. Every other sheet of the black export named the MAP
// region the closing RPCs stamp on each row instead. On Anti Infective those differ for all of Upper
// Egypt: the matrix shows Upper Egypt 1 and Upper Egypt 2, while Distributor Comparison, Rankings &
// Mix, Gaps & White-Space, Summary, the hidden Calc sheet, Data and Total said "Upper Egypt", a region
// that matrix does not have. Measured on production the same day: 13 to 14 Anti Infective areas, 6 to
// 9 CNS areas and 4 Pedia areas per month were named differently from the matrix.
//
// One real number went missing too. A direct order that names its own area is folded into that
// area's matrix row, but its cell still carried the MAP region, and both channel tabs keep only the
// regions the matrix holds. Anti Infective, August 2026: Minia 2's 20,370.00 was tagged Upper Egypt,
// so the Direct Sales tab showed 31,254.10 of the 51,624.10 the matrix counts.
//
// Labels only. No figure on any sheet may move, except the Direct tab coming up to the matrix.
// ─────────────────────────────────────────────────────────────────────────────

const LINE = "Anti Infective";
const AUGUST = "2026-08";
const JULY = "2026-07";
const PRODUCT = { family: "Quinolones", productCode: "RO001", productName: "Royafloxacin" };

const UPPER_EGYPT_1 = { regionCode: "UE-1", regionName: "Upper Egypt 1" };
const UPPER_EGYPT_2 = { regionCode: "UE-2", regionName: "Upper Egypt 2" };
const CAIRO = { regionCode: "CA", regionName: "Cairo" };

// Anti Infective's organogram as the matrix reads it: Minia 1 and 2 under Upper Egypt 1; Assiut 1
// and Qena 2 under Upper Egypt 2 (Assiut is Upper Egypt 2 on this line); Cairo East 2 unchanged.
// Main Store sits in no line's organogram.
const ORGANOGRAM = new Map([
  ["UE1", UPPER_EGYPT_1],
  ["UE2", UPPER_EGYPT_1],
  ["UE3", UPPER_EGYPT_2],
  ["UE8", UPPER_EGYPT_2],
  ["CA4", CAIRO],
]);
const regionOfArea: ComparisonRegionOfArea = (areaCode) => ORGANOGRAM.get(areaCode.trim().toUpperCase());

/** Upper Egypt with no number after it: the map region the matrix does not have. */
const MAP_UPPER_EGYPT = /Upper Egypt(?! [12])/;

/** Every string anywhere inside a value, for "is this label printed anywhere" checks. */
function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => stringsIn(entry, out));
  else if (value && typeof value === "object") Object.values(value).forEach((entry) => stringsIn(entry, out));
  return out;
}

/** Leaves and masters exactly as the closing RPCs return them: all of Upper Egypt on the MAP region. */
function geographicInput(period = AUGUST): AssembleComparisonInput {
  const leaf = (areaCode: string, regionCode: string, value: number) => ({
    areaCode, distributorCode: "UCP", productCode: PRODUCT.productCode, productName: PRODUCT.productName,
    regionCode, units: value / 100, value,
  });
  const distProductRows = [
    leaf("UE1", "UE", 3_000),
    leaf("UE2", "UE", 10_000),
    leaf("UE3", "UE", 7_000),
    leaf("CA4", "CA", 5_000),
    leaf("OTMS", "OT", 1_000),
  ];
  return {
    brickRows: distProductRows.map(({ areaCode, distributorCode, regionCode, units, value }) => ({
      areaCode, brickId: `B-${areaCode}`, distributorCode, regionCode, units, value,
    })),
    customerRows: distProductRows.map(({ areaCode, distributorCode, regionCode, units, value }) => ({
      areaCode, brickId: `B-${areaCode}`, clientCode: `C-${areaCode}`, clientName: `Pharmacy ${areaCode}`,
      distributorCode, regionCode, units, value,
    })),
    distProductRows,
    line: LINE,
    maps: {
      areaName: new Map([
        ["UE1", "Minia 1"], ["UE2", "Minia 2"], ["UE3", "Assiut 1"], ["UE8", "Qena 2"],
        ["CA4", "Cairo East 2"], ["OTMS", "Main Store"],
      ]),
      areaRegion: new Map([["UE1", "UE"], ["UE2", "UE"], ["UE3", "UE"], ["UE8", "UE"], ["CA4", "CA"], ["OTMS", "OT"]]),
      distributorName: new Map([["UCP", "United Company of Pharmacists"]]),
      // The production region master already lists Upper Egypt 1 and 2 and Delta (3), which no map
      // area sits in, so on geography they read as regions every product is "missing from".
      regionName: new Map([
        ["CA", "Cairo"], ["UE", "Upper Egypt"], ["OT", "Others"],
        ["UE-1", "Upper Egypt 1"], ["UE-2", "Upper Egypt 2"], ["D3", "Delta (3)"],
      ]),
    },
    masterAreas: [
      { areaCode: "UE1", areaName: "Minia 1", regionCode: "UE" },
      { areaCode: "UE2", areaName: "Minia 2", regionCode: "UE" },
      { areaCode: "UE3", areaName: "Assiut 1", regionCode: "UE" },
      { areaCode: "CA4", areaName: "Cairo East 2", regionCode: "CA" },
      { areaCode: "OTMS", areaName: "Main Store", regionCode: "OT" },
    ],
    masterBricks: [
      { areaCode: "UE2", brickId: "B-UE2", brickName: "Minia 2 brick", regionCode: "UE" },
      // Nothing sold here, so only the master says where it is.
      { areaCode: "UE8", brickId: "B-UE8", brickName: "Qena 2 brick", regionCode: "UE" },
    ],
    period,
  };
}

function cell(salesUnits: number, salesValue: number): MonthlyClosingCell {
  return { achievement: null, salesUnits, salesValue, targetUnits: null, targetValue: null };
}

type RegionLabel = { regionCode: string; regionName: string };

/** A retail matrix grouped the way loadMonthlyClosingParts groups it: by the organogram. */
function retailMatrix(period: string, groups: { region: RegionLabel; areas: [string, string, number][] }[]): MonthlyClosingMatrix {
  const regions = groups.map(({ region, areas }) => {
    const value = areas.reduce((sum, [, , v]) => sum + v, 0);
    return {
      ...region,
      areas: areas.map(([areaCode, areaName, v]) => ({
        ...region, areaCode, areaName, cells: [cell(v / 100, v)], kind: "area" as const, rowTotal: cell(v / 100, v),
      })),
      subtotal: { ...region, cells: [cell(value / 100, value)], kind: "regionSubtotal" as const, rowTotal: cell(value / 100, value) },
    };
  });
  const total = groups.flatMap((group) => group.areas).reduce((sum, [, , v]) => sum + v, 0);
  return {
    availableLines: [LINE],
    availablePeriods: [period],
    columns: [PRODUCT],
    grandTotal: { cells: [cell(total / 100, total)], kind: "grandTotal", rowTotal: cell(total / 100, total) },
    line: LINE,
    period,
    regions,
  };
}

/** A detail row as loadMonthlyClosingDetails returns one, map region and matrix region both stamped. */
function detailRow(overrides: Partial<ClosingDetailRow> & Pick<ClosingDetailRow, "areaCode" | "areaName" | "id">): ClosingDetailRow {
  const salesValue = overrides.salesValue ?? 0;
  return {
    areaMismatch: false,
    blockCode: "",
    bonusQty: 0,
    brickId: "",
    brickName: "",
    brickUnmapped: false,
    clientAddress: "",
    clientCode: "",
    clientName: "",
    discount: 0,
    distributorCode: "UCP",
    effectiveUnits: overrides.qty ?? 0,
    evenSplitApplied: false,
    exclusions: [],
    factoryPrice: 100,
    family: PRODUCT.family,
    includedInClosing: true,
    invoiceDate: null,
    invoicePeriod: AUGUST,
    isConfidential: false,
    isDirect: false,
    missingClientCode: false,
    officialLine: LINE,
    operationalRegionCode: "",
    operationalRegionName: "",
    productCode: PRODUCT.productCode,
    productName: PRODUCT.productName,
    qty: 0,
    regionCode: "",
    regionName: "",
    rowNumber: overrides.id,
    salesValue,
    sheetAreaCode: "",
    sheetAreaName: "",
    sheetRegionCode: "",
    sheetRegionName: "",
    sheetValue: salesValue,
    validationState: "valid",
    ...overrides,
  };
}

function detailsOf(rows: ClosingDetailRow[], period: string): ClosingDetailsResult {
  return {
    canRevealConfidential: false,
    confidentialIncluded: false,
    filteredRowCount: rows.length,
    line: LINE,
    options: buildFilterOptions(rows),
    outOfScope: false,
    page: 1,
    pageSize: rows.length,
    period,
    reconciliation: {
      areaMismatches: summarize(rows, (row) => row.areaMismatch),
      excludedConfidential: summarize(rows, (row) => row.isConfidential),
      excludedDirect: summarize(rows, (row) => row.isDirect),
      includedInClosing: summarize(rows, (row) => row.includedInClosing),
      missingClientCode: summarize(rows, (row) => row.missingClientCode),
      unmappedBricks: summarize(rows, (row) => row.brickUnmapped),
    },
    rows,
    totals: summarize(rows, () => true),
  } as unknown as ClosingDetailsResult;
}

type SheetValue = string | number | null;

/** Every non-empty row of a sheet, indexed by column number, with formulas reduced to their result. */
function sheetRows(sheet: ExcelJS.Worksheet): SheetValue[][] {
  const rows: SheetValue[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values: SheetValue[] = [];
    row.eachCell({ includeEmpty: true }, (excelCell, column) => {
      const raw = excelCell.value;
      let value: SheetValue = null;
      if (typeof raw === "number" || typeof raw === "string") value = raw;
      else if (raw && typeof raw === "object" && "result" in raw) value = (raw as { result?: number }).result ?? null;
      else if (raw && typeof raw === "object" && "text" in raw) value = String((raw as { text: unknown }).text);
      values[column] = value;
    });
    rows.push(values);
  });
  return rows;
}

/**
 * The body of the table whose header row carries `header`, as {column header -> value} records. It
 * ends at the row carrying `stopAt` (the table's totals row) or at a lone cell (the table's note).
 */
function tableUnder(sheet: ExcelJS.Worksheet, header: string, stopAt?: string): Record<string, SheetValue>[] {
  const rows = sheetRows(sheet);
  const headerAt = rows.findIndex((row) => row.includes(header));
  assert.ok(headerAt >= 0, `${sheet.name} has a table headed "${header}"`);
  const headers = rows[headerAt]!;
  const records: Record<string, SheetValue>[] = [];
  for (const row of rows.slice(headerAt + 1)) {
    if (stopAt !== undefined && row.includes(stopAt)) break;
    if (row.filter((value) => value !== null && value !== "").length <= 1) break;
    const record: Record<string, SheetValue> = {};
    headers.forEach((name, column) => {
      if (typeof name === "string") record[name] = row[column] ?? null;
    });
    records.push(record);
  }
  return records;
}

/** The number on the row labelled exactly `label`, or null when no row carries that label. */
function valueLabelled(sheet: ExcelJS.Worksheet, label: string): number | null {
  const row = sheetRows(sheet).find((values) => values.includes(label));
  const value = row?.slice(row.indexOf(label) + 1).find((entry) => typeof entry === "number");
  return typeof value === "number" ? value : null;
}

async function readBack(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer as unknown as Parameters<typeof book.xlsx.load>[0]);
  return book;
}

/** Every cell in the workbook, hidden Calc sheet included, that names the MAP region. */
function mapRegionMentions(book: ExcelJS.Workbook): string[] {
  const found: string[] = [];
  book.eachSheet((sheet) => {
    sheetRows(sheet).forEach((row) => row.forEach((value) => {
      if (typeof value === "string" && (MAP_UPPER_EGYPT.test(value) || value.trim() === "UE")) {
        found.push(`${sheet.name}: ${value}`);
      }
    }));
  });
  return found;
}

export async function runClosingExportOrganogramRegionLabelsTests() {
  // ── 1 · The comparison is re-filed under the matrix's regions, and moves no money ──────────────
  const geographic = geographicInput();
  const relabelled = relabelComparisonRegions(geographic, regionOfArea);
  const leafRegion = (input: AssembleComparisonInput, areaCode: string) =>
    input.distProductRows.find((row) => row.areaCode === areaCode)?.regionCode;

  assert.equal(leafRegion(geographic, "UE2"), "UE", "fixture sanity: the RPC files Minia 2 under the map's Upper Egypt");
  assert.equal(leafRegion(relabelled, "UE2"), "UE-1", "Minia 2 must be filed under Upper Egypt 1, where the matrix shows it");
  assert.equal(leafRegion(relabelled, "UE3"), "UE-2", "Assiut 1 must be filed under Upper Egypt 2");
  assert.equal(
    leafRegion(relabelled, "OTMS"),
    "OT",
    "an area the organogram does not carry keeps its own region; a missing mapping must never re-home money",
  );
  for (const [set, rows] of [
    ["brick", relabelled.brickRows],
    ["customer", relabelled.customerRows],
    ["area master", relabelled.masterAreas],
  ] as const) {
    assert.equal(
      rows.find((row) => row.areaCode === "UE2")?.regionCode,
      "UE-1",
      `the ${set} rows must move with the distributor rows, or one sheet names a different region from the next`,
    );
  }
  assert.equal(
    relabelled.masterBricks.find((brick) => brick.areaCode === "UE8")?.regionCode,
    "UE-2",
    "a brick master row must follow its area even where nothing sold",
  );
  assert.equal(relabelled.maps.areaRegion.get("UE2"), "UE-1", "the area-to-region map (Rankings' region sub-label) must follow too");
  assert.deepEqual(
    [...relabelled.maps.regionName.keys()].sort(),
    ["CA", "OT", "UE-1", "UE-2"],
    "the region list must be the regions the rows now sit in: Upper Egypt has no area left and Delta (3) "
      + "never had one on this line; left in, Gaps lists both as regions every product is missing from",
  );

  const before = assembleComparison(geographic);
  const after = assembleComparison(relabelled);
  assert.ok(
    stringsIn(before).some((text) => MAP_UPPER_EGYPT.test(text)),
    "fixture sanity: on geography the comparison names the map's Upper Egypt",
  );
  assert.ok(
    before.whiteSpace.productGaps.some((gap) => gap.missingRegions.includes("Upper Egypt 1")),
    "fixture sanity: on geography Royafloxacin reads as missing from Upper Egypt 1, where the matrix shows it selling",
  );
  assert.deepEqual(
    stringsIn(after).filter((text) => MAP_UPPER_EGYPT.test(text)),
    [],
    "no label anywhere in the comparison may name the map's Upper Egypt",
  );
  assert.deepEqual(
    after.whiteSpace.productGaps.flatMap((gap) => gap.missingRegions),
    [],
    "sold in every region the matrix holds, the product has no gap at all",
  );
  assert.deepEqual(
    after.rankings.regions.map((region) => region.label).sort(),
    ["Cairo", "Others", "Upper Egypt 1", "Upper Egypt 2"],
    "Top Regions must rank the matrix's regions",
  );
  assert.equal(
    after.data.distProduct.find((row) => row.areaCode === "UE2")?.regionCode,
    "UE-1",
    "the hidden Calc sheet's region column must carry the matrix's region, which the Region x Distributor, "
      + "Top Regions and Region Mix formulas sum by",
  );
  assert.equal(after.national.value, before.national.value, "re-filing must not move a single pound");

  // A region the master does not name yet takes its name from the organogram, never a bare code.
  const unnamed = geographicInput();
  unnamed.maps.regionName.delete("UE-2");
  assert.equal(
    relabelComparisonRegions(unnamed, regionOfArea).maps.regionName.get("UE-2"),
    "Upper Egypt 2",
    "a region missing from the master must be named from the organogram",
  );

  // Re-filed BEFORE the reader's region filter, because the filter was picked on the matrix's regions.
  assert.equal(
    scopeComparisonInput(geographic, { regionCodes: ["UE-1"] }).distProductRows.length,
    0,
    "fixture sanity: an Upper Egypt 1 filter over the RPC's map regions matches nothing",
  );
  assert.deepEqual(
    scopeComparisonInput(relabelled, { regionCodes: ["UE-1"] }).distProductRows.map((row) => row.areaCode).sort(),
    ["UE1", "UE2"],
    "an Upper Egypt 1 filter must keep exactly Minia 1 and Minia 2",
  );

  // `leaves: false` re-files the masters only. The from-rows loader passes it, because its leaves
  // already carry each row's own month's region, which a span of months needs.
  const mastersOnly = relabelComparisonRegions(geographic, regionOfArea, { leaves: false });
  assert.equal(leafRegion(mastersOnly, "UE2"), "UE", "leaves: false must leave the leaves as they arrived");
  assert.equal(
    mastersOnly.masterAreas.find((area) => area.areaCode === "UE2")?.regionCode,
    "UE-1",
    "leaves: false must still re-file the masters",
  );

  // ── 2 · From-rows leaves take each row's own matrix region under the organogram basis ─────────
  const invoice = (areaCode: string, operationalRegionCode: string, salesValue: number) => ({
    areaCode, brickId: `B-${areaCode}`, brickName: `${areaCode} brick`, clientCode: `C-${areaCode}`,
    clientName: `Pharmacy ${areaCode}`, distributorCode: "UCP", includedInClosing: true, operationalRegionCode,
    productCode: PRODUCT.productCode, productName: PRODUCT.productName, qty: 1, regionCode: "UE", salesValue,
  });
  const sourceRows = [invoice("UE2", "UE-1", 100), invoice("UE3", "UE-2", 50), invoice("UE9", "", 20)];
  const organogramLeaves = comparisonLeavesFromRows(sourceRows, "organogram");
  for (const [set, rows] of [
    ["distributor", organogramLeaves.distProductRows],
    ["brick", organogramLeaves.brickRows],
    ["customer", organogramLeaves.customerRows],
  ] as const) {
    assert.deepEqual(
      rows.map((row) => `${row.areaCode}:${row.regionCode}`).sort(),
      ["UE2:UE-1", "UE3:UE-2", "UE9:UE"],
      `each ${set} leaf takes its row's matrix region, and a row with none keeps its map region`,
    );
  }
  assert.deepEqual(
    comparisonLeavesFromRows(sourceRows).distProductRows.map((row) => row.regionCode),
    ["UE", "UE", "UE"],
    "the default basis stays geographic for every other caller",
  );

  // ── 3 · The lookup folds a merged area first, exactly as the matrix does ────────────────────────
  // CNS folds Beni Suef (UE9) into Fayoum (GZ6) from August 2026, so Beni Suef must be looked up as
  // the Fayoum row it is shown in.
  const fayoum = { regionCode: "GZ", regionName: "Giza" };
  const cnsMap = { regionByArea: new Map([["GZ6", fayoum]]) };
  assert.deepEqual(organogramRegionOfArea("cns", AUGUST, cnsMap)("ue9"), fayoum, "Beni Suef takes the region of the Fayoum row it folds into");
  assert.equal(
    organogramRegionOfArea("cns", JULY, cnsMap)("UE9"),
    undefined,
    "before CNS's merge starts, Beni Suef is its own area and must not borrow Fayoum's region",
  );

  // ── 4 · Direct orders are filed under the region the matrix shows their area in ─────────────────
  const augustRetail = retailMatrix(AUGUST, [
    { areas: [["CA4", "Cairo East 2", 5_000]], region: CAIRO },
    { areas: [["UE1", "Minia 1", 3_000], ["UE2", "Minia 2", 10_000]], region: UPPER_EGYPT_1 },
    { areas: [["UE3", "Assiut 1", 7_000]], region: UPPER_EGYPT_2 },
  ]);
  // As the direct RPC returns them: each order on its own area, tagged with the MAP region.
  const directCells: MonthlyClosingDirectCell[] = [
    { areaCode: "UE2", productCode: PRODUCT.productCode, regionCode: "UE", salesUnits: 30, salesValue: 20_370 },
    { areaCode: "UE3", productCode: PRODUCT.productCode, regionCode: "UE", salesUnits: 10, salesValue: 6_000 },
    { areaCode: "CA4", productCode: PRODUCT.productCode, regionCode: "CA", salesUnits: 5, salesValue: 2_500 },
  ];
  // Qena 1 has no row on this matrix, so the injector puts its order in its own region's Direct row.
  const noRowCell: MonthlyClosingDirectCell = {
    areaCode: "UE7", productCode: PRODUCT.productCode, regionCode: "UE", salesUnits: 1, salesValue: 400,
  };
  const withNoRow = [...directCells, noRowCell];

  const filed = fileDirectCellsUnderMatrixRegions(withNoRow, injectDirectIntoMatrix(augustRetail, withNoRow));
  assert.deepEqual(
    filed.map((entry) => `${entry.areaCode}:${entry.regionCode}`),
    ["UE2:UE-1", "UE3:UE-2", "CA4:CA", "UE7:UE"],
    "each order takes the region the matrix shows its area in; an order whose area has no row keeps the "
      + "region of the Direct row it sits in on the matrix",
  );
  assert.deepEqual(filed.map((entry) => entry.salesValue), withNoRow.map((entry) => entry.salesValue), "filing moves no money");
  assert.deepEqual(
    fileDirectCellsUnderMatrixRegions(withNoRow, { ...injectDirectIntoMatrix(augustRetail, withNoRow), period: JULY }),
    withNoRow,
    "July's direct is placed by the owner's hand mapping, never by the order's own area, so its cells are left alone",
  );

  // ── 5 · The August file, read back ───────────────────────────────────────────────────────────────
  const augustMaster = injectDirectIntoMatrix(augustRetail, directCells);
  const directTotal = directCells.reduce((sum, entry) => sum + entry.salesValue, 0);
  assert.equal(
    (augustMaster.companyTotal ?? augustMaster.grandTotal).rowTotal.salesValue,
    25_000 + directTotal,
    "fixture sanity: the matrix counts every direct order",
  );

  const mapAndMatrix = (areaCode: string, areaName: string, region: RegionLabel, mapCode: string, mapName: string) => ({
    areaCode, areaName, operationalRegionCode: region.regionCode, operationalRegionName: region.regionName,
    regionCode: mapCode, regionName: mapName,
  });
  const augustRows = [
    detailRow({ ...mapAndMatrix("CA4", "Cairo East 2", CAIRO, "CA", "Cairo"), id: 1, qty: 50, salesValue: 5_000 }),
    detailRow({ ...mapAndMatrix("UE1", "Minia 1", UPPER_EGYPT_1, "UE", "Upper Egypt"), id: 2, qty: 30, salesValue: 3_000 }),
    detailRow({ ...mapAndMatrix("UE2", "Minia 2", UPPER_EGYPT_1, "UE", "Upper Egypt"), id: 3, qty: 100, salesValue: 10_000 }),
    detailRow({ ...mapAndMatrix("UE3", "Assiut 1", UPPER_EGYPT_2, "UE", "Upper Egypt"), id: 4, qty: 70, salesValue: 7_000 }),
    // What the Direct Orders module books from August: the pharmacy's own identity on the row.
    detailRow({
      ...mapAndMatrix("UE2", "Minia 2", UPPER_EGYPT_1, "UE", "Upper Egypt"),
      clientAddress: "Minia", clientCode: "PH-2", clientName: "Minia Pharmacy", distributorCode: "DirectReq",
      exclusions: ["direct"], id: 5, includedInClosing: false, isDirect: true, qty: 30, salesValue: 20_370,
    }),
  ];
  // The route's full-file comparison: from-rows leaves on the organogram basis, masters re-filed.
  const augustComparison = assembleComparison(relabelComparisonRegions(
    { ...geographicInput(), ...comparisonLeavesFromRows(augustRows, "organogram") },
    regionOfArea,
    { leaves: false },
  ));
  const august = await readBack(await buildMonthlyClosingWorkbook(
    augustMaster,
    augustComparison,
    detailsOf(augustRows, AUGUST),
    { channels: { directCells: fileDirectCellsUnderMatrixRegions(directCells, augustMaster), retail: augustRetail } },
  ));

  const directSheet = august.getWorksheet("Direct Sales (no retail)");
  assert.ok(directSheet, "the August file has the Direct Sales tab");
  const retailSheet = august.getWorksheet("Retail Sales (no direct)");
  assert.ok(retailSheet, "the August file has the Retail Sales tab");
  assert.equal(
    valueLabelled(directSheet, "Direct sales (this sheet)"),
    directTotal,
    "the Direct tab must carry every direct order the matrix counts; Minia 2's 20,370 was the one it lost",
  );
  assert.equal(
    valueLabelled(directSheet, "Direct outside this filter, still counted in the master"),
    null,
    "an unfiltered file has no direct outside its filter; the lost order used to surface on this line",
  );
  assert.equal(valueLabelled(retailSheet, "Direct sales"), directTotal, "the Retail tab's direct figure must match the Direct tab");
  assert.deepEqual(
    tableUnder(directSheet, "Region", "DIRECT TOTAL").map((row) => row.Region).sort(),
    ["Cairo", "Upper Egypt 1", "Upper Egypt 2"],
    "the Direct tab lists direct money by the matrix's regions",
  );
  assert.equal(
    tableUnder(directSheet, "Customer Code", "TOTAL — all customers").find((row) => row.Customer === "Minia Pharmacy")?.Region,
    "Upper Egypt 1",
    "the direct customer list must name the matrix's region",
  );

  const dataSheet = august.getWorksheet("Data");
  assert.ok(dataSheet, "the August file has the Data sheet");
  const dataMinia2 = tableUnder(dataSheet, "Region Code")
    .find((row) => row["Area Code"] === "UE2" && row.Distributor === "UCP");
  assert.equal(dataMinia2?.["Region Code"], "UE-1", "Data must print the matrix's region code");
  assert.equal(dataMinia2?.Region, "Upper Egypt 1", "Data must print the matrix's region name");
  // The codes stay on Data only as HIDDEN formula keys (owner, 2026-10-26: "never use code always
  // use name"): the Total sheet's SUMIFS read them, so they are hidden, never deleted.
  for (const [sheet, labels] of [[dataSheet, ["Region Code", "Area Code", "Brick ID"]], [august.getWorksheet("Total")!, ["Region Code", "Area Code"]]] as const) {
    const columnOf = new Map<string, number>();
    sheet.eachRow((row) => {
      if (columnOf.has("Region Code")) return;
      const found = new Map<string, number>();
      row.eachCell((cell, column) => found.set(String(cell.value ?? ""), column));
      if (found.has("Region Code")) for (const [label, column] of found) columnOf.set(label, column);
    });
    for (const label of labels) {
      const column = columnOf.get(label);
      assert.ok(column, `${sheet.name} keeps its "${label}" key column`);
      assert.equal(sheet.getColumn(column).hidden, true, `${sheet.name}'s "${label}" column (${column}) is hidden — a reader sees names only`);
    }
  }

  const totalSheet = august.getWorksheet("Total");
  assert.ok(totalSheet, "the August file has the Total sheet");
  const totalGrid = tableUnder(totalSheet, "Region Code", "TOTAL");
  assert.deepEqual(
    totalGrid.map((row) => `${row["Area Code"]}:${row.Region}`),
    ["CA4:Cairo", "UE1:Upper Egypt 1", "UE2:Upper Egypt 1", "UE3:Upper Egypt 2"],
    "Total must name the matrix's regions and keep each region's areas together, so Assiut 1 (Upper Egypt 2) "
      + "sorts after Minia 1 and 2 rather than before them as it did under one Upper Egypt",
  );
  assert.equal(
    totalGrid.find((row) => row["Area Code"] === "UE2")?.["Data Value"],
    10_000,
    "renaming a region must not move a Total figure",
  );
  assert.equal(
    totalGrid.find((row) => row["Area Code"] === "UE2")?.["Sales Value"],
    10_000 + 20_370,
    "Minia 2's Sales on Total adds its direct order, as the Closing Matrix does (owner, 2026-09-18)",
  );

  assert.deepEqual(mapRegionMentions(august), [], "no sheet of the August file may name the map's Upper Egypt");

  // ── 6 · July's hand-mapped direct orders name the matrix's region, not the bare map code ────────
  const julyMatrix = retailMatrix(JULY, [
    { areas: [["UE1", "Minia 1", 3_000], ["UE2", "Minia 2", 10_000]], region: UPPER_EGYPT_1 },
    { areas: [["UE8", "Qena 2", 4_000]], region: UPPER_EGYPT_2 },
  ]);
  const july = await readBack(await buildMonthlyClosingWorkbook(
    julyMatrix,
    assembleComparison(relabelComparisonRegions(geographicInput(JULY), regionOfArea)),
    undefined,
    { channels: { directCells: [], retail: julyMatrix } },
  ));
  const julySheet = july.getWorksheet("Direct Orders (July)");
  assert.ok(julySheet, "the July file keeps its Direct Orders tab");
  assert.deepEqual(
    tableUnder(julySheet, "Pharmacy", "TOTAL DIRECT").map((row) => `${row.Area}:${row.Region}`).sort(),
    [
      "Minia 1:Upper Egypt 1",
      "Minia 1:Upper Egypt 1",
      "Minia 2:Upper Egypt 1",
      "Qena 2:Upper Egypt 2",
    ],
    "the owner's July orders for Minia 1, Minia 2 and Qena 2 must name the matrix's regions; the tab printed "
      + "the bare map code \"UE\" for every one of them",
  );
  const julyDirectSheet = july.getWorksheet("Direct Sales (no retail)");
  assert.ok(julyDirectSheet, "the July file has the Direct Sales tab");
  assert.deepEqual(
    [...new Set(tableUnder(julyDirectSheet, "Customer Code", "TOTAL — all customers").map((row) => row.Region))].sort(),
    ["Upper Egypt 1", "Upper Egypt 2"],
    "July's direct customer list must name the matrix's regions too",
  );
  assert.deepEqual(mapRegionMentions(july), [], "no sheet of the July file may name the map's Upper Egypt");
}
