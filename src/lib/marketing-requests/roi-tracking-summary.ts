/**
 * ROI Tracking — the words, grades, order and pages the screen prints (premium pass, owner, 9 Nov 2026: "eyeball
 * every report in My Team's Reports, premium polish, every single component"). The Filter Engine and its report
 * panels read these functions and decide nothing of their own, on both shells.
 *
 * Pure: it reads the report `getMarketingRoiReport` built and nothing else — no database, no clock.
 *
 *   - 🔴 ACTUAL SALES ACROSS REQUESTS ARE NEVER RE-ADDED HERE. Two campaigns can claim one sale, so the band's
 *     `totalActualValue` is deduplicated through the attribution ledger on the server; every team-level money
 *     figure is read off `kpi`, and only a single row's own figures are read off the row.
 *   - A window still open past the loaded month is "Data pending", never behind: it is never a request to look at
 *     and never a shortfall.
 *   - Sales are "loaded to" a month — never "attributed up to" it (`phx_marketing_roi_latest_validated_period()` is
 *     a completeness flag, not a cap).
 *   - Names, never codes: the confidential products are named, and a request's status is its words.
 */

import type {
  MarketingRoiKpiBand,
  MarketingRoiReportRow,
  MarketingRoiResultStatus,
} from "@/lib/marketing-requests/roi-report-types";
import {
  ROI_DATA_COVERAGE_LABEL,
  ROI_RESULT_STATUS_LABEL,
  marketingRequestStatusLabel,
} from "@/lib/marketing-requests/roi-labels";

// ── Words ────────────────────────────────────────────────────────────────────────────────────────

const MONEY = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** "EGP 12,345" — whole pounds; a figure that is not a number reads 0, never NaN. */
export function roiMoney(value: number): string {
  return `EGP ${MONEY.format(Math.round(Number.isFinite(value) ? value : 0))}`;
}

/** "84%" of a 0..1+ ratio. */
export function roiPercent(ratio: number): string {
  return `${Math.round((Number.isFinite(ratio) ? ratio : 0) * 100)}%`;
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function roiRequestsWord(count: number): string {
  return counted(count, "request", "requests");
}

// Engine-independent month names: the same words on the server and in the browser, whatever the locale.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "2026-08" → "Aug 2026"; anything else is left to the caller as null. */
export function roiMonthWords(period: string | null | undefined): string | null {
  const match = /^(\d{4})-(\d{2})/.exec(period ?? "");
  if (!match) return null;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${month} ${match[1]}` : null;
}

/** The trust line: how far the validated sales reach. Never "attributed up to". */
export function roiSalesLoadedLine(salesDataAsOf: string | null): string {
  const month = roiMonthWords(salesDataAsOf);
  return month ? `Sales loaded to ${month}` : "No validated sales loaded yet";
}

/** A request's status in words, from the one shared map — never the raw value. */
export function roiStatusWords(status: string | null | undefined): string {
  return marketingRequestStatusLabel(status);
}

/** The products the confidential switch reveals, by name (CEO and Super Admin only see the switch). */
export const ROI_CONFIDENTIAL_PRODUCTS = ["Lacto Basic 1", "Lacto Basic 2", "Satoslim"] as const;

export function roiConfidentialToggleLabel(): string {
  return `Include the confidential products — ${ROI_CONFIDENTIAL_PRODUCTS.join(", ")}`;
}

// ── The result of one request ────────────────────────────────────────────────────────────────────

/** The order the four results are told in: the two measured grades, then the two that are not graded yet. */
export const ROI_RESULT_ORDER: readonly MarketingRoiResultStatus[] = ["on_track", "behind", "awaiting_data", "no_data"];

/** The colour of each result's word: green and amber for the two grades, sky for data still coming, slate for none. */
export const ROI_RESULT_TONE: Record<MarketingRoiResultStatus, string> = {
  awaiting_data: "border-sky-200 bg-sky-50 text-sky-800",
  behind: "border-amber-300 bg-amber-50 text-amber-800",
  no_data: "border-slate-200 bg-slate-50 text-slate-600",
  on_track: "border-emerald-300 bg-emerald-50 text-emerald-800",
};

export const ROI_RESULT_SWATCH: Record<MarketingRoiResultStatus, string> = {
  awaiting_data: "bg-sky-400",
  behind: "bg-amber-500",
  no_data: "bg-slate-300",
  on_track: "bg-emerald-600",
};

export function roiResultWords(status: MarketingRoiResultStatus): string {
  return ROI_RESULT_STATUS_LABEL[status];
}

/** How far one request is short of its required return — only a request graded behind is short of anything. */
export function roiShortfall(row: Pick<MarketingRoiReportRow, "actualSalesValue" | "requiredRoiValue" | "resultStatus">): number {
  if (row.resultStatus !== "behind") return 0;
  return Math.max(0, row.requiredRoiValue - row.actualSalesValue);
}

/** "EGP 4,200 short of the required return", or null when nothing is short. */
export function roiShortfallWords(row: Pick<MarketingRoiReportRow, "actualSalesValue" | "requiredRoiValue" | "resultStatus">): string | null {
  const short = roiShortfall(row);
  return short > 0 ? `${roiMoney(short)} short of the required return` : null;
}

/** "84% of the required return", or the words for no sales attributed. */
export function roiRowCoverageWords(row: Pick<MarketingRoiReportRow, "actualCoverageRatio" | "hasSalesData">): string {
  return row.hasSalesData ? roiPercent(row.actualCoverageRatio) : ROI_RESULT_STATUS_LABEL.no_data;
}

/** The window's data words, only when the window is not yet complete. */
export function roiRowDataWords(row: Pick<MarketingRoiReportRow, "dataCoverage">): string | null {
  return row.dataCoverage === "complete" ? null : ROI_DATA_COVERAGE_LABEL[row.dataCoverage];
}

// ── The team, from the band ──────────────────────────────────────────────────────────────────────

export function roiResultCounts(kpi: Pick<MarketingRoiKpiBand, "awaitingDataCount" | "behindCount" | "noDataCount" | "onTrackCount">): Record<MarketingRoiResultStatus, number> {
  return { awaiting_data: kpi.awaitingDataCount, behind: kpi.behindCount, no_data: kpi.noDataCount, on_track: kpi.onTrackCount };
}

/** Requests graded on a finished measure: on track or behind. */
export function roiMeasuredCount(kpi: Pick<MarketingRoiKpiBand, "behindCount" | "onTrackCount">): number {
  return kpi.onTrackCount + kpi.behindCount;
}

/** "3 of 8 measured are behind · 5 on track", or what is still to come when nothing is measured. */
export function roiStandingCaption(kpi: Pick<MarketingRoiKpiBand, "awaitingDataCount" | "behindCount" | "noDataCount" | "onTrackCount">): string {
  const measured = roiMeasuredCount(kpi);
  if (measured === 0) {
    if (kpi.awaitingDataCount > 0) return `None measured yet · ${roiRequestsWord(kpi.awaitingDataCount)} waiting for sales data`;
    return "None measured yet";
  }
  return `${kpi.behindCount} of ${measured} measured ${kpi.behindCount === 1 ? "is" : "are"} behind · ${kpi.onTrackCount} on track`;
}

/** "84% of the required return · forecast 112%". */
export function roiActualCaption(kpi: Pick<MarketingRoiKpiBand, "coverageRatio" | "totalExpectedRoi" | "totalRequiredRoi">): string {
  const forecast = kpi.totalRequiredRoi > 0 ? kpi.totalExpectedRoi / kpi.totalRequiredRoi : 0;
  return `${roiPercent(kpi.coverageRatio)} of the required return · forecast ${roiPercent(forecast)}`;
}

/** "EGP 30,000 required against EGP 10,000 spent", the return asked of the money. */
export function roiRequiredCaption(kpi: Pick<MarketingRoiKpiBand, "totalEstimatedCost" | "totalRequiredRoi">): string {
  if (kpi.totalEstimatedCost <= 0) return "Nothing spent in these requests";
  return `${(kpi.totalRequiredRoi / kpi.totalEstimatedCost).toFixed(1)} times the cost`;
}

/** "2 waiting for sales data · 1 with no sales attributed". */
export function roiUnmeasuredCaption(kpi: Pick<MarketingRoiKpiBand, "awaitingDataCount" | "noDataCount">): string {
  const parts = [
    kpi.awaitingDataCount > 0 ? `${kpi.awaitingDataCount} waiting for sales data` : null,
    kpi.noDataCount > 0 ? `${kpi.noDataCount} with no sales attributed` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : "Every request is measured";
}

export type RoiBarPart = { key: MarketingRoiResultStatus; label: string; count: number; percent: number; swatch: string };

/** The four results as one bar of whole percents adding to exactly 100; the larger remainder takes a leftover point. */
export function roiResultBar(kpi: Pick<MarketingRoiKpiBand, "awaitingDataCount" | "behindCount" | "noDataCount" | "onTrackCount">): RoiBarPart[] {
  const counts = roiResultCounts(kpi);
  const present = ROI_RESULT_ORDER.filter((key) => counts[key] > 0);
  const whole = present.reduce((sum, key) => sum + counts[key], 0);
  if (whole === 0) return [];
  const parts = present.map((key) => {
    const exact = (counts[key] / whole) * 100;
    return { count: counts[key], exact, key, label: ROI_RESULT_STATUS_LABEL[key], percent: Math.floor(exact), swatch: ROI_RESULT_SWATCH[key] };
  });
  let left = 100 - parts.reduce((sum, part) => sum + part.percent, 0);
  for (const part of [...parts].sort((a, b) => b.exact - b.percent - (a.exact - a.percent))) {
    if (left <= 0) break;
    part.percent += 1;
    left -= 1;
  }
  return parts.map(({ count, key, label, percent, swatch }) => ({ count, key, label, percent, swatch }));
}

/** The trust notes beside the band, each only when it applies. */
export function roiTrustNotes(kpi: Pick<MarketingRoiKpiBand, "incompleteWindowCount" | "pendingValue" | "restrictedExcludedCount" | "salesDataAsOf">): Array<{ key: string; words: string; tone: "plain" | "sky" | "amber" }> {
  return [
    { key: "loaded", tone: "plain" as const, words: roiSalesLoadedLine(kpi.salesDataAsOf) },
    kpi.pendingValue > 0 ? { key: "pending", tone: "sky" as const, words: `${roiMoney(kpi.pendingValue)} in requests not approved yet, counted in no figure` } : null,
    kpi.incompleteWindowCount > 0
      ? { key: "incomplete", tone: "amber" as const, words: `${roiRequestsWord(kpi.incompleteWindowCount)} with a window still open past the loaded month` }
      : null,
    kpi.restrictedExcludedCount > 0
      ? { key: "restricted", tone: "plain" as const, words: `${roiRequestsWord(kpi.restrictedExcludedCount)} with confidential products left out` }
      : null,
  ].filter((note): note is { key: string; words: string; tone: "plain" | "sky" | "amber" } => note !== null);
}

// ── Requests to look at ──────────────────────────────────────────────────────────────────────────

export type RoiLookAtItem = { row: MarketingRoiReportRow; reason: "behind" | "nothing_attributed"; words: string };

/**
 * The requests worth a manager's look: those behind, the largest shortfall first; then those whose window is over
 * with nothing attributed and a reason the engine gave (a pharmacy with no code, say). A window still open is never
 * here — its sales have not arrived.
 */
export function roiRequestsToLookAt(rows: readonly MarketingRoiReportRow[], limit = 8): RoiLookAtItem[] {
  const behind = rows
    .filter((row) => roiShortfall(row) > 0)
    .sort((a, b) => roiShortfall(b) - roiShortfall(a) || a.requestCode.localeCompare(b.requestCode))
    .map((row) => ({ reason: "behind" as const, row, words: `${roiPercent(row.actualCoverageRatio)} of ${roiMoney(row.requiredRoiValue)} · ${roiShortfallWords(row)}` }));
  const nothing = rows
    .filter((row) => row.resultStatus === "no_data" && row.dataCoverage === "complete" && Boolean(row.attributionGapReason))
    .sort((a, b) => b.requiredRoiValue - a.requiredRoiValue || a.requestCode.localeCompare(b.requestCode))
    .map((row) => ({ reason: "nothing_attributed" as const, row, words: `Nothing attributed: ${row.attributionGapReason}` }));
  return [...behind, ...nothing].slice(0, limit);
}

export function roiLookAtEmptyLine(kpi: Pick<MarketingRoiKpiBand, "behindCount" | "onTrackCount" | "awaitingDataCount">): string {
  if (roiMeasuredCount(kpi) === 0) return "Nothing is measured yet, so nothing is behind.";
  return "No request is behind its required return, and none closed with nothing attributed.";
}

// ── Order and pages ──────────────────────────────────────────────────────────────────────────────

export type RoiSortKey =
  | "requestCode"
  | "requesterName"
  | "line"
  | "customerName"
  | "status"
  | "roiWindow"
  | "requiredRoiValue"
  | "actualSalesValue"
  | "actualCoverageRatio"
  | "shortfall"
  | "resultStatus";
export type RoiSortDirection = "asc" | "desc";
export type RoiSortState = { key: RoiSortKey; direction: RoiSortDirection };

export const ROI_SORT_LABEL: Record<RoiSortKey, string> = {
  actualCoverageRatio: "Actual coverage",
  actualSalesValue: "Actual sales",
  customerName: "Customer",
  line: "Line",
  requestCode: "Request",
  requesterName: "Requester",
  requiredRoiValue: "Required return",
  resultStatus: "Result",
  roiWindow: "ROI window",
  shortfall: "Shortfall",
  status: "Status",
};

/** The default order: the largest shortfall first, so the request that most needs a look leads. */
export const ROI_DEFAULT_SORT: RoiSortState = { direction: "desc", key: "shortfall" };

const RESULT_WEIGHT: Record<MarketingRoiResultStatus, number> = { awaiting_data: 2, behind: 1, no_data: 3, on_track: 0 };

export function roiSortValue(row: MarketingRoiReportRow, key: RoiSortKey): string | number | null {
  switch (key) {
    case "requestCode":
      return row.requestCode;
    case "requesterName":
      return row.requesterName ?? "";
    case "line":
      return row.line ?? "";
    case "customerName":
      return row.customerName;
    case "status":
      return roiStatusWords(row.status);
    case "roiWindow":
      return row.roiWindow ?? "";
    case "requiredRoiValue":
      return row.requiredRoiValue;
    case "actualSalesValue":
      return row.actualSalesValue;
    case "actualCoverageRatio":
      return row.hasSalesData ? row.actualCoverageRatio : null;
    case "shortfall":
      return roiShortfall(row);
    case "resultStatus":
      return RESULT_WEIGHT[row.resultStatus];
  }
}

function compare(left: string | number | null, right: string | number | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), undefined, { sensitivity: "base" });
}

/** Sorted by the chosen key; a missing value always goes last, whichever way; ties by request code. */
export function sortRoiRows(rows: readonly MarketingRoiReportRow[], sort: RoiSortState): MarketingRoiReportRow[] {
  return [...rows].sort((a, b) => {
    const left = roiSortValue(a, sort.key);
    const right = roiSortValue(b, sort.key);
    if (left === null || right === null) return compare(left, right) || a.requestCode.localeCompare(b.requestCode);
    const cmp = compare(left, right);
    return (sort.direction === "asc" ? cmp : -cmp) || a.requestCode.localeCompare(b.requestCode);
  });
}

/** A new key starts ascending, except a figure, which starts with its largest; the same key turns round. */
export function nextRoiSort(current: RoiSortState, key: RoiSortKey): RoiSortState {
  if (current.key === key) return { direction: current.direction === "asc" ? "desc" : "asc", key };
  const figure = key === "requiredRoiValue" || key === "actualSalesValue" || key === "actualCoverageRatio" || key === "shortfall";
  return { direction: figure ? "desc" : "asc", key };
}

export const ROI_ROWS_PER_PAGE = 10;

export type RoiPage = { page: number; pages: number; start: number; end: number };

/** The page asked for, held inside the pages there are. `start` and `end` index the sorted rows. */
export function roiPage(total: number, page: number, perPage = ROI_ROWS_PER_PAGE): RoiPage {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), pages);
  const start = (current - 1) * perPage;
  return { end: Math.min(start + perPage, total), page: current, pages, start };
}

/** "1–10 of 23 requests · page 1 of 3", or the empty words. */
export function roiPageLine(total: number, page: RoiPage): string {
  if (total === 0) return "No requests match these filters";
  if (page.pages === 1) return roiRequestsWord(total);
  return `${page.start + 1}–${page.end} of ${roiRequestsWord(total)} · page ${page.page} of ${page.pages}`;
}

/** "Sorted by shortfall, largest first". */
export function roiSortLine(sort: RoiSortState): string {
  const figure = sort.key === "requiredRoiValue" || sort.key === "actualSalesValue" || sort.key === "actualCoverageRatio" || sort.key === "shortfall";
  const way = figure ? (sort.direction === "desc" ? "largest first" : "smallest first") : sort.direction === "asc" ? "A to Z" : "Z to A";
  if (sort.key === "resultStatus") return `Sorted by result, ${sort.direction === "asc" ? "on track first" : "no sales attributed first"}`;
  return `Sorted by ${ROI_SORT_LABEL[sort.key].toLowerCase()}, ${way}`;
}

// ── The scope ────────────────────────────────────────────────────────────────────────────────────

/** "12 requests in scope", or "4 of 12 match" once a filter narrows them. */
export function roiScopeLine(matched: number, total: number): string {
  if (matched === total) return `${roiRequestsWord(total)} in scope`;
  return `${matched} of ${roiRequestsWord(total)} match`;
}

/** The button that runs the report over everything this viewer may see, with no filter. */
export function roiRunAllLabel(total: number): string {
  return total === 1 ? "Show the 1 request in scope" : `Show all ${total} requests in scope`;
}
