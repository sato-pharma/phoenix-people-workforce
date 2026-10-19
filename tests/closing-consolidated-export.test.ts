import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import JSZip from "jszip";

import {
  ConsolidatedClosingSelectionError,
  canExportConsolidatedClosing,
  consolidateEngineFill,
  consolidatedFilePeriod,
  consolidatedSpanLabel,
  describeConsolidatedMonths,
  relabelConsolidatedWorkbook,
  resolveConsolidatedPeriods,
} from "../src/lib/sales/closing-consolidated.ts";
import { closingFileName } from "../src/lib/sales/closing-export-filename.ts";
import {
  buildClosingPerformanceReview,
  reviewFilterIsActive,
  type AreaSeatAssignment,
  type ClosingPerformanceReviewFilter,
} from "../src/lib/sales/closing-performance-review.ts";
import { foldStoreSplitByArea } from "../src/lib/sales/closing-store-split-months.ts";
import { monthlyClosingFilterOptions } from "../src/lib/sales/monthly-closing-filter-options.ts";
import {
  addClosingSales,
  emptyClosingCell,
  filterMonthlyClosingMatrix,
  roundedClosingCell,
  sumClosingRowTotal,
} from "../src/lib/sales/monthly-closing-matrix-cells.ts";
import { mergeMonthlyClosingMatrices } from "../src/lib/sales/monthly-closing-period-merge.ts";
import type {
  MonthlyClosingAreaRow,
  MonthlyClosingCell,
  MonthlyClosingColumn,
  MonthlyClosingMatrix,
  MonthlyClosingSubtotalRow,
} from "../src/lib/sales/monthly-distributor-import.ts";
import {
  areaProductKey,
  summariseStoreSplitByArea,
  type StoreSplitRow,
} from "../src/lib/sales/store-sales-city-split.ts";
import { applyStoreSplitToMatrix } from "../src/lib/sales/store-split-matrix.ts";

/**
 * 🔒 THE CONSOLIDATED CLOSING — several months of one line added together, in the closing's own
 * workbook and in the premium one. Owner, 2026-09-14: Super Admin and the CEO only; the whole
 * workbook, summed; any month on screen; and the store split worked out PER MONTH, then added.
 */

// An El Qema warehouse sale in Qalubeya, as tests/qema-warehouse-split.test.ts sets one up.
const QEMA_SALE: StoreSplitRow = {
  areaCode: "D11",
  clientCode: "QM-9001",
  clientName: "مخزن القليوبية للأدوية",
  distributorCode: "QM",
  includedInClosing: true,
  isDirect: false,
  officialLine: "Pedia",
  productCode: "LA001",
  qty: 150,
  salesValue: 40_500,
};

export async function runClosingConsolidatedExportTests() {
  // ── 🔴 SPLIT EACH MONTH, THEN ADD ─────────────────────────────────────────────────────────────
  //
  // The assertion that pays for the whole fold. 150 packs in August and 150 in September are each
  // at or under El Qema's 200-pack band, so each month's closing kept its sale inside the
  // governorate. Pooling the two months would read 300, cross the band and spread half over the
  // rest of the country — moving money that neither month's closing moved.
  const august = [{ ...QEMA_SALE }];
  const september = [{ ...QEMA_SALE, clientCode: "QM-9001" }];
  const folded = foldStoreSplitByArea([
    { period: "2026-08", rows: august },
    { period: "2026-09", rows: september },
  ]);
  const pooled = summariseStoreSplitByArea([...august, ...september], "2026-09");
  const perMonth = [
    ...summariseStoreSplitByArea(august, "2026-08"),
    ...summariseStoreSplitByArea(september, "2026-09"),
  ];

  assert.ok(folded.length > 0, "the Qalubeya sale was split in each month, so the sheet has rows");
  assert.equal(
    folded.some((entry) => entry.areaCode === "AB1"),
    false,
    "Alexandria received nothing in either month, so the consolidated sheet must not credit it",
  );
  assert.ok(
    pooled.some((entry) => entry.areaCode === "AB1"),
    "the pooled 300 packs WOULD have reached Alexandria — which is exactly the error the fold avoids",
  );
  for (const entry of folded) {
    const months = perMonth.filter((month) => month.areaCode === entry.areaCode && month.line === entry.line);
    const sum = (field: "movedOutValue" | "receivedValue" | "netValue") =>
      Number(months.reduce((total, month) => total + month[field], 0).toFixed(2));
    assert.equal(entry.receivedValue, sum("receivedValue"), `${entry.areaCode} receives the two months' shares added`);
    assert.equal(entry.movedOutValue, sum("movedOutValue"), `${entry.areaCode} sends out the two months added`);
    assert.equal(entry.netValue, sum("netValue"), `${entry.areaCode}'s net is the two months' nets added`);
  }
  const qalubeya = folded.find((entry) => entry.areaCode === "D11");
  assert.ok(qalubeya, "Qalubeya appears");
  assert.equal(qalubeya.movedOutValue, 81_000, "both months of Qalubeya's own warehouse sale went out to its block");
  assert.equal(
    Number((qalubeya.beforeValue + qalubeya.netValue).toFixed(2)),
    qalubeya.afterValue,
    "before + net = after still holds across the span",
  );

  // A month the split was not applied to is left out once any month was split: its movement is
  // hypothetical and the Closing Matrix beside the sheet does not carry it. JUNE, not July — the
  // gate moved to 2026-07 on the owner's "FIX JULY" ruling (2026-10-02), so July is an APPLIED
  // month now and June is the newest unapplied one. The invariant is unchanged; only the month that
  // demonstrates it.
  const withJune = foldStoreSplitByArea([
    { period: "2026-06", rows: [{ ...QEMA_SALE, qty: 900, salesValue: 243_000 }] },
    { period: "2026-08", rows: august },
  ]);
  assert.equal(
    withJune.find((entry) => entry.areaCode === "D11")?.movedOutValue,
    40_500,
    "June's unapplied split does not ride into a span that includes August",
  );
  // And the other side of the ruling: July DOES ride in now, because it is an applied month.
  const withJuly = foldStoreSplitByArea([
    { period: "2026-07", rows: [{ ...QEMA_SALE, qty: 900, salesValue: 243_000 }] },
    { period: "2026-08", rows: august },
  ]);
  assert.equal(
    withJuly.find((entry) => entry.areaCode === "D11")?.movedOutValue,
    283_500,
    "July's split is applied since 'FIX JULY', so its 243,000 is added to August's 40,500",
  );

  // ── Who, and how many months ─────────────────────────────────────────────────────────────────
  assert.equal(canExportConsolidatedClosing("Super Admin"), true);
  assert.equal(canExportConsolidatedClosing("CEO"), true);
  for (const role of ["SFE Manager", "National Sales Manager", "Medical Rep", "Employee", "", null, undefined]) {
    assert.equal(canExportConsolidatedClosing(role), false, `${String(role)} is not offered a consolidated closing`);
  }
  assert.deepEqual(resolveConsolidatedPeriods(["2026-09", "2026-07", "2026-08", "2026-08"]), ["2026-07", "2026-08", "2026-09"]);
  assert.throws(() => resolveConsolidatedPeriods(["2026-08"]), ConsolidatedClosingSelectionError, "one month is the ordinary closing");
  assert.throws(() => resolveConsolidatedPeriods([]), ConsolidatedClosingSelectionError);
  assert.throws(() => resolveConsolidatedPeriods("nonsense"), ConsolidatedClosingSelectionError);

  // ── The span, named — never the latest month standing for all of them ────────────────────────
  assert.equal(consolidatedSpanLabel(["2026-07", "2026-08", "2026-09"]), "Jul–Sep 2026");
  assert.equal(consolidatedSpanLabel(["2025-11", "2025-12", "2026-01", "2026-02"]), "Nov 2025–Feb 2026");
  assert.equal(consolidatedSpanLabel(["2026-07", "2026-09"]), "Jul, Sep 2026", "a gap is listed, never drawn as a range over August");
  for (const label of [consolidatedSpanLabel(["2026-07", "2026-09"]), consolidatedSpanLabel(["2026-07", "2026-08"])]) {
    assert.equal(label.includes("·"), false, "the premium Contents sheet splits A1 on its last dot");
  }
  assert.equal(describeConsolidatedMonths(["2026-07", "2026-08", "2026-09"]), "July 2026 to September 2026 (3 months)");
  assert.equal(describeConsolidatedMonths(["2026-07", "2026-09"]), "July 2026, September 2026 (2 months)");
  assert.equal(
    closingFileName({ kind: "consolidated", line: "Pedia", period: consolidatedFilePeriod(["2026-07", "2026-08", "2026-09"]), region: "all regions" }),
    "phoenix-monthly-closing-consolidated-jul-2026-to-sep-2026-pedia-all-regions.xlsx",
  );
  assert.equal(
    closingFileName({ extension: "xlsm", kind: "premium-consolidated", line: "CNS", period: consolidatedFilePeriod(["2026-08", "2026-09"]), region: "Cairo" }),
    "phoenix-monthly-closing-premium-consolidated-aug-2026-to-sep-2026-cns-cairo.xlsm",
  );

  // ── The premium fill, relabelled for the span ────────────────────────────────────────────────
  const fill = consolidateEngineFill(
    {
      sheets: {
        "Family by Month": { cells: { A1: "Family by Month · September 2026" }, notes: ["Series from April 2026 to September 2026"] },
        Overview: { cells: { A1: "Pedia · September 2026", H8: "August value", I5: 0.12 }, notes: ["September 2026 closing"] },
        "Rep Card": { cells: { N4: "August 2026" } },
      },
    } as unknown as Parameters<typeof consolidateEngineFill>[0],
    { latestPeriod: "2026-09", periods: ["2026-07", "2026-08", "2026-09"] },
  );
  const overview = fill.sheets.Overview;
  assert.equal(overview.cells?.A1, "Pedia · Jul–Sep 2026", "the title names the span");
  assert.equal(overview.cells?.I5, null, "no growth figure against a month the span was never compared with");
  assert.equal(overview.cells?.H8, "Prior value");
  assert.equal(overview.cells?.I6, "not compared: 3 months added together");
  assert.deepEqual(overview.notes, ["Jul–Sep 2026 closing"]);
  assert.equal(fill.sheets["Rep Card"].cells?.N4, "The prior month");
  assert.deepEqual(
    fill.sheets["Family by Month"].notes,
    ["Series from April 2026 to September 2026"],
    "Family by Month's notes name where its month-by-month series runs, so they stay",
  );

  // ── The normal workbook, relabelled inside its XML ───────────────────────────────────────────
  const zip = new JSZip();
  zip.file("xl/sharedStrings.xml", "<sst><si><t>Month: 2026-09</t></si><si><t>Total 2026-09</t></si></sst>");
  zip.file("xl/worksheets/sheet1.xml", "<worksheet><c t=\"inlineStr\"><is><t>Month: 2026-09</t></is></c></worksheet>");
  zip.file("xl/styles.xml", "<styleSheet>Month: 2026-09</styleSheet>");
  const relabelled = await JSZip.loadAsync(
    await relabelConsolidatedWorkbook(Buffer.from(await zip.generateAsync({ type: "nodebuffer" })), {
      latestPeriod: "2026-09",
      periods: ["2026-07", "2026-08", "2026-09"],
    }),
  );
  const shared = await relabelled.file("xl/sharedStrings.xml")!.async("string");
  assert.ok(shared.includes("Months: July 2026 to September 2026 (3 months)"), "the band header names the span");
  assert.ok(shared.includes("Total 2026-09"), "only the band header's exact text changes");
  assert.ok(
    (await relabelled.file("xl/worksheets/sheet1.xml")!.async("string")).includes("Months: July 2026 to September 2026"),
    "inline strings in the sheets are relabelled too",
  );
  assert.equal(
    await relabelled.file("xl/styles.xml")!.async("string"),
    "<styleSheet>Month: 2026-09</styleSheet>",
    "no part but the strings and the sheets is touched",
  );

  // ── Where the gates and the switches sit ─────────────────────────────────────────────────────
  const ROOT = resolve(import.meta.dirname, "..");
  const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

  for (const route of [
    "app/api/sales/monthly-closing/consolidated-export/route.ts",
    "app/api/sales/monthly-closing/consolidated-premium-export/route.ts",
  ]) {
    const body = read(route);
    const permission = body.indexOf('assertPermission(access, "sales", "export")');
    const role = body.indexOf("canExportConsolidatedClosing(access.role)");
    const build = body.search(/buildConsolidated(ClosingWorkbook|PremiumClosing)\(/);
    assert.ok(permission > 0 && role > permission, `${route} checks the export permission, then the role`);
    assert.ok(build > role, `${route} refuses anyone but Super Admin and the CEO before it builds anything`);
  }

  const registry = read("src/lib/security/access-registry.ts");
  for (const path of ["/api/sales/monthly-closing/consolidated-export", "/api/sales/monthly-closing/consolidated-premium-export"]) {
    assert.ok(registry.includes(path), `${path} is declared in the access registry`);
  }

  const page = read("app/(admin)/sales/monthly-closing/page.tsx");
  assert.ok(
    page.includes("canExportConsolidated={canExportConsolidatedClosing(access.role)}"),
    "the screen offers the consolidated buttons by the same role question the routes ask",
  );
  const workspace = read("src/components/sales/monthly-closing-workspace.tsx");
  assert.ok(workspace.includes("canExportConsolidated = false"), "no consolidated button unless the page says so");
  assert.ok(
    workspace.includes("const showConsolidatedExports = isMultiPeriod && canExportConsolidated;"),
    "the consolidated buttons appear only with several months on screen, and only for the two roles",
  );
  for (const handler of ["handleConsolidatedExport", "handleConsolidatedPremiumExport", "handleConsolidatedPremiumXlsxExport"]) {
    assert.match(
      workspace,
      new RegExp(`async function ${handler}\\(\\) \\{\\s*await runExport\\(\\{\\s*body: \\{[^}]*periods: selectedPeriods`),
      `${handler} goes through runExport and sends the months on screen`,
    );
  }

  // 🔒 The frozen builder: the consolidated path is a switch that is OFF unless a caller passes it.
  const builder = read("src/lib/sales/monthly-closing-export.ts");
  assert.ok(builder.includes("consolidatedMonths?:"), "the switch is optional");
  assert.ok(
    builder.includes("matrix.period === JULY_2026_DIRECT_PERIOD && !options?.consolidatedMonths"),
    "the single-month July file keeps its Direct Orders sheet",
  );
  const consolidatedModule = read("src/lib/sales/monthly-closing-consolidated-export.ts");
  assert.ok(
    consolidatedModule.includes("mapWithConcurrency(requested, MONTH_CONCURRENCY"),
    "the months are loaded one by one, each with its own split — never pooled into one read",
  );
  assert.ok(
    consolidatedModule.indexOf("withoutMaskedSourceRows(") < consolidatedModule.indexOf("buildMonthlyClosingWorkbook("),
    "El Qema is masked before the consolidated workbook is written",
  );

  await runReviewMatchesConsolidatedClosingTests(read);
}

// ── 🔒 THE PERFORMANCE REVIEW IS THE CONSOLIDATED CLOSING, READ SIDEWAYS ───────────────────────
//
// Confirmed against production on 2026-10-09 by building BOTH workbooks for the same line and the
// same months and diffing every number: Anti Infective, CNS and Pedia over Jul+Aug+Sep, Pedia over
// Jul+Sep (a gap), and CNS Aug+Sep narrowed to Alexandria — 0 differences, to the last decimal of a
// double, area rows, region subtotals, the national total and every product column. This file is
// what keeps that answer true, because nothing asserted it before.
//
// THE TWO PATHS ARE THE SAME FUNCTIONS IN A DIFFERENT ORDER, and that is the whole risk:
//
//   Performance Review     filter( merge( split(month) for every month ) )
//   Consolidated closing   merge( split( filter(month) ) for every month )
//
// The split is ONE computation for both — loadClosingStoreSplitNet is literally
// `(await loadClosingStoreSplit(line, period)).net` — so nothing but the ORDER differs, and the two
// orders agree only because of two properties that no test pinned:
//
//   * filterMonthlyClosingMatrix AND mergeMonthlyClosingMatrices both re-derive every region
//     subtotal and the national total from the AREA rows in front of them — so whichever runs last
//     reaches the same figures, and narrowing commutes with folding the months.
//   * applyStoreSplitToMatrix places a delta by AREA × PRODUCT, so a share whose area is not in the
//     matrix is not placed at all rather than landing on another row — which is why a wholesaler's
//     counterpart area being filtered out costs both orders the same money.
//
// Lose either and the review and the download disagree silently, on the page a manager reads
// sales-vs-target off. `storeSplitAdjusted` is deliberately NOT compared: it chooses static values
// over a live formula in the workbook, it is not a number, and the two orders legitimately flag
// different rows with it.
async function runReviewMatchesConsolidatedClosingTests(read: (file: string) => string) {
  const TB001: MonthlyClosingColumn = { family: "Tebofortin", productCode: "TB001", productName: "Tebofortin 40mg" };
  const TB002: MonthlyClosingColumn = { family: "Tebofortin", productCode: "TB002", productName: "Tebofortin 80mg" };
  const RX001: MonthlyClosingColumn = { family: "Rispadex", productCode: "RX001", productName: "Rispadex 2mg" };

  const reviewCell = (salesUnits: number, salesValue: number, targetValue: number | null): MonthlyClosingCell =>
    roundedClosingCell({ achievement: null, salesUnits, salesValue, targetUnits: null, targetValue });

  const columnSums = (rows: readonly { cells: MonthlyClosingCell[] }[], width: number): MonthlyClosingCell[] =>
    Array.from({ length: width }, (_unused, index) => {
      const cell = emptyClosingCell();
      rows.forEach((row) => addClosingSales(cell, row.cells[index]));
      return roundedClosingCell(cell);
    });

  const area = (
    regionCode: string,
    regionName: string,
    areaCode: string,
    areaName: string,
    cells: MonthlyClosingCell[],
    isDirect?: boolean,
  ): MonthlyClosingAreaRow => ({
    areaCode,
    areaName,
    cells,
    isDirect,
    kind: "area",
    regionCode,
    regionName,
    rowTotal: sumClosingRowTotal(cells),
  });

  /**
   * One month of a closing, as the loader hands it over.
   *
   * The two months carry DIFFERENT column sets, in different positions — July has no Rispadex and
   * August has no Tebofortin 40mg — because merging by column POSITION instead of by product code is
   * the one way these two paths could disagree while both look right. Dakahlia 1 is a real area
   * carrying hand-mapped direct money (it keeps its own code and name); "DIRECT" is the synthetic
   * company row, which the split must never touch.
   */
  const closingMonth = (period: string, columns: MonthlyClosingColumn[], scale: number): MonthlyClosingMatrix => {
    const width = columns.length;
    const spread = (values: readonly [number, number, number | null][]) =>
      values.slice(0, width).map(([units, value, target]) => reviewCell(units * scale, value * scale, target));

    const cairo1 = area("CA", "Cairo", "CA1", "Cairo 1", spread([[100, 5_000, 6_000], [40, 3_000, 2_000], [10, 900, 1_000]]));
    const cairo2 = area("CA", "Cairo", "CA2", "Cairo 2", spread([[60, 2_400, 2_500], [25, 1_750, 1_500], [8, 640, null]]));
    const dakahlia = area(
      "DL",
      "Delta",
      "D21",
      "Dakahlia 1",
      spread([[30, 1_500, 1_800], [0, 0, null], [4, 260, 300]]),
      true,
    );
    const companyDirect = area(
      "DL",
      "Delta",
      "DIRECT",
      "Direct orders (company)",
      spread([[9, 400, null], [0, 0, null], [0, 0, null]]),
      true,
    );

    const cairoAreas = [cairo1, cairo2];
    const deltaAreas = [dakahlia, companyDirect];
    const cairoCells = columnSums(cairoAreas, width);
    const deltaCells = columnSums(deltaAreas, width);
    const grandCells = columnSums([...cairoAreas, ...deltaAreas], width);

    // Direct – National: money tied to no region at all. Production has NONE of this (all 27 of
    // 2026's line-months were probed on 2026-10-09 and `directNational` was null in every one), so
    // the fixture is the only place the branch gets exercised — see the caveat assertions below.
    const directCells = spread([[5, 275, null], [0, 0, null], [0, 0, null]]);
    const directNational: MonthlyClosingSubtotalRow = {
      cells: directCells,
      kind: "regionSubtotal",
      regionCode: "",
      regionName: "Direct – National",
      rowTotal: sumClosingRowTotal(directCells),
    };
    const companyCells = columnSums([{ cells: grandCells }, { cells: directCells }], width);

    return {
      availableLines: ["CNS"],
      availablePeriods: ["2026-07", "2026-08", "2026-09"],
      columns,
      companyTotal: { cells: companyCells, kind: "grandTotal", rowTotal: sumClosingRowTotal(companyCells) },
      directNational,
      grandTotal: { cells: grandCells, kind: "grandTotal", rowTotal: sumClosingRowTotal(grandCells) },
      line: "CNS",
      period,
      regions: [
        {
          areas: cairoAreas,
          regionCode: "CA",
          regionName: "Cairo",
          subtotal: {
            cells: cairoCells,
            kind: "regionSubtotal",
            regionCode: "CA",
            regionName: "Cairo",
            rowTotal: sumClosingRowTotal(cairoCells),
          },
        },
        {
          areas: deltaAreas,
          regionCode: "DL",
          regionName: "Delta",
          subtotal: {
            cells: deltaCells,
            kind: "regionSubtotal",
            regionCode: "DL",
            regionName: "Delta",
            rowTotal: sumClosingRowTotal(deltaCells),
          },
        },
      ],
    };
  };

  const MONTHS: { matrix: MonthlyClosingMatrix; period: string }[] = [
    { matrix: closingMonth("2026-07", [TB001, TB002], 1), period: "2026-07" },
    { matrix: closingMonth("2026-08", [TB002, RX001], 2), period: "2026-08" },
  ];

  /**
   * The city split, as loadClosingStoreSplit hands it to both paths: whole-month, never narrowed.
   *
   * Four deliberate shapes — a two-sided move inside Cairo (what a wholesaler's sell-in does), a
   * ONE-SIDED receipt on Dakahlia 1 (the counterpart area is excluded by a region filter, which is
   * the case where the two orders could diverge), a delta on a product only one month carries, and a
   * delta on an area neither month lists at all, which both orders must drop.
   */
  const NET = new Map<string, { qty: number; value: number }>([
    [areaProductKey("CA1", "TB002"), { qty: -12, value: -1_200 }],
    [areaProductKey("CA2", "TB002"), { qty: 12, value: 1_200 }],
    [areaProductKey("D21", "RX001"), { qty: 5, value: 400 }],
    [areaProductKey("OT9", "TB001"), { qty: 3, value: 250 }],
  ]);

  const narrow = (matrix: MonthlyClosingMatrix, filter: ClosingPerformanceReviewFilter) =>
    filterMonthlyClosingMatrix(matrix, {
      areaCodes: filter.areaCodes ?? [],
      productCodes: filter.productCodes ?? [],
      regionCodes: filter.regionCodes ?? [],
      search: filter.search ?? "",
    });

  /** The review: every month split, the months folded, and the fold narrowed — as the loader does. */
  const reviewMatrix = (filter: ClosingPerformanceReviewFilter): MonthlyClosingMatrix => {
    const merged = mergeMonthlyClosingMatrices(MONTHS.map((month) => applyStoreSplitToMatrix(month.matrix, NET).matrix));
    // The loader skips the filter outright when nothing is narrowed, so the pin uses the real
    // predicate rather than assuming filterMonthlyClosingMatrix is a no-op on an empty filter.
    return reviewFilterIsActive(filter) ? narrow(merged, filter) : merged;
  };

  /** The consolidated closing: each month narrowed, then split, then the months folded. */
  const consolidatedMatrix = (filter: ClosingPerformanceReviewFilter): MonthlyClosingMatrix =>
    mergeMonthlyClosingMatrices(
      MONTHS.map((month) => applyStoreSplitToMatrix(narrow(month.matrix, filter), NET).matrix),
    );

  /** Every number either workbook prints, and nothing that is not a number. */
  const numbersOf = (matrix: MonthlyClosingMatrix) => ({
    columns: matrix.columns.map((column) => column.productCode),
    companyTotalCells: matrix.companyTotal?.cells ?? null,
    companyTotalRow: matrix.companyTotal?.rowTotal ?? null,
    directNationalCells: matrix.directNational?.cells ?? null,
    directNationalRow: matrix.directNational?.rowTotal ?? null,
    grandCells: matrix.grandTotal.cells,
    grandRow: matrix.grandTotal.rowTotal,
    line: matrix.line,
    period: matrix.period,
    periods: matrix.periods ?? null,
    regions: matrix.regions.map((region) => ({
      areas: region.areas.map((row) => ({ areaCode: row.areaCode, cells: row.cells, rowTotal: row.rowTotal })),
      regionCode: region.regionCode,
      subtotalCells: region.subtotal.cells,
      subtotalRow: region.subtotal.rowTotal,
    })),
  });

  const FILTERS: { filter: ClosingPerformanceReviewFilter; what: string }[] = [
    { filter: {}, what: "the whole line, nothing narrowed" },
    { filter: { regionCodes: ["CA"] }, what: "one region — the split's counterpart area is outside it" },
    { filter: { productCodes: ["TB002"] }, what: "one product, carried by both months" },
    { filter: { productCodes: ["RX001"] }, what: "one product, carried by ONE of the two months" },
    { filter: { search: "cairo" }, what: "a free-text area search (the city-split stress case)" },
    { filter: { areaCodes: ["CA1", "D21"] }, what: "two areas picked out of two different regions" },
    { filter: { search: "nowhere" }, what: "a search that matches no area at all" },
  ];

  for (const { filter, what } of FILTERS) {
    assert.deepEqual(
      numbersOf(reviewMatrix(filter)),
      numbersOf(consolidatedMatrix(filter)),
      `the Performance Review and the consolidated closing print the same numbers — ${what}`,
    );
  }

  // The second property, pinned on its own because the fold above HIDES it: both orders end in a
  // merge, and the merge re-derives the national total from the area rows, so a delta that wandered
  // onto the grand total would be discarded before the comparison above could see it. A delta is
  // placed by area × product or not placed at all — OT9 is in the net and in neither month, and
  // Rispadex is in the net on an area July does not carry that column for.
  const [july] = MONTHS;
  assert.deepEqual(
    applyStoreSplitToMatrix(july.matrix, NET).applied,
    { qty: 0, value: 0 },
    "a whole-month split nets to zero — a delta with no area and no column of its own enters nothing",
  );
  assert.deepEqual(
    applyStoreSplitToMatrix(narrow(july.matrix, { regionCodes: ["CA"] }), NET).applied,
    { qty: 0, value: 0 },
    "and narrowed to Cairo, its own two areas still net to zero between themselves",
  );

  // ── The headline the review prints IS the Closing Matrix's own National Grand Total ───────────
  //
  // Not a number of its own: buildClosingPerformanceReview reads matrix.grandTotal.rowTotal, and the
  // by-product grid's rows are the matrix's area rows and region subtotals one for one. Pinned
  // through the real builder, so a future "small" re-derivation inside the review is caught here.
  const NO_SEATS = new Map<string, AreaSeatAssignment>();
  const buildReview = (filter: ClosingPerformanceReviewFilter) =>
    buildClosingPerformanceReview({
      availableLines: ["CNS"],
      availablePeriods: ["2026-07", "2026-08", "2026-09"],
      filterOptions: monthlyClosingFilterOptions(reviewMatrix({})),
      generatedAt: "2026-10-09T00:00:00.000Z",
      matrix: reviewMatrix(filter),
      seatAssignments: NO_SEATS,
      selectedPeriods: MONTHS.map((month) => month.period),
      seriesMatrices: MONTHS.map((month) => ({ matrix: month.matrix, period: month.period })),
    });

  for (const { filter, what } of FILTERS) {
    const review = buildReview(filter);
    const closing = consolidatedMatrix(filter);
    assert.equal(
      review.totals.salesValue,
      closing.grandTotal.rowTotal.salesValue,
      `the review's headline sales is the closing's National Grand Total — ${what}`,
    );
    assert.equal(
      review.totals.targetValue,
      closing.grandTotal.rowTotal.targetValue,
      `the review's headline target is the closing's National Grand Total — ${what}`,
    );
    assert.equal(
      review.totals.achievement,
      closing.grandTotal.rowTotal.achievement,
      `the review's achievement is the closing's own ratio, digit for digit — ${what}`,
    );

    // And row by row: every area and every region subtotal on the review's grid is the closing's.
    const closingAreas = closing.regions.flatMap((region) =>
      region.areas.map((row) => ({
        areaCode: row.areaCode,
        salesValue: row.rowTotal.salesValue,
        targetValue: row.rowTotal.targetValue,
      })),
    );
    assert.deepEqual(
      review.matrixByProduct.rows
        .filter((row) => row.kind === "area")
        .map((row) => ({ areaCode: row.areaCode, salesValue: row.salesValue, targetValue: row.targetValue })),
      closingAreas,
      `every area row of the review is the closing's area row — ${what}`,
    );
    assert.deepEqual(
      review.matrixByProduct.rows
        .filter((row) => row.kind === "regionSubtotal")
        .map((row) => ({ code: row.regionCode, salesValue: row.salesValue, targetValue: row.targetValue })),
      closing.regions.map((region) => ({
        code: region.regionCode,
        salesValue: region.subtotal.rowTotal.salesValue,
        targetValue: region.subtotal.rowTotal.targetValue,
      })),
      `every region subtotal of the review is the closing's subtotal — ${what}`,
    );
  }

  // ── 🔴 THE ONE PLACE THE TWO BOTTOM LINES ARE NOT THE SAME ROW ───────────────────────────────
  //
  // The closing workbook prints a "Grand Total (incl. Direct)" line below the national total when a
  // month has Direct – National money — sales tied to no region, so to no area and no rep. The
  // review's headline is the AREA grand total, by design: a review of reps cannot carry money that
  // belongs to none of them. Today the two read the same, because production has no national direct
  // bucket at all (null in all 27 of 2026's line-months, probed 2026-10-09) and the closing sheet
  // therefore prints no such row. The day one appears, the workbook's last line is HIGHER than the
  // review's headline by exactly that money — two different rows, not a disagreement. Pinned so it
  // stays a known difference instead of surfacing as a defect nobody can explain.
  const withDirect = consolidatedMatrix({});
  assert.ok(withDirect.directNational, "the fixture carries a Direct – National row");
  assert.ok(withDirect.companyTotal, "so the closing also carries its 'incl. Direct' bottom line");
  assert.equal(
    Number((withDirect.grandTotal.rowTotal.salesValue + withDirect.directNational.rowTotal.salesValue).toFixed(6)),
    Number(withDirect.companyTotal.rowTotal.salesValue.toFixed(6)),
    "the closing's 'incl. Direct' line is the national total PLUS the national direct money",
  );
  assert.equal(
    buildReview({}).totals.salesValue,
    withDirect.grandTotal.rowTotal.salesValue,
    "the review's headline is the AREA grand total — never the 'incl. Direct' line",
  );
  assert.notEqual(
    buildReview({}).totals.salesValue,
    withDirect.companyTotal.rowTotal.salesValue,
    "and with national direct money present those two lines are genuinely different numbers",
  );

  // ── One pipeline, not two that agree today ───────────────────────────────────────────────────
  //
  // Argument-shaped, not name-shaped: a bare function name is satisfied by the comment that explains
  // the call, so deleting the call would stay green.
  const reviewModule = read("src/lib/sales/closing-performance-review.ts");
  assert.ok(
    reviewModule.includes("loadMergedMonthlyClosingParts({"),
    "the review reads the closing through the shared multi-month loader, never its own query",
  );
  assert.ok(
    reviewModule.includes("return filterMonthlyClosingMatrix(matrix, {"),
    "and narrows with the closing's own filter rather than a second implementation of it",
  );
  const periodLoad = read("src/lib/sales/monthly-closing-period-load.ts");
  assert.ok(
    periodLoad.includes("loadMonthlyClosingPartsWithStoreSplit({ line: input.line ?? null, period }, reuse)"),
    "every month of a selection is read WITH its own store split",
  );
  assert.ok(
    periodLoad.includes("mergeMonthlyClosingMatrices(usable.map((entry) => entry.parts!.combined))"),
    "and the months are folded by the shared merge",
  );
  assert.ok(
    consolidatedModuleOf(read).includes("mergeMonthlyClosingMatrices(months.map((month) => month.matrix))"),
    "the consolidated workbook folds its months with the SAME merge the review's loader uses",
  );
  assert.ok(
    consolidatedModuleOf(read).includes("filterMonthlyClosingMatrix(parts.combined, filter)"),
    "and narrows each month with the same filter",
  );
  const splitNet = read("src/lib/sales/closing-store-split-net.ts");
  assert.ok(
    splitNet.includes("return (await loadClosingStoreSplit(line, period)).net;"),
    "both paths apply ONE split: the net the review reads is a field of the split the export reads",
  );
  const premium = read("src/lib/sales/closing-consolidated-premium-export.ts");
  assert.ok(
    premium.includes("loadMergedMonthlyClosingParts({ line: input.line, periods: requested })") &&
      premium.includes("loadClosingPerformanceReview({"),
    "the premium consolidated workbook IS the review's own path — it embeds the review's sheets",
  );
}

function consolidatedModuleOf(read: (file: string) => string): string {
  return read("src/lib/sales/monthly-closing-consolidated-export.ts");
}
