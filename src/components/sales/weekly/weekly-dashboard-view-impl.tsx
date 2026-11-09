"use client";

import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  CalendarDays,
  Download,
  FileSpreadsheet,
  Filter,
  Loader2,
  MapPin,
  Minus,
  Package,
  Store,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ReferenceLine, ResponsiveContainer, Text, Tooltip, XAxis, YAxis } from "recharts";

import { cn } from "@/lib/utils";
import type {
  WeeklyBranchComparisonRow,
  WeeklyBranchRow,
  WeeklyDashboard,
  WeeklyDelta,
  WeeklyFilterMode,
  WeeklyRanked,
} from "@/lib/sales/weekly/types";
import { MultiSelectFilter } from "@/components/ui/multi-select-filter";
import {
  SortButton,
  SortableTh,
  TableNoResults,
  TableSearchInput,
  useSortableTable,
  visibleMax,
  type SortState,
} from "@/components/ui/sortable-table";
import {
  branchComparisonColumns,
  rankColumns,
  weekComparisonColumns,
  zeroStockColumns,
} from "@/components/sales/weekly/weekly-table-widths";
import { WeeklyUnitProductPicker } from "@/components/sales/weekly/weekly-unit-product-picker";
import {
  weeklyCutUnits,
  weeklyRowsWithCutUnits,
  weeklyUnitTiles,
  weeklyWeekRowsWithUnits,
  weeklyWeekUnits,
} from "@/lib/sales/weekly/unit-totals";

// THE FITS-THE-SCREEN AND SQUARE-EDGE GOLDEN RULES (AGENTS.md §4). Every table here is `w-full
// table-fixed` with its column widths declared in weekly-table-widths.ts, so none can grow past the
// screen; a long name wraps, and nothing is cut with an ellipsis — the chart labels included. Below md
// each table becomes a list of cards with its own sort row. No corner is rounded. Pinned by
// tests/weekly-sales-fits-the-screen.test.ts, the same test that holds the managers' portal version.
//
// UNITS OF DIFFERENT PRODUCTS ARE NEVER ADDED (owner rule, 2026-08-27; this page, 2026-09-17). Every unit
// or stock figure here adds rows — the tiles and their changes, the Units and Stock columns and cards, the
// two unit charts and the watchlist's stock — so each is its rows' own only while they are one product's,
// and otherwise the "Units for" product's own (owner, 2026-09-19), named on the tile or table it sits in.
// Each asks unit-totals.ts. A product row is always one product's, so By product keeps its own units. The
// Export Excel still dashes a unit total that would add products. Pinned by
// tests/weekly-admin-units-one-product.test.ts.

const money = (value: number) => `EGP ${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const num = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 0 });
const pct = (value: number) => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
const compactNumber = (value: number) => {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${Math.round(value / 1_000)}K`;
  return `${Math.round(value)}`;
};
const CHART_COLORS = ["#F97316", "#2563EB", "#0F766E", "#7C3AED", "#DC2626", "#64748B", "#CA8A04"];

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
// "2026-05-01" → "May 2026" (pure string parse, timezone-safe).
const monthLabelClient = (cycleMonth: string | null) => {
  if (!cycleMonth) return "—";
  const [year, month] = cycleMonth.split("-");
  const name = MONTH_NAMES[Number(month) - 1];
  return name ? `${name} ${year}` : cycleMonth;
};

type WeeklyFilters = {
  distributorCodes: string[];
  distributorMode: WeeklyFilterMode;
  regionCodes: string[];
  regionMode: WeeklyFilterMode;
  productCodes: string[];
  productMode: WeeklyFilterMode;
  lineCodes: string[];
  lineMode: WeeklyFilterMode;
  monthCodes: string[];
  monthMode: WeeklyFilterMode;
  weekNumberCodes: string[];
  weekNumberMode: WeeklyFilterMode;
  /** weekly_sales_batches.id values — pick individual uploads. Empty = every upload in scope. */
  uploadIds: string[];
};

export function WeeklyDashboardView({ initial, initialError }: { initial: WeeklyDashboard | null; initialError: string | null }) {
  const [data, setData] = useState<WeeklyDashboard | null>(initial);
  const [error, setError] = useState<string | null>(initialError);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadingSummary, setDownloadingSummary] = useState(false);
  const [downloadingNsmDsm, setDownloadingNsmDsm] = useState(false);
  const [filters, setFilters] = useState<WeeklyFilters>({
    distributorCodes: initial?.appliedFilters.distributorCodes ?? [],
    distributorMode: initial?.appliedFilters.distributorFilterMode ?? "include",
    regionCodes: initial?.appliedFilters.regionCodes ?? [],
    regionMode: initial?.appliedFilters.regionFilterMode ?? "include",
    productCodes: initial?.appliedFilters.productCodes ?? [],
    productMode: initial?.appliedFilters.productFilterMode ?? "include",
    lineCodes: initial?.appliedFilters.lineCodes ?? [],
    lineMode: initial?.appliedFilters.lineFilterMode ?? "include",
    monthCodes: initial?.appliedFilters.cycleMonths ?? [],
    monthMode: initial?.appliedFilters.cycleMonthMode ?? "include",
    weekNumberCodes: (initial?.appliedFilters.weekNumbers ?? []).map((value) => String(value)),
    weekNumberMode: initial?.appliedFilters.weekNumberMode ?? "include",
    uploadIds: [],
  });
  // The "Units for" pick (WeeklyDashboardUnitView): null until one is picked, when the server shows the top
  // product by value. It rides on the feed request only, never on the filters or the exports.
  const [unitProduct, setUnitProduct] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    // No date-week selector: week scoping is via Month + Week-of-month filters below. With neither set,
    // the server returns all weeks.
    for (const code of filters.distributorCodes) params.append("distributor", code);
    if (filters.distributorMode === "exclude") params.set("distributorMode", "exclude");
    for (const code of filters.regionCodes) params.append("region", code);
    if (filters.regionMode === "exclude") params.set("regionMode", "exclude");
    for (const code of filters.productCodes) params.append("product", code);
    if (filters.productMode === "exclude") params.set("productMode", "exclude");
    for (const code of filters.lineCodes) params.append("line", code);
    if (filters.lineMode === "exclude") params.set("lineMode", "exclude");
    for (const code of filters.monthCodes) params.append("month", code);
    if (filters.monthMode === "exclude") params.set("monthMode", "exclude");
    for (const code of filters.weekNumberCodes) params.append("weekNum", code);
    if (filters.weekNumberMode === "exclude") params.set("weekNumMode", "exclude");
    for (const id of filters.uploadIds) params.append("batch", id);
    if (unitProduct) params.set("unitProduct", unitProduct);
    (async () => {
      // Defer the loading flag off the synchronous effect tick (avoids cascading-render lint).
      await Promise.resolve();
      if (cancelled) return;
      setLoading(true);
      try {
        const response = await fetch(`/api/sales/weekly/dashboard?${params.toString()}`, { cache: "no-store" });
        const payload = (await response.json()) as { success?: boolean; data?: WeeklyDashboard; error?: string };
        if (cancelled) return;
        if (payload?.success && payload.data) {
          setData(payload.data);
          setError(null);
        } else {
          setError(payload?.error ?? "Failed to load the weekly dashboard.");
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Failed to load the weekly dashboard.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    filters.distributorCodes,
    filters.distributorMode,
    filters.regionCodes,
    filters.regionMode,
    filters.productCodes,
    filters.productMode,
    filters.lineCodes,
    filters.lineMode,
    filters.monthCodes,
    filters.monthMode,
    filters.weekNumberCodes,
    filters.weekNumberMode,
    filters.uploadIds,
    unitProduct,
  ]);

  const distributorOptions = useMemo(
    () => (data?.distributors ?? []).map((distributor) => ({ code: distributor.code, label: distributor.name })),
    [data],
  );
  const regionOptions = useMemo(
    () => (data?.availableRegions ?? []).map((region) => ({ code: region.code, label: region.name })),
    [data],
  );
  const productOptions = useMemo(
    () => (data?.availableProducts ?? []).map((product) => ({ code: product.code, label: product.name })),
    [data],
  );
  const lineOptions = useMemo(
    () => (data?.availableLines ?? []).map((line) => ({ code: line, label: line })),
    [data],
  );
  const monthOptions = useMemo(
    () => (data?.availableMonths ?? []).map((month) => ({ code: month.code, label: month.name })),
    [data],
  );
  const weekNumberOptions = useMemo(
    () => (data?.availableWeekNumbers ?? []).map((week) => ({ code: String(week), label: `Week ${week}` })),
    [data],
  );
  const uploadOptions = useMemo(
    () => (data?.availableUploads ?? []).map((upload) => ({ code: upload.code, label: upload.name })),
    [data],
  );
  // Both exports send the SAME filter query — they differ only in the endpoint and the fallback
  // filename. Shared so the two downloads can never drift into disagreeing about what the user is
  // looking at, which is the whole point of the summarized report reconciling to this screen.
  const buildExportParams = useCallback(() => {
    const params = new URLSearchParams();
    for (const code of filters.distributorCodes) params.append("distributor", code);
    if (filters.distributorMode === "exclude") params.set("distributorMode", "exclude");
    for (const code of filters.regionCodes) params.append("region", code);
    if (filters.regionMode === "exclude") params.set("regionMode", "exclude");
    for (const code of filters.productCodes) params.append("product", code);
    if (filters.productMode === "exclude") params.set("productMode", "exclude");
    for (const code of filters.lineCodes) params.append("line", code);
    if (filters.lineMode === "exclude") params.set("lineMode", "exclude");
    for (const code of filters.monthCodes) params.append("month", code);
    if (filters.monthMode === "exclude") params.set("monthMode", "exclude");
    for (const code of filters.weekNumberCodes) params.append("weekNum", code);
    if (filters.weekNumberMode === "exclude") params.set("weekNumMode", "exclude");
    for (const id of filters.uploadIds) params.append("batch", id);
    return params;
  }, [filters]);

  const downloadWorkbook = useCallback(
    async (endpoint: string, fallbackName: string) => {
      const response = await fetch(`${endpoint}?${buildExportParams().toString()}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Export failed.");
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match?.[1] ?? fallbackName;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    },
    [buildExportParams],
  );

  const handleExport = useCallback(async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadWorkbook("/api/sales/weekly/export", "phoenix-weekly-sales.xlsx");
    } catch {
      // silent — network errors show as nothing downloaded
    } finally {
      setDownloading(false);
    }
  }, [downloading, downloadWorkbook]);

  // A third busy flag, for the same reason the second one exists: three exports sharing one flag
  // would freeze all three on any click.
  const handleNsmDsmExport = useCallback(async () => {
    if (downloadingNsmDsm) return;
    setDownloadingNsmDsm(true);
    try {
      await downloadWorkbook("/api/sales/weekly/nsm-dsm-export", "phoenix-weekly-nsm-dsm.xlsx");
    } catch {
      // silent — network errors show as nothing downloaded
    } finally {
      setDownloadingNsmDsm(false);
    }
  }, [downloadingNsmDsm, downloadWorkbook]);

  // Separate busy flag: the summarized report loads three dashboard scopes (period, month, year) and
  // takes longer than the BI workbook, so sharing one flag would freeze both buttons on either click.
  const handleSummaryExport = useCallback(async () => {
    if (downloadingSummary) return;
    setDownloadingSummary(true);
    try {
      await downloadWorkbook("/api/sales/weekly/summary-export", "phoenix-weekly-summary.xlsx");
    } catch {
      // silent — network errors show as nothing downloaded
    } finally {
      setDownloadingSummary(false);
    }
  }, [downloadingSummary, downloadWorkbook]);

  if (!data) {
    return (
      <div className="p-6">
        <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-700 shadow-sm">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <span>{error ?? "No weekly data available yet. Upload a weekly file to get started."}</span>
        </div>
      </div>
    );
  }

  const noData = data.availableWeeks.length === 0;
  const branchRows = data.branchBreakdown ?? [];
  const zeroStockRows = data.zeroSalesBranches ?? [];
  // Which units each figure shows (unit-totals.ts): its rows' own while they are one product's, else the
  // "Units for" product's, named on the tile or table. null only where there is neither. A table whose unit
  // columns come or go is keyed on it, so it starts again from its own sort rather than staying ordered by
  // a column no longer shown.
  const unitTiles = weeklyUnitTiles(data);
  const regionUnits = weeklyCutUnits(data, "region");
  const productUnits = weeklyCutUnits(data, "product");
  const distributorUnits = weeklyCutUnits(data, "distributor");
  const branchUnits = weeklyCutUnits(data, "branch");
  const weekUnits = weeklyWeekUnits(data);
  const unitsFor = (shown: { of: string } | null): string =>
    shown?.of && data.unitView ? ` · units for ${data.unitView.productName}` : "";
  const branchUnitRows = weeklyRowsWithCutUnits(branchRows, branchUnits, (row) => row.code);
  const zeroStockUnitRows = weeklyRowsWithCutUnits(zeroStockRows, branchUnits, (row) => row.branchCode);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <header className="border border-phx-line bg-white px-4 py-3 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="mb-1 flex items-center gap-2 text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-faint">
              <span className="h-2 w-2 bg-phx-accent" />
              Weekly Sales
            </div>
            <h1 className="text-xl font-black text-phx-ink">Weekly Sales Dashboard</h1>
            <p className="mt-1 text-sm font-medium text-phx-ink-soft">
              Consolidated by region, product, branch, and distributor. Stock shown as units only.
            </p>
          </div>
          {/* Wraps: the three exports side by side are wider than a phone. */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleExport}
              disabled={downloading || loading}
              className="flex items-center gap-1.5 border border-phx-accent bg-phx-accent px-3 py-2 text-sm font-black text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-60"
              title="Download Excel report with current filters applied"
            >
              {downloading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {downloading ? "Preparing…" : "Export Excel"}
            </button>
            {/* Second, separate export. Outlined rather than filled so the existing report stays the
                primary action and nobody has to choose between formats after clicking one button. */}
            <button
              type="button"
              onClick={handleSummaryExport}
              disabled={downloadingSummary || loading}
              className="flex items-center gap-1.5 border border-phx-accent bg-white px-3 py-2 text-sm font-black text-phx-accent-hover shadow-sm transition-colors hover:bg-phx-accent-soft disabled:opacity-60"
              title="Download the 5-tab management summary: weekly by branch and manager, month-to-date, year-to-date, and low-sales branches holding stock"
            >
              {downloadingSummary ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileSpreadsheet className="h-4 w-4" />
              )}
              {downloadingSummary ? "Preparing…" : "Summarized Report"}
            </button>
            {/* Third export, outlined like the second so the BI workbook stays the primary action.
                This one is the field manager's book: the same seven tabs the owner reviewed, in
                units, week by week, scoped by whatever filters are on screen. */}
            <button
              type="button"
              onClick={handleNsmDsmExport}
              disabled={downloadingNsmDsm || loading}
              className="flex items-center gap-1.5 border border-phx-accent bg-white px-3 py-2 text-sm font-black text-phx-accent-hover shadow-sm transition-colors hover:bg-phx-accent-soft disabled:opacity-60"
              title="Download the field-manager workbook: sales by area, branch and distributor week by week in units, branches ranked, stock with no sales, and full details — with the current filters applied"
            >
              {downloadingNsmDsm ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Users className="h-4 w-4" />
              )}
              {downloadingNsmDsm ? "Preparing…" : "NSM/DSM Export"}
            </button>
          </div>
        </div>
      </header>

      <div className="border border-phx-line bg-white p-2 shadow-sm">
        <div className="mb-2 flex items-center justify-between px-1 text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-faint">
          <span className="flex items-center gap-1.5">
            <Filter className="h-3.5 w-3.5" />
            Filters
          </span>
          {/* A weekly reload takes seconds, and until it lands the PREVIOUS numbers are still on
              screen. A faint "Updating" was too easy to miss, so a stale unfiltered total read as
              "the period filter did nothing" — make the pending state unmissable instead. */}
          {loading ? (
            <span className="flex items-center gap-1.5 bg-phx-accent px-2 py-0.5 text-white">
              <Loader2 className="h-3 w-3 animate-spin" />
              Updating…
            </span>
          ) : (
            <span className="text-phx-ink-soft">Ready</span>
          )}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {/* Pick individual uploaded sheets. This is the only unambiguous way to say "the file I
              just uploaded" — a date is not, because distributors share week dates and the loader
              merges dates less than 5 days apart into one group. */}
          <MultiSelectFilter
            label="Upload"
            icon={<FileSpreadsheet className="h-3.5 w-3.5" />}
            options={uploadOptions}
            selected={filters.uploadIds}
            mode="include"
            onSelectedChange={(next) => setFilters((f) => ({ ...f, uploadIds: next }))}
            onModeChange={() => undefined}
            allLabel="All uploads"
            searchPlaceholder="Search distributor or date…"
          />
          <MultiSelectFilter
            label="Month"
            icon={<CalendarDays className="h-3.5 w-3.5" />}
            options={monthOptions}
            selected={filters.monthCodes}
            mode={filters.monthMode}
            onSelectedChange={(next) => setFilters((f) => ({ ...f, monthCodes: next }))}
            onModeChange={(next) => setFilters((f) => ({ ...f, monthMode: next }))}
            allLabel="All months"
          />
          <MultiSelectFilter
            label="Week of month"
            icon={<CalendarDays className="h-3.5 w-3.5" />}
            options={weekNumberOptions}
            selected={filters.weekNumberCodes}
            mode={filters.weekNumberMode}
            onSelectedChange={(next) => setFilters((f) => ({ ...f, weekNumberCodes: next }))}
            onModeChange={(next) => setFilters((f) => ({ ...f, weekNumberMode: next }))}
            allLabel="All weeks"
          />
          <MultiSelectFilter
            label="Distributor"
            icon={<Store className="h-3.5 w-3.5" />}
            options={distributorOptions}
            selected={filters.distributorCodes}
            mode={filters.distributorMode}
            onSelectedChange={(next) => setFilters((f) => ({ ...f, distributorCodes: next }))}
            onModeChange={(next) => setFilters((f) => ({ ...f, distributorMode: next }))}
            allLabel="All distributors"
          />
          <MultiSelectFilter
            label="Region"
            icon={<MapPin className="h-3.5 w-3.5" />}
            options={regionOptions}
            selected={filters.regionCodes}
            mode={filters.regionMode}
            onSelectedChange={(next) => setFilters((f) => ({ ...f, regionCodes: next }))}
            onModeChange={(next) => setFilters((f) => ({ ...f, regionMode: next }))}
            allLabel="All regions"
          />
          <MultiSelectFilter
            label="Product"
            icon={<Package className="h-3.5 w-3.5" />}
            options={productOptions}
            selected={filters.productCodes}
            mode={filters.productMode}
            onSelectedChange={(next) => setFilters((f) => ({ ...f, productCodes: next }))}
            onModeChange={(next) => setFilters((f) => ({ ...f, productMode: next }))}
            allLabel="All products"
          />
          <MultiSelectFilter
            label="Line"
            icon={<BarChart3 className="h-3.5 w-3.5" />}
            options={lineOptions}
            selected={filters.lineCodes}
            mode={filters.lineMode}
            onSelectedChange={(next) => setFilters((f) => ({ ...f, lineCodes: next }))}
            onModeChange={(next) => setFilters((f) => ({ ...f, lineMode: next }))}
            // Not "All lines": with no line named the default scope is the TRACKED ones. Saying
            // "all" while excluding 78% of the table is exactly the misreading this scope exists
            // to end.
            allLabel="Tracked lines"
          />
        </div>
      </div>

      {/* What these numbers cover, said on the screen rather than assumed. Head Office is not tracked
          weekly (the owner's golden rule) and is out of scope until a line is named — and it is far
          too big a number to leave out silently. */}
      {data.trackedScope?.active && (
        <p className="text-xs font-semibold text-phx-ink-soft">{data.trackedScope.note}</p>
      )}

      {/* Several products: every unit figure that would add them shows the product picked here instead. */}
      {!noData && data.unitView && data.products.length > 1 ? (
        <WeeklyUnitProductPicker
          tone="admin"
          products={data.products.map((product) => ({ code: product.code, name: product.name }))}
          value={data.unitView.productCode}
          onChange={setUnitProduct}
          note={`This selection holds ${num(data.products.length)} products, and units of different products are never added — so the unit tiles, the unit charts and every Units and Stock column show the product picked here. Values cover every product, and By product lists each product's own units.`}
        />
      ) : null}

      {error && (
        <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700 shadow-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {noData ? (
        <div className="border border-dashed border-phx-line-strong bg-white p-8 text-center text-sm font-semibold text-phx-ink-soft shadow-sm">
          No validated weekly uploads yet. Upload a weekly file from <span className="font-black">Weekly Sales Upload</span>.
        </div>
      ) : (
        // Dim EVERY figure while a reload is in flight, not just the KPI row — the tables and charts
        // below carry the same about-to-be-replaced numbers, and leaving them crisp is what made a
        // pending filter look like an applied one.
        <div className={cn("space-y-4 transition-opacity", loading && "opacity-40")} aria-busy={loading}>
          {/* Four tiles, or two when there are no unit tiles at all — laid out for the count actually there. */}
          <div className={`grid grid-cols-2 gap-3 ${unitTiles ? "lg:grid-cols-4" : ""}`}>
            <Kpi icon={<TrendingUp className="h-4 w-4" />} label="Sales value" value={money(data.kpis.salesValue)} delta={data.compare.salesValue} format={money} />
            {unitTiles ? (
              <Kpi
                icon={<Package className="h-4 w-4" />}
                label={`Sales units${unitTiles.of}`}
                value={num(unitTiles.salesUnits)}
                delta={unitTiles.compare?.salesUnits}
                format={num}
              />
            ) : null}
            {unitTiles ? (
              <Kpi
                icon={<Store className="h-4 w-4" />}
                label={`Stock units${unitTiles.of}`}
                value={num(unitTiles.stockUnits)}
                delta={unitTiles.compare?.stockUnits}
                format={num}
              />
            ) : null}
            <Kpi icon={<Store className="h-4 w-4" />} label="Branches" value={num(data.kpis.branchCount)} sub={`${data.kpis.regionCount} regions - ${data.kpis.productCount} products`} />
          </div>

          <DashboardCharts
            data={data}
            branchUnitRows={branchUnits ? branchUnitRows : null}
            zeroStockUnitRows={branchUnits ? zeroStockUnitRows : null}
            unitsFor={unitsFor(branchUnits)}
          />

          <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
            <RankTable
              key={`region-${regionUnits != null}`}
              title={`By region (all distributors)${unitsFor(regionUnits)}`}
              rows={weeklyRowsWithCutUnits(data.regions, regionUnits, (row) => row.code)}
              showUnits={regionUnits != null}
            />
            <RankTable key={`product-${productUnits != null}`} title="By product" rows={data.products} showUnits={productUnits != null} />
          </div>

          <BranchComparisonTable
            key={`branch-${branchUnits != null}`}
            rows={branchUnitRows}
            showUnits={branchUnits != null}
            unitsFor={unitsFor(branchUnits)}
          />

          {data.distributors.length > 1 && (
            <RankTable
              key={`distributor-${distributorUnits != null}`}
              maxHeight="max-h-64"
              title={`By distributor${unitsFor(distributorUnits)}`}
              rows={weeklyRowsWithCutUnits(data.distributorBreakdown, distributorUnits, (row) => row.code)}
              showUnits={distributorUnits != null}
            />
          )}

          <WeekComparisonTable
            rows={weeklyWeekRowsWithUnits(data.weekComparison, weekUnits)}
            showUnits={weekUnits != null}
            unitsFor={unitsFor(weekUnits)}
          />

          <TrendStrip trend={data.trend} selected={[]} />

          <ZeroStockTable
            key={`stock-${branchUnits != null}`}
            rows={zeroStockUnitRows}
            showStock={branchUnits != null}
            unitsFor={unitsFor(branchUnits)}
          />
        </div>
      )}
    </div>
  );
}

function DeltaPct({ value }: { value: number }) {
  const up = value >= 0;
  return (
    <span className={cn("inline-flex items-center gap-0.5 font-bold", up ? "text-emerald-600" : "text-rose-600")}>
      {up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
      {pct(value)}
    </span>
  );
}

// Week-by-week comparison of REAL (de-cumulated) sales: each week minus the previous week of its
// month. Stock is the week's snapshot (not a difference). The % delta is vs the previous week. Its units
// and stock add every week in scope, so they are the rows' own only while a product filter pins one
// product, and otherwise the "Units for" product's, which `unitsFor` names.
function WeekComparisonTable({
  rows,
  showUnits,
  unitsFor,
}: {
  rows: readonly WeeklyDashboard["weekComparison"][number][];
  showUnits: boolean;
  unitsFor: string;
}) {
  if (!rows || rows.length === 0) return null;
  const columns = weekComparisonColumns(showUnits);
  return (
    <section className="overflow-hidden border border-phx-line bg-white shadow-sm">
      <div className="border-b border-phx-line px-4 py-3">
        <h2 className="break-words text-sm font-black uppercase tracking-[0.12em] text-phx-ink">{`Week-by-week comparison${unitsFor}`}</h2>
        <p className="mt-0.5 text-xs font-medium text-phx-ink-soft">
          Real sales per week — each week minus the previous week of its month (W2−W1, W3−W2, …).
          {showUnits ? " Stock is the week's snapshot, never subtracted." : null}
        </p>
      </div>
      {/* DESKTOP — fixed to its container with every column width declared. This was the page's one
          sideways scroll box until 2026-09-17; the gap chips now wrap under the week mark instead. */}
      <div className="hidden md:block">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col style={{ width: `${columns.month}%` }} />
            <col style={{ width: `${columns.week}%` }} />
            <col style={{ width: `${columns.date}%` }} />
            <col style={{ width: `${columns.value}%` }} />
            {showUnits ? <col style={{ width: `${columns.units}%` }} /> : null}
            {showUnits ? <col style={{ width: `${columns.stock}%` }} /> : null}
            <col style={{ width: `${columns.delta}%` }} />
          </colgroup>
          <thead className="bg-[#020617] text-left text-phx-xs font-black uppercase tracking-wide text-white">
            <tr>
              <th className="px-3 py-2">Month</th>
              <th className="px-2 py-2">Week</th>
              <th className="px-2 py-2">Period date</th>
              <th className="px-2 py-2 text-right">Sales value</th>
              {showUnits ? <th className="px-2 py-2 text-right">Sales units</th> : null}
              {showUnits ? <th className="px-2 py-2 text-right">Stock units</th> : null}
              <th className="px-2 py-2 text-right">vs prev week</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className="border-t border-[#FFE8D6]" key={`${row.cycleMonth}-${row.weekNumber}`}>
                <td className="break-words px-3 py-2 font-semibold text-phx-ink">{monthLabelClient(row.cycleMonth)}</td>
                <td className="px-2 py-2">
                  <WeekMarks row={row} />
                </td>
                <td className="break-words px-2 py-2 text-phx-ink-soft tabular-nums">{row.weekStart ?? "—"}</td>
                <td className="break-words px-2 py-2 text-right font-bold tabular-nums text-phx-ink">
                  {row.salesValue == null ? <span className="text-phx-ink-faint">—</span> : money(row.salesValue)}
                </td>
                {showUnits ? (
                  <td className="break-words px-2 py-2 text-right tabular-nums text-phx-ink-2">
                    {row.salesUnits == null ? <span className="text-phx-ink-faint">—</span> : num(row.salesUnits)}
                  </td>
                ) : null}
                {showUnits ? (
                  <td className="break-words px-2 py-2 text-right tabular-nums text-phx-ink-2">{num(row.stockUnits)}</td>
                ) : null}
                <td className="px-2 py-2 text-right tabular-nums">
                  {row.deltaValuePct == null ? <span className="text-phx-ink-faint">—</span> : <DeltaPct value={row.deltaValuePct} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* PHONE — one card per week, the same figures under the same labels. */}
      <div className="space-y-2 p-3 md:hidden">
        {rows.map((row) => (
          <PhoneCard key={`card-${row.cycleMonth}-${row.weekNumber}`}>
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 break-words text-sm font-black text-phx-ink">{monthLabelClient(row.cycleMonth)}</p>
              <WeekMarks row={row} />
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <CardStat label="Period date" value={row.weekStart ?? "—"} />
              <CardStat label="Sales value" value={row.salesValue == null ? "—" : money(row.salesValue)} />
              {showUnits ? <CardStat label="Sales units" value={row.salesUnits == null ? "—" : num(row.salesUnits)} /> : null}
              {showUnits ? <CardStat label="Stock units" value={num(row.stockUnits)} /> : null}
              <CardStat
                label="vs prev week"
                value={row.deltaValuePct == null ? "—" : <DeltaPct value={row.deltaValuePct} />}
              />
            </div>
          </PhoneCard>
        ))}
      </div>
    </section>
  );
}

/** The week mark and its gap chips. They wrap under the mark when the column is narrow. */
function WeekMarks({ row }: { row: WeeklyDashboard["weekComparison"][number] }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="inline-flex items-center bg-phx-accent-soft px-2 py-0.5 text-phx-xs font-black text-[#9A3412]">
        W{row.weekNumber}
      </span>
      {row.spansGap ? (
        <span
          className="inline-flex items-center bg-[#FEF3C7] px-1.5 py-0.5 text-phx-sm font-bold uppercase tracking-wide text-[#92400E]"
          title="An earlier week of this month was never uploaded, so this week's figure spans the missing week(s) — it is not a true single-week value."
        >
          Spans gap
        </span>
      ) : null}
      {/* Kept, marked: one depot skipped the week before, the other depots' figures are real. */}
      {row.depotSpansGap && !row.spansGap ? (
        <span
          className="inline-flex items-center bg-[#FEF3C7] px-1.5 py-0.5 text-phx-sm font-bold uppercase tracking-wide text-[#92400E]"
          title="A branch whose sales are in this week sent no sheet for the week before, so this figure also holds the week it skipped and reads high."
        >
          Branch gap
        </span>
      ) : null}
    </span>
  );
}

// ── Phone cards ──────────────────────────────────────────────────────────────────────────────────────
// Below md a table is a list of cards (AGENTS.md §4: desktop shows full tables, phones get cards).

function PhoneCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex overflow-hidden border border-phx-line bg-white">
      <span className="w-[3px] shrink-0 bg-phx-accent" />
      <div className="min-w-0 flex-1 p-3">{children}</div>
    </div>
  );
}

function CardStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0 border border-phx-paper-2 bg-phx-paper px-2 py-1.5">
      <p className="break-words text-phx-xs font-black uppercase tracking-wide text-phx-ink-faint">{label}</p>
      <div className="break-words text-sm font-black tabular-nums text-phx-ink">{value}</div>
    </div>
  );
}

/** The value bar under a name, square-ended. */
function ValueBar({ value, max, floor, thick = false }: { value: number; max: number; floor: number; thick?: boolean }) {
  return (
    <div className={cn("mt-1 w-full bg-phx-paper-2", thick ? "h-1.5" : "h-1")}>
      <div className={cn("bg-phx-accent", thick ? "h-1.5" : "h-1")} style={{ width: `${Math.max(floor, (value / max) * 100)}%` }} />
    </div>
  );
}

/** A table's sort controls for the phone cards, which have no header row to click. */
function PhoneSortRow({
  sort,
  onSort,
  options,
}: {
  sort: SortState | null;
  onSort: (key: string) => void;
  options: { key: string; label: string }[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-phx-line px-3 py-2 text-phx-sm font-black uppercase tracking-wide text-phx-ink-soft md:hidden">
      <span className="text-phx-ink-faint">Sort</span>
      {options.map((option) => (
        <SortButton key={option.key} label={option.label} onSort={onSort} sort={sort} sortKey={option.key} />
      ))}
    </div>
  );
}

function CardsNoResults({ filtered, label = "rows" }: { filtered: boolean; label?: string }) {
  return (
    <p className="px-3 py-5 text-center text-sm text-phx-ink-faint">
      {filtered ? `No ${label} match your search.` : `No ${label}.`}
    </p>
  );
}

function Kpi({
  icon,
  label,
  value,
  sub,
  delta,
  format,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  delta?: WeeklyDelta;
  format?: (value: number) => string;
}) {
  return (
    <div className="border border-phx-line bg-white p-3 shadow-sm">
      <div className="flex items-center gap-2 text-phx-xs font-black uppercase tracking-wide text-phx-ink-faint">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center border border-phx-line bg-phx-paper text-phx-ink-soft">{icon}</span>
        {label}
      </div>
      <div className="mt-2 text-lg font-black tabular-nums text-phx-ink">{value}</div>
      {delta ? <DeltaLabel delta={delta} format={format} /> : sub ? <div className="mt-0.5 text-phx-xs font-bold text-phx-ink-faint">{sub}</div> : null}
    </div>
  );
}

function DeltaLabel({ delta, format }: { delta: WeeklyDelta; format?: (value: number) => string }) {
  if (delta.prior == null) {
    return (
      <div className="mt-0.5 flex items-center gap-1 text-phx-xs font-bold text-phx-ink-faint">
        <Minus className="h-3 w-3" /> no prior week
      </div>
    );
  }
  const up = (delta.pct ?? 0) >= 0;
  const tone = delta.pct == null ? "text-phx-ink-faint" : up ? "text-emerald-600" : "text-rose-600";
  return (
    <div className={`mt-0.5 flex items-center gap-1 text-phx-xs font-bold ${tone}`}>
      {delta.pct == null ? <Minus className="h-3 w-3" /> : up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
      {delta.pct == null ? "-" : pct(delta.pct)}
      <span className="font-medium text-phx-ink-faint">vs {format ? format(delta.prior) : delta.prior}</span>
    </div>
  );
}

/**
 * The two unit charts draw a branch's units and stock. Those add its products, so they are the branch's
 * own only while the selection is one product, and otherwise the "Units for" product's (`unitsFor` names
 * it): its top branches by its own units, and the zero-sales branches holding it. The value charts always
 * cover every product. A null row list is a chart with no units to draw.
 */
function DashboardCharts({
  data,
  branchUnitRows,
  zeroStockUnitRows,
  unitsFor,
}: {
  data: WeeklyDashboard;
  branchUnitRows: readonly WeeklyBranchComparisonRow[] | null;
  zeroStockUnitRows: readonly WeeklyBranchRow[] | null;
  unitsFor: string;
}) {
  const picked = unitsFor !== "";
  const branchRows = branchUnitRows
    ? (picked
        ? [...branchUnitRows].sort((a, b) => b.salesUnits - a.salesUnits || b.stockUnits - a.stockUnits)
        : branchUnitRows
      ).slice(0, 10)
    : null;
  const stockRiskRows = zeroStockUnitRows
    ? (picked
        ? zeroStockUnitRows.filter((row) => row.stockUnits > 0).sort((a, b) => b.stockUnits - a.stockUnits)
        : zeroStockUnitRows
      ).slice(0, 8)
    : null;
  return (
    <section className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <HorizontalValueChart rows={data.regions.slice(0, 8)} title="Regional sales value" />
      <ProductMixChart rows={data.products} />
      {branchRows ? <BranchSalesStockChart rows={branchRows} unitsFor={unitsFor} /> : null}
      {stockRiskRows ? <ZeroSalesStockChart rows={stockRiskRows} unitsFor={unitsFor} /> : null}
    </section>
  );
}

function ChartPanel({
  children,
  meta,
  title,
}: {
  children: React.ReactNode;
  meta?: string;
  title: string;
}) {
  return (
    <div className="overflow-hidden border border-phx-line bg-white shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-phx-line bg-phx-paper px-3 py-2">
        <span className="text-xs font-black uppercase tracking-wide text-phx-ink-soft">{title}</span>
        {meta ? <span className="text-phx-sm font-black uppercase tracking-wide text-phx-ink-faint">{meta}</span> : null}
      </div>
      {children}
    </div>
  );
}

function EmptyChart({ label }: { label: string }) {
  return (
    <div className="flex h-[260px] items-center justify-center px-4 text-center text-sm font-semibold text-phx-ink-faint">
      {label}
    </div>
  );
}

function HorizontalValueChart({ rows, title }: { rows: WeeklyRanked[]; title: string }) {
  // The whole name: the axis wraps it onto a second line rather than cutting it with an ellipsis.
  const chartRows = rows.map((row) => ({
    ...row,
    label: row.name || row.code,
  }));
  return (
    <ChartPanel meta={`${chartRows.length} rows`} title={title}>
      {chartRows.length === 0 ? (
        <EmptyChart label="No sales rows for this filter." />
      ) : (
        <div className="h-[300px] min-w-0 px-2 py-3">
          <ResponsiveContainer height="100%" width="100%">
            <BarChart data={chartRows} layout="vertical" margin={{ bottom: 4, left: 8, right: 18, top: 6 }}>
              <CartesianGrid horizontal={false} stroke="#E2E8F0" strokeDasharray="4 8" />
              <XAxis axisLine={false} tick={{ fill: "#94A3B8", fontSize: 10, fontWeight: 700 }} tickFormatter={(value) => compactNumber(Number(value))} tickLine={false} type="number" />
              <YAxis axisLine={false} dataKey="label" tick={{ fill: "#334155", fontSize: 10, fontWeight: 700 }} tickLine={false} type="category" width={112} />
              <Tooltip formatter={(value) => money(Number(value))} labelFormatter={(_, payload) => payload?.[0]?.payload?.name ?? ""} />
              <Bar dataKey="salesValue" fill="#F97316" radius={[0, 0, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartPanel>
  );
}

function ProductMixChart({ rows }: { rows: WeeklyRanked[] }) {
  const top = rows.slice(0, 6);
  const restValue = rows.slice(6).reduce((total, row) => total + row.salesValue, 0);
  const chartRows = restValue > 0 ? [...top, { code: "OTHER", name: "Other products", salesValue: restValue, salesUnits: 0, stockUnits: 0, share: 0 }] : top;
  return (
    <ChartPanel meta={`${rows.length} products`} title="Product mix">
      {chartRows.length === 0 ? (
        <EmptyChart label="No product sales for this filter." />
      ) : (
        <div className="grid min-h-[300px] grid-cols-1 gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_180px]">
          <div className="h-[260px] min-w-0">
            <ResponsiveContainer height="100%" width="100%">
              <PieChart>
                <Tooltip formatter={(value) => money(Number(value))} />
                <Pie cx="50%" cy="50%" data={chartRows} dataKey="salesValue" innerRadius="56%" nameKey="name" outerRadius="82%" paddingAngle={2}>
                  {chartRows.map((row, index) => (
                    <Cell fill={CHART_COLORS[index % CHART_COLORS.length]} key={row.code} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="flex flex-col justify-center gap-2">
            {chartRows.map((row, index) => (
              <div className="flex items-center justify-between gap-2 text-xs" key={row.code}>
                <span className="flex min-w-0 items-center gap-2 font-bold text-phx-ink-2">
                  <span className="h-2 w-2 shrink-0" style={{ background: CHART_COLORS[index % CHART_COLORS.length] }} />
                  <span className="min-w-0 break-words">{row.name}</span>
                </span>
                <span className="shrink-0 tabular-nums font-black text-phx-ink">{compactNumber(row.salesValue)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </ChartPanel>
  );
}

function BranchSalesStockChart({ rows, unitsFor }: { rows: readonly WeeklyBranchComparisonRow[]; unitsFor: string }) {
  const chartRows = rows.map((row) => ({
    ...row,
    label: row.name || row.code,
  }));
  return (
    <ChartPanel meta={`${chartRows.length} branches`} title={`Branch sales vs stock${unitsFor}`}>
      {chartRows.length === 0 ? (
        <EmptyChart label="No branch rows for this filter." />
      ) : (
        <div className="h-[300px] min-w-0 px-2 py-3">
          <ResponsiveContainer height="100%" width="100%">
            {/* The axis is taller and the bottom margin smaller by the same amount, so the plot keeps
                its height while a whole branch name wraps inside its own slot. */}
            <BarChart data={chartRows} margin={{ bottom: 4, left: -8, right: 14, top: 8 }}>
              <CartesianGrid stroke="#E2E8F0" strokeDasharray="4 8" vertical={false} />
              <XAxis axisLine={false} dataKey="label" height={48} interval={0} tick={<SlotWrappedTick />} tickLine={false} />
              <YAxis axisLine={false} tick={{ fill: "#94A3B8", fontSize: 10, fontWeight: 700 }} tickFormatter={(value) => compactNumber(Number(value))} tickLine={false} width={46} />
              <Tooltip formatter={(value, name) => [num(Number(value)), name === "salesUnits" ? "Sales units" : "Stock units"]} labelFormatter={(_, payload) => payload?.[0]?.payload?.name ?? ""} />
              <Bar dataKey="salesUnits" fill="#F97316" radius={[0, 0, 0, 0]} />
              <Bar dataKey="stockUnits" fill="#2563EB" radius={[0, 0, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartPanel>
  );
}

/**
 * A category tick that wraps its whole label inside its own slot. The default tick is handed the WHOLE
 * axis width, so long names under neighbouring bars ran into each other — which is why they used to be
 * cut with an ellipsis instead.
 */
function SlotWrappedTick({
  x,
  y,
  width,
  visibleTicksCount,
  payload,
}: {
  x?: number;
  y?: number;
  width?: number;
  visibleTicksCount?: number;
  payload?: { value?: string | number };
}) {
  const slot = width && visibleTicksCount ? width / visibleTicksCount : undefined;
  return (
    <Text
      fill="#64748B"
      fontSize={9}
      fontWeight={700}
      textAnchor="middle"
      verticalAnchor="start"
      width={slot}
      x={x}
      y={y}
    >
      {String(payload?.value ?? "")}
    </Text>
  );
}

function ZeroSalesStockChart({ rows, unitsFor }: { rows: readonly WeeklyBranchRow[]; unitsFor: string }) {
  const chartRows = rows.map((row) => ({
    ...row,
    label: row.branchName || row.branchCode,
  }));
  return (
    <ChartPanel meta={`${chartRows.length} branches`} title={`Stock with zero sales${unitsFor}`}>
      {chartRows.length === 0 ? (
        <EmptyChart label="No stock-on-hand zero-sales branches for this filter." />
      ) : (
        <div className="h-[300px] min-w-0 px-2 py-3">
          <ResponsiveContainer height="100%" width="100%">
            <BarChart data={chartRows} layout="vertical" margin={{ bottom: 4, left: 8, right: 18, top: 6 }}>
              <CartesianGrid horizontal={false} stroke="#E2E8F0" strokeDasharray="4 8" />
              <XAxis axisLine={false} tick={{ fill: "#94A3B8", fontSize: 10, fontWeight: 700 }} tickFormatter={(value) => compactNumber(Number(value))} tickLine={false} type="number" />
              <YAxis axisLine={false} dataKey="label" tick={{ fill: "#334155", fontSize: 10, fontWeight: 700 }} tickLine={false} type="category" width={112} />
              <Tooltip formatter={(value) => [num(Number(value)), "Stock units"]} labelFormatter={(_, payload) => payload?.[0]?.payload?.branchName ?? ""} />
              <Bar dataKey="stockUnits" fill="#0F766E" radius={[0, 0, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartPanel>
  );
}

/** A ranked table. `showUnits` is the rule's answer for its cut: a hidden figure neither shows nor sorts. */
function RankTable({
  title,
  rows,
  showUnits,
  className,
  maxHeight = "max-h-80",
}: {
  title: string;
  rows: readonly WeeklyRanked[];
  showUnits: boolean;
  className?: string;
  maxHeight?: string;
}) {
  const table = useSortableTable(rows, {
    columns: [
      { key: "name", accessor: (row) => row.name, type: "string" },
      { key: "salesValue", accessor: (row) => row.salesValue, type: "number" },
      ...(showUnits
        ? [
            { key: "salesUnits", accessor: (row: WeeklyRanked) => row.salesUnits, type: "number" as const },
            { key: "stockUnits", accessor: (row: WeeklyRanked) => row.stockUnits, type: "number" as const },
          ]
        : []),
      { key: "share", accessor: (row) => row.share, type: "number" },
    ],
    searchAccessors: [(row) => row.name, (row) => row.code],
    initialSort: { key: "salesValue", dir: "desc" },
    secondarySort: { key: "name", accessor: (row) => row.name, type: "string" },
  });
  const max = visibleMax(table.rows, (row) => row.salesValue);
  const columns = rankColumns(showUnits);
  return (
    <section className={cn("overflow-hidden border border-phx-line bg-white shadow-sm", className)}>
      <PanelTitle
        count={table.visible}
        total={table.total}
        filtered={table.isFiltered}
        title={title}
        actions={
          <TableSearchInput value={table.query} onChange={table.setQuery} onClear={table.clearQuery} placeholder="Filter…" />
        }
      />
      <PhoneSortRow
        sort={table.sort}
        onSort={table.toggleSort}
        options={[
          { key: "name", label: "Name" },
          { key: "salesValue", label: "Sales value" },
          ...(showUnits
            ? [
                { key: "salesUnits", label: "Units" },
                { key: "stockUnits", label: "Stock" },
              ]
            : []),
          { key: "share", label: "Share" },
        ]}
      />
      {/* Scrolls DOWN only, inside its height cap; the table itself is fixed to the card's width. */}
      <div className={cn("overflow-y-auto", maxHeight)}>
        <div className="hidden md:block">
          <table className="w-full table-fixed text-sm">
            <colgroup>
              <col style={{ width: `${columns.name}%` }} />
              <col style={{ width: `${columns.value}%` }} />
              {showUnits ? <col style={{ width: `${columns.units}%` }} /> : null}
              {showUnits ? <col style={{ width: `${columns.stock}%` }} /> : null}
              <col style={{ width: `${columns.share}%` }} />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-[#020617] text-left text-phx-sm font-black uppercase text-white">
              <tr>
                <SortableTh label="Name" sortKey="name" sort={table.sort} onSort={table.toggleSort} />
                <SortableTh label="Sales value" sortKey="salesValue" sort={table.sort} onSort={table.toggleSort} align="right" className="px-2" />
                {showUnits ? (
                  <SortableTh label="Units" sortKey="salesUnits" sort={table.sort} onSort={table.toggleSort} align="right" className="px-2" />
                ) : null}
                {showUnits ? (
                  <SortableTh label="Stock" sortKey="stockUnits" sort={table.sort} onSort={table.toggleSort} align="right" className="px-2" />
                ) : null}
                <SortableTh label="Share" sortKey="share" sort={table.sort} onSort={table.toggleSort} align="right" className="px-2" />
              </tr>
            </thead>
            <tbody>
              {table.rows.length === 0 && <TableNoResults colSpan={3 + (showUnits ? 2 : 0)} filtered={table.isFiltered} />}
              {table.rows.map((row) => (
                <tr className="border-t border-phx-paper-2 transition hover:bg-phx-accent-soft" key={row.code}>
                  <td className="px-3 py-2">
                    <div className="break-words font-semibold text-phx-ink">{row.name}</div>
                    <ValueBar value={row.salesValue} max={max} floor={2} />
                  </td>
                  <td className="break-words px-2 py-2 text-right tabular-nums font-bold text-phx-ink">{money(row.salesValue)}</td>
                  {showUnits ? (
                    <td className="break-words px-2 py-2 text-right tabular-nums text-phx-ink-2">{num(row.salesUnits)}</td>
                  ) : null}
                  {showUnits ? (
                    <td className="break-words px-2 py-2 text-right tabular-nums text-phx-ink-2">{num(row.stockUnits)}</td>
                  ) : null}
                  <td className="break-words px-2 py-2 text-right tabular-nums text-phx-ink-soft">{(row.share * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="space-y-2 p-3 md:hidden">
          {table.rows.length === 0 && <CardsNoResults filtered={table.isFiltered} />}
          {table.rows.map((row) => (
            <PhoneCard key={`card-${row.code}`}>
              <p className="break-words text-sm font-black text-phx-ink">{row.name}</p>
              <ValueBar value={row.salesValue} max={max} floor={2} />
              <div className="mt-2 grid grid-cols-2 gap-2">
                <CardStat label="Sales value" value={money(row.salesValue)} />
                {showUnits ? <CardStat label="Units" value={num(row.salesUnits)} /> : null}
                {showUnits ? <CardStat label="Stock" value={num(row.stockUnits)} /> : null}
                <CardStat label="Share" value={`${(row.share * 100).toFixed(1)}%`} />
              </div>
            </PhoneCard>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * The Branches comparison. A branch row adds its products, so its units and stock are its own only while
 * the selection is one product, and otherwise the "Units for" product's, which `unitsFor` names.
 */
function BranchComparisonTable({
  rows,
  showUnits,
  unitsFor,
}: {
  rows: readonly WeeklyBranchComparisonRow[];
  showUnits: boolean;
  unitsFor: string;
}) {
  const table = useSortableTable(rows, {
    columns: [
      { key: "name", accessor: (row) => row.name, type: "string" },
      { key: "regionName", accessor: (row) => row.regionName, type: "string" },
      { key: "salesValue", accessor: (row) => row.salesValue, type: "number" },
      ...(showUnits
        ? [
            { key: "salesUnits", accessor: (row: WeeklyBranchComparisonRow) => row.salesUnits, type: "number" as const },
            { key: "stockUnits", accessor: (row: WeeklyBranchComparisonRow) => row.stockUnits, type: "number" as const },
          ]
        : []),
      { key: "share", accessor: (row) => row.share, type: "number" },
    ],
    searchAccessors: [(row) => row.name, (row) => row.regionName, (row) => row.code],
    initialSort: { key: "salesValue", dir: "desc" },
    secondarySort: { key: "name", accessor: (row) => row.name, type: "string" },
  });
  const max = visibleMax(table.rows, (row) => row.salesValue);
  const columns = branchComparisonColumns(showUnits);
  return (
    <section className="overflow-hidden border border-phx-line bg-white shadow-sm">
      <PanelTitle
        count={table.visible}
        total={table.total}
        filtered={table.isFiltered}
        title={`Branches comparison${unitsFor}`}
        actions={
          <TableSearchInput value={table.query} onChange={table.setQuery} onClear={table.clearQuery} placeholder="Filter branches…" />
        }
      />
      <PhoneSortRow
        sort={table.sort}
        onSort={table.toggleSort}
        options={[
          { key: "name", label: "Branch" },
          { key: "regionName", label: "Region" },
          { key: "salesValue", label: "Sales value" },
          ...(showUnits
            ? [
                { key: "salesUnits", label: "Units" },
                { key: "stockUnits", label: "Stock" },
              ]
            : []),
          { key: "share", label: "Share" },
        ]}
      />
      <div className="max-h-96 overflow-y-auto">
        <div className="hidden md:block">
          <table className="w-full table-fixed text-sm">
            <colgroup>
              <col style={{ width: `${columns.branch}%` }} />
              <col style={{ width: `${columns.region}%` }} />
              <col style={{ width: `${columns.value}%` }} />
              {showUnits ? <col style={{ width: `${columns.units}%` }} /> : null}
              {showUnits ? <col style={{ width: `${columns.stock}%` }} /> : null}
              <col style={{ width: `${columns.share}%` }} />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-[#020617] text-left text-phx-sm font-black uppercase text-white">
              <tr>
                <SortableTh label="Branch" sortKey="name" sort={table.sort} onSort={table.toggleSort} />
                <SortableTh label="Region" sortKey="regionName" sort={table.sort} onSort={table.toggleSort} className="px-2" />
                <SortableTh label="Sales value" sortKey="salesValue" sort={table.sort} onSort={table.toggleSort} align="right" className="px-2" />
                {showUnits ? (
                  <SortableTh label="Units" sortKey="salesUnits" sort={table.sort} onSort={table.toggleSort} align="right" className="px-2" />
                ) : null}
                {showUnits ? (
                  <SortableTh label="Stock" sortKey="stockUnits" sort={table.sort} onSort={table.toggleSort} align="right" className="px-2" />
                ) : null}
                <SortableTh label="Share" sortKey="share" sort={table.sort} onSort={table.toggleSort} align="right" className="px-2" />
              </tr>
            </thead>
            <tbody>
              {table.rows.length === 0 && (
                <TableNoResults colSpan={4 + (showUnits ? 2 : 0)} filtered={table.isFiltered} label="branch rows" />
              )}
              {table.rows.map((row) => (
                <tr className="border-t border-phx-paper-2 transition hover:bg-phx-accent-soft" key={row.code}>
                  <td className="px-3 py-2">
                    <div className="break-words font-semibold text-phx-ink">{row.name}</div>
                    <ValueBar value={row.salesValue} max={max} floor={2} />
                  </td>
                  <td className="break-words px-2 py-2 font-semibold text-phx-ink-2">{row.regionName}</td>
                  <td className="break-words px-2 py-2 text-right tabular-nums font-bold text-phx-ink">{money(row.salesValue)}</td>
                  {showUnits ? (
                    <td className="break-words px-2 py-2 text-right tabular-nums text-phx-ink-2">{num(row.salesUnits)}</td>
                  ) : null}
                  {showUnits ? (
                    <td className="break-words px-2 py-2 text-right tabular-nums text-phx-ink-2">{num(row.stockUnits)}</td>
                  ) : null}
                  <td className="break-words px-2 py-2 text-right tabular-nums text-phx-ink-soft">{(row.share * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="space-y-2 p-3 md:hidden">
          {table.rows.length === 0 && <CardsNoResults filtered={table.isFiltered} label="branch rows" />}
          {table.rows.map((row) => (
            <PhoneCard key={`card-${row.code}`}>
              <p className="break-words text-sm font-black text-phx-ink">{row.name}</p>
              <p className="break-words text-phx-xs font-semibold text-phx-ink-2">{row.regionName}</p>
              <ValueBar value={row.salesValue} max={max} floor={2} />
              <div className="mt-2 grid grid-cols-2 gap-2">
                <CardStat label="Sales value" value={money(row.salesValue)} />
                {showUnits ? <CardStat label="Units" value={num(row.salesUnits)} /> : null}
                {showUnits ? <CardStat label="Stock" value={num(row.stockUnits)} /> : null}
                <CardStat label="Share" value={`${(row.share * 100).toFixed(1)}%`} />
              </div>
            </PhoneCard>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * The Stock on hand watchlist. A branch's stock adds its products, so the stock column, its bars and the
 * header total are there only while the selection is one product; without them the branches keep the
 * order they arrive in, biggest stock VALUE first (weeklyZeroSalesBranches).
 */
function ZeroStockTable({
  rows,
  showStock,
  unitsFor,
}: {
  rows: readonly WeeklyBranchRow[];
  showStock: boolean;
  unitsFor: string;
}) {
  const table = useSortableTable(rows, {
    columns: [
      { key: "branchName", accessor: (row) => row.branchName, type: "string" },
      { key: "regionName", accessor: (row) => row.regionName, type: "string" },
      ...(showStock
        ? [{ key: "stockUnits", accessor: (row: WeeklyBranchRow) => row.stockUnits, type: "number" as const }]
        : []),
    ],
    searchAccessors: [(row) => row.branchName, (row) => row.regionName],
    initialSort: showStock ? { key: "stockUnits", dir: "desc" } : null,
    secondarySort: { key: "branchName", accessor: (row) => row.branchName, type: "string" },
  });
  const max = showStock ? visibleMax(table.rows, (row) => row.stockUnits) : 1;
  // The rows shown: every row until a search narrows them.
  const shownStock = showStock ? table.rows.reduce((total, row) => total + row.stockUnits, 0) : null;
  const columns = zeroStockColumns(showStock);
  return (
    <section className="overflow-hidden border border-phx-line bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-phx-line bg-phx-paper px-3 py-2">
        <div>
          <div className="text-xs font-black uppercase tracking-wide text-phx-ink-soft">Stock on hand watchlist</div>
          <div className="break-words text-phx-xs font-bold text-phx-ink-faint">{`Zero sales branches${unitsFor}`}</div>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-40 sm:w-48">
            <TableSearchInput value={table.query} onChange={table.setQuery} onClear={table.clearQuery} placeholder="Filter branches…" />
          </div>
          <div className="text-right">
            {shownStock !== null ? <div className="text-sm font-black tabular-nums text-phx-ink">{num(shownStock)}</div> : null}
            <div className="text-phx-sm font-black uppercase tracking-wide text-phx-ink-faint">
              {table.isFiltered && table.visible !== table.total ? `${table.visible} / ${table.total}` : table.visible} rows
            </div>
          </div>
        </div>
      </div>
      <PhoneSortRow
        sort={table.sort}
        onSort={table.toggleSort}
        options={[
          { key: "branchName", label: "Branch" },
          { key: "regionName", label: "Region" },
          ...(showStock ? [{ key: "stockUnits", label: "Stock units" }] : []),
        ]}
      />
      <div className="max-h-80 overflow-y-auto">
        <div className="hidden md:block">
          <table className="w-full table-fixed text-sm">
            <colgroup>
              <col style={{ width: `${columns.branch}%` }} />
              <col style={{ width: `${columns.region}%` }} />
              {showStock ? <col style={{ width: `${columns.stock}%` }} /> : null}
            </colgroup>
            <thead className="sticky top-0 z-10 bg-[#020617] text-left text-phx-sm font-black uppercase text-white">
              <tr>
                <SortableTh label="Branch" sortKey="branchName" sort={table.sort} onSort={table.toggleSort} />
                <SortableTh label="Region" sortKey="regionName" sort={table.sort} onSort={table.toggleSort} />
                {showStock ? (
                  <SortableTh label="Stock units" sortKey="stockUnits" sort={table.sort} onSort={table.toggleSort} align="right" />
                ) : null}
              </tr>
            </thead>
            <tbody>
              {table.rows.length === 0 && (
                <TableNoResults
                  colSpan={2 + (showStock ? 1 : 0)}
                  filtered={table.isFiltered}
                  label="stock-on-hand branches with zero sales"
                />
              )}
              {table.rows.map((branch) => (
                <tr className="border-t border-phx-paper-2 transition hover:bg-phx-accent-soft" key={`${branch.branchCode}-${branch.regionName}`}>
                  <td className="px-3 py-2">
                    <div className="break-words font-semibold text-phx-ink">{branch.branchName}</div>
                    {showStock ? <ValueBar value={branch.stockUnits} max={max} floor={4} thick /> : null}
                  </td>
                  <td className="break-words px-3 py-2 text-phx-ink-2">{branch.regionName}</td>
                  {showStock ? (
                    <td className="break-words px-3 py-2 text-right tabular-nums font-bold text-phx-ink-2">{num(branch.stockUnits)}</td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="space-y-2 p-3 md:hidden">
          {table.rows.length === 0 && <CardsNoResults filtered={table.isFiltered} label="stock-on-hand branches with zero sales" />}
          {table.rows.map((branch) => (
            <PhoneCard key={`card-${branch.branchCode}-${branch.regionName}`}>
              <p className="break-words text-sm font-black text-phx-ink">{branch.branchName}</p>
              {showStock ? <ValueBar value={branch.stockUnits} max={max} floor={4} thick /> : null}
              <div className="mt-2 grid grid-cols-2 gap-2">
                <CardStat label="Region" value={branch.regionName} />
                {showStock ? <CardStat label="Stock units" value={num(branch.stockUnits)} /> : null}
              </div>
            </PhoneCard>
          ))}
        </div>
      </div>
    </section>
  );
}

function PanelTitle({
  count,
  total,
  filtered,
  title,
  actions,
}: {
  count: number;
  total?: number;
  filtered?: boolean;
  title: string;
  actions?: React.ReactNode;
}) {
  const showSplit = filtered && typeof total === "number" && total !== count;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-phx-line bg-phx-paper px-3 py-2">
      <span className="text-xs font-black uppercase tracking-wide text-phx-ink-soft">{title}</span>
      <div className="flex items-center gap-2">
        {actions ? <div className="w-40 sm:w-48">{actions}</div> : null}
        <span className="shrink-0 border border-phx-line bg-white px-2 py-1 text-phx-sm font-black uppercase tracking-wide text-phx-ink-faint">
          {showSplit ? `${count} / ${total}` : count} rows
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Weekly sales-value trend — year-aware smooth area chart (white surface, calm).
// 2025 = muted slate-blue (the "past"); 2026 = brand orange (the "now"); any other
// year falls back to neutral slate so the chart never breaks on long/odd spans.
// ─────────────────────────────────────────────────────────────────────────────

// Per-year stroke colors. Distributors are NEVER drawn as extra lines — they live
// only inside the tooltip, so the chart stays quiet.
const TREND_YEAR_COLOR: Record<string, string> = {
  "2025": "#60A5FA", // blue-400 — quiet past year
  "2026": "#F97316", // brand orange — current year (focal)
};
const TREND_YEAR_FALLBACK = "#94A3B8"; // slate — any other year
const TREND_SELECTED = "#EA580C"; // deep brand orange — selected emphasis
const trendYearColor = (year: string) => TREND_YEAR_COLOR[year] ?? TREND_YEAR_FALLBACK;

const TREND_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Full-date x-axis tick: "2026-05-18" -> "18 May".
const formatWeekTick = (weekStart: string) => {
  const [, m, d] = String(weekStart).split("-");
  const month = TREND_MONTHS[Number(m) - 1];
  const day = Number(d);
  return month && day ? `${day} ${month}` : weekStart;
};

// Week-of-month x-axis label: "W1 May". Falls back to the date when a point isn't week-tagged.
const weekOfMonthLabel = (weekNumber: number | null, cycleMonth: string | null, weekStart: string) => {
  if (weekNumber == null || !cycleMonth) return formatWeekTick(weekStart);
  const month = TREND_MONTHS[Number(cycleMonth.split("-")[1]) - 1];
  return month ? `W${weekNumber} ${month}` : `W${weekNumber}`;
};

// Compact EGP axis formatter — 1_200_000 -> "1.2M", 48_000 -> "48K".
const compactEgp = (value: number) => {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${Math.round(value / 1_000)}K`;
  return `${Math.round(value)}`;
};

// One row per week. Each year gets its own value channel (null elsewhere) so the
// year segments render in their own color and visually meet at the boundary.
type TrendDatum = {
  weekStart: string;
  /** "W1 May" week-of-month label for the axis + tooltip */
  label: string;
  year: string;
  total: number;
  selected: boolean;
  wow: number | null; // week-over-week ratio vs the previous in-scope week
  byDistributor: { distributorCode: string; distributorName: string; salesValue: number }[];
  v2025: number | null;
  v2026: number | null;
  vOther: number | null;
};

// Per-point dot — a small clean ring on every week, and a larger ringed marker on
// selected weeks. Keyed off the datum payload (NOT the x category), so it can never
// mis-resolve when the same calendar date recurs across years.
type TrendDotProps = {
  cx?: number;
  cy?: number;
  payload?: TrendDatum;
  color?: string;
};

function TrendDot({ cx, cy, payload, color = TREND_YEAR_FALLBACK }: TrendDotProps) {
  if (cx == null || cy == null) return null;
  if (payload?.selected) {
    return (
      <g>
        <circle cx={cx} cy={cy} fill="#FFFFFF" r={7} stroke={TREND_SELECTED} strokeOpacity={0.22} strokeWidth={6} />
        <circle cx={cx} cy={cy} fill={TREND_SELECTED} r={4} stroke="#FFFFFF" strokeWidth={2} />
      </g>
    );
  }
  return <circle cx={cx} cy={cy} fill="#FFFFFF" r={2.75} stroke={color} strokeWidth={2} />;
}

// Compact white floating tooltip — week + total + prominent WoW% + distributor share.
function TrendTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload?: TrendDatum }[];
}) {
  const datum = active ? payload?.find((entry) => entry.payload)?.payload : undefined;
  if (!datum) return null;

  const color = trendYearColor(datum.year);
  const breakdown = [...datum.byDistributor].filter((d) => d.salesValue > 0).sort((a, b) => b.salesValue - a.salesValue);
  const top = breakdown.slice(0, 4);
  const rest = breakdown.slice(4);
  const restValue = rest.reduce((sum, row) => sum + row.salesValue, 0);
  const up = (datum.wow ?? 0) >= 0;

  return (
    <div className="pointer-events-none w-max max-w-[270px] border border-phx-line bg-white px-3 py-2.5 shadow-[0_8px_24px_-8px_rgba(15,23,42,0.25)]">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-phx-xs font-bold tabular-nums text-phx-ink-soft">
          <span className="inline-block h-2 w-2" style={{ background: color }} />
          {datum.label}
        </span>
        {datum.selected && (
          <span className="bg-phx-accent-soft px-1.5 py-0.5 text-phx-xs font-black uppercase tracking-wide text-phx-accent-hover">
            Selected
          </span>
        )}
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-3">
        <span className="text-lg font-black tabular-nums text-phx-ink">{money(datum.total)}</span>
        {datum.wow !== null && (
          <span
            className={cn(
              "inline-flex items-center gap-1 px-1.5 py-1 text-phx-md font-black tabular-nums",
              up ? "bg-[#ECFDF5] text-[#047857]" : "bg-[#FEF2F2] text-[#B91C1C]",
            )}
          >
            {up ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
            {`${up ? "+" : ""}${(datum.wow * 100).toFixed(1)}%`}
          </span>
        )}
      </div>
      {datum.wow !== null && <div className="mt-0.5 text-phx-sm font-bold text-phx-ink-faint">vs previous week</div>}
      {top.length > 0 && (
        <div className="mt-2 space-y-1 border-t border-phx-paper-2 pt-2">
          {top.map((row) => {
            const share = datum.total > 0 ? row.salesValue / datum.total : 0;
            return (
              <div className="flex items-center justify-between gap-3" key={row.distributorCode}>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="inline-block h-1.5 w-1.5 shrink-0" style={{ background: color, opacity: 0.45 }} />
                  <span className="min-w-0 break-words text-phx-sm font-bold text-phx-ink-soft">{row.distributorName || row.distributorCode}</span>
                </span>
                <span className="shrink-0 text-phx-sm font-black tabular-nums text-phx-ink-2">
                  {(share * 100).toFixed(0)}% · {compactEgp(row.salesValue)}
                </span>
              </div>
            );
          })}
          {rest.length > 0 && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-phx-sm font-bold text-phx-ink-faint">+{rest.length} more</span>
              <span className="shrink-0 text-phx-sm font-black tabular-nums text-phx-ink-faint">{compactEgp(restValue)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TrendStrip({ trend, selected }: { trend: WeeklyDashboard["trend"]; selected: string[] }) {
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const { chartData, years, multiYear, yearBoundaries } = useMemo(() => {
    const seen = new Set<string>();
    const boundaries: string[] = [];
    const rows: TrendDatum[] = trend.map((point, index) => {
      const year = point.weekStart.slice(0, 4);
      if (!seen.has(year)) {
        seen.add(year);
        boundaries.push(point.weekStart);
      }
      const prev = index > 0 ? trend[index - 1] : null;
      const wow = prev && prev.salesValue !== 0 ? (point.salesValue - prev.salesValue) / prev.salesValue : null;
      return {
        weekStart: point.weekStart,
        label: weekOfMonthLabel(point.weekNumber, point.cycleMonth, point.weekStart),
        year,
        total: point.salesValue,
        selected: selectedSet.has(point.weekStart),
        wow,
        byDistributor: point.byDistributor ?? [],
        v2025: year === "2025" ? point.salesValue : null,
        v2026: year === "2026" ? point.salesValue : null,
        vOther: year === "2025" || year === "2026" ? null : point.salesValue,
      };
    });

    // Stitch the boundary: write the LAST week of the ending year into the NEXT
    // year's channel too, so the two colored areas touch instead of leaving a gap.
    for (let i = 1; i < rows.length; i += 1) {
      const prevRow = rows[i - 1];
      const currRow = rows[i];
      if (prevRow.year === currRow.year) continue;
      if (currRow.v2026 !== null) prevRow.v2026 = prevRow.total;
      else if (currRow.v2025 !== null) prevRow.v2025 = prevRow.total;
      else prevRow.vOther = prevRow.total;
    }

    const ys = [...seen].sort();
    return {
      chartData: rows,
      years: ys,
      multiYear: ys.length > 1,
      yearBoundaries: boundaries.slice(1), // first year needs no divider
    };
  }, [trend, selectedSet]);

  const meta = useMemo(() => {
    const average = trend.length ? trend.reduce((sum, point) => sum + point.salesValue, 0) / trend.length : 0;
    const selectedPoints = trend.filter((point) => selectedSet.has(point.weekStart));
    const highlightTotal = selectedPoints.length
      ? selectedPoints.reduce((sum, point) => sum + point.salesValue, 0)
      : (trend[trend.length - 1]?.salesValue ?? 0);
    return { average, selectedCount: selectedPoints.length, highlightTotal };
  }, [trend, selectedSet]);

  // Render the card even when there is too little data — show a message rather than
  // vanishing silently, so the user knows the section exists and why it is empty.
  if (trend.length < 2) {
    return (
      <section className="w-full overflow-hidden border border-phx-line bg-white shadow-sm">
        <div className="flex items-center gap-1.5 border-b border-phx-line bg-phx-paper px-4 py-3">
          <span className="inline-block h-1.5 w-1.5 bg-phx-accent" />
          <span className="text-xs font-black uppercase tracking-wide text-phx-ink-soft">Weekly sales-value trend</span>
          <span className="ml-2 text-phx-xs font-semibold text-phx-ink-faint">
            {trend.length === 0 ? "No data for current filter" : "1 week — need at least 2 to draw a trend"}
          </span>
        </div>
        <div className="flex h-20 items-center justify-center text-phx-xs font-medium text-phx-line-strong">
          {trend.length === 0
            ? "No weekly sales data matches the current filter selection."
            : "Upload a second week or clear filters to display the trend chart."}
        </div>
      </section>
    );
  }

  const hasOther = chartData.some((d) => d.vOther !== null);
  const labelByWeekStart = new Map(chartData.map((d) => [d.weekStart, d.label]));

  return (
    <section className="w-full overflow-hidden border border-phx-line bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-phx-line bg-phx-paper px-4 py-3">
        <div>
          <div className="flex items-center gap-1.5 text-xs font-black uppercase tracking-wide text-phx-ink-soft">
            <span className="inline-block h-1.5 w-1.5 bg-phx-accent" />
            Weekly sales-value trend
          </div>
          <div className="mt-1 flex items-center gap-2.5">
            <span className="text-phx-xs font-bold text-phx-ink-faint">{trend.length} weeks</span>
            {multiYear && (
              <span className="flex items-center gap-2 border-l border-phx-line pl-2.5">
                {years.map((year) => (
                  <span className="flex items-center gap-1" key={year}>
                    <span className="inline-block h-1.5 w-3" style={{ background: trendYearColor(year) }} />
                    <span className="text-phx-sm font-bold tabular-nums text-phx-ink-faint">{year}</span>
                  </span>
                ))}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-right">
          <div>
            <div className="text-phx-sm font-black uppercase tracking-wide text-phx-ink-soft">Average</div>
            <div className="text-sm font-black tabular-nums text-phx-ink-2">{money(meta.average)}</div>
          </div>
          <div className="border-l border-phx-line pl-3">
            <div className="text-phx-sm font-black uppercase tracking-wide text-phx-accent-hover">
              {meta.selectedCount > 1 ? `${meta.selectedCount} selected weeks` : "Highlighted week"}
            </div>
            <div className="text-lg font-black tabular-nums text-phx-ink">{money(meta.highlightTotal)}</div>
          </div>
        </div>
      </div>

      <div className="h-[300px] min-w-0 px-1 pb-1 pt-3">
        <ResponsiveContainer height="100%" width="100%">
          <AreaChart data={chartData} margin={{ bottom: 4, left: -12, right: 10, top: 14 }}>
            <defs>
              <linearGradient id="trendFill2026" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#F97316" stopOpacity={0.2} />
                <stop offset="100%" stopColor="#F97316" stopOpacity={0.01} />
              </linearGradient>
              <linearGradient id="trendFill2025" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#60A5FA" stopOpacity={0.16} />
                <stop offset="100%" stopColor="#60A5FA" stopOpacity={0.01} />
              </linearGradient>
              <linearGradient id="trendFillOther" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#94A3B8" stopOpacity={0.14} />
                <stop offset="100%" stopColor="#94A3B8" stopOpacity={0.01} />
              </linearGradient>
            </defs>

            <CartesianGrid stroke="#E2E8F0" strokeDasharray="4 10" vertical={false} />
            <XAxis
              axisLine={false}
              dataKey="weekStart"
              interval="preserveStartEnd"
              minTickGap={24}
              tick={{ fill: "#64748B", fontSize: 10, fontWeight: 600 }}
              tickFormatter={(value) => labelByWeekStart.get(String(value)) ?? formatWeekTick(String(value))}
              tickLine={false}
              tickMargin={8}
            />
            <YAxis
              axisLine={false}
              tick={{ fill: "#94A3B8", fontSize: 10, fontWeight: 600 }}
              tickFormatter={compactEgp}
              tickLine={false}
              width={48}
            />
            <Tooltip
              content={<TrendTooltip />}
              cursor={{ stroke: "#F97316", strokeDasharray: "4 4", strokeWidth: 1 }}
              isAnimationActive={false}
              wrapperStyle={{ outline: "none" }}
            />

            {/* Quiet average baseline */}
            <ReferenceLine ifOverflow="extendDomain" stroke="#CBD5E1" strokeDasharray="2 6" y={meta.average} />

            {/* Hairline year-boundary markers, labeled with the actual year. */}
            {multiYear &&
              yearBoundaries.map((boundary) => (
                <ReferenceLine
                  ifOverflow="extendDomain"
                  key={boundary}
                  label={{ fill: "#94A3B8", fontSize: 9, fontWeight: 700, position: "insideTopRight", value: boundary.slice(0, 4) }}
                  stroke="#CBD5E1"
                  strokeDasharray="2 4"
                  x={boundary}
                />
              ))}

            {/* Prior year (2025) — calm blue, recedes. */}
            <Area
              activeDot={{ fill: "#FFFFFF", r: 4, stroke: "#60A5FA", strokeWidth: 2.5 }}
              animationDuration={650}
              animationEasing="ease-out"
              connectNulls
              dataKey="v2025"
              dot={<TrendDot color="#60A5FA" />}
              fill="url(#trendFill2025)"
              isAnimationActive
              stroke="#60A5FA"
              strokeWidth={2}
              type="monotone"
            />
            {/* Current year (2026) — brand orange, the focal line. */}
            <Area
              activeDot={{ fill: "#FFFFFF", r: 5, stroke: "#F97316", strokeWidth: 3 }}
              animationBegin={140}
              animationDuration={700}
              animationEasing="ease-out"
              connectNulls
              dataKey="v2026"
              dot={<TrendDot color="#F97316" />}
              fill="url(#trendFill2026)"
              isAnimationActive
              stroke="#F97316"
              strokeWidth={2.5}
              type="monotone"
            />
            {/* Fallback for any year that is not 2025/2026 — never breaks. */}
            {hasOther && (
              <Area
                activeDot={{ fill: "#FFFFFF", r: 4, stroke: "#94A3B8", strokeWidth: 2.5 }}
                animationDuration={650}
                animationEasing="ease-out"
                connectNulls
                dataKey="vOther"
                dot={<TrendDot color="#94A3B8" />}
                fill="url(#trendFillOther)"
                isAnimationActive
                stroke="#94A3B8"
                strokeWidth={2}
                type="monotone"
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
