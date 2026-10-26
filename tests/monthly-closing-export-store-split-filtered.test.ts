import assert from "node:assert/strict";

import { countsInClosingHeadline } from "../src/lib/sales/closing-headline.ts";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import { prepareClosingStoreSplit } from "../src/lib/sales/closing-store-split-export.ts";
import { assembleComparison } from "../src/lib/sales/monthly-closing-comparison.ts";
import {
  buildFilterOptions,
  summarize,
  type ClosingDetailRow,
  type ClosingDetailsResult,
} from "../src/lib/sales/monthly-closing-details.ts";
import { buildMonthlyClosingWorkbook } from "../src/lib/sales/monthly-closing-export.ts";
import {
  filterMonthlyClosingMatrix,
  injectDirectIntoMatrix,
  type MonthlyClosingCell,
  type MonthlyClosingDirectCell,
  type MonthlyClosingMatrix,
} from "../src/lib/sales/monthly-distributor-import.ts";
import {
  areaProductKey,
  isStoreCitySplitActive,
  STORE_CITY_SPLIT_ENABLED,
  STORE_CITY_SPLIT_FROM_PERIOD,
} from "../src/lib/sales/store-sales-city-split.ts";
import { applyStoreSplitToMatrix } from "../src/lib/sales/store-split-matrix.ts";

// A FILTERED Monthly Closing export whose city straddles the filter must not lose sales value.
//
// THE OWNER'S RULE. A store in Alex East selling 750 boxes is 250 / 250 / 250 across Alex East,
// Alex West and Alex Center — a wholesaler supplies its whole city, so its sell-in is shared
// evenly across every area of that city. That allocation belongs to the MONTH. It must not change
// because someone filtered the screen to one area.
//
// THE BUG THIS PINS. The export used to load its detail rows ALREADY narrowed to the filtered
// areas, then compute the split from them against the master city map. A store's shares therefore
// aimed at areas that were not in the filtered matrix; those had nowhere to land and were silently
// skipped, while the origin area's outgoing side still applied in full. Filtering to Alex East
// alone deleted 2/3 of that store's sales from the headline — measured on live June 2026 data,
// every single-region filter across the three lines dropped 95,888 EGP in one month, and the worst
// single-area filter (CNS / CA2, Cairo) dropped 271,294 EGP of 325,553. The Total sheet's
// "Difference" row — the one line whose whole job is to prove the audit sheet reproduces the
// headline — stopped reading zero.
//
// WHAT IS ASSERTED. Same-city rows inside and outside the filter, exported filtered, then the real
// workbook is read back: the Total sheet's Difference row must be zero, the money that belongs to
// the excluded areas must be NAMED on its own reconciliation line (the owner's rule that missing
// or moved data never renders as an unexplained absence), and each area must carry the SAME number
// in the filtered export as in the unfiltered one.

const PRODUCT = "AB-01";
const LINE = "Pedia";
const PERIOD = "2026-07";
// Alexandria is AB1 + AB2 + AB3 in the master city map — a real three-area city, so a store there
// splits three ways exactly like the owner's Alex East / West / Center example.
const ALEX = ["AB1", "AB2", "AB3"] as const;
const AREA_NAMES: Record<string, string> = { AB1: "Alex East", AB2: "Alex West", AB3: "Alex Center" };
// Six Arabic words classify a customer as a store; مخزن is one of them (customer-channel.ts).
const STORE = "مخزن الاسكندرية";
const PHARMACY = "صيدلية النور";

function detailRow(id: number, areaCode: string, clientName: string, qty: number, salesValue: number): ClosingDetailRow {
  return {
    areaCode,
    areaMismatch: false,
    areaName: AREA_NAMES[areaCode] ?? areaCode,
    blockCode: "",
    bonusQty: 0,
    brickId: `B-${areaCode}`,
    brickName: `${areaCode} brick`,
    brickUnmapped: false,
    clientAddress: "",
    clientCode: `C${id}`,
    clientName,
    discount: 0,
    distributorCode: "PS",
    effectiveUnits: qty,
    exclusions: [],
    factoryPrice: salesValue / qty,
    family: "Milk",
    id,
    includedInClosing: true,
    invoiceDate: `${PERIOD}-15`,
    invoicePeriod: PERIOD,
    isConfidential: false,
    isDirect: false,
    missingClientCode: false,
    evenSplitApplied: false,
    officialLine: LINE,
    productCode: PRODUCT,
    productName: "Lacto Advanced 1",
    qty,
    regionCode: "AB",
    regionName: "Alex-BHR",
    operationalRegionCode: "AB",
    operationalRegionName: "Alex-BHR",
    rowNumber: id,
    salesValue,
    sheetAreaCode: areaCode,
    sheetAreaName: AREA_NAMES[areaCode] ?? areaCode,
    sheetRegionCode: "AB",
    sheetRegionName: "Alex-BHR",
    sheetValue: salesValue,
    validationState: "valid",
  };
}

// One store in Alex East with 750 units / 750,000 EGP, plus a pharmacy in each of the three areas
// so every area has a number of its own to compare against.
const MONTH_ROWS: ClosingDetailRow[] = [
  detailRow(1, "AB1", STORE, 750, 750_000),
  ...ALEX.map((area, index) => detailRow(10 + index, area, PHARMACY, 100, 100_000)),
];

function detailsFor(rows: ClosingDetailRow[]): ClosingDetailsResult {
  return {
    availableLines: [LINE],
    availablePeriods: [PERIOD],
    canRevealConfidential: false,
    confidentialIncluded: false,
    filteredRowCount: rows.length,
    line: LINE,
    options: buildFilterOptions(rows),
    outOfScope: false,
    page: 1,
    pageSize: rows.length,
    period: PERIOD,
    reconciliation: {
      areaMismatches: summarize(rows, (row) => row.areaMismatch),
      closingHeadline: summarize(rows, countsInClosingHeadline),
      excludedConfidential: summarize(rows, (row) => row.isConfidential),
      excludedDirect: summarize(rows, (row) => row.isDirect),
      includedInClosing: summarize(rows, (row) => row.includedInClosing),
      missingClientCode: summarize(rows, (row) => row.missingClientCode),
      unmappedBricks: summarize(rows, (row) => row.brickUnmapped),
    },
    rows,
    totals: summarize(rows, () => true),
  };
}

function cell(salesUnits: number, salesValue: number): MonthlyClosingCell {
  return { achievement: null, salesUnits, salesValue, targetUnits: null, targetValue: null };
}

/** The area x product matrix the closing RPC would return for MONTH_ROWS. */
function fullMatrix(): MonthlyClosingMatrix {
  const areas = ALEX.map((code) => {
    const own = MONTH_ROWS.filter((row) => row.areaCode === code);
    const cells = [cell(
      own.reduce((sum, row) => sum + row.qty, 0),
      own.reduce((sum, row) => sum + row.salesValue, 0),
    )];
    return {
      areaCode: code,
      areaName: AREA_NAMES[code],
      cells,
      kind: "area" as const,
      regionCode: "AB",
      regionName: "Alex-BHR",
      rowTotal: cells[0],
    };
  });
  const grand = cell(
    areas.reduce((sum, area) => sum + area.cells[0].salesUnits, 0),
    areas.reduce((sum, area) => sum + area.cells[0].salesValue, 0),
  );
  return {
    availableLines: [LINE],
    availablePeriods: [PERIOD],
    columns: [{ family: "Milk", productCode: PRODUCT, productName: "Lacto Advanced 1" }],
    grandTotal: { cells: [grand], kind: "grandTotal", rowTotal: grand },
    line: LINE,
    period: PERIOD,
    regions: [{
      areas,
      regionCode: "AB",
      regionName: "Alex-BHR",
      subtotal: { cells: [grand], kind: "regionSubtotal", regionCode: "AB", regionName: "Alex-BHR", rowTotal: grand },
    }],
  } as unknown as MonthlyClosingMatrix;
}

function comparisonFor(rows: ClosingDetailRow[]) {
  const areaCodes = [...new Set(rows.map((row) => row.areaCode))];
  return assembleComparison({
    brickRows: rows.map((row) => ({
      areaCode: row.areaCode, brickId: row.brickId, distributorCode: "PS",
      regionCode: "AB", units: row.qty, value: row.salesValue,
    })),
    customerRows: rows.map((row) => ({
      areaCode: row.areaCode, brickId: row.brickId, clientCode: row.clientCode, clientName: row.clientName,
      distributorCode: "PS", regionCode: "AB", units: row.qty, value: row.salesValue,
    })),
    distProductRows: rows.map((row) => ({
      areaCode: row.areaCode, distributorCode: "PS", productCode: PRODUCT, productName: "Lacto Advanced 1",
      regionCode: "AB", units: row.qty, value: row.salesValue,
    })),
    line: LINE,
    maps: {
      areaName: new Map(ALEX.map((code) => [code, AREA_NAMES[code]])),
      areaRegion: new Map(ALEX.map((code) => [code, "AB"])),
      distributorName: new Map([["PS", "Pharma Serve"]]),
      regionName: new Map([["AB", "Alex-BHR"]]),
    },
    masterAreas: areaCodes.map((code) => ({ areaCode: code, areaName: AREA_NAMES[code] ?? code, regionCode: "AB" })),
    masterBricks: areaCodes.map((code) => ({ areaCode: code, brickId: `B-${code}`, brickName: `${code} brick`, regionCode: "AB" })),
    period: PERIOD,
  });
}

/**
 * What app/api/sales/monthly-closing/export/route.ts does: filter the matrix, resolve the areas it
 * KEPT, then hand the whole month plus that area list to prepareClosingStoreSplit. The route is an
 * HTTP handler that loads from Supabase and cannot be called here, but the ordering that used to
 * lose the money lives in that domain function rather than in the route, so this exercises the real
 * thing. `runRouteWiringChecks` below pins the half that can only live in the route.
 */
async function exportWorkbook(areaCodes: string[]) {
  const matrix = areaCodes.length > 0
    ? filterMonthlyClosingMatrix(fullMatrix(), { areaCodes })
    : fullMatrix();
  const scopedAreaCodes = areaCodes.length > 0
    ? matrix.regions.flatMap((region) => region.areas.map((area) => area.areaCode))
    : [];
  const monthRows = detailsFor(MONTH_ROWS);
  const { details, net } = prepareClosingStoreSplit(monthRows, scopedAreaCodes);
  const { applied, matrix: workbookMatrix } = applyStoreSplitToMatrix(matrix, net);
  const buffer = await buildMonthlyClosingWorkbook(workbookMatrix, comparisonFor(details.rows), details, {
    filterNote: areaCodes.length > 0 ? `Filtered export — Area: ${areaCodes.join(", ")}.` : undefined,
    storeSplitApplied: applied,
    storeSplitRows: monthRows.rows,
    storeSplitScopeAreaCodes: scopedAreaCodes,
  });
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer as unknown as ArrayBuffer);
  return { applied, book, matrix: workbookMatrix };
}

/**
 * One cell of a labelled reconciliation row on the Total sheet, read back out of the real file.
 * `column` is 2 for Units and 3 for Value (EGP).
 *
 * Some cells are plain numbers and some are formulas carrying a cached result; both are read.
 * A formula whose cached result is exactly zero comes back WITHOUT a result — ExcelJS drops a
 * falsy cached value on write — which is precisely the Difference row in a healthy workbook, so
 * `null` here means "a formula that caches zero" and never "the row is missing".
 */
function reconciliationCell(book: ExcelJS.Workbook, startsWith: string, column: number): number | null {
  const sheet = book.getWorksheet("Total");
  assert.ok(sheet, "the workbook has a Total sheet");
  let seen = false;
  let found: number | null = null;
  sheet.eachRow((row) => {
    const label = String(row.getCell(1).value ?? "");
    if (!label.startsWith(startsWith)) return;
    seen = true;
    const raw = row.getCell(column).value;
    const value = raw && typeof raw === "object" && "result" in raw ? (raw as { result?: number }).result : raw;
    found = typeof value === "number" ? value : null;
  });
  assert.ok(seen, `the Total sheet has a reconciliation row starting "${startsWith}"`);
  return found;
}

/**
 * Does the Total sheet's own reconciliation block add up, using the numbers the FILE carries?
 *
 * Data rows + direct + store split − headline. The Difference row states exactly this, but it
 * states it as a formula caching zero, and a cached zero does not survive the round trip — so
 * re-adding the published rows proves the same thing against values that do.
 *
 * Direct belongs in the sum because direct orders never arrive as a distributor invoice line and so
 * have no row on the Data sheet at all. Leaving them out is what used to make this block print a
 * Difference with every explanatory line reading zero.
 */
function reconciliationGap(book: ExcelJS.Workbook): number {
  const sheet = book.getWorksheet("Total");
  // Matched on the prefix so a wording change to the label cannot silently disable the check.
  // Cells here can be plain numbers OR formula objects carrying a cached result — `Number({...})`
  // on the latter is NaN, which would pass straight through the sum and read as a broken sheet.
  const numeric = (value: unknown): number => {
    if (typeof value === "number") return value;
    if (value && typeof value === "object" && "result" in value) {
      return Number((value as { result?: unknown }).result ?? 0) || 0;
    }
    return Number(value ?? 0) || 0;
  };
  const rowStartingWith = (prefix: string): number => {
    let found = 0;
    sheet?.eachRow((row) => {
      if (String(row.getCell(1).value ?? "").startsWith(prefix)) found = numeric(row.getCell(3).value);
    });
    return found;
  };
  const data = rowStartingWith("Data sheet —");
  const direct = rowStartingWith("+ Direct orders");
  const split = rowStartingWith("Store split");
  const headline = reconciliationCell(book, "Closing Matrix grand total", 3) ?? 0;
  return data + direct + split - headline;
}

/** The signed store-split disclosure line, or null when the workbook does not carry one. */
function storeSplitLine(book: ExcelJS.Workbook): number | null {
  const sheet = book.getWorksheet("Total");
  let found: number | null = null;
  sheet?.eachRow((row) => {
    if (String(row.getCell(1).value ?? "").startsWith("Store split")) found = Number(row.getCell(3).value ?? 0);
  });
  return found;
}

/** A single area's sales value on the Closing Matrix, whatever the filter was. */
function areaValue(matrix: MonthlyClosingMatrix, areaCode: string): number | undefined {
  return matrix.regions
    .flatMap((region) => region.areas)
    .find((area) => area.areaCode === areaCode)
    ?.cells[0]?.salesValue;
}

/**
 * The one half of the fix a unit test cannot reach: the export route must load its detail rows
 * WITHOUT place narrowing, so the split has the whole city to allocate across. Re-adding an area or
 * region filter to that loader call would restore the leak with every assertion below still green,
 * because the fixture supplies its own rows. Reading the route is the only guard against that.
 */
function runRouteWiringChecks() {
  const route = readFileSync(
    new URL("../app/api/sales/monthly-closing/export/route.ts", import.meta.url),
    "utf8",
  );
  const call = route.slice(route.indexOf("const detailsPromise"), route.indexOf("const aggregateComparisonPromise"));
  assert.ok(call.length > 0, "the export route still loads its detail rows through loadMonthlyClosingDetails");
  assert.match(
    call,
    /areaCodes:\s*\[\]\s*,\s*regionCodes:\s*\[\]/,
    "the export's detail load must NOT narrow by place — the store split needs the whole city, and "
      + "narrowing here silently deletes every share belonging to a filtered-out area",
  );
  assert.match(
    route,
    /prepareClosingStoreSplit\(monthRows,\s*scopedAreaCodes\b/,
    "the route narrows through prepareClosingStoreSplit, which is what guarantees allocate-then-narrow",
  );
  // The third argument is what keeps the workbook equal to the SCREEN: it hands the route the
  // screen's own cached split instead of letting the export derive a second one. Without it the two
  // drift apart whenever the cache is older than the data (see closing-store-split-net.ts).
  assert.match(
    route,
    /prepareClosingStoreSplit\(monthRows,\s*scopedAreaCodes,\s*await\s+sharedSplitPromise\)/,
    "the route must pass the SHARED split into prepareClosingStoreSplit — deriving a second one is "
      + "how the workbook and the Closing Matrix came to disagree about a wholesaler's areas",
  );
  assert.match(
    route,
    /rowLevelActive && isStoreCitySplitActive\(matrix\.period\)\s*\n?\s*\?\s*Promise\.resolve\(null\)/,
    "the shared split may be skipped only under a row-level filter AND only where the split is "
      + "active FOR THAT PERIOD — a null here makes prepareClosingStoreSplit derive a live split "
      + "from the rows, so asking the bare flag instead of the period would split a row-level "
      + "filtered export of June while the screen's June stays unsplit",
  );
  // OWNER RULING 2026-09-04: the wholesaler city split is ON, on every city — "شغل تقسيم المخازن
  // على كل المدن". It was OFF from 2026-08-10 to 2026-09-04; his August Anti Infective manual sheet
  // applied the split in Menoufia only (7 of its 30 store rows), and he chose to make that uniform
  // by turning the rule on everywhere. Flipping this in EITHER direction is an owner decision —
  // never a code cleanup, and never a way to make a reconciliation go green.
  assert.equal(
    STORE_CITY_SPLIT_ENABLED,
    true,
    "the wholesaler city split must stay ON until the owner explicitly orders it back off",
  );

  // OWNER RULING 2026-10-02: "FIX JULY" — July 2026 takes the split too, so the gate moved from
  // 2026-08 to 2026-07. It had read 2026-08 since 2026-09-04, on his ruling that day ("DONT TOUCH
  // JULY APPLY ON AUGUST AND UPCOMING"), and he reversed it after auditing which customers and
  // months the split had actually touched.
  //
  // 🔴 JUNE IS STILL THE LINE, AND THAT IS WHAT THIS ASSERTION GUARDS. The gate is a floor, so
  // 2026-07 reaches July, August and September and nothing earlier. January–June are published and
  // he did not ask for them: measured 2026-10-02 they would have moved 262,846.70 / 252,084.29 /
  // 301,764.29 / 1,807,659.82 / 573,326.77 / 936,655.07 EGP between areas, and nothing would report
  // it — the publication drift check compares UNITS only, and the split preserves each line's unit
  // total while moving units between areas. Moving this constant EARLIER than 2026-07 restates six
  // published months with no drift signal at all. Either direction is an owner decision.
  assert.equal(
    STORE_CITY_SPLIT_FROM_PERIOD,
    "2026-07",
    "the city split starts at July 2026 (owner, 2026-10-02 'FIX JULY') — June and earlier keep the "
      + "numbers they were published with",
  );
  assert.equal(isStoreCitySplitActive("2026-06"), false, "June 2026 must never be split");
  assert.equal(isStoreCitySplitActive("2026-05"), false, "May 2026 must never be split");
  assert.equal(isStoreCitySplitActive("2026-07"), true, "July 2026 is now the first split month");
  assert.equal(isStoreCitySplitActive("2026-08"), true, "August 2026 was the first split month before the ruling");
  assert.equal(isStoreCitySplitActive("2026-09"), true, "every month after July is split");
  assert.equal(isStoreCitySplitActive("2027-01"), true, "the gate is a floor, not a window");
  // Anything unparseable falls to NOT active. That is the safe direction: not splitting leaves a
  // number where it already was, while splitting a month that should not be moves money between
  // reps with nothing on screen to say so.
  for (const bad of ["", "   ", "2026", "2026-8", "August", "2026-08-01"]) {
    assert.equal(
      isStoreCitySplitActive(bad),
      false,
      `a malformed period (${JSON.stringify(bad)}) must not activate the split`,
    );
  }
  assert.equal(isStoreCitySplitActive(null), false, "a null period must not activate the split");
  assert.equal(isStoreCitySplitActive(undefined), false, "an absent period must not activate the split");
}

export async function runMonthlyClosingExportStoreSplitFilteredTests() {
  runRouteWiringChecks();

  // ── The export must USE the screen's split, never derive a second one ────────────────────────
  // The screen reads a cached split (closing-store-split-net.ts); the export used to recompute one
  // from its own freshly read rows. Two derivations of one rule, one of them up to an hour old, so
  // a cross-city customer re-point moved the workbook's areas and left the screen's alone. Passing
  // the screen's result in is what makes them equal BY CONSTRUCTION rather than by luck.
  {
    const monthRows = detailsFor(MONTH_ROWS);
    const own = prepareClosingStoreSplit(monthRows, []);

    // Stands in for the screen's cached split after the data moved underneath it. Deliberately
    // unlike anything these rows would produce, so following the wrong one is unmistakable.
    const shared = {
      exemptStoreValueByBrick: new Map([["B-AB1|AB1", 12_345]]),
      movements: [{
        areaCode: "AB1", city: "Alexandria", inQty: 1, inValue: 2,
        line: LINE, outQty: 3, outValue: 4, productCode: PRODUCT,
      }],
      net: new Map([[areaProductKey("AB1", PRODUCT), { qty: -999, value: -999_000 }]]),
      // The Office channel's own slice of `net` — empty here, as it is on every line but CNS and
      // every month before 2026-09 (closing-office-respread.ts). Present because the Office GRID
      // takes this slice and nothing else of `net`.
      officeNet: new Map<string, { qty: number; value: number }>(),
    };

    // Not vacuous: the stand-in must genuinely disagree with what these rows derive.
    assert.notDeepEqual(
      [...own.net.entries()],
      [...shared.net.entries()],
      "fixture sanity: the shared split must differ from the rows' own, or this proves nothing",
    );

    const used = prepareClosingStoreSplit(monthRows, [], shared);
    assert.equal(used.net, shared.net, "the export must hand back the SHARED net, not a re-derivation");
    assert.equal(used.movements, shared.movements, "the Channel Breakdown must read the SHARED movements");
    assert.equal(
      used.exemptStoreValueByBrick,
      shared.exemptStoreValueByBrick,
      "the exempt-by-brick map must come from the SAME computation as the movements beside it",
    );

    // Falling back is still correct — a row-level filter, or a failed cache read, derives its own.
    assert.ok(own.net.size > 0, "with no shared split the export still derives one from its own rows");

    // Which split was used must not change allocate-then-narrow: `details` always comes from the
    // rows, so a place filter still narrows AFTER the whole month was allocated.
    const narrowed = prepareClosingStoreSplit(monthRows, ["AB1"], shared);
    assert.deepEqual(
      [...new Set(narrowed.details.rows.map((row) => row.areaCode))],
      ["AB1"],
      "a place filter still narrows the rows even when the split came from the screen",
    );
    assert.equal(narrowed.net, shared.net, "narrowing must not re-derive the split it was handed");
  }

  // ── A month WITH direct orders: the Total sheet must still bridge to zero ──
  // Direct orders never arrive as a distributor invoice line, so they have no row on the Data
  // sheet. The reconciliation used to print the resulting Difference with "Excluded — Direct
  // orders = 0" beside it, so the sheet built to prove the headline was the one that made the
  // numbers look wrong. The bridge now names the direct money explicitly.
  {
    const retail = fullMatrix();
    const directCells: MonthlyClosingDirectCell[] = [
      { productCode: retail.columns[0]!.productCode, regionCode: retail.regions[0]!.regionCode, salesUnits: 40, salesValue: 4_000 },
    ];
    const master = injectDirectIntoMatrix(retail, directCells);
    const monthRows = detailsFor(MONTH_ROWS);
    const { details } = prepareClosingStoreSplit(monthRows, []);
    const buffer = await buildMonthlyClosingWorkbook(master, comparisonFor(details.rows), details, {
      channels: { directCells, retail },
      storeSplitRows: monthRows.rows,
      storeSplitScopeAreaCodes: [],
    });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(buffer as unknown as ArrayBuffer);

    assert.equal(
      reconciliationCell(book, "+ Direct orders counted in the matrix", 3),
      4_000,
      "the reconciliation must name the direct money the Data sheet cannot carry, not leave it at 0",
    );
    assert.equal(
      reconciliationGap(book),
      0,
      "Data rows + direct must reproduce the headline exactly — an unexplained Difference is what "
        + "made the closing look untrustworthy",
    );
  }

  // ── The whole month: the split moves money between the three Alexandria areas, nothing else ──
  const whole = await exportWorkbook([]);
  assert.deepEqual(whole.applied, { qty: 0, value: 0 }, "an unfiltered export has nothing crossing its edge");
  assert.equal(
    reconciliationGap(whole.book),
    0,
    "the unfiltered Total sheet still reproduces the headline exactly",
  );
  assert.equal(reconciliationCell(whole.book, "Difference", 2), 0, "and its Difference row reads zero units");
  assert.equal(
    storeSplitLine(whole.book),
    null,
    "a whole-month export has nothing to explain, so it carries no store-split line at all",
  );
  // 750,000 shared three ways = 250,000 each, on top of each area's own 100,000 pharmacy row.
  assert.equal(areaValue(whole.matrix, "AB1"), 350_000, "Alex East keeps 250,000 of its store's 750,000");
  assert.equal(areaValue(whole.matrix, "AB2"), 350_000, "Alex West receives its 250,000 share");
  assert.equal(areaValue(whole.matrix, "AB3"), 350_000, "Alex Center receives its 250,000 share");

  // ── Filtered to the store's OWN area: two thirds of its sales belong to the excluded areas ──
  //
  // This block pins the OUTBOUND half — the money leaving the export must be stated. Deleting the
  // store-split reconciliation line makes the next assertion fail with exactly 500000 !== 0.
  const east = await exportWorkbook(["AB1"]);
  // THE HEADLINE ASSERTION. Before the fix this read 500,000 — the money aimed at Alex West and
  // Alex Center had nowhere to land, so it left the headline without ever being mentioned.
  assert.equal(
    reconciliationGap(east.book),
    0,
    "a filtered export whose city straddles the filter still ties: Data + store split = the headline",
  );
  assert.equal(reconciliationCell(east.book, "Difference", 2), 0, "its Difference row reads zero units too");
  assert.equal(
    storeSplitLine(east.book),
    -500_000,
    "and the 500,000 that belongs to Alex West and Alex Center is NAMED, never a silent absence",
  );
  assert.equal(east.applied.value, -500_000, "the matrix reports exactly what crossed its edge");
  assert.equal(
    areaValue(east.matrix, "AB1"),
    350_000,
    "Alex East carries the SAME number as in the unfiltered export — the filter selects rows, it never changes them",
  );

  // ── Filtered to an area that only RECEIVES: the incoming share must not go missing either ──
  //
  // This block pins the INBOUND half, and it is the one that catches allocate-then-narrow being
  // reversed: with the split computed from the narrowed rows there is no Alex East store to fund
  // Alex West at all, so the store-split line comes back null instead of 250,000 and Alex West
  // silently under-reports. The outbound block above passes either way, because there every store
  // is already inside the filter — which is exactly why both blocks have to exist.
  const west = await exportWorkbook(["AB2"]);
  assert.equal(reconciliationGap(west.book), 0, "an area with no store of its own still ties");
  assert.equal(
    storeSplitLine(west.book),
    250_000,
    "the share received from the excluded Alex East store is named as an inbound line",
  );
  assert.equal(
    areaValue(west.matrix, "AB2"),
    350_000,
    "Alex West shows its real 250,000 share even though the store that funded it was filtered out",
  );

  // ── Two of three areas: the leak is only the third area's share ──
  const twoOfThree = await exportWorkbook(["AB1", "AB2"]);
  assert.equal(reconciliationGap(twoOfThree.book), 0, "a partial city slice ties too");
  assert.equal(
    storeSplitLine(twoOfThree.book),
    -250_000,
    "only Alex Center's share sits outside this filter",
  );

  // ── The Store Split sheet shows the WHOLE city, marking what is inside this export ──
  const splitSheet = east.book.getWorksheet("Store Split");
  assert.ok(splitSheet, "the filtered workbook still has a Store Split sheet");
  const marked = new Map<string, string>();
  // The area is shown by NAME, never its code (owner, 2026-10-26); "In this export" is column 4.
  const alexNames = ALEX.map((code) => AREA_NAMES[code]);
  splitSheet.eachRow((row) => {
    const name = String(row.getCell(1).value ?? "");
    if (alexNames.includes(name)) marked.set(name, String(row.getCell(4).value ?? ""));
  });
  assert.deepEqual(
    [...marked.entries()].sort(),
    [["Alex Center", "No"], ["Alex East", "Yes"], ["Alex West", "No"]],
    "every area of the store's city is listed, each marked with whether this export covers it — "
      + "so a reader who filtered to one area can still see where the rest of the money went",
  );
}
