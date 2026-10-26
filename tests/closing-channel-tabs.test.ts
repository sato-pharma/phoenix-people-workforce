import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import type { ClosingExportData, MonthlyClosingComparison } from "../src/lib/sales/monthly-closing-comparison.ts";
import type { ClosingDetailRow } from "../src/lib/sales/monthly-closing-details.ts";
import { buildMonthlyClosingWorkbook } from "../src/lib/sales/monthly-closing-export.ts";
import {
  filterMonthlyClosingMatrix,
  injectDirectIntoMatrix,
  type MonthlyClosingCell,
  type MonthlyClosingDirectCell,
  type MonthlyClosingMatrix,
} from "../src/lib/sales/monthly-distributor-import.ts";
import { areaProductKey } from "../src/lib/sales/store-sales-city-split.ts";
import { applyStoreSplitToMatrix } from "../src/lib/sales/store-split-matrix.ts";

// The Closing Matrix is the MASTER: retail + direct in one grid. The owner asked for each channel
// on its own tab beside it (2026-08-05). The property that makes those tabs trustworthy is that
// they are a PARTITION of the master — every EGP on the master appears on exactly one of them,
// never both, never neither. This file pins that, through the real workbook builder:
//
//   1. retail total + direct total == master total, arithmetically, before any Excel is involved.
//   2. Both sheets exist, carry their own TOTAL row, and their reconciliation Difference is 0.
//   3. The store split moves retail money between areas WITHOUT breaking the tie — the split is a
//      retail-only redistribution, so applying it to the retail half and to the master must land
//      on the same number.
//   4. The contribution columns say "Contr%" outright, so they are never read as achievement.

const PRODUCT = { family: "Milk", productCode: "LA001", productName: "Lacto Advanced 1" };

function cell(salesUnits: number, salesValue: number, targetValue: number | null = null): MonthlyClosingCell {
  return {
    achievement: targetValue === null || targetValue === 0 ? null : salesValue / targetValue,
    salesUnits,
    salesValue,
    targetUnits: targetValue === null ? null : targetValue / 100,
    targetValue,
  };
}

function areaRow(regionCode: string, regionName: string, areaCode: string, areaName: string, cells: MonthlyClosingCell[]) {
  return {
    areaCode,
    areaName,
    cells,
    kind: "area" as const,
    regionCode,
    regionName,
    rowTotal: cell(
      cells.reduce((sum, c) => sum + c.salesUnits, 0),
      cells.reduce((sum, c) => sum + c.salesValue, 0),
    ),
  };
}

/** Retail only — two Menoufia areas of one city plus Cairo. June 2026, so no July special case. */
function buildRetailMatrix(): MonthlyClosingMatrix {
  return {
    availableLines: ["Pedia"],
    availablePeriods: ["2026-06"],
    columns: [PRODUCT],
    grandTotal: { cells: [cell(160, 48_000, 80_000)], kind: "grandTotal", rowTotal: cell(160, 48_000, 80_000) },
    line: "Pedia",
    period: "2026-06",
    regions: [
      {
        areas: [
          areaRow("D1", "Delta (1)", "D12", "Menoufia 1", [cell(100, 30_000, 50_000)]),
          areaRow("D1", "Delta (1)", "D13", "Menoufia 2", [cell(30, 8_000, 30_000)]),
        ],
        regionCode: "D1",
        regionName: "Delta (1)",
        subtotal: {
          cells: [cell(130, 38_000, 80_000)],
          kind: "regionSubtotal",
          regionCode: "D1",
          regionName: "Delta (1)",
          rowTotal: cell(130, 38_000, 80_000),
        },
      },
      {
        areas: [areaRow("CA", "Cairo", "CA3", "Cairo Centers", [cell(30, 10_000)])],
        regionCode: "CA",
        regionName: "Cairo",
        subtotal: {
          cells: [cell(30, 10_000)],
          kind: "regionSubtotal",
          regionCode: "CA",
          regionName: "Cairo",
          rowTotal: cell(30, 10_000),
        },
      },
    ],
  };
}

// Direct money is tagged with a REGION and a product, never an area — one in a region the retail
// matrix has (Delta) and one in a region it does not (Upper Egypt), which is the case that proves
// the direct tab cannot silently drop money that has no retail row to sit beside.
const DIRECT_CELLS: MonthlyClosingDirectCell[] = [
  { productCode: "LA001", regionCode: "D1", salesUnits: 20, salesValue: 7_000 },
  { productCode: "LA001", regionCode: "UE", salesUnits: 10, salesValue: 5_000 },
];

const DIST_PRODUCT: ClosingExportData["distProduct"] = [
  { areaCode: "D12", areaName: "Menoufia 1", distributorCode: "UCP", distributorName: "UCP", productCode: "LA001", productName: "Lacto Advanced 1", regionCode: "D1", regionName: "Delta (1)", units: 100, value: 30_000 },
  { areaCode: "D13", areaName: "Menoufia 2", distributorCode: "UCP", distributorName: "UCP", productCode: "LA001", productName: "Lacto Advanced 1", regionCode: "D1", regionName: "Delta (1)", units: 30, value: 8_000 },
  { areaCode: "CA3", areaName: "Cairo Centers", distributorCode: "UCP", distributorName: "UCP", productCode: "LA001", productName: "Lacto Advanced 1", regionCode: "CA", regionName: "Cairo", units: 30, value: 10_000 },
];

function buildComparison(): MonthlyClosingComparison {
  return {
    areaByDistributor: [],
    avgPrice: [],
    byDistributor: [],
    coverage: [],
    data: {
      areaByDist: [],
      bricks: [],
      customers: [],
      distProduct: DIST_PRODUCT,
      masterAreas: [
        { areaCode: "D12", areaName: "Menoufia 1", regionName: "Delta (1)" },
        { areaCode: "D13", areaName: "Menoufia 2", regionName: "Delta (1)" },
        { areaCode: "CA3", areaName: "Cairo Centers", regionName: "Cairo" },
      ],
      masterBricks: [],
      productByDist: [],
    },
    distributors: [{ code: "UCP", name: "UCP" }],
    insights: [],
    line: "Pedia",
    mix: { distributor: [], product: [], region: [] },
    national: { areaCount: 3, customerCount: 0, productCount: 1, units: 160, value: 48_000 },
    pareto: { customers: { rows: [], share: 0, topValue: 0, total: 0 } },
    period: "2026-06",
    productByDistributor: [],
    rankings: { areas: [], bricks: [], customers: [], products: [], regions: [] },
    regionByDistributor: [],
    totalAreas: 3,
    totalBricks: 0,
    whiteSpace: { productGaps: [], singleDistributorAreas: [], zeroSalesAreas: [], zeroSalesBricks: [] },
  };
}

/**
 * A direct invoice row carrying its customer identity — what the Direct Orders module writes from
 * 2026-08 (pharmacy code, name and address on every row it books).
 */
function directDetailRow(
  clientCode: string,
  clientName: string,
  regionCode: string,
  units: number,
  value: number,
): ClosingDetailRow {
  return {
    areaCode: "",
    areaMismatch: false,
    areaName: "",
    blockCode: "",
    bonusQty: 0,
    brickId: "",
    brickName: "",
    brickUnmapped: false,
    clientAddress: `${clientName} street`,
    clientCode,
    clientName,
    discount: 0,
    distributorCode: "DirectReq",
    effectiveUnits: units,
    exclusions: ["direct"],
    factoryPrice: 0,
    family: "Milk",
    id: Math.round(value),
    includedInClosing: false,
    invoiceDate: null,
    invoicePeriod: "2026-06",
    isConfidential: false,
    evenSplitApplied: false,
    isDirect: true,
    missingClientCode: false,
    officialLine: "Pedia",
    productCode: "LA001",
    productName: "Lacto Advanced 1",
    qty: units,
    regionCode,
    regionName: regionCode === "D1" ? "Delta (1)" : "Upper Egypt",
    operationalRegionCode: regionCode,
    operationalRegionName: regionCode === "D1" ? "Delta (1)" : "Upper Egypt",
    rowNumber: 1,
    salesValue: value,
    sheetAreaCode: "",
    sheetAreaName: "",
    sheetRegionCode: regionCode,
    sheetRegionName: regionCode,
    sheetValue: value,
    validationState: "valid",
  };
}

/** Every cell value of a sheet, row by row, with formulas reduced to their cached result. */
function sheetValues(sheet: ExcelJS.Worksheet): (string | number | null)[][] {
  const rows: (string | number | null)[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values: (string | number | null)[] = [];
    row.eachCell({ includeEmpty: true }, (excelCell) => {
      const raw = excelCell.value;
      if (raw && typeof raw === "object" && "result" in raw) values.push((raw as { result: number }).result);
      else if (typeof raw === "number" || typeof raw === "string") values.push(raw);
      else values.push(null);
    });
    rows.push(values);
  });
  return rows;
}

/** The numbers on the row whose first non-empty label matches. */
function rowLabelled(rows: (string | number | null)[][], label: string): (string | number | null)[] | null {
  return rows.find((row) => row.some((value) => typeof value === "string" && value.trim() === label)) ?? null;
}

/**
 * Extract the text from every hyperlink cell on a worksheet (e.g. the Dashboard's tab-link
 * column, which uses `{ text, hyperlink }` objects rather than plain strings).
 */
function dashboardTabLinks(sheet: ExcelJS.Worksheet): string[] {
  const links: string[] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (excelCell) => {
      const v = excelCell.value;
      if (v && typeof v === "object" && "text" in v && typeof (v as { text: unknown }).text === "string") {
        links.push((v as { text: string }).text);
      }
    });
  });
  return links;
}

export async function runClosingChannelTabsTests() {
  const retail = buildRetailMatrix();
  const master = injectDirectIntoMatrix(retail, DIRECT_CELLS);

  const retailValue = retail.grandTotal.rowTotal.salesValue;
  const directValue = DIRECT_CELLS.reduce((sum, entry) => sum + entry.salesValue, 0);
  const masterValue = (master.companyTotal ?? master.grandTotal).rowTotal.salesValue;

  // 1. The partition, in pure arithmetic.
  assert.equal(retailValue, 48_000);
  assert.equal(directValue, 12_000);
  assert.equal(
    retailValue + directValue,
    masterValue,
    "retail + direct must equal the master exactly — the channel tabs are a partition of it, not a third view",
  );
  assert.notEqual(
    retail.grandTotal.rowTotal.salesValue,
    masterValue,
    "the retail matrix must be the PRE-injection grid; if it already equalled the master, direct would be double counted",
  );

  // 2 + 4. The sheets themselves.
  const buffer = await buildMonthlyClosingWorkbook(master, buildComparison(), undefined, {
    channels: { directCells: DIRECT_CELLS, retail },
    storeSplitRows: [
      directDetailRow("PH-001", "El Nile Pharmacy", "D1", 20, 7_000),
      directDetailRow("PH-002", "Zamzam Hospital", "UE", 10, 5_000),
    ],
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  // NOT PROTECTED (owner, 2026-10-26: "all its types download non protected"): no tab of the
  // normal workbook -- the hidden Calc sheet included -- leaves the server protected.
  assert.ok(workbook.worksheets.length >= 5, "the fixture workbook has its real tabs");
  for (const sheet of workbook.worksheets) {
    assert.ok(
      !(sheet as unknown as { sheetProtection?: { sheet?: boolean } | null }).sheetProtection?.sheet,
      `${sheet.name} must not be sheet-protected`,
    );
  }

  const retailSheet = workbook.getWorksheet("Retail Sales (no direct)");
  const directSheet = workbook.getWorksheet("Direct Sales (no retail)");
  assert.ok(retailSheet, "the Retail tab is written whenever channels are supplied");
  assert.ok(directSheet, "the Direct tab is written whenever channels are supplied");

  const retailRows = sheetValues(retailSheet!);
  const directRows = sheetValues(directSheet!);

  const retailTotal = rowLabelled(retailRows, "RETAIL TOTAL");
  assert.ok(retailTotal?.includes(48_000), "the Retail tab totals the retail channel and nothing else");
  const directTotal = rowLabelled(directRows, "DIRECT TOTAL");
  assert.ok(directTotal?.includes(12_000), "the Direct tab totals the direct channel and nothing else");

  for (const [name, rows] of [["Retail", retailRows], ["Direct", directRows]] as const) {
    const difference = rowLabelled(rows, "Difference");
    assert.ok(difference, `${name} tab states its reconciliation against the master`);
    assert.ok(
      difference!.some((value) => value === 0),
      `${name} tab's Difference row is zero — the two channels reproduce the master exactly`,
    );
    assert.ok(
      rows.some((row) => row.some((value) => typeof value === "string" && value.includes("Contr%"))),
      `${name} tab names its share column Contr%, so it is never read as an achievement`,
    );
  }

  // A direct region with no retail row must still be listed, or its money would vanish from the
  // only tab that reports it.
  assert.ok(
    directRows.some((row) => row.some((value) => value === 5_000)),
    "a direct region absent from the retail grid still appears on the Direct tab",
  );

  // ── Achievement: present, and the two channels' percentages ADD to the master's ─────────────
  // Both tabs divide by the SAME whole-month target, which is the property that makes them
  // additive. If a channel tab ever grew its own target the sum would silently stop meaning
  // anything, so the arithmetic is pinned here rather than trusted.
  for (const [name, rows] of [["Retail", retailRows], ["Direct", directRows]] as const) {
    assert.ok(
      rows.some((row) => row.some((value) => typeof value === "string" && value === "Ach % of Target")),
      `${name} tab carries the achievement column the owner asked for`,
    );
  }
  const target = retail.grandTotal.rowTotal.targetValue!;
  assert.equal(target, 80_000, "the fixture must carry a target, or the achievement assertions below prove nothing");
  const masterAch = (master.companyTotal ?? master.grandTotal).rowTotal.salesValue / target;
  assert.ok(
    Math.abs(retailValue / target + directValue / target - masterAch) < 1e-9,
    "retail Ach% + direct Ach% must equal the master's — same denominator, split numerator",
  );

  // ── The customer section: direct money named, and it re-adds to the same total ──────────────
  const customerTotal = rowLabelled(directRows, "TOTAL — all customers");
  assert.ok(customerTotal, "the Direct tab lists its orders customer by customer, not only by region");
  assert.ok(
    customerTotal!.includes(12_000),
    "the customer section re-adds to the DIRECT TOTAL — the same money, once by region and once by customer",
  );
  for (const header of ["Customer Code", "Customer", "Details", "Medical Rep"]) {
    assert.ok(
      directRows.some((row) => row.some((value) => value === header)),
      `the Direct tab names each order's ${header}`,
    );
  }

  // ── An empty section must give the RIGHT reason ─────────────────────────────────────────────
  // Two different emptinesses, and naming the wrong one is its own defect: a line with no direct
  // business at all was being told its direct sheet had arrived without customer identity, which
  // reads as a data-quality problem where none exists (found on CNS 2026-07, live).
  const noDirectBuffer = await buildMonthlyClosingWorkbook(retail, buildComparison(), undefined, {
    channels: { directCells: [], retail },
  });
  const noDirectWorkbook = new ExcelJS.Workbook();
  await noDirectWorkbook.xlsx.load(noDirectBuffer as unknown as ArrayBuffer);
  const noDirectRows = sheetValues(noDirectWorkbook.getWorksheet("Direct Sales (no retail)")!);
  const noDirectText = noDirectRows.flat().filter((value): value is string => typeof value === "string").join(" ");
  assert.ok(
    noDirectText.includes("No direct orders reached this line and month, so there is no customer to name"),
    "a line with NO direct orders is told exactly that — nothing is missing, the channel simply had no business",
  );
  assert.ok(
    !noDirectText.includes("carries no customer identity"),
    "…and is NOT blamed for a blank-customer sheet it never received",
  );
  // The opposite case still says the opposite thing: direct money exists, identity does not.
  const identitylessBuffer = await buildMonthlyClosingWorkbook(master, buildComparison(), undefined, {
    channels: { directCells: DIRECT_CELLS, retail },
  });
  const identitylessWorkbook = new ExcelJS.Workbook();
  await identitylessWorkbook.xlsx.load(identitylessBuffer as unknown as ArrayBuffer);
  const identitylessText = sheetValues(identitylessWorkbook.getWorksheet("Direct Sales (no retail)")!)
    .flat().filter((value): value is string => typeof value === "string").join(" ");
  assert.ok(
    identitylessText.includes("carries no customer identity"),
    "direct money with no customer identity on the sheet still says so — that IS a real gap worth naming",
  );

  // ── The Direct tab must FOLLOW THE FILTER ───────────────────────────────────────────────────
  // Reported live: an export filtered to Delta 1 still listed Giza, Upper Egypt, D2 and Others on
  // this tab, while every other sheet correctly showed Delta only. The direct RPC has no notion of
  // the reader's filter, so the sheet has to take its scope from the matrix it sits beside.
  const filtered = filterMonthlyClosingMatrix(master, { regionCodes: ["D1"] });
  const filteredRetail = filterMonthlyClosingMatrix(retail, { regionCodes: ["D1"] });
  const filteredBuffer = await buildMonthlyClosingWorkbook(filtered, buildComparison(), undefined, {
    channels: { directCells: DIRECT_CELLS, retail: filteredRetail },
    filterNote: "Filtered export — this workbook covers only: Region: Delta (1).",
  });
  const filteredWorkbook = new ExcelJS.Workbook();
  await filteredWorkbook.xlsx.load(filteredBuffer as unknown as ArrayBuffer);
  const filteredDirect = sheetValues(filteredWorkbook.getWorksheet("Direct Sales (no retail)")!);
  const directText = filteredDirect.flat().filter((value): value is string => typeof value === "string");

  assert.ok(
    directText.some((value) => value === "Delta (1)"),
    "the region the reader filtered to is on the Direct tab",
  );
  assert.ok(
    !directText.some((value) => value === "UE"),
    "a region the filter excluded must NOT appear on the Direct tab — that was the reported bug",
  );
  assert.ok(
    !filteredDirect.some((row) => row.some((value) => value === 5_000)),
    "…and neither may its money",
  );
  // Here the filter drops Upper Egypt's synthetic Direct row from the master as well, so nothing is
  // left over and no "outside" line is needed — the tie is exact on its own. (The case where the
  // master DOES keep excluded direct is July's area-less orders, which live in its "Direct –
  // National" row: verified live on Pedia 2026-07 filtered to Delta 1, where the sheet names
  // 13,732 EGP as outside the filter and the Difference still reads zero. Reproducing that here
  // would mean rebuilding the July hand-map path, which this fixture deliberately does not model.)
  assert.ok(
    !filteredDirect.some((row) =>
      row.some((value) => typeof value === "string" && value.startsWith("Direct outside this filter"))),
    "nothing is claimed to be outside the filter when the master dropped it too",
  );
  const filteredDifference = rowLabelled(filteredDirect, "Difference");
  assert.ok(
    filteredDifference?.some((value) => value === 0),
    "so the filtered tab still reconciles to the master at zero",
  );

  // 3. The store split is a retail-only redistribution: applying it to the retail half and to the
  // master must leave both totals untouched, so the tie survives it.
  const net = new Map([
    [areaProductKey("D12", "LA001"), { qty: -20, value: -6_000 }],
    [areaProductKey("D13", "LA001"), { qty: 20, value: 6_000 }],
  ]);
  const splitRetail = applyStoreSplitToMatrix(retail, net).matrix;
  const splitMaster = applyStoreSplitToMatrix(master, net).matrix;
  assert.equal(
    splitRetail.grandTotal.rowTotal.salesValue,
    retailValue,
    "the split moves money between areas of one city; the retail total cannot change",
  );
  assert.equal(
    splitRetail.grandTotal.rowTotal.salesValue + directValue,
    (splitMaster.companyTotal ?? splitMaster.grandTotal).rowTotal.salesValue,
    "after the split the two channels still add up to the master — the tie is not an accident of the unsplit case",
  );

  // The master's own contribution header must carry Contr% too (owner, 2026-08-05).
  const matrixRows = sheetValues(workbook.getWorksheet("Closing Matrix")!);
  assert.ok(
    matrixRows.some((row) => row.some((value) => typeof value === "string" && value.includes("Contr%"))),
    "the Closing Matrix's contribution columns say Contr%, not a bare % that reads like achievement",
  );

  // ── Dashboard — tab 1 lists every sheet in this workbook ────────────────────────────────────
  // The Dashboard is always the first sheet created, written last from the sheets that actually
  // exist. Its rows must mention the tabs the reader will find, and never a tab that is absent.
  const dashboardSheet = workbook.getWorksheet("Dashboard");
  assert.ok(dashboardSheet, "the Dashboard sheet is always present as tab 1");
  assert.equal(workbook.worksheets[0]?.name, "Dashboard", "Dashboard is the first tab — created before all others so it lands at position 1");

  // The tab-name column uses hyperlink objects {text, hyperlink} — extract the text field.
  const tabLinksOnDashboard = dashboardTabLinks(dashboardSheet!);
  assert.ok(
    tabLinksOnDashboard.includes("Closing Matrix"),
    "Dashboard links to the Closing Matrix tab",
  );
  assert.ok(
    tabLinksOnDashboard.includes("Retail Sales (no direct)"),
    "Dashboard links to the Retail Sales tab when channels are provided",
  );

  // ── Store Split Detail sheet — one row per store that was split ──────────────────────────────
  // The Store Split and Store Split Detail sheets are only written when `details` is provided.
  // Build a minimal details object with one split-eligible store row to exercise the non-empty
  // code path in writeStoreSplitDetailSheet.
  const storeRow: ClosingDetailRow = {
    areaCode: "D12",
    areaMismatch: false,
    areaName: "Menoufia 1",
    blockCode: "",
    bonusQty: 0,
    brickId: "",
    brickName: "",
    brickUnmapped: false,
    clientAddress: "",
    clientCode: "W-001",
    clientName: "مخزن الدلتا للدواء",  // Arabic for "Delta Medicine Warehouse" — classified as a store
    discount: 0,
    distributorCode: "UCP",
    effectiveUnits: 60,
    exclusions: [],
    factoryPrice: 0,
    family: "Milk",
    id: 9001,
    includedInClosing: true,
    invoiceDate: null,
    invoicePeriod: "2026-06",
    isConfidential: false,
    evenSplitApplied: false,
    isDirect: false,
    missingClientCode: false,
    officialLine: "Pedia",
    productCode: "LA001",
    productName: "Lacto Advanced 1",
    qty: 60,
    regionCode: "D1",
    regionName: "Delta (1)",
    operationalRegionCode: "D1",
    operationalRegionName: "Delta (1)",
    rowNumber: 1,
    salesValue: 6_000,
    sheetAreaCode: "D12",
    sheetAreaName: "Menoufia 1",
    sheetRegionCode: "D1",
    sheetRegionName: "Delta (1)",
    sheetValue: 6_000,
    validationState: "valid",
  };
  const emptyTotals = { effectiveUnits: 0, rows: 0, salesValue: 0, units: 0 };
  const minimalDetails = {
    availableLines: ["Pedia"],
    availablePeriods: ["2026-06"],
    canRevealConfidential: false,
    confidentialIncluded: false,
    filteredRowCount: 1,
    line: "Pedia",
    options: { areas: [], distributors: [], products: [], regions: [] },
    outOfScope: false,
    page: 1,
    pageSize: 500,
    period: "2026-06",
    reconciliation: {
      areaMismatches: emptyTotals,
      // Zeroed like every other total in this deliberately minimal fixture: the workbook builder
      // reads `includedInClosing` and the rows, never the headline.
      closingHeadline: emptyTotals,
      excludedConfidential: emptyTotals,
      excludedDirect: emptyTotals,
      includedInClosing: emptyTotals,
      missingClientCode: emptyTotals,
      unmappedBricks: emptyTotals,
    },
    rows: [storeRow],
    totals: emptyTotals,
  };
  const bufferWithDetails = await buildMonthlyClosingWorkbook(master, buildComparison(), minimalDetails, {
    channels: { directCells: DIRECT_CELLS, retail },
  });
  const wbWithDetails = new ExcelJS.Workbook();
  await wbWithDetails.xlsx.load(bufferWithDetails as unknown as ArrayBuffer);

  const splitDetailSheet = wbWithDetails.getWorksheet("Store Split Detail");
  assert.ok(splitDetailSheet, "Store Split Detail sheet is present when details with split-eligible store rows are provided");
  const splitDetailRows = sheetValues(splitDetailSheet!);
  const splitDetailText = splitDetailRows.flat().filter((v): v is string => typeof v === "string");
  assert.ok(
    splitDetailText.some((v) => v.includes("مخزن الدلتا للدواء")),
    "the store's name appears on the detail sheet",
  );
  assert.ok(
    splitDetailText.some((v) => v === "W-001"),
    "the store's customer code appears on the detail sheet",
  );
  assert.ok(
    splitDetailText.some((v) => v === "Menoufia 1") && !splitDetailText.some((v) => v.includes("(D12)")),
    "the store's own area is shown by its name, never its code, on the detail sheet (owner, 2026-10-26)",
  );

  // Dashboard for the details workbook must also list the Store Split tabs.
  const dashboardWithDetails = wbWithDetails.getWorksheet("Dashboard");
  const tabLinksWithDetails = dashboardTabLinks(dashboardWithDetails!);
  assert.ok(tabLinksWithDetails.includes("Store Split"), "Dashboard links to the Store Split tab when details are provided");
  assert.ok(tabLinksWithDetails.includes("Store Split Detail"), "Dashboard links to the Store Split Detail tab when details are provided");

  // ── Outside rows — filtered export with area-less national direct ────────────────────────────
  // When a filtered export's master still carries direct money that belongs to no area on show
  // (e.g. the National Sales Manager's own orders), the reconciliation section names them so the
  // Difference stays exactly zero rather than leaving the reader an unexplained gap.
  // Simulate this by injecting a NATIONAL direct cell (empty regionCode), which
  // filterMonthlyClosingMatrix carries through while the filter excludes it from the Direct tab.
  const directWithNational: MonthlyClosingDirectCell[] = [
    ...DIRECT_CELLS,
    { productCode: "LA001", regionCode: "", salesUnits: 5, salesValue: 3_000 },
  ];
  const masterWithNational = injectDirectIntoMatrix(retail, directWithNational);
  const filteredWithNational = filterMonthlyClosingMatrix(masterWithNational, { regionCodes: ["D1"] });
  const filteredRetailForNational = filterMonthlyClosingMatrix(retail, { regionCodes: ["D1"] });
  const bufferWithNational = await buildMonthlyClosingWorkbook(filteredWithNational, buildComparison(), undefined, {
    channels: { directCells: directWithNational, retail: filteredRetailForNational },
  });
  const wbWithNational = new ExcelJS.Workbook();
  await wbWithNational.xlsx.load(bufferWithNational as unknown as ArrayBuffer);
  const directWithNationalRows = sheetValues(wbWithNational.getWorksheet("Direct Sales (no retail)")!);
  const directWithNationalText = directWithNationalRows.flat().filter((v): v is string => typeof v === "string");
  assert.ok(
    directWithNationalText.some((v) => v.startsWith("Direct outside this filter")),
    "when the master carries national direct money that the filter excluded, the reconciliation names it",
  );
  const nationalDiff = rowLabelled(directWithNationalRows, "Difference");
  assert.ok(
    nationalDiff?.some((v) => v === 0),
    "the Difference is still zero even when national money sits outside the filter",
  );
}
