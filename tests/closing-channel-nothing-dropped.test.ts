import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import ExcelJS from "exceljs";

import {
  assembleChannelBreakdown,
  assembleChannelComparison,
  breakdownSelfCheck,
  emptyBreakdownRow,
  sumBreakdownRows,
  type ChannelTotalsRow,
} from "../src/lib/sales/monthly-closing-channel-comparison.ts";
import { applyJulyDirectAreasToBreakdown } from "../src/lib/sales/july-direct-channel-breakdown.ts";
import type { ClosingExportData, MonthlyClosingComparison } from "../src/lib/sales/monthly-closing-comparison.ts";
import { buildMonthlyClosingWorkbook } from "../src/lib/sales/monthly-closing-export.ts";
import type { MonthlyClosingCell, MonthlyClosingMatrix } from "../src/lib/sales/monthly-distributor-import.ts";
import {
  netStoreSplitByAreaProduct,
  splitStoreSalesAcrossCityAreas,
  type StoreSplitRow,
} from "../src/lib/sales/store-sales-city-split.ts";
import {
  applyStoreSplitToChannelBreakdown,
  planChannelBreakdownStoreSplit,
  STORE_SPLIT_BRICK_KEY,
} from "../src/lib/sales/store-split-channel-breakdown.ts";
import { applyStoreSplitToMatrix } from "../src/lib/sales/store-split-matrix.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The Monthly Closing channel sheets, and the four ways they published a number that was not the
// month. All four were measured against PRODUCTION on 2026-08-06 and the figures below are those
// measurements, not invented ones — that is what makes this a regression test rather than a shape
// test.
//
//   1. MONEY DROPPED. Both RPCs filtered `client_code is not null` on their retail half. CNS 2026-05
//      lost 4,363,635.38 of 8,354,429.79; five more CNS months lost money too. Anti Infective and
//      Pedia lost nothing in any 2026 month, which is exactly why nobody caught it.
//   2. UNNAMED DIRECT ORDERS BECAME PHARMACIES. The direct key was 'name:' || fold(client_name),
//      never null, so the channel CASE fell through to `else 'pharmacy'`. Anti Infective 2026-07
//      printed Pharmacies 450,035.45 against a true 356,481.45 — overstated 26.2% — with 93,554.00
//      of unnamed direct money inside it, counted as ONE customer.
//   3. THE GRIDS IGNORED THE STORE CITY SPLIT. The Closing Matrix halves a Gharbia wholesaler's
//      sell-in across D14 and D15; the Area × Channel grid kept all of it on D15. Two sheets, one
//      workbook, two different numbers for one area.
//   4. THE SELF-CHECK ONLY CHECKED THE EXPORTED MONTH. CNS 2026-07 happens to be clean, so a CNS
//      July export printed "Difference 0.00" while the six month blocks above it were short.
//
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATION = path.join(
  process.cwd(),
  "supabase/migrations/20260806160000_closing_channel_unattributed_buckets.sql",
);

// The real Anti Infective 2026-07 split, as production returns it.
const AI_PHARMACY = 356_481.45;
const AI_STORE = 99_694.35;
const AI_HOSPITAL = 6_729.75;
const AI_DIRECT_UNNAMED = 93_554.00;
const AI_MONTH = AI_PHARMACY + AI_STORE + AI_HOSPITAL + AI_DIRECT_UNNAMED; // 556,459.55

// The real CNS shortfall, month by month, as production returns it.
const CNS_NO_CODE: Record<string, number> = {
  "2026-05": 4_363_635.38,
  "2026-06": 400_219.65,
  "2026-07": 0,
};
const CNS_CHANNELS: Record<string, number> = {
  "2026-05": 3_990_794.42,
  "2026-06": 3_708_822.00,
  "2026-07": 1_484_178.10,
};

function totalsRow(period: string, channel: string, value: number, customers = 0, units = 0): ChannelTotalsRow {
  return { channel, customers, period, units: units || value, value };
}

function labelOf(rows: readonly { label: string }[], needle: string): string | undefined {
  return rows.find((row) => row.label.toLowerCase().includes(needle.toLowerCase()))?.label;
}

// ── Defect 1 — money with no client code gets a row, and the month is whole ───
function runNoClientCodeBucketTests() {
  const comparison = assembleChannelComparison({
    line: "CNS",
    restrictedProductsIncluded: false,
    rows: Object.keys(CNS_CHANNELS).flatMap((period) => [
      totalsRow(period, "pharmacy", CNS_CHANNELS[period], 10_033),
      ...(CNS_NO_CODE[period] > 0 ? [totalsRow(period, "unidentified_no_code", CNS_NO_CODE[period])] : []),
      totalsRow(period, "__population__", CNS_CHANNELS[period] + CNS_NO_CODE[period]),
    ]),
  });

  const bucket = comparison.rows.find((row) => row.channel === "unidentified_no_code");
  assert.ok(
    bucket,
    "DEFECT 1: money the distributor sent with no client code must have its own visible row on the "
    + "Channel Comparison sheet. CNS 2026-05 carries 4,363,635.38 EGP of it and the sheet shows no such row, "
    + `so that money is being dropped again. Rows present: ${comparison.rows.map((row) => row.channel).join(", ")}`,
  );
  assert.equal(
    bucket?.byPeriod["2026-05"]?.value,
    4_363_635.38,
    "DEFECT 1: the no-client-code row must carry the whole measured amount for the month",
  );
  assert.equal(
    bucket?.byPeriod["2026-05"]?.customers,
    0,
    "DEFECT 1: a row with no client code counts ZERO customers — there is no identity there to count, "
    + "and one synthetic customer per month would be a number nobody could act on",
  );

  // The property that matters more than any single row: the month adds up. Asserted against the
  // month's own population rather than against a third typed-in constant — production reports
  // 8,354,429.79 for CNS May, and the two figures above are each rounded to the piastre on their
  // own, so a literal here would be a cent out for a reason that has nothing to do with the defect.
  // Asserted on the MONEY, not on the self-check that watches it: the two must be able to fail
  // independently, or a broken check would be reported as a broken bucket.
  const mayTotal = comparison.totalsByPeriod["2026-05"]?.value ?? 0;
  const mayWhole = CNS_CHANNELS["2026-05"] + CNS_NO_CODE["2026-05"];
  assert.equal(
    mayTotal,
    mayWhole,
    "DEFECT 1: the sheet's own May total must equal the whole month — production reports 8,354,429.79, of "
    + `which 4,363,635.38 has no client code. The sheet's rows add up to ${mayTotal} against ${mayWhole}. `
    + "Anything less means money is dropped between the source tables and this sheet",
  );

  // A clean line grows no row of zeroes — the bucket is an exception report, not a fixed column.
  const clean = assembleChannelComparison({
    line: "Anti Infective",
    restrictedProductsIncluded: false,
    rows: [
      totalsRow("2026-07", "pharmacy", AI_PHARMACY, 1_700),
      totalsRow("2026-07", "store", AI_STORE, 40),
      totalsRow("2026-07", "hospital", AI_HOSPITAL, 3),
      totalsRow("2026-07", "__population__", AI_PHARMACY + AI_STORE + AI_HOSPITAL),
    ],
  });
  assert.equal(
    clean.rows.length,
    3,
    "DEFECT 1: a line with nothing unattributable shows the three real channels and no bucket rows — "
    + `a clean sheet must not grow three rows of zeroes (got ${clean.rows.map((row) => row.label).join(", ")})`,
  );
}

// ── Defect 2 — an unnamed direct order is never a pharmacy ────────────────────
function runUnnamedDirectTests() {
  const comparison = assembleChannelComparison({
    line: "Anti Infective",
    restrictedProductsIncluded: false,
    rows: [
      totalsRow("2026-07", "pharmacy", AI_PHARMACY, 1_700),
      totalsRow("2026-07", "store", AI_STORE, 40),
      totalsRow("2026-07", "hospital", AI_HOSPITAL, 3),
      totalsRow("2026-07", "direct_unnamed", AI_DIRECT_UNNAMED, 0),
      totalsRow("2026-07", "__population__", AI_MONTH),
    ],
  });

  const pharmacy = comparison.rows.find((row) => row.channel === "pharmacy");
  assert.equal(
    pharmacy?.byPeriod["2026-07"]?.value,
    AI_PHARMACY,
    "DEFECT 2: Pharmacies must read 356,481.45 for Anti Infective July — the true retail pharmacy figure. "
    + "450,035.45 is the old number, which had 93,554.00 of unnamed DIRECT orders folded into it and "
    + "overstated the channel by 26.2%",
  );
  const unnamed = comparison.rows.find((row) => row.channel === "direct_unnamed");
  assert.ok(
    unnamed,
    "DEFECT 2: direct orders with no customer name must have their own labelled row rather than being "
    + "assigned to Pharmacies — they are 93,554.00 EGP on Anti Infective July and 534,713.65 on Pedia July",
  );
  assert.equal(unnamed?.byPeriod["2026-07"]?.value, AI_DIRECT_UNNAMED, "DEFECT 2: the row carries the whole amount");
  assert.equal(
    unnamed?.byPeriod["2026-07"]?.customers,
    0,
    "DEFECT 2: unnamed direct orders count ZERO customers, never one — the old sheet counted every unnamed "
    + "order in a month as a single confident pharmacy customer",
  );
  assert.ok(
    (labelOf(comparison.rows, "direct orders") ?? "").toLowerCase().includes("no customer name"),
    "DEFECT 2: the row must SAY what is missing, so a reader knows it is a Direct Orders data problem "
    + `and not a channel (got "${labelOf(comparison.rows, "direct orders")}")`,
  );

  // The SQL is the only place this ordering can be enforced, so the migration body is asserted
  // directly: if the unattributed branches ever move below the classifier, `else 'pharmacy'` catches
  // them again and this whole defect returns with no TypeScript change to notice it.
  // Comments stripped first: this migration's header QUOTES the filter it removes and names the
  // fallback it reorders, so a raw text search would match the explanation instead of the code.
  const sql = readFileSync(MIGRATION, "utf8")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
  assert.ok(
    !/client_code\s+is\s+not\s+null/i.test(sql),
    "DEFECT 1: neither RPC may filter `client_code is not null` on its retail half — that filter is what "
    + "dropped 4,363,635.38 EGP of CNS May",
  );
  for (const fn of ["phx_closing_channel_totals", "phx_closing_channel_breakdown"]) {
    const body = sql.slice(sql.indexOf(`function public.${fn}`));
    const unnamedAt = body.indexOf("'direct_unnamed'");
    const noCodeAt = body.indexOf("'unidentified_no_code'");
    const fallbackAt = body.indexOf("else 'pharmacy'");
    assert.ok(unnamedAt > 0 && noCodeAt > 0 && fallbackAt > 0, `${fn} carries all three CASE branches`);
    assert.ok(
      unnamedAt < fallbackAt && noCodeAt < fallbackAt,
      `DEFECT 2: in ${fn} the unattributed branches must be tested BEFORE the classifier's `
      + "`else 'pharmacy'` fallback. Below it, every unnamed direct order becomes a pharmacy again — "
      + "which is exactly how Anti Infective July came to print 450,035.45",
    );
  }
}

// ── Defect 3 — the grids carry the same store split as the Closing Matrix ─────
//
// Gharbia is D14 + D15. A wholesaler in D15 sells 51,570.00; the Closing Matrix shares it evenly, so
// each area books 25,785.00. The grids used to keep all 51,570.00 on D15 and credit it all to D15's
// rep.
function runStoreSplitOnGridsTests() {
  const STORE_VALUE = 51_570;
  const PHARMACY_D15 = 10_000;

  const breakdown = assembleChannelBreakdown({
    line: "Anti Infective",
    period: "2026-07",
    restrictedProductsIncluded: false,
    rows: [
      { dimension: "area", hospital: 0, key: "D15", label: "", pharmacy: PHARMACY_D15, store: STORE_VALUE, total: STORE_VALUE + PHARMACY_D15 },
      { dimension: "rep", hospital: 0, key: "HR-D15", label: "Tanta Rep", pharmacy: PHARMACY_D15, store: STORE_VALUE, total: STORE_VALUE + PHARMACY_D15 },
      { dimension: "brick", hospital: 0, key: "BR-15", label: "", pharmacy: PHARMACY_D15, store: STORE_VALUE, total: STORE_VALUE + PHARMACY_D15 },
      { dimension: "product", hospital: 0, key: "RO001", label: "Royafloxacin", pharmacy: PHARMACY_D15, store: STORE_VALUE, total: STORE_VALUE + PHARMACY_D15 },
      { dimension: "area_rep", hospital: 0, key: "D15", label: "Tanta Rep", pharmacy: 0, rep_key: "HR-D15", store: 0, total: 0 },
      { dimension: "area_rep", hospital: 0, key: "D14", label: "Mahalla Rep", pharmacy: 0, rep_key: "HR-D14", store: 0, total: 0 },
      { dimension: "brick_area", area_key: "D15", hospital: 0, key: "BR-15", label: "", pharmacy: 0, store: STORE_VALUE, total: STORE_VALUE },
      { dimension: "population", hospital: 0, key: "TOTAL", label: "", pharmacy: 0, store: 0, total: STORE_VALUE + PHARMACY_D15 },
    ],
  });

  // The SAME movements the Closing Matrix is given, exactly as the export route hands them to both.
  const rows: (StoreSplitRow & { brickId: string })[] = [{
    areaCode: "D15", brickId: "BR-15", clientName: "مخزن الغربية", includedInClosing: true,
    isDirect: false, officialLine: "Anti Infective", productCode: "RO001", qty: 100, salesValue: STORE_VALUE,
  }];
  const { movements } = splitStoreSalesAcrossCityAreas(rows);

  const before = sumBreakdownRows(breakdown.byDimension.area).total;
  const split = planChannelBreakdownStoreSplit(breakdown, movements);
  const after = applyStoreSplitToChannelBreakdown(breakdown, split);

  const areaValue = (key: string) =>
    after.byDimension.area.find((row) => row.key.toUpperCase() === key)?.store ?? 0;
  const repValue = (key: string) =>
    after.byDimension.rep.find((row) => row.key.toUpperCase() === key)?.store ?? 0;

  // The headline claim: the grid and the matrix publish the SAME figure for the same area. Proved by
  // running the matrix's own write-back over the same sale and comparing, rather than by asserting a
  // number twice — if the two implementations ever disagree, this is where it shows.
  const net = netStoreSplitByAreaProduct(movements);
  const matrixCell = (salesValue: number): MonthlyClosingCell =>
    ({ achievement: null, salesUnits: 0, salesValue, targetUnits: null, targetValue: null });
  const grand = matrixCell(STORE_VALUE);
  const { matrix: splitMatrix } = applyStoreSplitToMatrix({
    availableLines: ["Anti Infective"], availablePeriods: ["2026-07"],
    columns: [{ family: "Anti", productCode: "RO001", productName: "Royafloxacin" }],
    grandTotal: { cells: [grand], kind: "grandTotal", rowTotal: grand },
    line: "Anti Infective", period: "2026-07",
    regions: [{
      areas: [
        { areaCode: "D15", areaName: "Tanta", cells: [matrixCell(STORE_VALUE)], kind: "area" as const, regionCode: "DE", regionName: "Delta", rowTotal: matrixCell(STORE_VALUE) },
        { areaCode: "D14", areaName: "Mahalla", cells: [matrixCell(0)], kind: "area" as const, regionCode: "DE", regionName: "Delta", rowTotal: matrixCell(0) },
      ],
      regionCode: "DE", regionName: "Delta",
      subtotal: { cells: [matrixCell(STORE_VALUE)], kind: "regionSubtotal", regionCode: "DE", regionName: "Delta", rowTotal: matrixCell(STORE_VALUE) },
    }],
  }, net);
  const matrixArea = (code: string) =>
    splitMatrix.regions[0].areas.find((area) => area.areaCode === code)?.cells[0].salesValue ?? 0;

  for (const code of ["D15", "D14"]) {
    assert.equal(
      areaValue(code),
      matrixArea(code),
      `DEFECT 3: the Area × Channel grid and the Closing Matrix must publish the SAME store figure for ${code}. `
      + `The grid says ${areaValue(code)} and the Matrix says ${matrixArea(code)} — two sheets in one workbook `
      + "disagreeing about one area is the defect, whichever of them is right",
    );
  }
  assert.equal(areaValue("D15"), 25_785, "DEFECT 3: D15 keeps only its own share of the city pool");
  assert.equal(areaValue("D14"), 25_785, "DEFECT 3: D14 receives its share even though it sold no store money itself");

  assert.equal(
    repValue("HR-D14"),
    25_785,
    "DEFECT 3: the rep grid must move with the areas — Mahalla's rep is credited with Mahalla's share. "
    + "Leaving the whole 51,570.00 on Tanta's rep is the behaviour the owner ruled against on 2026-08-04",
  );
  assert.equal(repValue("HR-D15"), 25_785, "DEFECT 3: Tanta's rep keeps only Tanta's share");

  const brick = after.byDimension.brick.find((row) => row.key === "BR-15");
  assert.equal(
    brick?.store,
    0,
    "DEFECT 3: once a wholesaler's sell-in belongs to every area of its city it belongs to no single brick — "
    + "including the shop's own. Leaving it on BR-15 credits a brick with money the Area grid beside it has "
    + "already moved away",
  );
  const shared = after.byDimension.brick.find((row) => row.key === STORE_SPLIT_BRICK_KEY);
  assert.equal(
    shared?.store,
    STORE_VALUE,
    "DEFECT 3: the store money that left its brick must land on one named row, not vanish",
  );

  // Total preservation, in all four grids. A total-preserving move that changes the total is the
  // whole bug in one sentence — it already happened once on the matrix (Anti Infective 2026-07 came
  // out 22,336.87 short).
  for (const dimension of ["area", "rep", "brick", "product"] as const) {
    assert.equal(
      Number(sumBreakdownRows(after.byDimension[dimension]).total.toFixed(2)),
      Number(before.toFixed(2)),
      `DEFECT 3: the ${dimension} grid must still total the month after the split — the split MOVES money `
      + "between areas of one city, it never creates or destroys any",
    );
  }
  assert.equal(after.storeSplit?.applied, true, "DEFECT 3: the breakdown records that the split reached it");
  assert.equal(split.movedValue, STORE_VALUE, "DEFECT 3: the amount moved is stated so the sheet can print it");
}

// ── Defect 3, second cause — July 2026's hand-mapped direct orders ───────────
//
// Found while proving the store-split fix: after it, Anti Infective still had six areas and Pedia
// eleven disagreeing with the Closing Matrix, by 93,554.00 and 534,713.65 — the exact direct totals.
// The cause is separate from the split. Those orders carry NO area in the database (verified in
// production: 46 rows, 0 with an area); the Matrix places them from the owner's hand-mapping of
// 2026-08-03 and the grids did not. CNS has no direct orders, which is why the one line anybody
// checked could never show it.
function runJulyDirectAreaTests() {
  const DIRECT = 93_554;
  const rows = [
    { dimension: "product", hospital: 0, key: "RO001", label: "Royafloxacin", pharmacy: 100, store: 0, total: 100 },
    { dimension: "product", hospital: 0, key: "SA001", label: "Saginkgo", pharmacy: 0, store: 0, total: 0 },
    { dimension: "area", direct_unnamed: DIRECT, hospital: 0, key: "__DIRECT__", label: "", pharmacy: 0, store: 0, total: DIRECT },
    { dimension: "area", hospital: 0, key: "CA4", label: "", pharmacy: 100, store: 0, total: 100 },
    { dimension: "rep", direct_unnamed: DIRECT, hospital: 0, key: "__DIRECT__", label: "", pharmacy: 0, store: 0, total: DIRECT },
    { dimension: "rep", hospital: 0, key: "B-161", label: "Sherif Medhat", pharmacy: 100, store: 0, total: 100 },
    { dimension: "brick", direct_unnamed: DIRECT, hospital: 0, key: "__DIRECT__", label: "", pharmacy: 100, store: 0, total: DIRECT + 100 },
    { dimension: "population", hospital: 0, key: "TOTAL", label: "", pharmacy: 0, store: 0, total: DIRECT + 100 },
  ];
  const breakdown = assembleChannelBreakdown({
    line: "Anti Infective", period: "2026-07", restrictedProductsIncluded: false, rows,
  });
  const merged = applyJulyDirectAreasToBreakdown(breakdown);

  assert.equal(
    merged.applied,
    true,
    "DEFECT 3 (July direct): July 2026's direct orders must be placed on the areas the owner mapped them to, "
    + "because the Closing Matrix places them there. Leaving them in a Direct row put six Anti Infective areas "
    + `and eleven Pedia areas out of step with the Matrix (${merged.reason ?? "no reason given"})`,
  );
  const areaValue = (key: string) =>
    merged.breakdown.byDimension.area.find((row) => row.key.toUpperCase() === key)?.total ?? 0;
  assert.equal(
    Number(areaValue("CA4").toFixed(2)),
    10_680,
    "DEFECT 3 (July direct): CA4 must carry its own 100.00 of distributor sales PLUS the 10,580.00 of direct "
    + "money the owner mapped to it — which is exactly what the Closing Matrix shows for CA4",
  );
  assert.equal(
    merged.breakdown.byDimension.area.some((row) => row.key === "__DIRECT__"),
    false,
    "DEFECT 3 (July direct): with every mapped order placed, no Direct row is left over on the Area grid",
  );
  for (const dimension of ["area", "rep", "brick", "product"] as const) {
    assert.equal(
      Number(sumBreakdownRows(merged.breakdown.byDimension[dimension]).total.toFixed(2)),
      dimension === "product" ? 100 : DIRECT + 100,
      `DEFECT 3 (July direct): the ${dimension} grid must still total the month — re-attributing direct money `
      + "moves it between rows, it never creates or destroys any",
    );
  }
  assert.ok(
    merged.breakdown.byDimension.brick.some((row) => row.key === "__DIRECT__"),
    "DEFECT 3 (July direct): the BRICK grid keeps its Direct row — the mapping resolves an area and a rep and "
    + "no brick, and inventing one would be the only made-up number on the sheet",
  );

  // Every other month must be untouched: a direct order really does have no area then.
  const june = applyJulyDirectAreasToBreakdown(assembleChannelBreakdown({
    line: "Anti Infective", period: "2026-06", restrictedProductsIncluded: false, rows,
  }));
  assert.equal(
    june.applied,
    false,
    "DEFECT 3 (July direct): the mapping is a one-off for July 2026 and must never touch another month",
  );
}

// ── Defect 4 — the self-check covers every month the sheet displays ───────────
async function runSelfCheckEveryMonthTests() {
  // CNS as production actually returns it: July is clean, May and June are not. The OLD check tied
  // July alone and printed 0.00.
  const comparison = assembleChannelComparison({
    line: "CNS",
    restrictedProductsIncluded: false,
    rows: Object.keys(CNS_CHANNELS).flatMap((period) => [
      totalsRow(period, "pharmacy", CNS_CHANNELS[period], 10_033),
      // Deliberately NO bucket row: this simulates the money still going missing, which is what the
      // self-check exists to catch. The population row knows the month's real size.
      totalsRow(period, "__population__", CNS_CHANNELS[period] + CNS_NO_CODE[period]),
    ]),
  });

  assert.equal(
    comparison.selfCheck.length,
    3,
    "DEFECT 4: the self-check must cover EVERY month the sheet displays, not only the exported one — "
    + `this sheet shows 3 months and checked ${comparison.selfCheck.length}`,
  );
  const july = comparison.selfCheck.find((check) => check.period === "2026-07");
  assert.equal(july?.ok, true, "DEFECT 4: July really is clean — that is why checking it alone looked fine");
  const may = comparison.selfCheck.find((check) => check.period === "2026-05");
  assert.equal(
    may?.ok,
    false,
    "DEFECT 4: May is short by 4,363,635.38 EGP and the self-check must say so. A check that passes while "
    + "a month on the same sheet is short by 4.36M is worse than no check, because it is believed",
  );
  assert.equal(
    Number((may?.differenceValue ?? 0).toFixed(2)),
    -4_363_635.38,
    "DEFECT 4: the difference must be the real shortfall, signed so the reader knows money is MISSING",
  );
  assert.equal(
    comparison.worstSelfCheck?.period,
    "2026-05",
    "DEFECT 4: the sheet leads with the worst month rather than making the reader find it",
  );

  // ...and the rendered sheet says it, loudly, rather than printing a reassuring zero.
  const buffer = await buildMonthlyClosingWorkbook(buildMatrix(), buildComparison(), undefined, {
    channelComparison: comparison,
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.getWorksheet("Channel Comparison")!;
  const flat: string[] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      const raw = cell.value;
      values.push(String((raw && typeof raw === "object" && "result" in raw ? (raw as { result: unknown }).result : raw) ?? ""));
    });
    flat.push(values.join(" | "));
  });

  for (const month of ["May 2026", "Jun 2026", "Jul 2026"]) {
    assert.ok(
      flat.some((line) => line.includes(month) && (line.includes("MISMATCH") || line.includes("OK — whole month"))),
      `DEFECT 4: the self-check block must carry a verdict line for ${month}. Every month the sheet shows is `
      + "checked, or the block is a reassurance rather than a check",
    );
  }
  assert.ok(
    flat.some((line) => line.includes("THIS SHEET IS NOT THE WHOLE LINE")),
    "DEFECT 4: when a month does not tie, the sheet must fail LOUDLY on itself — the old block printed "
    + "\"Difference 0.00 — this sheet and the Data sheet are the same money\" while six months were short",
  );
  assert.ok(
    flat.some((line) => line.includes("2 of 3 MONTHS DO NOT TIE")),
    "DEFECT 4: the block's own total row must count the failing months",
  );
  assert.ok(
    !flat.some((line) => line.includes("MISMATCH") && line.includes("Jul 2026")),
    "DEFECT 4: a month that does tie must still read OK — the check must not cry wolf either",
  );

  // The other half of honesty: a database with no independent total must say NOT CHECKED, never OK.
  const unchecked = assembleChannelComparison({
    line: "CNS",
    restrictedProductsIncluded: false,
    rows: [totalsRow("2026-07", "pharmacy", CNS_CHANNELS["2026-07"], 5_109)],
  });
  assert.equal(
    unchecked.selfCheck[0]?.populationAvailable,
    false,
    "DEFECT 4: with no independent total the check must record that it could NOT run. Falling back to the "
    + "sheet's own figure prints a difference of 0.00 and an OK it did not earn",
  );

  // The breakdown sheet's own check has the same duty, against the same independent total.
  const grids = breakdownSelfCheck(assembleChannelBreakdown({
    line: "CNS",
    period: "2026-05",
    restrictedProductsIncluded: false,
    rows: [
      { dimension: "area", hospital: 0, key: "CA1", label: "", pharmacy: CNS_CHANNELS["2026-05"], store: 0, total: CNS_CHANNELS["2026-05"] },
      { dimension: "population", hospital: 0, key: "TOTAL", label: "", pharmacy: 0, store: 0, total: CNS_CHANNELS["2026-05"] + CNS_NO_CODE["2026-05"] },
    ],
  }));
  const areaCheck = grids.find((check) => check.dimension === "area");
  assert.equal(
    areaCheck?.ok,
    false,
    "DEFECT 4: a breakdown grid short of the month must fail its own check. The four grids are four cuts of "
    + "ONE query, so comparing them with each other proves only that addition works",
  );
  assert.equal(areaCheck?.available, true, "DEFECT 4: the breakdown check knows whether it had a figure to check against");
}

// ── Fixtures for the rendered-sheet assertions ───────────────────────────────

function cell(salesUnits: number, salesValue: number): MonthlyClosingCell {
  return { achievement: null, salesUnits, salesValue, targetUnits: null, targetValue: null };
}

function buildMatrix(): MonthlyClosingMatrix {
  const total = cell(5_000, CNS_CHANNELS["2026-07"]);
  return {
    availableLines: ["CNS"],
    availablePeriods: ["2026-05", "2026-06", "2026-07"],
    columns: [{ family: "CNS", productCode: "SA001", productName: "Saginko" }],
    grandTotal: { cells: [total], kind: "grandTotal", rowTotal: total },
    line: "CNS",
    period: "2026-07",
    regions: [{
      areas: [{
        areaCode: "CA1", areaName: "Cairo 1", cells: [total], kind: "area" as const,
        regionCode: "CA", regionName: "Cairo", rowTotal: total,
      }],
      regionCode: "CA",
      regionName: "Cairo",
      subtotal: { cells: [total], kind: "regionSubtotal", regionCode: "CA", regionName: "Cairo", rowTotal: total },
    }],
  };
}

const DIST_PRODUCT: ClosingExportData["distProduct"] = [{
  areaCode: "CA1", areaName: "Cairo 1", distributorCode: "UCP", distributorName: "UCP",
  productCode: "SA001", productName: "Saginko", regionCode: "CA", regionName: "Cairo",
  units: 5_000, value: CNS_CHANNELS["2026-07"],
}];

function buildComparison(): MonthlyClosingComparison {
  return {
    areaByDistributor: [], avgPrice: [], byDistributor: [], coverage: [],
    data: {
      areaByDist: [], bricks: [], customers: [], distProduct: DIST_PRODUCT,
      masterAreas: [{ areaCode: "CA1", areaName: "Cairo 1", regionName: "Cairo" }],
      masterBricks: [], productByDist: [],
    },
    distributors: [{ code: "UCP", name: "UCP" }],
    insights: [], line: "CNS",
    mix: { distributor: [], product: [], region: [] },
    national: { areaCount: 1, customerCount: 0, productCount: 1, units: 5_000, value: CNS_CHANNELS["2026-07"] },
    pareto: { customers: { rows: [], share: 0, topValue: 0, total: 0 } },
    period: "2026-07", productByDistributor: [],
    rankings: { areas: [], bricks: [], customers: [], products: [], regions: [] },
    regionByDistributor: [], totalAreas: 1, totalBricks: 0,
    whiteSpace: { productGaps: [], singleDistributorAreas: [], zeroSalesAreas: [], zeroSalesBricks: [] },
  };
}

// A row literal that predates the bucket columns must still be a complete row — the helper is the
// one place the column list is written, so a future column cannot be half-added.
function runRowShapeTests() {
  const empty = emptyBreakdownRow("K", "L");
  assert.equal(
    empty.hospital + empty.store + empty.pharmacy + empty.unidentifiedNoCode + empty.unidentifiedNoName
      + empty.directUnnamed + empty.total,
    0,
    "every money column of an empty breakdown row starts at zero",
  );
}

export async function runClosingChannelNothingDroppedTests() {
  runNoClientCodeBucketTests();
  runUnnamedDirectTests();
  runStoreSplitOnGridsTests();
  runJulyDirectAreaTests();
  runRowShapeTests();
  await runSelfCheckEveryMonthTests();
}
