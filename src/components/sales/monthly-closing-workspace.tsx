"use client";

import { AlertTriangle, CalendarRange, Download, Loader2, RefreshCw } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import {
  MonthlyClosingFilters,
  emptyMonthlyClosingFilter,
  type MonthlyClosingFilter,
} from "@/components/sales/monthly-closing-filters";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatNumber, formatPercent } from "@/lib/sales/format";
import {
  filterMonthlyClosingMatrix,
  type MonthlyClosingCell,
  type MonthlyClosingMatrix,
  type MonthlyClosingRegionGroup,
} from "@/lib/sales/monthly-distributor-import";

type Props = {
  initialError: string | null;
  initialMatrix: MonthlyClosingMatrix | null;
};

type ClosingResponse = {
  data?: MonthlyClosingMatrix;
  error?: string;
  success: boolean;
};

type RowVariant = "area" | "subtotal" | "grand";

const valueFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const BLANK = "—";

function valueText(value: number) {
  return valueFormatter.format(value || 0);
}

function toneText(variant: RowVariant, dim: boolean) {
  if (variant === "grand") return dim ? "text-slate-500" : "font-semibold text-white";
  if (variant === "subtotal") return dim ? "text-slate-400" : "font-bold text-slate-900";
  return dim ? "text-slate-300" : "text-slate-700";
}

function NumCell({
  bg = "",
  kind = "int",
  muted = false,
  value,
  variant,
}: {
  bg?: string;
  kind?: "int" | "value";
  muted?: boolean;
  value: number | null;
  variant: RowVariant;
}) {
  const base = "whitespace-nowrap px-3 py-2 text-right tabular-nums";
  if (value === null) {
    return <td className={cn(base, bg, variant === "grand" ? "text-slate-500" : "text-slate-300")}>{BLANK}</td>;
  }
  const dim = muted || value === 0;
  const text = kind === "value" ? valueText(value) : formatNumber(value);
  return <td className={cn(base, bg, toneText(variant, dim))}>{text}</td>;
}

function AchCell({ bg = "", value, variant }: { bg?: string; value: number | null; variant: RowVariant }) {
  const base = "whitespace-nowrap px-3 py-2 text-right tabular-nums";
  if (value === null) {
    return <td className={cn(base, bg, variant === "grand" ? "text-slate-500" : "text-slate-300")}>{BLANK}</td>;
  }
  return <td className={cn(base, bg, variant === "grand" ? "font-semibold text-white" : "text-slate-600")}>{formatPercent(value, { input: "ratio" })}</td>;
}

// Darker-orange tint for the Achievement % column so it reads as its own axis.
function achBgFor(variant: RowVariant) {
  if (variant === "area") return "bg-orange-100";
  if (variant === "subtotal") return "bg-orange-200/80";
  return "";
}

// Stronger-orange tint for the rightmost Grand Total block.
function totalBgFor(variant: RowVariant) {
  if (variant === "area") return "bg-[#FBD8A6]";
  if (variant === "subtotal") return "bg-[#F4C078]";
  return "";
}

function ProductCells({ bandTint, cell, rowBg, variant }: { bandTint: boolean; cell: MonthlyClosingCell; rowBg?: string; variant: RowVariant }) {
  const bg = rowBg ?? (variant === "area" && bandTint ? "bg-orange-50/50" : "");
  const achBg = rowBg ?? achBgFor(variant);
  return (
    <>
      <NumCell bg={bg} value={cell.salesUnits} variant={variant} />
      <NumCell bg={bg} kind="value" value={cell.salesValue} variant={variant} />
      <NumCell bg={bg} muted value={cell.targetUnits} variant={variant} />
      <NumCell bg={bg} kind="value" muted value={cell.targetValue} variant={variant} />
      <AchCell bg={achBg} value={cell.achievement} variant={variant} />
    </>
  );
}

function TotalCells({ cell, rowBg, variant }: { cell: MonthlyClosingCell; rowBg?: string; variant: RowVariant }) {
  const bg = rowBg ?? totalBgFor(variant);
  return (
    <>
      <NumCell bg={bg} kind="value" value={cell.salesValue} variant={variant} />
      <NumCell bg={bg} kind="value" muted value={cell.targetValue} variant={variant} />
      <AchCell bg={bg} value={cell.achievement} variant={variant} />
    </>
  );
}

function MetricHeaders() {
  const cell = "sticky z-30 whitespace-nowrap px-2 py-1.5 align-middle";
  return (
    <>
      <th className={cell} style={{ top: 44 }}>Units</th>
      <th className={cell} style={{ top: 44 }}>Value</th>
      <th className={`${cell} font-normal opacity-60`} style={{ top: 44 }}>Tgt Units</th>
      <th className={`${cell} font-normal opacity-60`} style={{ top: 44 }}>Tgt Value</th>
      <th className={`${cell} phx-ach`} style={{ top: 44 }}>Ach %</th>
    </>
  );
}

// Fixed column widths (px) — generous like the workbook so numbers breathe and the table
// scrolls horizontally instead of squashing 30 columns into one screen width.
const COL = { ach: 64, area: 92, gtAch: 64, gtTgt: 96, gtValue: 110, name: 196, tgtUnits: 66, tgtValue: 96, units: 70, value: 102 };
const PRODUCT_GROUP_WIDTH = COL.units + COL.value + COL.tgtUnits + COL.tgtValue + COL.ach;
const STICKY1 = "sticky left-0 z-20";
const STICKY2 = "sticky z-20";

function RegionBlock({ region }: { region: MonthlyClosingRegionGroup }) {
  return (
    <>
      {region.areas.map((area) => {
        // Direct (company) rows get a distinct blue band across the WHOLE row so they stand
        // apart from the orange area/region palette.
        const directBg = "bg-[#CFE0FB]";
        return (
          <tr className={area.isDirect ? "" : "transition-colors hover:bg-orange-50/40"} key={area.areaCode}>
            <td className={`${STICKY1} whitespace-nowrap px-3 py-2.5 font-semibold ${area.isDirect ? `${directBg} uppercase tracking-wide text-[#1D4ED8]` : "bg-white text-slate-900"}`}>{area.isDirect ? "◆ Direct" : area.areaCode}</td>
            <td className={`${STICKY2} truncate px-3 py-2.5 ${area.isDirect ? `${directBg} font-bold text-[#1D4ED8]` : "bg-white text-slate-600"}`} style={{ left: COL.area }}>{area.isDirect ? "Direct orders (company)" : area.areaName}</td>
            {area.cells.map((cell, index) => (
              <ProductCells bandTint={index % 2 === 1} cell={cell} key={`${area.areaCode}-${index}`} rowBg={area.isDirect ? directBg : undefined} variant="area" />
            ))}
            <TotalCells cell={area.rowTotal} rowBg={area.isDirect ? directBg : undefined} variant="area" />
          </tr>
        );
      })}
      <tr className="bg-[#FDEAD0]">
        <td className={`${STICKY1} whitespace-nowrap bg-[#FDEAD0] px-3 py-2.5 font-black uppercase tracking-wide text-slate-900`}>{region.regionCode}</td>
        <td className={`${STICKY2} truncate bg-[#FDEAD0] px-3 py-2.5 font-black text-slate-900`} style={{ left: COL.area }}>{region.regionName}</td>
        {region.subtotal.cells.map((cell, index) => (
          <ProductCells bandTint={index % 2 === 1} cell={cell} key={`sub-${region.regionCode}-${index}`} variant="subtotal" />
        ))}
        <TotalCells cell={region.subtotal.rowTotal} variant="subtotal" />
      </tr>
    </>
  );
}

function ClosingMatrixTable({ matrix }: { matrix: MonthlyClosingMatrix }) {
  const topRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  function syncScroll(source: HTMLDivElement | null, target: HTMLDivElement | null) {
    if (!source || !target || syncing.current) return;
    syncing.current = true;
    target.scrollLeft = source.scrollLeft;
    requestAnimationFrame(() => {
      syncing.current = false;
    });
  }

  if (matrix.columns.length === 0) {
    return (
      <div className="p-4 md:p-5">
        <AdminCallout tone="warning">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          <p>No products match the current filters for this line.</p>
        </AdminCallout>
      </div>
    );
  }

  const tableWidth = COL.area + COL.name + matrix.columns.length * PRODUCT_GROUP_WIDTH + COL.gtValue + COL.gtTgt + COL.gtAch;
  const bandHeader = "whitespace-nowrap px-3 align-middle";

  return (
    <div className="p-4 md:p-5">
      {/* Solid black header band + crisp light-orange grid (matches the exported workbook).
          Scoped to this table with table-level specificity so it is opaque on scroll (the
          sticky header must cover the rows beneath it) regardless of the global shell rules. */}
      <style>{`
        table.phx-closing-grid th, table.phx-closing-grid td { border: 1px solid #F4B66E !important; }
        table.phx-closing-grid thead th { background-color: #0B0B0B !important; color: #F1F5F9 !important; box-shadow: inset 0 -2px 0 #F97316; }
      `}</style>

      {/* Top horizontal scrollbar (synced proxy) */}
      <div
        className="overflow-x-auto overflow-y-hidden border-x border-t border-[#E2E8F0]"
        onScroll={() => syncScroll(topRef.current, bodyRef.current)}
        ref={topRef}
        style={{ height: 14 }}
      >
        <div style={{ height: 1, width: tableWidth }} />
      </div>

      <div
        className="max-h-[72vh] overflow-auto border border-[#E2E8F0]"
        onScroll={() => syncScroll(bodyRef.current, topRef.current)}
        ref={bodyRef}
      >
        <table className="phx-closing-grid text-sm" style={{ tableLayout: "fixed", width: tableWidth }}>
          <colgroup>
            <col style={{ width: COL.area }} />
            <col style={{ width: COL.name }} />
            {matrix.columns.flatMap((column, index) => [
              <col key={`u${index}`} style={{ width: COL.units }} />,
              <col key={`v${index}`} style={{ width: COL.value }} />,
              <col key={`tu${index}`} style={{ width: COL.tgtUnits }} />,
              <col key={`tv${index}`} style={{ width: COL.tgtValue }} />,
              <col key={`a${index}`} style={{ width: COL.ach }} />,
            ])}
            <col style={{ width: COL.gtValue }} />
            <col style={{ width: COL.gtTgt }} />
            <col style={{ width: COL.gtAch }} />
          </colgroup>
          <thead>
            <tr>
              <th className={`${bandHeader} ${STICKY1} top-0 z-40 h-11`} rowSpan={2}>Area</th>
              <th className={`${bandHeader} ${STICKY2} top-0 z-40 h-11`} rowSpan={2} style={{ left: COL.area }}>Area Name</th>
              {matrix.columns.map((column) => (
                <th className={`${bandHeader} sticky top-0 z-30 h-11`} colSpan={5} key={column.productCode}>
                  <span className="block truncate text-[12px] font-black leading-tight" style={{ color: "#FDBA74" }}>{column.productName}</span>
                  <span className="block text-[10px] font-normal" style={{ color: "#CBD5E1" }}>{column.productCode}</span>
                </th>
              ))}
              <th className={`${bandHeader} phx-gt sticky top-0 z-30 h-11`} colSpan={3}>Grand Total</th>
            </tr>
            <tr>
              {matrix.columns.map((column) => (
                <MetricHeaders key={`m-${column.productCode}`} />
              ))}
              <th className="phx-gt sticky z-30 whitespace-nowrap px-2 py-1.5 align-middle" style={{ top: 44 }}>Value</th>
              <th className="phx-gt sticky z-30 whitespace-nowrap px-2 py-1.5 align-middle font-normal opacity-60" style={{ top: 44 }}>Tgt Value</th>
              <th className="phx-gt phx-ach sticky z-30 whitespace-nowrap px-2 py-1.5 align-middle" style={{ top: 44 }}>Ach %</th>
            </tr>
          </thead>
          <tbody>
            {matrix.regions.map((region) => (
              <RegionBlock key={region.regionCode} region={region} />
            ))}
            <tr className="bg-[#0B0B0B]">
              <td className={`${STICKY1} whitespace-nowrap bg-[#0B0B0B] px-3 py-3 font-black uppercase tracking-wide text-white`}>NAT</td>
              <td className={`${STICKY2} whitespace-nowrap bg-[#0B0B0B] px-3 py-3 font-black text-white`} style={{ left: COL.area }}>National Grand Total</td>
              {matrix.grandTotal.cells.map((cell, index) => (
                <ProductCells bandTint={index % 2 === 1} cell={cell} key={`gt-${matrix.columns[index]?.productCode ?? index}`} variant="grand" />
              ))}
              <TotalCells cell={matrix.grandTotal.rowTotal} variant="grand" />
            </tr>
            {matrix.directNational ? (
              <tr>
                <td className={`${STICKY1} whitespace-nowrap bg-[#B6CEF8] px-3 py-2.5 font-black uppercase tracking-wide text-[#1E3A8A]`}>◆ DIR</td>
                <td className={`${STICKY2} whitespace-nowrap bg-[#B6CEF8] px-3 py-2.5 font-black text-[#1E3A8A]`} style={{ left: COL.area }}>Direct – National</td>
                {matrix.directNational.cells.map((cell, index) => (
                  <ProductCells bandTint={index % 2 === 1} cell={cell} key={`dn-${matrix.columns[index]?.productCode ?? index}`} rowBg="bg-[#B6CEF8]" variant="subtotal" />
                ))}
                <TotalCells cell={matrix.directNational.rowTotal} rowBg="bg-[#B6CEF8]" variant="subtotal" />
              </tr>
            ) : null}
            {matrix.companyTotal ? (
              <tr className="bg-[#0B0B0B]">
                <td className={`${STICKY1} whitespace-nowrap bg-[#0B0B0B] px-3 py-3 font-black uppercase tracking-wide text-[#FDBA74]`}>TOT</td>
                <td className={`${STICKY2} whitespace-nowrap bg-[#0B0B0B] px-3 py-3 font-black text-[#FDBA74]`} style={{ left: COL.area }}>Grand Total (incl. Direct)</td>
                {matrix.companyTotal.cells.map((cell, index) => (
                  <ProductCells bandTint={index % 2 === 1} cell={cell} key={`ct-${matrix.columns[index]?.productCode ?? index}`} variant="grand" />
                ))}
                <TotalCells cell={matrix.companyTotal.rowTotal} variant="grand" />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-slate-500">
        Values in EGP, computed as Qty × factory price × (1 − discount). Region rows and the national total are
        roll-ups of their areas — each area is counted once. Target and Achievement populate after the targets upload.
      </p>
    </div>
  );
}

export function MonthlyClosingWorkspace({ initialError, initialMatrix }: Props) {
  const [matrix, setMatrix] = useState<MonthlyClosingMatrix | null>(initialMatrix);
  const [isLoading, setIsLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [filter, setFilter] = useState<MonthlyClosingFilter>(emptyMonthlyClosingFilter);

  const selectedLine = matrix?.line ?? "";
  const selectedPeriod = matrix?.period ?? "";
  const availableLines = matrix?.availableLines ?? [];
  const availablePeriods = matrix?.availablePeriods ?? [];

  const filteredMatrix = useMemo(
    () => (matrix ? filterMonthlyClosingMatrix(matrix, filter) : null),
    [matrix, filter],
  );

  const filterOptions = useMemo(() => {
    if (!matrix) return { areas: [], products: [], regions: [] };
    return {
      regions: matrix.regions.map((region) => ({ code: region.regionCode, label: `${region.regionName} (${region.regionCode})` })),
      // Exclude the synthetic per-region "Direct" rows — they share the code "DIRECT" across
      // regions and are not a filterable area.
      areas: matrix.regions.flatMap((region) =>
        region.areas
          .filter((area) => !area.isDirect)
          .map((area) => ({ code: area.areaCode, label: `${area.areaName} (${area.areaCode})`, regionCode: region.regionCode })),
      ),
      products: matrix.columns.map((column) => ({ code: column.productCode, label: `${column.productName} (${column.productCode})` })),
    };
  }, [matrix]);

  async function reload(line: string, period: string) {
    setIsLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams();
      if (line) query.set("line", line);
      if (period) query.set("period", period);
      const response = await fetch(`/api/sales/monthly-closing?${query.toString()}`, { cache: "no-store" });
      const text = await response.text();
      const payload: ClosingResponse = text ? JSON.parse(text) : { success: response.ok };
      if (payload.success && payload.data) {
        setMatrix(payload.data);
        setFilter(emptyMonthlyClosingFilter);
      } else {
        setError(payload.error ?? "Failed to load Monthly Closing.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to load Monthly Closing.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleExport() {
    if (!selectedLine || !selectedPeriod) return;
    setIsExporting(true);
    try {
      const response = await fetch("/api/sales/monthly-closing/export", {
        body: JSON.stringify({ line: selectedLine, period: selectedPeriod }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error("Export failed");
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = /filename="(.+?)"/.exec(disposition);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = match?.[1] ?? "phoenix-monthly-closing.xlsx";
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

  if (initialError && !matrix) {
    return (
      <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-[#E2E8F0] bg-[#F8FAFC] p-5 sm:p-6 xl:p-8">
        <AdminCallout tone="danger">
          <AlertTriangle className="h-4 w-4" />
          <p>{initialError}</p>
        </AdminCallout>
      </div>
    );
  }

  const selectClassName =
    "h-11 w-full rounded-2xl border border-[#D8E0EA] bg-[#F8FAFC] px-3.5 text-sm font-semibold text-[#0F172A] outline-none transition focus:border-[#FDBA74] focus:ring-4 focus:ring-[#F97316]/10 disabled:opacity-60";

  return (
    <div className="min-h-[calc(100vh-7rem)] space-y-7">
      <AdminPageHero
        badges={(
          <>
            <AdminInsightChip>Line: {selectedLine || "None"}</AdminInsightChip>
            <AdminInsightChip>Month: {selectedPeriod || "No validated data"}</AdminInsightChip>
            <AdminInsightChip tone="slate">Products: {filteredMatrix?.columns.length ?? 0}</AdminInsightChip>
            <AdminInsightChip tone="orange">Sales from uploaded distributor sheets</AdminInsightChip>
          </>
        )}
        description="Sales vs target closing per area and region, rolled up to national. Targets and achievement are populated by the upcoming targets upload."
        eyebrow="Monthly Closing"
        icon={<CalendarRange className="h-4 w-4" />}
        title="Monthly Closing"
      />

      <AdminTableShell
        action={(
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="flex flex-col gap-1 sm:w-44">
              <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Line</span>
              <select
                className={selectClassName}
                disabled={isLoading || availableLines.length === 0}
                onChange={(event) => void reload(event.target.value, selectedPeriod)}
                value={selectedLine}
              >
                {availableLines.length === 0 ? (
                  <option value="">No products</option>
                ) : (
                  availableLines.map((line) => (
                    <option key={line} value={line}>{line}</option>
                  ))
                )}
              </select>
            </label>
            <label className="flex flex-col gap-1 sm:w-44">
              <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Month</span>
              <select
                className={selectClassName}
                disabled={isLoading || availablePeriods.length === 0}
                onChange={(event) => void reload(selectedLine, event.target.value)}
                value={selectedPeriod}
              >
                {availablePeriods.length === 0 ? (
                  <option value="">No validated month</option>
                ) : (
                  availablePeriods.map((period) => (
                    <option key={period} value={period}>{period}</option>
                  ))
                )}
              </select>
            </label>
            <Button
              className="gap-2"
              disabled={isLoading}
              onClick={() => void reload(selectedLine, selectedPeriod)}
              variant="secondary"
            >
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </Button>
          </div>
        )}
        description="Areas grouped by region with region subtotals and a national grand total. Each area is counted once — region and national rows are roll-ups of the areas."
        title="Closing Matrix"
      >
        {error ? (
          <div className="p-4 md:p-5">
            <AdminCallout tone="danger">
              <AlertTriangle className="mt-0.5 h-4 w-4" />
              <p>{error}</p>
            </AdminCallout>
          </div>
        ) : !filteredMatrix || availablePeriods.length === 0 ? (
          <div className="p-4 md:p-5">
            <AdminCallout tone="neutral">
              <AlertTriangle className="mt-0.5 h-4 w-4" />
              <p>No validated Source of Sales data yet. Upload and validate distributor sheets first.</p>
            </AdminCallout>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-3 border-b border-slate-100 px-4 py-4 md:flex-row md:items-center md:justify-between md:px-5">
              <MonthlyClosingFilters
                areas={filterOptions.areas}
                onChange={setFilter}
                products={filterOptions.products}
                regions={filterOptions.regions}
                value={filter}
              />
              <button
                className={cn(
                  "inline-flex h-10 shrink-0 items-center gap-2 border border-[#0B0B0B] bg-[#0B0B0B] px-4 text-sm font-bold text-white transition hover:bg-[#F97316] disabled:opacity-50",
                )}
                disabled={isExporting || filteredMatrix.columns.length === 0}
                onClick={() => void handleExport()}
                type="button"
              >
                {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                Export XLSX
              </button>
            </div>
            <ClosingMatrixTable matrix={filteredMatrix} />
          </>
        )}
      </AdminTableShell>
    </div>
  );
}
