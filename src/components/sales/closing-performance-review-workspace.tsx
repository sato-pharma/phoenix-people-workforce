"use client";

import { AlertTriangle, Download, Loader2, RefreshCw, Trophy } from "lucide-react";
import { Fragment, useMemo, useRef, useState } from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { ClosingPeriodSelect } from "@/components/sales/closing-period-select";
import {
  MonthlyClosingFilters,
  emptyMonthlyClosingFilter,
  type MonthlyClosingFilter,
} from "@/components/sales/monthly-closing-filters";
import { CrmCard, CrmCardsOnPhone, CrmFacts } from "@/components/phoenix-crm/ui";
import { Button } from "@/components/ui/button";
import { MatrixScroller } from "@/components/ui/matrix-scroller";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { emptyMonthlyClosingFilterOptions } from "@/lib/sales/monthly-closing-filter-options";
import { describePeriodSelection } from "@/lib/sales/monthly-closing-period-merge";
import type {
  ClosingPerformanceReview,
  PerformanceMatrix,
  PerformanceProductMonthMatrix,
  PerformanceReviewSeriesRow,
} from "@/lib/sales/closing-performance-review";
import {
  GROWTH_NO_BASE,
  performanceReviewRegionStyle,
  PERFORMANCE_REVIEW_FIRST_PERIOD,
  reviewTotalRowLabel,
  type PerformanceReviewGrowth,
} from "@/lib/sales/closing-performance-review-regions";
import { phxSelectClassName } from "@/components/ui/form-tokens";

// The screen half of the Performance Review. Its sections are the workbook's tabs, in the same
// order, from the same object — the owner's rule is that an export matches the screen, and the
// cheapest way to keep that true is for both to render one payload.
//
// Units appear only where the thing being counted IS one product code: "Units and growth by month"
// (a row per product) and "Reps and areas · products by month" (a BLOCK per product, months inside
// it). Everywhere else the measure is value, because units of different products are never added.

type Props = {
  /**
   * Which shell this is mounted in. "admin" draws its own page hero, as it always has; "portal"
   * leaves the title and the blurb to EmployeePortalPageShell and prints the same chips as a compact
   * strip instead, so a manager's tab does not carry two mastheads (owner, 2026-10-13).
   *
   * Presentation only. The bound a portal viewer reads under is applied SERVER-side before this
   * component ever sees a row, so no prop here can widen it.
   */
  chrome?: "admin" | "portal";
  initialError: string | null;
  initialReview: ClosingPerformanceReview | null;
  /** One sentence naming what the figures cover — "Scoped to your own areas." Portal only. */
  scopeNote?: string | null;
};

const EM = "—";
const DOT = "·";

const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-07" -> "July 2026". Falls back to the raw period rather than inventing one. */
function longMonth(period: string | null | undefined): string {
  const raw = String(period ?? "").trim();
  const match = /^(\d{4})-(\d{2})$/.exec(raw);
  if (!match) return raw || EM;
  const name = MONTHS_LONG[Number(match[2]) - 1];
  return name ? name + " " + match[1] : raw;
}

/** "2026-07" -> "Jul". The narrow heading of a by-month column. */
function shortMonth(period: string): string {
  const raw = period.trim();
  const match = /^(\d{4})-(\d{2})$/.exec(raw);
  if (!match) return raw;
  return MONTHS_SHORT[Number(match[2]) - 1] ?? raw;
}

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** One figure. Nothing sold reads as a dot; never uploaded reads as a dash — they are not the same. */
function Figure({ value }: { value: number | null }) {
  if (value == null) return <span className="text-slate-300">{EM}</span>;
  if (value === 0) return <span className="text-slate-300">{DOT}</span>;
  return <span className="tabular-nums">{numberFormat.format(value)}</span>;
}

function achievementClass(ratio: number | null): string {
  if (ratio == null) return "text-slate-400";
  if (ratio >= 0.8) return "text-teal-700";
  if (ratio >= 0.55) return "text-amber-700";
  return "text-red-700";
}

/** No target is a fact about the area, not a failure — it never renders as 0%. */
function Achievement({ ratio }: { ratio: number | null }) {
  if (ratio == null) return <span className="text-xs italic text-slate-400">no target</span>;
  return <span className={"font-black tabular-nums " + achievementClass(ratio)}>{(ratio * 100).toFixed(1)}%</span>;
}

/** "new" when the month before has nothing on record; "—" when it stood at zero or below (returns). */
/** The "Achievement" heading, short on a phone where a narrow column cannot hold the whole word. */
function AchievementHead() {
  return (
    <>
      <span className="hidden sm:inline">Achievement</span>
      <span className="sm:hidden">Ach %</span>
    </>
  );
}

function Growth({ ratio }: { ratio: PerformanceReviewGrowth }) {
  if (ratio == null) return <span className="text-xs italic text-slate-400">new</span>;
  if (ratio === GROWTH_NO_BASE) return <span className="text-xs text-slate-400">—</span>;
  const sign = ratio >= 0 ? "+" : "−";
  return (
    <span className={"font-black tabular-nums " + (ratio >= 0 ? "text-teal-700" : "text-red-700")}>
      {sign}{Math.abs(ratio * 100).toFixed(1)}%
    </span>
  );
}

/** The region swatch — the same colour the workbook paints that region on every tab. */
function RegionDot({ regionCode }: { regionCode: string }) {
  const style = performanceReviewRegionStyle(regionCode);
  return (
    <span
      aria-hidden
      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: "#" + style.chip.slice(2) }}
    />
  );
}

// These wrap by default so the ranked/summary tables below can be table-fixed and fit
// their container. The three MATRIX tables (GridTable, the month series, and the
// per-product month blocks) keep a sideways scroll on purpose — their column count is
// the product/month count and can never fit — so each re-applies nowrap on its own
// <table> with [&_th]/[&_td], and all three share the ONE declared scroller,
// MatrixScroller — moved to src/components/ui so the weekly per-product units grid
// shares the same single permission rather than opening a fourth one.
const headClassName =
  "break-words px-3 py-2.5 text-left text-phx-sm font-black uppercase tracking-[0.14em] text-slate-500";
const cellClassName = "break-words px-3 py-2 text-sm text-slate-700";

/**
 * The owner's shape: who on the left, what across the top.
 *
 * Four sticky columns name the row — rep, area, district manager, region — then one column per
 * family or product code, then the row's own total, target and achievement. The cell is units on the
 * by-product grid and value on the by-family grid; the row total is value on both, because adding a
 * row's units across products is the one sum that is never done.
 *
 * `totalLabel` is what the bottom row is CALLED — "National total" only when the view really covers
 * the whole line. It is passed in rather than decided here because the grid alone cannot tell: the
 * rows it holds are the ones that survived the filter, and the full option lists live on the payload.
 */
function GridTable({
  grid,
  measure,
  totalLabel,
}: {
  grid: PerformanceMatrix;
  measure: "units" | "value";
  totalLabel: string;
}) {
  const stickyHead = headClassName + " sticky left-0 z-20 bg-slate-50";
  // EXEMPT from the fits-the-screen sweep, deliberately: one column PER PRODUCT, so the width is
  // the product count and no merge can bound it — the same shape as the monthly closing matrix,
  // which the owner ruled keeps its scroll. The sticky first column is the frozen-rep-name half of
  // that design and only works with a sideways scroll.
  return (
    <MatrixScroller>
      <table className="w-full border-collapse [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
        <thead className="border-b border-slate-200 bg-slate-50/80">
          <tr>
            <th className={stickyHead}>Rep</th>
            <th className={headClassName}>Area</th>
            <th className={headClassName}>District manager</th>
            <th className={headClassName}>Region</th>
            {grid.columns.map((column) => (
              <th className={headClassName + " text-right"} key={column.key} title={column.subLabel}>
                {column.label}
              </th>
            ))}
            <th className={headClassName + " text-right"}>{measure === "units" ? "Total value" : "Total"}</th>
            <th className={headClassName + " text-right"}>Target</th>
            <th className={headClassName + " text-right"}>Ach %</th>
          </tr>
        </thead>
        <tbody>
          {grid.rows.map((row, index) => {
            const isTotal = row.kind !== "area";
            const tone = row.kind === "grandTotal"
              ? "bg-slate-900 text-white"
              : row.kind === "regionSubtotal"
                ? "bg-sky-50 font-semibold"
                : index % 2 === 1
                  ? "bg-slate-50/50"
                  : "";
            const stickyCell =
              cellClassName +
              " sticky left-0 z-10 font-semibold " +
              (row.kind === "grandTotal"
                ? "bg-slate-900 text-white"
                : row.kind === "regionSubtotal"
                  ? "bg-sky-50 text-slate-900"
                  : index % 2 === 1
                    ? "bg-slate-50 text-slate-900"
                    : "bg-white text-slate-900");
            return (
              <tr className={tone} key={row.kind + ":" + row.areaCode + ":" + index}>
                <td className={stickyCell}>
                  {row.kind !== "area" ? (
                    row.kind === "grandTotal" ? totalLabel : row.regionName + " total"
                  ) : row.repName ? (
                    row.repName
                  ) : row.repIsVacant ? (
                    <span className="text-xs italic text-slate-400">Vacant seat</span>
                  ) : (
                    <span className="text-slate-300">{EM}</span>
                  )}
                </td>
                <td className={cellClassName}>{isTotal ? "" : row.areaName}</td>
                <td className={cellClassName}>
                  {isTotal ? "" : (row.managerName ?? <span className="text-slate-300">{EM}</span>)}
                </td>
                <td className={cellClassName}>
                  {isTotal ? "" : (
                    <span className="flex items-center gap-2">
                      <RegionDot regionCode={row.regionCode} />
                      <span className="text-slate-500">{row.regionName}</span>
                    </span>
                  )}
                </td>
                {grid.columns.map((column, columnIndex) => (
                  <td className={cellClassName + " text-right" + (isTotal ? " font-semibold" : "")} key={column.key}>
                    <Figure value={(measure === "units" ? row.units : row.values)[columnIndex] ?? null} />
                  </td>
                ))}
                <td className={cellClassName + " text-right font-semibold"}><Figure value={row.salesValue} /></td>
                <td className={cellClassName + " text-right"}><Figure value={row.targetValue} /></td>
                <td className={cellClassName + " text-right"}><Achievement ratio={row.achievement} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </MatrixScroller>
  );
}

function SeriesTable({
  months,
  regionCodeOf,
  rowHeading,
  rows,
  subHeading,
}: {
  months: string[];
  /** Supplied only for the area series, whose sub-label is a region. */
  regionCodeOf?: (row: PerformanceReviewSeriesRow) => string;
  rowHeading: string;
  rows: PerformanceReviewSeriesRow[];
  subHeading: string;
}) {
  // EXEMPT, deliberately: one column PER MONTH in the series, so the width is the month count.
  // Same ruling as the closing matrix — the scroll stays.
  return (
    <MatrixScroller>
      <table className="w-full border-collapse [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
        <thead className="border-b border-slate-200 bg-slate-50/80">
          <tr>
            <th className={headClassName}>{rowHeading}</th>
            <th className={headClassName}>{subHeading}</th>
            {months.map((month) => (
              <th className={headClassName + " text-right"} key={month}>{shortMonth(month)}</th>
            ))}
            <th className={headClassName + " text-right"}>Growth</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr className={index % 2 === 1 ? "bg-slate-50/50" : undefined} key={row.key}>
              <td className={cellClassName + " font-semibold text-slate-900"}>{row.label}</td>
              <td className={cellClassName}>
                <span className="flex items-center gap-2">
                  {regionCodeOf ? <RegionDot regionCode={regionCodeOf(row)} /> : null}
                  <span className="text-slate-500">{row.subLabel}</span>
                </span>
              </td>
              {row.perMonth.map((value, monthIndex) => (
                <td className={cellClassName + " text-right"} key={months[monthIndex] ?? String(monthIndex)}>
                  <Figure value={value} />
                </td>
              ))}
              <td className={cellClassName + " text-right"}><Growth ratio={row.growth} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </MatrixScroller>
  );
}

/**
 * Reps and areas down the side, one PRODUCT per block across the top, its months inside the block.
 *
 * The owner's shape for this one: the product name merges over its own run of months plus that
 * product's growth, then the next product's block begins. Every figure is units, and they are a real
 * quantity because a block never spans more than one product code — which is also why there is no
 * row total here: a row spans products, and units of different products are never added.
 */
function ProductMonthTable({
  grid,
  totalLabel,
}: {
  grid: PerformanceProductMonthMatrix;
  totalLabel: string;
}) {
  const stickyHead = headClassName + " sticky left-0 z-20 bg-slate-50";
  const perProduct = grid.months.length + 1;
  // EXEMPT from the fits-the-screen sweep, deliberately, and for the two reasons already ruled on
  // elsewhere on this page: one block PER PRODUCT and one column PER MONTH inside it, so the width
  // is the product count times the month count and no merge can bound it. The sticky rep column is
  // the frozen-names half of that design and only works with a sideways scroll.
  return (
    <MatrixScroller>
      <table className="w-full border-collapse [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
        <thead className="border-b border-slate-200 bg-slate-50/80">
          <tr>
            <th className={stickyHead} colSpan={4}>
              Who sold it
            </th>
            {grid.columns.map((column) => (
              <th
                className={headClassName + " border-l border-slate-300 text-center"}
                colSpan={perProduct}
                key={column.key}
                title={column.subLabel}
              >
                {column.label}
              </th>
            ))}
          </tr>
          <tr>
            <th className={stickyHead}>Rep</th>
            <th className={headClassName}>Area</th>
            <th className={headClassName}>District manager</th>
            <th className={headClassName}>Region</th>
            {grid.columns.map((column) => (
              <Fragment key={column.key}>
                {grid.months.map((month, monthIndex) => (
                  <th
                    className={
                      headClassName + " text-right" + (monthIndex === 0 ? " border-l border-slate-300" : "")
                    }
                    key={column.key + ":" + month}
                  >
                    {shortMonth(month)}
                  </th>
                ))}
                <th className={headClassName + " text-right"}>Growth</th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.rows.map((row, index) => {
            const isTotal = row.kind !== "area";
            const tone = row.kind === "grandTotal"
              ? "bg-slate-900 text-white"
              : row.kind === "regionSubtotal"
                ? "bg-sky-50 font-semibold"
                : index % 2 === 1
                  ? "bg-slate-50/50"
                  : "";
            const stickyCell =
              cellClassName +
              " sticky left-0 z-10 font-semibold " +
              (row.kind === "grandTotal"
                ? "bg-slate-900 text-white"
                : row.kind === "regionSubtotal"
                  ? "bg-sky-50 text-slate-900"
                  : index % 2 === 1
                    ? "bg-slate-50 text-slate-900"
                    : "bg-white text-slate-900");
            return (
              <tr className={tone} key={row.kind + ":" + row.areaCode + ":" + index}>
                <td className={stickyCell}>
                  {row.kind !== "area" ? (
                    row.kind === "grandTotal" ? totalLabel : row.regionName + " total"
                  ) : row.repName ? (
                    row.repName
                  ) : row.repIsVacant ? (
                    <span className="text-xs italic text-slate-400">Vacant seat</span>
                  ) : (
                    <span className="text-slate-300">{EM}</span>
                  )}
                </td>
                <td className={cellClassName}>{isTotal ? "" : row.areaName}</td>
                <td className={cellClassName}>
                  {isTotal ? "" : (row.managerName ?? <span className="text-slate-300">{EM}</span>)}
                </td>
                <td className={cellClassName}>
                  {isTotal ? "" : (
                    <span className="flex items-center gap-2">
                      <RegionDot regionCode={row.regionCode} />
                      <span className="text-slate-500">{row.regionName}</span>
                    </span>
                  )}
                </td>
                {grid.columns.map((column, productIndex) => (
                  <Fragment key={column.key}>
                    {grid.months.map((month, monthIndex) => (
                      <td
                        className={
                          cellClassName +
                          " text-right" +
                          (isTotal ? " font-semibold" : "") +
                          (monthIndex === 0 ? " border-l border-slate-300" : "")
                        }
                        key={column.key + ":" + month}
                      >
                        <Figure value={row.units[productIndex]?.[monthIndex] ?? null} />
                      </td>
                    ))}
                    <td className={cellClassName + " text-right"}>
                      <Growth ratio={row.growth[productIndex] ?? null} />
                    </td>
                  </Fragment>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </MatrixScroller>
  );
}

export function ClosingPerformanceReviewWorkspace({
  chrome = "admin",
  initialError,
  initialReview,
  scopeNote = null,
}: Props) {
  const isPortal = chrome === "portal";
  const [review, setReview] = useState<ClosingPerformanceReview | null>(initialReview);
  const [error, setError] = useState<string | null>(initialError);
  const [isLoading, setIsLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [filter, setFilter] = useState<MonthlyClosingFilter>(emptyMonthlyClosingFilter);
  // The search box types a character at a time and every change here costs a server round trip, so
  // changes are collected for a moment before one request goes out. A side benefit on the tick
  // boxes: selecting five areas in a row sends one request, not five.
  const filterDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const line = review?.line ?? "";
  const period = review?.period ?? "";
  const months = review?.months ?? [];

  // What every total row that closes a whole table is CALLED. A filtered view's bottom row is not a
  // national anything — three areas of fifty-eight, or one product of twelve, is a FILTERED total,
  // and the workbook reads the same helper so the export and the screen cannot disagree.
  const totalLabel = review ? reviewTotalRowLabel(review) : "National total";

  // The months the headline figures actually cover — one, or several folded together. Distinct from
  // `months` above, which is the by-month SERIES behind the growth tabs and is always a run of them.
  const selectedPeriods = review?.selectedPeriods?.length ? review.selectedPeriods : period ? [period] : [];
  const periodSpan = describePeriodSelection(selectedPeriods);
  const isMultiPeriod = selectedPeriods.length > 1;

  // The pickers' options are built on the SERVER from the unfiltered matrix and ride along in the
  // payload. Deriving them here from `review.areas` would offer only the rows that survived the
  // current filter, so narrowing to one region would delete every other region from the control
  // that is meant to let you switch between them.
  const filterOptions = review?.filterOptions ?? emptyMonthlyClosingFilterOptions;

  const filterIsActive =
    filter.regionCodes.length > 0 ||
    filter.areaCodes.length > 0 ||
    filter.productCodes.length > 0 ||
    filter.search.trim().length > 0;

  const skippedPeriods = review?.skippedPeriods ?? [];

  // The series starts at the review's first period (July 2026) and fills forward. Saying the span
  // out loud is the whole point: "1 months of history" reads as a bug, and an unexplained single
  // column reads as a broken report. For a manager in the portal it is his PUBLISHED months from
  // July upward, so the sentence is also how he sees which ones he has. The workbook prints the same
  // sentence, from the same rule.
  const seriesSpan =
    months.length === 0
      ? "Series starts " + longMonth(PERFORMANCE_REVIEW_FIRST_PERIOD)
      : months.length === 1
        ? longMonth(months[0]) + " — the series starts here"
        : months.length + " months — " + longMonth(months[0]) + " to " + longMonth(months[months.length - 1]);

  // The area series carries a region NAME as its sub-label, and the palette is keyed by CODE, so the
  // swatch needs this translation. Without it every area row would take the neutral fallback colour
  // and the area tab would be the one place the region key does not hold.
  const regionCodeByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of review?.regions ?? []) map.set(group.regionName, group.regionCode);
    return map;
  }, [review]);

  /**
   * Re-read the review.
   *
   * The filter travels to the SERVER, unlike the Monthly Closing screen's own, because this page is
   * six views derived from the matrix rather than the matrix itself. Narrowing them in the browser
   * would leave a rank of "3rd of 50" printed above a table showing four rows, and a national total
   * that still counted every area. Filtering the matrix first and re-deriving is the only way the
   * headline numbers stay true to what is on the screen.
   */
  async function reload(nextLine: string, nextPeriods: string[], nextFilter: MonthlyClosingFilter) {
    setIsLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams();
      if (nextLine) query.set("line", nextLine);
      // `period` is the single-month parameter the route has always understood; `periods` is the
      // multi-month one. A selection of exactly one keeps the original path.
      if (nextPeriods.length === 1) query.set("period", nextPeriods[0]);
      else if (nextPeriods.length > 1) query.set("periods", nextPeriods.join(","));
      if (nextFilter.regionCodes.length > 0) query.set("regions", nextFilter.regionCodes.join(","));
      if (nextFilter.areaCodes.length > 0) query.set("areas", nextFilter.areaCodes.join(","));
      if (nextFilter.productCodes.length > 0) query.set("products", nextFilter.productCodes.join(","));
      if (nextFilter.search.trim() !== "") query.set("search", nextFilter.search.trim());
      const response = await fetch("/api/sales/monthly-closing/performance-review?" + query.toString(), {
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        data?: ClosingPerformanceReview;
        error?: string;
        success: boolean;
      };
      if (payload.success && payload.data) setReview(payload.data);
      else setError(payload.error ?? "Failed to load the Performance Review.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to load the Performance Review.");
    } finally {
      setIsLoading(false);
    }
  }

  /** Move the pickers now, ask the server in a moment. */
  function applyFilter(next: MonthlyClosingFilter) {
    setFilter(next);
    if (filterDebounce.current) clearTimeout(filterDebounce.current);
    filterDebounce.current = setTimeout(() => void reload(line, selectedPeriods, next), 350);
  }

  async function handleExport() {
    if (!review) return;
    setIsExporting(true);
    setError(null);
    try {
      // The workbook is sent the SAME selection and the SAME filter the screen is showing. The
      // owner's rule is that an export matches the screen: a workbook covering three months, or
      // every region, while the reader is looking at one month of Delta would be different data
      // wearing the same title.
      const response = await fetch("/api/sales/monthly-closing/performance-review/export", {
        body: JSON.stringify({
          areas: filter.areaCodes,
          line: review.line,
          months: review.months.length,
          period: review.period,
          periods: selectedPeriods,
          products: filter.productCodes,
          regions: filter.regionCodes,
          search: filter.search,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Export failed.");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = /filename="(.+?)"/.exec(disposition);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = match?.[1] ?? "sato-performance-review.xlsx";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Export failed.");
    } finally {
      setIsExporting(false);
    }
  }

  if (!review) {
    return (
      <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-phx-line bg-phx-paper p-5 sm:p-6 xl:p-8">
        <AdminCallout tone="danger">
          <AlertTriangle className="h-4 w-4" />
          <p>{error ?? "No closing has been uploaded yet, so there is nothing to review."}</p>
        </AdminCallout>
      </div>
    );
  }

  const selectClassName  = phxSelectClassName;

  // The same five facts in both shells, from one place — the admin hero's badge row and the portal's
  // own strip must never drift into saying different things about the same payload.
  const chips = (
    <>
      <AdminInsightChip>Line: {line || "None"}</AdminInsightChip>
      <AdminInsightChip>
        {isMultiPeriod ? "Months" : "Month"}: {selectedPeriods.length > 0 ? periodSpan : "No validated data"}
      </AdminInsightChip>
      <AdminInsightChip tone="slate">Areas: {review.areas.length}</AdminInsightChip>
      <AdminInsightChip tone="slate">District managers: {review.managers.length}</AdminInsightChip>
      <AdminInsightChip tone="orange">{seriesSpan}</AdminInsightChip>
    </>
  );

  return (
    <div className={isPortal ? "space-y-7" : "min-h-[calc(100vh-7rem)] space-y-7"}>
      {isPortal ? (
        <div className="flex flex-col gap-3 border border-phx-line bg-white p-4 shadow-[0_10px_30px_rgba(15,23,42,0.05)] sm:p-5">
          <div className="flex flex-wrap items-center gap-2">{chips}</div>
          {scopeNote ? (
            <p className="text-xs font-semibold text-slate-500">{scopeNote}</p>
          ) : null}
        </div>
      ) : (
        <AdminPageHero
          badges={chips}
          description="Who sold what, ranked. Reps, district managers and regions against target, then the same line broken down by product and by area, month by month. The by-month views start at July 2026 and fill forward: earlier months were closed on a different area map and are not comparable. Export downloads exactly these views as a Sato-branded workbook."
          eyebrow="Monthly Closing"
          icon={<Trophy className="h-4 w-4" />}
          title="Performance Review"
        />
      )}

      {error ? (
        <AdminCallout tone="danger">
          <AlertTriangle className="h-4 w-4" />
          <p>{error}</p>
        </AdminCallout>
      ) : null}

      {/* A requested month the closing could not read is NAMED. Silently totalling two months when
          three were asked for is the failure this banner exists to make impossible. */}
      {skippedPeriods.length > 0 ? (
        <AdminCallout tone="warning">
          <AlertTriangle className="h-4 w-4" />
          <p>
            No validated closing for {skippedPeriods.map((entry) => longMonth(entry)).join(", ")} — every figure
            below covers {periodSpan} only.
          </p>
        </AdminCallout>
      ) : null}

      {/* The filter bar narrows every section at once, and it does so on the SERVER: the ranks,
          the region subtotals and the national total are all re-derived from what survives, so a
          rank of "3rd" always counts the rows the reader can actually see. */}
      <div className="flex flex-col gap-3 rounded-[28px] border border-phx-line bg-white p-4 shadow-[0_10px_30px_rgba(15,23,42,0.05)] sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-phx-sm font-black uppercase tracking-[0.18em] text-slate-500">Filter the review</span>
          <span className="text-xs font-semibold text-slate-500">
            {filterIsActive
              ? "Showing " + review.areas.length + " " + (review.areas.length === 1 ? "area" : "areas") +
                " " + DOT + " every total below is recalculated from these rows"
              : review.scopeIsBounded
                // A bounded viewer has not filtered anything, and his unfiltered view is still not
                // the line — saying "every area on the line" over his own district would be the same
                // false claim `reviewTotalRowLabel` refuses to print on his total row.
                ? "Every area in your scope"
                : "Every area on the line"}
          </span>
        </div>
        <MonthlyClosingFilters
          areas={filterOptions.areas}
          onChange={applyFilter}
          products={filterOptions.products}
          regions={filterOptions.regions}
          value={filter}
        />
      </div>

      {/* The grids lead the page, as they lead the workbook: who is on the left, what they sold
          across the top. Every other section below is a different cut of these same numbers. */}
      <AdminTableShell
        action={(
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            {/* A viewer with exactly one line gets no picker at all. His line is resolved from his
                HR_ID, not chosen, and a select holding one locked option invites a press that can
                only fail — the portal Monthly Closing locks the same box for the same reason. The
                admin always holds three, so this is unchanged there. */}
            {review.availableLines.length > 1 ? (
              <label className="flex flex-col gap-1 sm:w-44">
                <span className="text-phx-sm font-bold uppercase tracking-[0.16em] text-slate-500">Line</span>
                <SearchableSelect
                  className={selectClassName}
                  disabled={isLoading}
                  onChange={(event) => void reload(event.target.value, selectedPeriods, filter)}
                  value={line}
                >
                  {review.availableLines.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </SearchableSelect>
              </label>
            ) : null}
            <label className="flex flex-col gap-1">
              <span className="text-phx-sm font-bold uppercase tracking-[0.16em] text-slate-500">
                {isMultiPeriod ? "Months" : "Month"}
              </span>
              <ClosingPeriodSelect
                availablePeriods={review.availablePeriods}
                disabled={isLoading || review.availablePeriods.length === 0}
                onChange={(next) => void reload(line, next, filter)}
                value={selectedPeriods}
              />
            </label>
            <Button
              className="gap-2"
              disabled={isLoading}
              onClick={() => void reload(line, selectedPeriods, filter)}
              variant="secondary"
            >
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </Button>
            <Button className="gap-2" disabled={isExporting || isLoading} onClick={() => void handleExport()}>
              {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Export workbook
            </Button>
          </div>
        )}
        description={"Every rep and area down the side, every family across the top. A family cell is value: a family spans several concentrations, and units of different products are never added. Region totals and the national total close each block."}
        title={"Reps and areas " + DOT + " families"}
      >
        <GridTable grid={review.matrixByFamily} measure="value" totalLabel={totalLabel} />
      </AdminTableShell>

      <AdminTableShell
        description={"The same rows against every product code. Each column is one product, so these units are a real quantity and may be read down the column. The row total stays value, because a row spans products."}
        title={"Reps and areas " + DOT + " products"}
      >
        <GridTable grid={review.matrixByProduct} measure="units" totalLabel={totalLabel} />
      </AdminTableShell>

      <AdminTableShell
        description={"Every area on the line, ranked on achievement. An area with no target follows the ranked block, ordered by value " + DOT + " it is present, never dropped."}
        title="Medical rep ranking"
      >
        {/* Desktop gets the full table; a phone gets cards — the admin shell never shows a wide table on mobile. */}
        <div className="hidden lg:block">
          {/* A width floor made this scroll on any 1024-1280px screen, which is the
              width most of these are read at. The colgroup owns it now. */}
          <table className="w-full table-fixed border-collapse">
            <colgroup>
              <col className="w-[6%]" />
              <col className="w-[14%]" />
              <col className="w-[16%]" />
              <col className="w-[13%]" />
              <col className="w-[16%]" />
              <col className="w-[12%]" />
              <col className="w-[12%]" />
              <col className="w-[11%]" />
            </colgroup>
            <thead className="border-b border-slate-200 bg-slate-50/80">
              <tr>
                <th className={headClassName}>Rank</th>
                <th className={headClassName}>Region</th>
                <th className={headClassName}>Medical rep</th>
                <th className={headClassName}>Area</th>
                <th className={headClassName}>District manager</th>
                <th className={headClassName + " text-right"}>Sales value</th>
                <th className={headClassName + " text-right"}>Target value</th>
                <th className={headClassName + " text-right"}>Achievement</th>
              </tr>
            </thead>
            <tbody>
              {review.areas.map((area, index) => (
                <tr className={index % 2 === 1 ? "bg-slate-50/50" : undefined} key={area.regionCode + "-" + area.areaCode}>
                  <td className={cellClassName + " font-black text-slate-400"}>
                    {area.achievement == null ? EM : index + 1}
                  </td>
                  <td className={cellClassName}>
                    <span className="flex items-center gap-2">
                      <RegionDot regionCode={area.regionCode} />
                      <span className="font-semibold text-slate-600">{area.regionName}</span>
                    </span>
                  </td>
                  <td className={cellClassName + " font-semibold text-slate-900"}>
                    {area.repName ?? (
                      <span className="italic text-slate-400">{area.repIsVacant ? "Vacant seat" : EM}</span>
                    )}
                  </td>
                  <td className={cellClassName}>{area.areaName}</td>
                  <td className={cellClassName}>
                    {area.managerName ?? <span className="text-slate-300">{EM}</span>}
                  </td>
                  <td className={cellClassName + " text-right font-semibold text-slate-900"}>
                    <Figure value={area.salesValue} />
                  </td>
                  <td className={cellClassName + " text-right"}><Figure value={area.targetValue} /></td>
                  <td className={cellClassName + " text-right"}><Achievement ratio={area.achievement} /></td>
                </tr>
              ))}
              <tr className="border-t-2 border-slate-300 bg-slate-100/80">
                <td className={cellClassName + " font-black uppercase tracking-[0.12em] text-slate-700"} colSpan={5}>
                  {line} {DOT} {totalLabel}
                </td>
                <td className={cellClassName + " text-right font-black text-slate-900"}>
                  <Figure value={review.totals.salesValue} />
                </td>
                <td className={cellClassName + " text-right font-black text-slate-900"}>
                  <Figure value={review.totals.targetValue} />
                </td>
                <td className={cellClassName + " text-right"}><Achievement ratio={review.totals.achievement} /></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="space-y-3 p-4 lg:hidden">
          {review.areas.map((area, index) => (
            <div className="border border-slate-200 bg-white p-4" key={area.regionCode + "-" + area.areaCode}>
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2">
                  <RegionDot regionCode={area.regionCode} />
                  <span className="text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">
                    {area.achievement == null ? area.regionName : "#" + (index + 1) + " " + DOT + " " + area.regionName}
                  </span>
                </span>
                <Achievement ratio={area.achievement} />
              </div>
              <p className="mt-2 text-base font-black text-slate-900">
                {area.repName ?? (area.repIsVacant ? "Vacant seat" : EM)}
              </p>
              <p className="text-sm text-slate-500">{area.areaName}</p>
              {area.managerName ? <p className="text-xs text-slate-400">Reports to {area.managerName}</p> : null}
              <p className="mt-2 text-sm font-semibold text-slate-700">
                <Figure value={area.salesValue} />
                <span className="text-slate-400"> of </span>
                <Figure value={area.targetValue} />
              </p>
            </div>
          ))}
          <div className="border border-slate-300 bg-slate-100/80 p-4">
            <p className="text-phx-xs font-black uppercase tracking-[0.12em] text-slate-700">
              {line} {DOT} {totalLabel}
            </p>
            <p className="mt-2 text-sm font-semibold text-slate-700">
              <Figure value={review.totals.salesValue} />
              <span className="text-slate-400"> of </span>
              <Figure value={review.totals.targetValue} />
              <span className="ml-2"><Achievement ratio={review.totals.achievement} /></span>
            </p>
          </div>
        </div>
      </AdminTableShell>

      <AdminTableShell
        description="Each district manager against the areas he or she runs, and each region against its own areas. A manager total is by value: a manager covers several areas selling several products."
        title="District managers and regions"
      >
        <div className="grid gap-0 lg:grid-cols-2">
          <div className="border-b border-slate-200 lg:border-b-0 lg:border-r">
            <div className="hidden md:block">
            <table className="w-full table-fixed border-collapse">
              <colgroup>
                <col className="w-[40%]" />
                <col className="w-[14%]" />
                <col className="w-[24%]" />
                <col className="w-[22%]" />
              </colgroup>
              <thead className="border-b border-slate-200 bg-slate-50/80">
                <tr>
                  <th className={headClassName}>District manager</th>
                  <th className={headClassName}>Areas</th>
                  <th className={headClassName + " text-right"}>Sales value</th>
                  <th className={headClassName + " text-right"}><AchievementHead /></th>
                </tr>
              </thead>
              <tbody>
                {review.managers.map((group, index) => (
                  <tr className={index % 2 === 1 ? "bg-slate-50/50" : undefined} key={group.label}>
                    <td className={cellClassName + " font-semibold text-slate-900"}>
                      <span className="flex items-center gap-2">
                        <RegionDot regionCode={group.regionCode} />
                        {group.label}
                      </span>
                    </td>
                    <td className={cellClassName}>{group.areaCount}</td>
                    <td className={cellClassName + " text-right"}><Figure value={group.salesValue} /></td>
                    <td className={cellClassName + " text-right"}><Achievement ratio={group.achievement} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <CrmCardsOnPhone>
              {review.managers.map((group) => (
                <CrmCard key={group.label + ":card"} title={group.label}>
                  <CrmFacts
                    facts={[
                      { label: "Areas", value: group.areaCount },
                      { label: "Sales value", value: <Figure value={group.salesValue} /> },
                      { label: "Achievement", value: <Achievement ratio={group.achievement} /> },
                    ]}
                  />
                </CrmCard>
              ))}
            </CrmCardsOnPhone>
          </div>
          <div>
            <div className="hidden md:block">
            <table className="w-full table-fixed border-collapse">
              <colgroup>
                <col className="w-[40%]" />
                <col className="w-[14%]" />
                <col className="w-[24%]" />
                <col className="w-[22%]" />
              </colgroup>
              <thead className="border-b border-slate-200 bg-slate-50/80">
                <tr>
                  <th className={headClassName}>Region</th>
                  <th className={headClassName}>Areas</th>
                  <th className={headClassName + " text-right"}>Sales value</th>
                  <th className={headClassName + " text-right"}><AchievementHead /></th>
                </tr>
              </thead>
              <tbody>
                {review.regions.map((group, index) => (
                  <tr className={index % 2 === 1 ? "bg-slate-50/50" : undefined} key={group.regionCode}>
                    <td className={cellClassName + " font-semibold text-slate-900"}>
                      <span className="flex items-center gap-2">
                        <RegionDot regionCode={group.regionCode} />
                        {group.regionName}
                      </span>
                    </td>
                    <td className={cellClassName}>{group.areaCount}</td>
                    <td className={cellClassName + " text-right"}><Figure value={group.salesValue} /></td>
                    <td className={cellClassName + " text-right"}><Achievement ratio={group.achievement} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <CrmCardsOnPhone>
              {review.regions.map((group) => (
                <CrmCard key={group.regionCode + ":card"} title={group.regionName}>
                  <CrmFacts
                    facts={[
                      { label: "Areas", value: group.areaCount },
                      { label: "Sales value", value: <Figure value={group.salesValue} /> },
                      { label: "Achievement", value: <Achievement ratio={group.achievement} /> },
                    ]}
                  />
                </CrmCard>
              ))}
            </CrmCardsOnPhone>
          </div>
        </div>
      </AdminTableShell>

      <AdminTableShell
        description="A family spans several concentrations, so it is measured by value. Units show only where the family happens to be a single product code."
        title="Family performance"
      >
        <div className="hidden md:block">
          <table className="w-full table-fixed border-collapse">
            <colgroup>
              <col className="w-[26%]" />
              <col className="w-[12%]" />
              <col className="w-[15%]" />
              <col className="w-[17%]" />
              <col className="w-[17%]" />
              <col className="w-[13%]" />
            </colgroup>
            <thead className="border-b border-slate-200 bg-slate-50/80">
              <tr>
                <th className={headClassName}>Product family</th>
                <th className={headClassName}>Products</th>
                <th className={headClassName + " text-right"}>Units</th>
                <th className={headClassName + " text-right"}>Sales value</th>
                <th className={headClassName + " text-right"}>Target value</th>
                <th className={headClassName + " text-right"}><AchievementHead /></th>
              </tr>
            </thead>
            <tbody>
              {review.families.map((family, index) => (
                <tr className={index % 2 === 1 ? "bg-slate-50/50" : undefined} key={family.family}>
                  <td className={cellClassName + " font-semibold text-slate-900"}>{family.family}</td>
                  <td className={cellClassName}>{family.productCount}</td>
                  <td className={cellClassName + " text-right"}>
                    {family.unitsAreAddable ? (
                      <Figure value={family.salesUnits} />
                    ) : (
                      <span className="text-xs italic text-slate-400">several products</span>
                    )}
                  </td>
                  <td className={cellClassName + " text-right font-semibold text-slate-900"}>
                    <Figure value={family.salesValue} />
                  </td>
                  <td className={cellClassName + " text-right"}><Figure value={family.targetValue} /></td>
                  <td className={cellClassName + " text-right"}><Achievement ratio={family.achievement} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <CrmCardsOnPhone>
          {review.families.map((family) => (
            <CrmCard key={family.family + ":card"} title={family.family}>
              <CrmFacts
                facts={[
                  { label: "Products", value: family.productCount },
                  {
                    label: "Units",
                    value: family.unitsAreAddable ? <Figure value={family.salesUnits} /> : <span className="text-xs italic text-slate-400">several products</span>,
                  },
                  { label: "Sales value", value: <Figure value={family.salesValue} /> },
                  { label: "Target value", value: <Figure value={family.targetValue} /> },
                  { label: "Achievement", value: <Achievement ratio={family.achievement} /> },
                ]}
              />
            </CrmCard>
          ))}
        </CrmCardsOnPhone>
      </AdminTableShell>

      <AdminTableShell
        description="Every row here is one product code, so these units are a real quantity and may be compared month to month. A dash is a month that was never uploaded; a dot is a month that sold nothing."
        title="Units and growth by month"
      >
        <SeriesTable months={months} rowHeading="Product" rows={review.productUnitsByMonth} subHeading="Family" />
      </AdminTableShell>

      <AdminTableShell
        description="The same products in value, so concentrations can be compared side by side and added."
        title="All products by month"
      >
        <SeriesTable months={months} rowHeading="Product" rows={review.productValueByMonth} subHeading="Family" />
      </AdminTableShell>

      <AdminTableShell
        description="Each area's own trend. An area sells the whole line, so this is value: units of different products are never added."
        title={"Growth by month " + DOT + " area"}
      >
        <SeriesTable
          months={months}
          regionCodeOf={(row) => regionCodeByName.get(row.subLabel) ?? ""}
          rowHeading="Area"
          rows={review.areaValueByMonth}
          subHeading="Region"
        />
      </AdminTableShell>

      <AdminTableShell
        description={"Every product in turn, and under each one every rep's own months and growth. The figures are units: a block is ONE product code, so they are a real quantity and may be read across the months and down the column. There is no row total " + DOT + " a row spans products, and units of different products are never added."}
        title={"Reps and areas " + DOT + " products by month"}
      >
        <ProductMonthTable grid={review.productUnitsByRepByMonth} totalLabel={totalLabel} />
      </AdminTableShell>
    </div>
  );
}
