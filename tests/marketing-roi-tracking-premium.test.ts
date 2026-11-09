import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { MarketingRoiKpiBand, MarketingRoiReportRow } from "../src/lib/marketing-requests/roi-report-types.ts";
import {
  ROI_CONFIDENTIAL_PRODUCTS,
  ROI_DEFAULT_SORT,
  ROI_RESULT_ORDER,
  ROI_RESULT_TONE,
  nextRoiSort,
  roiActualCaption,
  roiConfidentialToggleLabel,
  roiLookAtEmptyLine,
  roiMeasuredCount,
  roiMoney,
  roiMonthWords,
  roiPage,
  roiPageLine,
  roiPercent,
  roiRequestsToLookAt,
  roiRequiredCaption,
  roiResultBar,
  roiRowCoverageWords,
  roiRowDataWords,
  roiRunAllLabel,
  roiSalesLoadedLine,
  roiScopeLine,
  roiShortfall,
  roiShortfallWords,
  roiSortLine,
  roiStandingCaption,
  roiStatusWords,
  roiTrustNotes,
  roiUnmeasuredCaption,
  sortRoiRows,
} from "../src/lib/marketing-requests/roi-tracking-summary.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * ROI Tracking premium pass (owner, 9 Nov 2026: "eyeball every report in My Team's Reports, premium polish").
 *
 * Six requests, worked by hand:
 *
 *   MKT-1 El Salam      behind     required 30,000 · actual 12,000 (40%) · window complete → 18,000 short
 *   MKT-2 Dar El Fouad  behind     required 10,000 · actual  9,000 (90%) · window complete →  1,000 short
 *   MKT-3 El Nour       on track   required 20,000 · actual 25,000 (125%)
 *   MKT-4 El Hayah      data pending, required 15,000 · actual 2,000 · window still open → never short
 *   MKT-5 Alex Clinic   no sales attributed, window complete, "No pharmacy codes" → a request to look at
 *   MKT-6 Smouha        no sales attributed, window not loaded yet → not one to look at
 *
 * The band says actual sales EGP 45,000, while the rows add to 48,000: two of them claim one sale, and the band is
 * deduplicated on the server. Every team figure on the screen is the band's.
 */

function row(code: string, customerName: string, fields: Partial<MarketingRoiReportRow>): MarketingRoiReportRow {
  return {
    actualCoverageRatio: 0,
    actualSalesUnits: 0,
    actualSalesValue: 0,
    approverRoleKeys: [],
    attributionGapReason: null,
    attributionQuality: "exact_customer" as MarketingRoiReportRow["attributionQuality"],
    customerName,
    dataCoverage: "complete",
    distributorCodes: [],
    estimatedCost: 5000,
    expectedRoiValue: 0,
    forecastCoverageRatio: 0,
    hasSalesData: true,
    line: "Pedia",
    payDate: "2026-05-01",
    productCodes: [],
    region: "Delta (1)",
    requestCode: code,
    requestId: `id-${code}`,
    requestTypeName: "Pharmacy support",
    requesterHrId: "HR-0001",
    requesterName: "Sahar El Gallad",
    requiredRoiValue: 0,
    resultStatus: "on_track",
    roiDurationMonths: 3,
    roiWindow: "May 2026 – Jul 2026",
    salesDataComplete: true,
    status: "approved",
    ...fields,
  };
}

const ROWS: MarketingRoiReportRow[] = [
  row("MKT-1", "El Salam", { actualCoverageRatio: 0.4, actualSalesValue: 12000, requiredRoiValue: 30000, resultStatus: "behind" }),
  row("MKT-2", "Dar El Fouad", { actualCoverageRatio: 0.9, actualSalesValue: 9000, requiredRoiValue: 10000, resultStatus: "behind" }),
  row("MKT-3", "El Nour", { actualCoverageRatio: 1.25, actualSalesValue: 25000, requiredRoiValue: 20000, resultStatus: "on_track" }),
  row("MKT-4", "El Hayah", { actualCoverageRatio: 2000 / 15000, actualSalesValue: 2000, dataCoverage: "partial_pending", requiredRoiValue: 15000, resultStatus: "awaiting_data", salesDataComplete: false }),
  row("MKT-5", "Alex Clinic", { attributionGapReason: "No pharmacy codes", hasSalesData: false, requiredRoiValue: 8000, resultStatus: "no_data" }),
  row("MKT-6", "Smouha", { attributionGapReason: "No pharmacy codes", dataCoverage: "no_validated_data", hasSalesData: false, requiredRoiValue: 8000, resultStatus: "no_data", salesDataComplete: false }),
];

const KPI: MarketingRoiKpiBand = {
  approvedValue: 30000,
  awaitingDataCount: 1,
  behindCount: 2,
  coverageRatio: 0.5,
  incompleteWindowCount: 2,
  noDataCount: 2,
  onTrackCount: 1,
  pendingValue: 5000,
  requestCount: 6,
  restrictedExcludedCount: 1,
  salesDataAsOf: "2026-08",
  totalActualValue: 45000,
  totalEstimatedCost: 30000,
  totalExpectedRoi: 100100,
  totalRequiredRoi: 91000,
};

function theWords() {
  assert.equal(roiMoney(1234.5), "EGP 1,235");
  assert.equal(roiMoney(Number.NaN), "EGP 0", "never NaN on the screen");
  assert.equal(roiPercent(0.844), "84%");
  assert.equal(roiMonthWords("2026-08"), "Aug 2026");
  assert.equal(roiMonthWords("2026-13"), null);
  assert.equal(roiMonthWords(null), null);
  // Sales are LOADED to a month, never "attributed up to" it: the frontier is a completeness flag, not a cap.
  assert.equal(roiSalesLoadedLine("2026-08"), "Sales loaded to Aug 2026");
  assert.equal(roiSalesLoadedLine(null), "No validated sales loaded yet");
  assert.equal(roiStatusWords("roi_tracking"), "ROI tracking");
  assert.equal(roiStatusWords("finance_hold"), "Finance hold");
  assert.equal(roiStatusWords("weird_value"), "Unknown status", "never the raw value");
  // The confidential switch names its products, never their codes.
  assert.deepEqual([...ROI_CONFIDENTIAL_PRODUCTS], ["Lacto Basic 1", "Lacto Basic 2", "Satoslim"]);
  assert.equal(roiConfidentialToggleLabel(), "Include the confidential products — Lacto Basic 1, Lacto Basic 2, Satoslim");
  assert.ok(!/LA00|SS00/.test(roiConfidentialToggleLabel()));
}

function oneRequest() {
  const [salam, fouad, nour, hayah, alex, smouha] = ROWS;
  assert.equal(roiShortfall(salam), 18000);
  assert.equal(roiShortfall(fouad), 1000);
  assert.equal(roiShortfall(nour), 0);
  assert.equal(roiShortfall(hayah), 0, "a window still open is never short, whatever its sales so far");
  assert.equal(roiShortfall(alex), 0, "a request with nothing attributed is not graded, so it is short of nothing");
  assert.equal(roiShortfallWords(salam), "EGP 18,000 short of the required return");
  assert.equal(roiShortfallWords(hayah), null);
  assert.equal(roiRowCoverageWords(salam), "40%");
  assert.equal(roiRowCoverageWords(alex), "No attributed sales");
  assert.equal(roiRowDataWords(salam), null, "a complete window says nothing more");
  assert.equal(roiRowDataWords(hayah), "Partial window · Data pending");
  assert.equal(roiRowDataWords(smouha), "No validated SoS data");
  for (const status of ROI_RESULT_ORDER) assert.ok(ROI_RESULT_TONE[status], `${status} has its tone`);
  assert.match(ROI_RESULT_TONE.behind, /amber/);
  assert.match(ROI_RESULT_TONE.on_track, /emerald/);
  assert.match(ROI_RESULT_TONE.awaiting_data, /sky/, "data still coming is never a warning colour");
}

function theTeam() {
  assert.equal(roiMeasuredCount(KPI), 3);
  assert.equal(roiStandingCaption(KPI), "2 of 3 measured are behind · 1 on track");
  assert.equal(roiStandingCaption({ ...KPI, behindCount: 1 }), "1 of 2 measured is behind · 1 on track");
  assert.equal(roiStandingCaption({ ...KPI, behindCount: 0, onTrackCount: 0 }), "None measured yet · 1 request waiting for sales data");
  assert.equal(roiStandingCaption({ awaitingDataCount: 0, behindCount: 0, noDataCount: 0, onTrackCount: 0 }), "None measured yet");
  assert.equal(roiUnmeasuredCaption(KPI), "1 waiting for sales data · 2 with no sales attributed");
  assert.equal(roiUnmeasuredCaption({ awaitingDataCount: 0, noDataCount: 0 }), "Every request is measured");
  assert.equal(roiActualCaption(KPI), "50% of the required return · forecast 110%");
  assert.equal(roiRequiredCaption(KPI), "3.0 times the cost");
  assert.equal(roiRequiredCaption({ totalEstimatedCost: 0, totalRequiredRoi: 0 }), "Nothing spent in these requests");
  assert.deepEqual(roiTrustNotes(KPI).map((note) => [note.key, note.words]), [
    ["loaded", "Sales loaded to Aug 2026"],
    ["pending", "EGP 5,000 in requests not approved yet, counted in no figure"],
    ["incomplete", "2 requests with a window still open past the loaded month"],
    ["restricted", "1 request with confidential products left out"],
  ]);
  assert.deepEqual(roiTrustNotes({ incompleteWindowCount: 0, pendingValue: 0, restrictedExcludedCount: 0, salesDataAsOf: null }).map((note) => note.words), ["No validated sales loaded yet"]);
}

function theBar() {
  // 1 · 2 · 1 · 2 of 6 = 16.67 · 33.33 · 16.67 · 33.33 → floors 16 · 33 · 16 · 33 = 98; the two larger remainders take a point.
  assert.deepEqual(roiResultBar(KPI).map((part) => [part.key, part.count, part.percent]), [
    ["on_track", 1, 17],
    ["behind", 2, 33],
    ["awaiting_data", 1, 17],
    ["no_data", 2, 33],
  ]);
  for (const counts of [[1, 1, 1, 0], [3, 0, 0, 0], [2, 3, 5, 7], [0, 1, 0, 2]]) {
    const parts = roiResultBar({ awaitingDataCount: counts[2], behindCount: counts[1], noDataCount: counts[3], onTrackCount: counts[0] });
    assert.equal(parts.reduce((sum, part) => sum + part.percent, 0), 100, `${counts.join(",")} add to 100`);
    assert.ok(parts.every((part) => part.count > 0), "an empty result is left out, never a zero-width slice");
  }
  assert.deepEqual(roiResultBar({ awaitingDataCount: 0, behindCount: 0, noDataCount: 0, onTrackCount: 0 }), []);
}

function theRequestsToLookAt() {
  const items = roiRequestsToLookAt(ROWS);
  assert.deepEqual(
    items.map((item) => [item.row.requestCode, item.reason, item.words]),
    [
      ["MKT-1", "behind", "40% of EGP 30,000 · EGP 18,000 short of the required return"],
      ["MKT-2", "behind", "90% of EGP 10,000 · EGP 1,000 short of the required return"],
      ["MKT-5", "nothing_attributed", "Nothing attributed: No pharmacy codes"],
    ],
    "the largest shortfall first, then a closed window with nothing attributed",
  );
  assert.ok(!items.some((item) => item.row.resultStatus === "awaiting_data"), "a window still open is never a request to look at");
  assert.ok(!items.some((item) => item.row.requestCode === "MKT-6"), "nor one whose window the sales have not reached");
  assert.equal(roiRequestsToLookAt(ROWS, 1).length, 1, "the list is held to its limit");
  assert.equal(roiLookAtEmptyLine(KPI), "No request is behind its required return, and none closed with nothing attributed.");
  assert.equal(roiLookAtEmptyLine({ awaitingDataCount: 3, behindCount: 0, onTrackCount: 0 }), "Nothing is measured yet, so nothing is behind.");
}

function theOrderAndThePages() {
  assert.deepEqual(ROI_DEFAULT_SORT, { direction: "desc", key: "shortfall" }, "the request most short leads");
  assert.deepEqual(sortRoiRows(ROWS, ROI_DEFAULT_SORT).map((entry) => entry.requestCode), ["MKT-1", "MKT-2", "MKT-3", "MKT-4", "MKT-5", "MKT-6"]);
  assert.deepEqual(
    sortRoiRows(ROWS, { direction: "desc", key: "actualCoverageRatio" }).map((entry) => entry.requestCode),
    ["MKT-3", "MKT-2", "MKT-1", "MKT-4", "MKT-5", "MKT-6"],
    "a request with no sales attributed has no coverage, and goes last",
  );
  assert.deepEqual(
    sortRoiRows(ROWS, { direction: "asc", key: "actualCoverageRatio" }).map((entry) => entry.requestCode).slice(-2),
    ["MKT-5", "MKT-6"],
    "last whichever way",
  );
  assert.deepEqual(sortRoiRows(ROWS, { direction: "asc", key: "customerName" }).map((entry) => entry.customerName), ["Alex Clinic", "Dar El Fouad", "El Hayah", "El Nour", "El Salam", "Smouha"]);
  assert.deepEqual(sortRoiRows(ROWS, { direction: "asc", key: "resultStatus" }).map((entry) => entry.requestCode), ["MKT-3", "MKT-1", "MKT-2", "MKT-4", "MKT-5", "MKT-6"]);
  assert.deepEqual(nextRoiSort(ROI_DEFAULT_SORT, "customerName"), { direction: "asc", key: "customerName" });
  assert.deepEqual(nextRoiSort({ direction: "asc", key: "customerName" }, "customerName"), { direction: "desc", key: "customerName" });
  assert.deepEqual(nextRoiSort({ direction: "asc", key: "customerName" }, "requiredRoiValue"), { direction: "desc", key: "requiredRoiValue" }, "a figure starts with its largest");
  assert.deepEqual(roiPage(23, 3), { end: 23, page: 3, pages: 3, start: 20 });
  assert.deepEqual(roiPage(23, 9), { end: 23, page: 3, pages: 3, start: 20 }, "held inside the pages there are");
  assert.deepEqual(roiPage(23, 0), { end: 10, page: 1, pages: 3, start: 0 });
  assert.deepEqual(roiPage(0, 1), { end: 0, page: 1, pages: 1, start: 0 });
  assert.equal(roiPageLine(23, roiPage(23, 1)), "1–10 of 23 requests · page 1 of 3");
  assert.equal(roiPageLine(6, roiPage(6, 1)), "6 requests", "one page needs no page words");
  assert.equal(roiPageLine(0, roiPage(0, 1)), "No requests match these filters");
  assert.equal(roiSortLine(ROI_DEFAULT_SORT), "Sorted by shortfall, largest first");
  assert.equal(roiSortLine({ direction: "asc", key: "customerName" }), "Sorted by customer, A to Z");
  assert.equal(roiSortLine({ direction: "asc", key: "resultStatus" }), "Sorted by result, on track first");
}

function theScope() {
  assert.equal(roiScopeLine(12, 12), "12 requests in scope");
  assert.equal(roiScopeLine(1, 1), "1 request in scope");
  assert.equal(roiScopeLine(4, 12), "4 of 12 requests match");
  assert.equal(roiRunAllLabel(12), "Show all 12 requests in scope");
  assert.equal(roiRunAllLabel(1), "Show the 1 request in scope");
}

function theScreen() {
  const read = (path: string) => stripComments(readFileSync(path, "utf8"));
  const engine = read("src/components/marketing-requests/roi-filter-engine.tsx");
  const panels = read("src/components/marketing-requests/roi-report-panels.tsx");
  const page = read("app/employee-portals/marketing-requests/roi-tracking/page.tsx");
  for (const [name, source] of [["engine", engine], ["panels", panels]] as const) {
    assert.ok(!/\brounded/.test(source), `${name}: square corners`);
    assert.ok(!/text-phx-(?:2xs|3xs|4xs)\b/.test(source), `${name}: no text below 11px`);
    assert.ok(!/\btruncate\b|line-clamp|text-ellipsis/.test(source), `${name}: no ellipsis`);
    assert.ok(!/overflow-x-auto|min-w-\[/.test(source), `${name}: never a sideways scroll`);
    assert.ok(!/LA003|LA004|SS001/.test(source), `${name}: the confidential products by name, never by code`);
    assert.ok(!/requesterHrId/.test(source), `${name}: never a raw HR id`);
    assert.ok(!/STATUS_LABELS\b/.test(source), `${name}: one shared status map, never a copy`);
    const literals = source.match(/(["'`])(?:\\.|(?!\1)[\s\S])*\1/g) ?? [];
    const text = [...literals, ...[...source.matchAll(/>([^<>{}]+)</g)].map((match) => match[1] ?? "")];
    assert.ok(!text.some((value) => /\b(?:he|his|him|she|her)\b/i.test(value)), `${name}: no gendered word on screen`);
  }
  // The team's money is the band's — deduplicated on the server — and never re-added from the rows.
  assert.ok(!panels.includes(".reduce("), "the panels add up nothing of their own");
  assert.ok(panels.includes("roiMoney(kpi.totalActualValue)"), "actual sales are the band's");
  assert.ok(panels.includes("roiResultBar(report.kpi)") && panels.includes("roiRequestsToLookAt(report.rows)"), "the bar and the list are the lib's");
  assert.ok(panels.includes("sortRoiRows(report.rows, sort)") && panels.includes("roiPage(sorted.length, pageAsked)"), "order and pages are the lib's");
  assert.ok(panels.includes('<table className="w-full table-fixed'), "the table fits its width");
  assert.ok(panels.includes('className="md:hidden"') && panels.includes('className="hidden md:block"'), "cards on a phone, a table on desktop");
  // Show everything in scope sends no filter at all: the server's own role scope, never wider.
  assert.ok(engine.includes("function runAllInScope() {\n    const empty = emptyRoiFilterState();"), "the whole scope is the empty filter");
  assert.ok(engine.includes("roiRunAllLabel(faceted.totalCount)"), "it names how many requests it reads");
  assert.ok(engine.includes("{roiConfidentialToggleLabel()}"), "the switch names its products");
  assert.ok(engine.includes("<RoiReportView "), "the engine mounts the report panels");
  assert.ok(page.includes('assertEmployeePortalMarketingPageAccess("roi-tracking")'), "the portal page keeps its gate");
}

export function runMarketingRoiTrackingPremiumTests(): void {
  theWords();
  oneRequest();
  theTeam();
  theBar();
  theRequestsToLookAt();
  theOrderAndThePages();
  theScope();
  theScreen();
}
