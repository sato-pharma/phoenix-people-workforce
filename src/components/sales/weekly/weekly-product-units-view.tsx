"use client";

// Weekly Sales — the PRODUCTS BY MONTH tab.
//
// WHAT THE OWNER ASKED FOR, IN HIS WORDS: "add the same per-product units tab to the Weekly Sales
// review" — the Performance Review's shape, brought to the weekly sheet. So the product name merges
// over its own run of months plus that product's growth, then the next product's block begins, and
// the people are down the side with their names frozen.
//
// THE SHAPE IS DELIBERATELY NOT THE FIELD FORCE TAB'S. That tab is rep-major and week-wide ("how is
// Sally doing"); this one is product-major and month-wide ("how did Royanoxicam move, person by
// person, July to September"). Same people, same engine, different question.
//
// WHY IT SCROLLS SIDEWAYS WHEN NOTHING ELSE ON THIS PAGE DOES. The fits-the-screen golden rule is
// obeyed by MERGING columns, and no merge bounds a COUNT: the width here is the product count times
// the month count. The owner ruled on exactly this shape for the monthly closing matrix — it can
// never fit, so it keeps its scroll — and the sticky name column is the frozen-names half of that
// design. The permission is declared once, in MatrixScroller, which every grid of this shape shares;
// this file opens no scroll box of its own.
//
// THREE THINGS THIS SCREEN MUST SAY OUT LOUD
//   1. Units are never added across products, so there is NO row total — only each block's own months.
//   2. Most of these cells are an ALLOCATION. A weekly row is a depot shipment; where the owner
//      mapped the branch by hand the credit is exact, everywhere else it is spread by the branch
//      name, which is why a cell can be a fraction of a unit and reads "<1" rather than "0".
//   3. Unmapped products are left out (every weekly report sets excludeUnmapped) and money that
//      reached no area is still shown, under its line's own bucket row.

import { AlertTriangle, Layers, Loader2, Package } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MatrixScroller } from "@/components/ui/matrix-scroller";
import { performanceReviewRegionStyle } from "@/lib/sales/closing-performance-review-regions";
// THE SHAPE MODULE, NEVER THE BUILDER. `portal-weekly-product-units.ts` reaches the weekly service,
// which reaches the employee directory, which reaches `node:crypto` — webpack refuses a Node builtin
// in a client bundle and the dev server then 500s every request. Importing a single `const` from it
// is enough to do that, because only TYPES are erased.
import {
  WEEKLY_PRODUCT_UNITS_MAX_MONTHS,
  WEEKLY_PRODUCT_UNITS_MONTHS,
  type WeeklyProductUnitsMatrix,
  type WeeklyProductUnitsRow,
} from "@/lib/sales/weekly/product-units-shape";
import { weeklyAreaLabel, weeklyPersonLabel, weeklyRegionLabel } from "@/lib/sales/weekly/display-labels";
import { WEEKLY_UNITS_UNDER_ONE, weeklyUnitsUnderOne } from "@/lib/sales/weekly/unit-totals";

const EM = "—";
const DOT = "·";

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-07-01" -> "Jul 26". The narrow heading of a month column inside a product's block. */
function shortMonth(code: string): string {
  const match = /^(\d{4})-(\d{2})-01$/.exec(code.trim());
  if (!match) return code;
  const name = MONTHS_SHORT[Number(match[2]) - 1];
  return name ? `${name} ${match[1].slice(2)}` : code;
}

/** "2026-07-01" -> "July 2026", for prose rather than a column head. */
function longMonth(code: string): string {
  const match = /^(\d{4})-(\d{2})-01$/.exec(code.trim());
  if (!match) return code;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function formatEgp(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `EGP ${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `EGP ${(value / 1_000).toFixed(1)}K`;
  return `EGP ${Math.round(value).toLocaleString("en-US")}`;
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * One unit cell.
 *
 * Three states that are NOT the same thing and never share a glyph: a month nobody uploaded reads as
 * a dash, a month that came with none of this product reads as a dot, and a positive allocated share
 * that rounds to nothing reads "<1" — never "0" beside the money it earned.
 */
function UnitsCell({ value }: { value: number | null }) {
  if (value == null) return <span className="text-slate-300">{EM}</span>;
  if (weeklyUnitsUnderOne(value)) return <span className="tabular-nums text-slate-500">{WEEKLY_UNITS_UNDER_ONE}</span>;
  if (Math.round(value) === 0) return <span className="text-slate-300">{DOT}</span>;
  return <span className="tabular-nums">{numberFormat.format(value)}</span>;
}

function Growth({ ratio }: { ratio: number | null }) {
  if (ratio == null) return <span className="text-xs italic text-slate-400">new</span>;
  const sign = ratio >= 0 ? "+" : "−";
  return (
    <span className={"font-black tabular-nums " + (ratio >= 0 ? "text-teal-700" : "text-red-700")}>
      {sign}
      {Math.abs(ratio * 100).toFixed(1)}%
    </span>
  );
}

/** The region swatch, in the palette the Performance Review paints that region. SQUARE — §4. */
function RegionSwatch({ regionCode }: { regionCode: string | null }) {
  const style = performanceReviewRegionStyle(regionCode);
  return (
    <span
      aria-hidden
      className="inline-block h-2.5 w-2.5 shrink-0"
      style={{ backgroundColor: "#" + style.chip.slice(2) }}
    />
  );
}

const headClassName =
  "break-words px-3 py-2.5 text-left text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500";
const cellClassName = "whitespace-nowrap px-3 py-2 text-sm text-slate-700";

/** The row's own heading in the frozen left column. A subtotal says what it totals. */
function rowHeading(row: WeeklyProductUnitsRow) {
  if (row.kind === "vacant") return <span className="text-xs italic text-slate-400">Vacant seat</span>;
  if (row.kind === "unattributed") return <span className="text-xs italic text-amber-700">{row.label}</span>;
  return row.label;
}

function toneOf(row: WeeklyProductUnitsRow, index: number): string {
  if (row.kind === "grandTotal") return "bg-slate-900 text-white";
  if (row.kind === "lineSubtotal") return "bg-slate-100 font-semibold";
  if (row.kind === "regionSubtotal") return "bg-sky-50 font-semibold";
  return index % 2 === 1 ? "bg-slate-50/50" : "";
}

function stickyToneOf(row: WeeklyProductUnitsRow, index: number): string {
  if (row.kind === "grandTotal") return "bg-slate-900 text-white";
  if (row.kind === "lineSubtotal") return "bg-slate-100 text-slate-900";
  if (row.kind === "regionSubtotal") return "bg-sky-50 text-slate-900";
  return index % 2 === 1 ? "bg-slate-50 text-slate-900" : "bg-white text-slate-900";
}

export function WeeklyProductUnitsView({
  active,
  availableMonths,
  hostFilterCount,
  scopeSummary,
}: {
  /** The tab is open. The feed is fetched on the FIRST opening and then kept. */
  active: boolean;
  /** The dashboard's own month universe, newest-last, so the window never asks for a month that is not there. */
  availableMonths: string[];
  /**
   * How many chips the page's own filter bar is holding.
   *
   * This grid does NOT follow that bar — it reads the viewer's whole scope over its own month window,
   * because narrowing it would re-read several months of row grain on every chip. That is a defensible
   * choice and an indefensible silence: a reader who filtered to one region on the tab beside this one
   * would otherwise read these rows as that region's. So the count is here only to say so, out loud,
   * exactly when there is something to say.
   */
  hostFilterCount: number;
  scopeSummary: string;
}) {
  const [matrix, setMatrix] = useState<WeeklyProductUnitsMatrix | null>(null);
  const [monthsBack, setMonthsBack] = useState(WEEKLY_PRODUCT_UNITS_MONTHS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedFor = useRef<string | null>(null);

  // The window is picked from what the dashboard already knows exists, so the request names real
  // months and the server's own calendar read is never needed.
  const monthWindow = useMemo(() => {
    const months = [...new Set(availableMonths.filter(Boolean))].sort();
    return months.slice(-Math.min(monthsBack, WEEKLY_PRODUCT_UNITS_MAX_MONTHS));
  }, [availableMonths, monthsBack]);

  const load = useCallback(
    async (months: string[], signal: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (months.length > 0) params.set("months", months.join(","));
        params.set("monthsBack", String(monthsBack));
        const response = await fetch(`/api/employee-portals/weekly-sales/product-units?${params.toString()}`, {
          signal,
        });
        const json = await response.json();
        if (json?.success) setMatrix((json.productUnits ?? null) as WeeklyProductUnitsMatrix | null);
        else setError(typeof json?.error === "string" ? json.error : "Failed to load per-product units.");
      } catch (caught) {
        if (!(caught instanceof DOMException && caught.name === "AbortError")) {
          setError("Failed to load per-product units.");
        }
      } finally {
        setLoading(false);
      }
    },
    [monthsBack],
  );

  useEffect(() => {
    if (!active) return;
    const key = monthWindow.join(",") + "|" + monthsBack;
    if (loadedFor.current === key) return;
    loadedFor.current = key;
    const controller = new AbortController();
    void load(monthWindow, controller.signal);
    return () => controller.abort();
  }, [active, load, monthsBack, monthWindow]);

  const allocatedShare =
    matrix && matrix.totals.value !== 0 ? matrix.totals.allocatedValue / matrix.totals.value : null;
  const perProduct = (matrix?.months.length ?? 0) + 1;

  return (
    <div className="space-y-4">
      <div className="border border-slate-200 bg-white p-4 shadow-[0_10px_30px_rgba(15,23,42,0.05)] ring-1 ring-slate-200/60">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-sm font-black tracking-tight text-slate-900">
              <Package className="h-4 w-4 text-orange-500" />
              Products by month · units per person
            </h3>
            <p className="mt-1 break-words text-xs font-semibold text-slate-500">
              One block per product, its months inside it, and the people down the side. {scopeSummary}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {[3, 6].map((count) => (
              <button
                className={
                  "px-3 py-1.5 text-phx-2xs font-black uppercase tracking-wide transition " +
                  (monthsBack === count
                    ? "bg-slate-900 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200")
                }
                key={count}
                onClick={() => setMonthsBack(count)}
                type="button"
              >
                {count} months
              </button>
            ))}
          </div>
        </div>

        <ul className="mt-3 space-y-1.5 text-phx-2xs font-semibold text-slate-500">
          <li className="flex items-start gap-2">
            <Layers className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
            <span className="break-words">
              A block is one product, so its months may be read across and its column added down. There is
              no row total: units of different products are never added.
            </span>
          </li>
          {allocatedShare !== null ? (
            <li className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
              <span className="break-words">
                {formatPct(allocatedShare)} of the {formatEgp(matrix?.totals.value ?? 0)} behind this grid was
                placed by reading the branch name, not mapped by hand — which is why a cell can be a share of
                a unit and reads {WEEKLY_UNITS_UNDER_ONE}. Exact credit:{" "}
                {formatEgp(matrix?.totals.exactValue ?? 0)}.
              </span>
            </li>
          ) : null}
          {matrix && matrix.totals.unattributedValue > 0 ? (
            <li className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
              <span className="break-words">
                {formatEgp(matrix.totals.unattributedValue)} reached no area and so no person. It is shown on
                its own line bucket row, never dropped.
              </span>
            </li>
          ) : null}
          {matrix && matrix.emptyMonths.length > 0 ? (
            <li className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
              <span className="break-words">
                No sheet has been uploaded for {matrix.emptyMonths.map(longMonth).join(", ")}. Those columns
                read {EM}, which is not a zero.
              </span>
            </li>
          ) : null}
          <li className="flex items-start gap-2">
            <Package className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
            <span className="break-words">
              Products the Product Master has not mapped are left out, as every weekly report leaves them
              out — an unmapped code would double-count against the real product it belongs to.
            </span>
          </li>
          {hostFilterCount > 0 ? (
            <li className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
              <span className="break-words">
                The {hostFilterCount === 1 ? "filter" : `${hostFilterCount} filters`} on the bar above do not
                narrow this grid. It reads everything you may see, over the month window picked here.
              </span>
            </li>
          ) : null}
        </ul>
      </div>

      {matrix?.seatIndexUnavailable ? (
        <div className="flex items-start gap-2 border border-amber-200 bg-amber-50 p-3 text-xs font-semibold text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-words">
            The seat index could not be read, so nobody can be named on these rows. This is not an empty
            field force.
          </span>
        </div>
      ) : null}

      {error ? (
        <div className="flex items-start gap-2 border border-red-200 bg-red-50 p-3 text-xs font-semibold text-red-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      ) : null}

      {loading && !matrix ? (
        <div className="flex items-center gap-2 border border-slate-200 bg-white p-6 text-xs font-semibold text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin text-orange-500" />
          Reading every month of the row grain…
        </div>
      ) : null}

      {matrix && matrix.columns.length > 0 ? (
        <div className="relative border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.05)] ring-1 ring-slate-200/60">
          {loading ? (
            <div className="absolute right-3 top-3 z-30 flex items-center gap-2 bg-white/90 px-2 py-1 text-phx-2xs font-black uppercase tracking-wide text-slate-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-orange-500" />
              Updating
            </div>
          ) : null}
          <MatrixScroller>
            <table className="w-full border-collapse [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
              <thead className="border-b border-slate-200 bg-slate-50/80">
                <tr>
                  <th className={headClassName + " sticky left-0 z-20 bg-slate-50"} colSpan={4}>
                    Who sold it
                  </th>
                  {matrix.columns.map((column) => (
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
                  <th className={headClassName + " sticky left-0 z-20 bg-slate-50"}>Person</th>
                  <th className={headClassName}>Area</th>
                  <th className={headClassName}>District manager</th>
                  <th className={headClassName}>Region</th>
                  {matrix.columns.map((column) => (
                    <Fragment key={column.key}>
                      {matrix.months.map((month, monthIndex) => (
                        <th
                          className={
                            headClassName +
                            " text-right" +
                            (monthIndex === 0 ? " border-l border-slate-300" : "")
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
                {matrix.rows.map((row, index) => {
                  const isTotal =
                    row.kind === "regionSubtotal" || row.kind === "lineSubtotal" || row.kind === "grandTotal";
                  return (
                    <tr className={toneOf(row, index)} key={row.kind + ":" + row.key}>
                      <td
                        className={
                          cellClassName + " sticky left-0 z-10 font-semibold " + stickyToneOf(row, index)
                        }
                      >
                        {rowHeading(row)}
                      </td>
                      <td className={cellClassName}>
                        {(row.areaName ? weeklyAreaLabel(row.areaName) : null) ?? (isTotal ? "" : <span className="text-slate-300">{EM}</span>)}
                      </td>
                      <td className={cellClassName}>
                        {isTotal ? (
                          row.kind === "grandTotal" ? "" : row.lineName
                        ) : (
                          (row.managerName ? weeklyPersonLabel(row.managerName) : null) ?? <span className="text-slate-300">{EM}</span>
                        )}
                      </td>
                      <td className={cellClassName}>
                        {row.regionName ? (
                          <span className="flex items-center gap-2">
                            <RegionSwatch regionCode={row.regionCode} />
                            <span className={row.kind === "grandTotal" ? "" : "text-slate-500"}>
                              {weeklyRegionLabel(row.regionName)}
                            </span>
                          </span>
                        ) : isTotal ? (
                          row.kind === "grandTotal" ? "Every line" : row.lineName
                        ) : (
                          <span className="text-slate-300">{EM}</span>
                        )}
                      </td>
                      {matrix.columns.map((column, productIndex) => (
                        <Fragment key={column.key}>
                          {matrix.months.map((month, monthIndex) => (
                            <td
                              className={
                                cellClassName +
                                " text-right" +
                                (isTotal ? " font-semibold" : "") +
                                (monthIndex === 0 ? " border-l border-slate-300" : "")
                              }
                              key={column.key + ":" + month}
                            >
                              <UnitsCell value={row.units[productIndex]?.[monthIndex] ?? null} />
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
        </div>
      ) : null}

      {matrix && matrix.columns.length === 0 && !loading ? (
        <div className="border border-slate-200 bg-white p-6 text-xs font-semibold text-slate-500">
          No mapped product moved in {matrix.months.length > 0 ? matrix.months.map(longMonth).join(", ") : "the window"}.
        </div>
      ) : null}
    </div>
  );
}
