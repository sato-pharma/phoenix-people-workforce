"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Boxes,
  Building2,
  CalendarRange,
  Clock,
  Coins,
  Download,
  Layers,
  MapPin,
  Package,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
  Truck,
} from "lucide-react";

import { MultiSelectFilter, type MultiSelectFilterMode, type MultiSelectFilterOption } from "@/components/ui/multi-select-filter";
import {
  WEEKLY_STOCK_COVER_LOW_WEEKS,
  WEEKLY_STOCK_COVER_OVER_WEEKS,
  WEEKLY_STOCK_SALES_WINDOW_WEEKS,
  WEEKLY_STOCK_STATUS_LABELS,
  type WeeklyStockCell,
  type WeeklyStockDistributorRow,
  type WeeklyStockGroupRow,
  type WeeklyStockProductRow,
  type WeeklyStockStatus,
} from "@/lib/sales/weekly/stock-dashboard";
import type { WeeklyStockPayload } from "@/lib/sales/weekly/stock-dashboard-service";

// Weekly Stock — one screen for the admin shell and the employee portal. The server decides the
// viewer's scope; this component only carries the viewer's own filter choices to the feed and renders
// what comes back. Units appear ONLY against a single product; every figure spanning products is a
// value (owner rule), so the depot/area/region/distributor tables have no unit column at all.

type Props = {
  initial: WeeklyStockPayload;
  /** JSON feed for this shell (`/api/sales/weekly/stock` or `/api/employee-portals/weekly-stock`). */
  feedPath: string;
  /** XLSX export for this shell — same query string, so the download matches the screen. */
  exportPath: string;
};

type ServerKey = "distributors" | "regions" | "lines" | "products";
type LocalKey = "areas" | "depots" | "statuses";
type FilterKey = ServerKey | LocalKey;
type StockTab = "cells" | "products" | "depots" | "areas" | "regions" | "distributors";

const FILTER_KEYS: FilterKey[] = ["distributors", "regions", "lines", "products", "areas", "depots", "statuses"];
const LOCAL_KEYS: LocalKey[] = ["areas", "depots", "statuses"];
const PAGE_SIZE = 100;
/** Sent when an exclude selection leaves nothing: a depot key that matches no depot. */
const NOTHING = "__none__";

const blankSelection = () => Object.fromEntries(FILTER_KEYS.map((key) => [key, [] as string[]])) as Record<FilterKey, string[]>;
const includeModes = () =>
  Object.fromEntries(FILTER_KEYS.map((key) => [key, "include"])) as Record<FilterKey, MultiSelectFilterMode>;
const blankResolved = (): Record<LocalKey, string[] | null> => ({ areas: null, depots: null, statuses: null });
const isLocalKey = (key: FilterKey): key is LocalKey => (LOCAL_KEYS as string[]).includes(key);

const STATUS_OPTIONS: MultiSelectFilterOption[] = (Object.keys(WEEKLY_STOCK_STATUS_LABELS) as WeeklyStockStatus[]).map((code) => ({
  code,
  label: WEEKLY_STOCK_STATUS_LABELS[code],
}));

const STATUS_BADGE: Record<WeeklyStockStatus, string> = {
  low: "border-rose-200 bg-rose-50 text-rose-700",
  healthy: "border-emerald-200 bg-emerald-50 text-emerald-700",
  over: "border-amber-200 bg-amber-50 text-amber-800",
  no_sales: "border-slate-200 bg-slate-100 text-slate-600",
};
const STATUS_RAIL: Record<WeeklyStockStatus, string> = {
  low: "bg-rose-500",
  healthy: "bg-emerald-500",
  over: "bg-amber-500",
  no_sales: "bg-slate-400",
};

const TABS: { key: StockTab; label: string }[] = [
  { key: "cells", label: "Depot × Product" },
  { key: "products", label: "Products" },
  { key: "depots", label: "Depots" },
  { key: "areas", label: "Areas" },
  { key: "regions", label: "Regions" },
  { key: "distributors", label: "Distributors" },
];

// ── Formatting ───────────────────────────────────────────────────────────────
function formatEgp(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `EGP ${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `EGP ${(value / 1_000).toFixed(1)}K`;
  return `EGP ${Math.round(value).toLocaleString("en-US")}`;
}
function formatEgpFull(value: number): string {
  return `EGP ${Math.round(value).toLocaleString("en-US")}`;
}
function formatUnits(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}
function formatAvgUnits(value: number): string {
  return value >= 10 ? Math.round(value).toLocaleString("en-US") : value.toFixed(1);
}
function formatCover(value: number | null): string {
  return value == null ? "—" : `${value.toFixed(1)} wks`;
}
/** Weeks of cover as the line under the average in the desktop tables, labelled because it has no column of its own. */
function formatCoverLine(value: number | null): string {
  return `Cover ${formatCover(value)}`;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

export function WeeklyStockDashboard({ initial, feedPath, exportPath }: Props) {
  const [payload, setPayload] = useState<WeeklyStockPayload>(initial);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [asOf, setAsOf] = useState("");
  const [selection, setSelection] = useState(blankSelection);
  const [modes, setModes] = useState(includeModes);
  // Area, depot and status are applied by the stock builder, which takes an include list. An exclude
  // choice is turned into "every option shown except these" at the moment it is made, so the query
  // never depends on option lists that themselves change with the response.
  const [resolved, setResolved] = useState(blankResolved);
  const [tab, setTab] = useState<StockTab>("cells");
  const [pager, setPager] = useState({ key: "", limit: PAGE_SIZE });

  const firstRun = useRef(true);
  const cacheRef = useRef(new Map<string, WeeklyStockPayload>());

  const { view, options, scope } = payload;
  const vis = scope.visibility;

  const areaOptions = useMemo(() => view.availableAreas.map((area) => ({ code: area.code, label: area.name })), [view.availableAreas]);
  const depotOptions = useMemo(
    () => view.availableBranches.map((branch) => ({ code: branch.code, label: branch.name })),
    [view.availableBranches],
  );
  const distributorOptions = useMemo(() => options.distributors.map((d) => ({ code: d.code, label: d.name })), [options.distributors]);
  const regionOptions = useMemo(() => options.regions.map((r) => ({ code: r.code, label: r.name })), [options.regions]);
  const productOptions = useMemo(() => options.products.map((p) => ({ code: p.code, label: p.name })), [options.products]);
  const lineOptions = useMemo(() => options.lines.map((line) => ({ code: line, label: line })), [options.lines]);

  const localOptions = (key: LocalKey) => (key === "areas" ? areaOptions : key === "depots" ? depotOptions : STATUS_OPTIONS);
  const resolveLocal = (key: LocalKey, selected: string[], mode: MultiSelectFilterMode): string[] | null => {
    if (selected.length === 0) return null;
    if (mode === "include") return selected;
    return localOptions(key)
      .map((option) => option.code)
      .filter((code) => !selected.includes(code));
  };

  const changeSelection = (key: FilterKey, next: string[]) => {
    setSelection((prev) => ({ ...prev, [key]: next }));
    if (isLocalKey(key)) setResolved((prev) => ({ ...prev, [key]: resolveLocal(key, next, modes[key]) }));
  };
  const changeMode = (key: FilterKey, next: MultiSelectFilterMode) => {
    setModes((prev) => ({ ...prev, [key]: next }));
    if (isLocalKey(key)) setResolved((prev) => ({ ...prev, [key]: resolveLocal(key, selection[key], next) }));
  };
  const drill = (key: FilterKey, code: string) => {
    setSelection((prev) => ({ ...prev, [key]: [code] }));
    setModes((prev) => ({ ...prev, [key]: "include" }));
    if (isLocalKey(key)) setResolved((prev) => ({ ...prev, [key]: [code] }));
    setTab("cells");
  };
  const resetFilters = () => {
    setAsOf("");
    setSelection(blankSelection());
    setModes(includeModes());
    setResolved(blankResolved());
  };

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (asOf) params.set("asOf", asOf);
    const addServer = (key: ServerKey, allowed: boolean) => {
      if (!allowed || selection[key].length === 0) return;
      params.set(key, selection[key].join(","));
      if (modes[key] === "exclude") params.set(`${key}Mode`, "exclude");
    };
    addServer("distributors", true);
    addServer("regions", vis.region);
    addServer("lines", vis.line);
    addServer("products", true);
    let matchesNothing = false;
    for (const key of LOCAL_KEYS) {
      const codes = resolved[key];
      if (codes == null) continue;
      if (codes.length === 0) matchesNothing = true;
      else params.set(key, codes.join(","));
    }
    if (matchesNothing) params.set("depots", NOTHING);
    return params.toString();
  }, [asOf, selection, modes, resolved, vis.region, vis.line]);

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      cacheRef.current.set(query, initial);
      return;
    }
    const cached = cacheRef.current.get(query);
    if (cached) {
      setPayload(cached);
      setError(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(`${feedPath}${query ? `?${query}` : ""}`, { signal: controller.signal, cache: "no-store" });
        const json = await response.json().catch(() => null);
        if (response.ok && json?.success) {
          const next: WeeklyStockPayload = { view: json.view, options: json.options, scope: json.scope };
          cacheRef.current.set(query, next);
          setPayload(next);
          setError(null);
        } else {
          setError(typeof json?.error === "string" ? json.error : "Weekly Stock could not be loaded.");
        }
      } catch (caught) {
        if (!(caught instanceof DOMException && caught.name === "AbortError")) {
          setError("Weekly Stock could not be loaded. Check your connection and try again.");
        }
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, feedPath, initial, refreshTick]);

  const refresh = () => {
    cacheRef.current.clear();
    setRefreshTick((tick) => tick + 1);
  };

  const activeFilterCount =
    (asOf ? 1 : 0) +
    selection.distributors.length +
    (vis.region ? selection.regions.length : 0) +
    (vis.line ? selection.lines.length : 0) +
    selection.products.length +
    selection.areas.length +
    selection.depots.length +
    selection.statuses.length;

  const pageKey = `${query}|${tab}`;
  const limit = pager.key === pageKey ? pager.limit : PAGE_SIZE;
  const showMore = () => setPager({ key: pageKey, limit: limit + PAGE_SIZE });

  const staleDistributors = view.distributors.filter((row) => row.stale);
  const exportHref = `${exportPath}${query ? `?${query}` : ""}`;
  const kpis = view.kpis;
  const totalCover = kpis.coverWeeks;

  const rowCount =
    tab === "cells"
      ? view.cells.length
      : tab === "products"
        ? view.products.length
        : tab === "depots"
          ? view.depots.length
          : tab === "areas"
            ? view.areas.length
            : tab === "regions"
              ? view.regions.length
              : view.distributors.length;

  const hasAnyStock = view.availableAsOfWeeks.length > 0;

  const filterField = (key: FilterKey, label: string, icon: ReactNode, fieldOptions: MultiSelectFilterOption[]) => (
    <MultiSelectFilter
      label={label}
      icon={icon}
      options={fieldOptions}
      selected={selection[key]}
      mode={modes[key]}
      onSelectedChange={(next) => changeSelection(key, next)}
      onModeChange={(next) => changeMode(key, next)}
    />
  );

  return (
    <div className="space-y-5">
      {/* Scope bar */}
      <div className="flex flex-col gap-3 rounded-sm border border-slate-200 bg-white px-4 py-3 shadow-[0_10px_30px_rgba(15,23,42,0.05)] ring-1 ring-slate-200/60 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="h-9 w-[3px] shrink-0 bg-orange-500" />
          <div className="min-w-0">
            <p className="text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-400">Your scope</p>
            <p className="break-words text-sm font-black text-slate-900">{scope.summary}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border border-slate-200 bg-slate-50 px-2.5 py-1 text-phx-2xs font-black uppercase tracking-wide text-slate-600">
            <Clock className="h-3 w-3" />
            Stock as of {formatDate(view.asOfWeekStart)}
          </span>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-sm border border-slate-200 bg-white px-2.5 py-1.5 text-phx-2xs font-black uppercase tracking-wide text-slate-700 transition hover:border-orange-300 hover:text-orange-600 disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            Sync now
          </button>
          {loading ? (
            <span className="flex items-center gap-1.5 text-phx-2xs font-bold uppercase tracking-wide text-orange-600">
              <span className="h-1.5 w-1.5 animate-pulse bg-orange-500" />
              Updating
            </span>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="rounded-sm border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-800">{error}</div>
      ) : null}

      {staleDistributors.length > 0 ? (
        <div className="flex gap-3 rounded-sm border border-amber-200 bg-amber-50 px-4 py-3">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="text-phx-md font-semibold text-amber-900">
            {"Old stock files: "}
            {staleDistributors.map((row) => `${row.name} (${formatDate(row.asOfWeekStart)})`).join(", ")}
            {". Their stock is shown as last reported, not as today's."}
          </p>
        </div>
      ) : null}

      {/* Filters */}
      <Panel
        title="Filters"
        overflowVisible
        action={
          activeFilterCount > 0 ? (
            <button
              type="button"
              onClick={resetFilters}
              className="inline-flex items-center gap-1.5 rounded-sm bg-white/10 px-2.5 py-1 text-phx-2xs font-black uppercase tracking-wide text-white transition hover:bg-orange-500"
            >
              <RotateCcw className="h-3 w-3" />
              Reset {activeFilterCount}
            </button>
          ) : (
            <span className="text-phx-2xs font-bold uppercase tracking-widest text-slate-400">No filters applied</span>
          )
        }
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <label className="flex min-w-0 flex-col gap-1.5 rounded-sm border border-slate-200 bg-white px-3 py-2">
            <span className="flex items-center gap-1.5 text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">
              <CalendarRange className="h-3 w-3" />
              Stock as of
            </span>
            <select
              value={asOf}
              onChange={(event) => setAsOf(event.target.value)}
              className="w-full rounded-sm border-0 bg-transparent p-0 text-sm font-black text-slate-900 focus:outline-none focus:ring-0"
            >
              <option value="">Latest file per distributor</option>
              {view.availableAsOfWeeks.map((week) => (
                <option key={week} value={week}>
                  {formatDate(week)}
                </option>
              ))}
            </select>
          </label>
          {filterField("distributors", "Distributor", <Truck className="h-3 w-3" />, distributorOptions)}
          {vis.region ? filterField("regions", "Region", <MapPin className="h-3 w-3" />, regionOptions) : null}
          {filterField("areas", "Area", <MapPin className="h-3 w-3" />, areaOptions)}
          {filterField("depots", "Depot", <Building2 className="h-3 w-3" />, depotOptions)}
          {vis.line ? filterField("lines", "Line", <Layers className="h-3 w-3" />, lineOptions) : null}
          {filterField("products", "Product", <Package className="h-3 w-3" />, productOptions)}
          {filterField("statuses", "Stock status", <Boxes className="h-3 w-3" />, STATUS_OPTIONS)}
        </div>
      </Panel>

      {!hasAnyStock && activeFilterCount === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-sm border border-dashed border-slate-200 bg-white p-12 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-sm bg-orange-50 text-orange-500 ring-1 ring-orange-100">
            <Boxes className="h-5 w-5" />
          </span>
          <p className="max-w-md text-sm font-semibold text-slate-600">
            No distributor has reported stock for your scope yet. This is a missing file, not a zero stock.
          </p>
        </div>
      ) : (
        <>
          {/* KPIs — every total here is a value, never a unit count across products. */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi accent="#F97316" icon={Coins} label="Stock value" value={formatEgp(kpis.stockValue)} sub="Units × factory price" />
            <Kpi
              accent="#0EA5E9"
              icon={CalendarRange}
              label="Avg weekly sales"
              value={formatEgp(kpis.avgWeeklyValue)}
              sub={`Last ${WEEKLY_STOCK_SALES_WINDOW_WEEKS} weeks, value`}
            />
            <Kpi
              accent="#6366F1"
              icon={Clock}
              label="Weeks of cover"
              value={formatCover(totalCover)}
              sub={totalCover == null ? "No sales in window" : "Stock value ÷ weekly sales"}
            />
            <Kpi accent="#0F172A" icon={Building2} label="Depots" value={formatUnits(kpis.depotCount)} sub={`${formatUnits(kpis.productCount)} products`} />
            <Kpi
              accent="#E11D48"
              icon={TriangleAlert}
              label="Low stock"
              value={formatUnits(kpis.lowCount)}
              sub={`Under ${WEEKLY_STOCK_COVER_LOW_WEEKS} weeks`}
              onClick={() => drill("statuses", "low")}
            />
            <Kpi
              accent="#10B981"
              icon={Boxes}
              label="Healthy"
              value={formatUnits(Math.max(0, view.cells.length - kpis.lowCount - kpis.overCount - kpis.noSalesCount))}
              sub={`${WEEKLY_STOCK_COVER_LOW_WEEKS} to ${WEEKLY_STOCK_COVER_OVER_WEEKS} weeks`}
              onClick={() => drill("statuses", "healthy")}
            />
            <Kpi
              accent="#F59E0B"
              icon={Package}
              label="Overstock"
              value={formatUnits(kpis.overCount)}
              sub={`Over ${WEEKLY_STOCK_COVER_OVER_WEEKS} weeks`}
              onClick={() => drill("statuses", "over")}
            />
            <Kpi
              accent="#64748B"
              icon={Boxes}
              label="No sales"
              value={formatUnits(kpis.noSalesCount)}
              sub="Stock, nothing sold"
              onClick={() => drill("statuses", "no_sales")}
            />
          </div>

          {kpis.priceMissingCount > 0 ? (
            <p className="text-phx-xs font-semibold text-slate-500">
              {kpis.priceMissingCount} {kpis.priceMissingCount === 1 ? "row has" : "rows have"} no factory price in the Product Master, so
              {kpis.priceMissingCount === 1 ? " it is" : " they are"} counted in units but valued at zero.
            </p>
          ) : null}

          <Panel
            title="Stock"
            action={
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex flex-wrap border border-slate-700">
                  {TABS.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => setTab(item.key)}
                      className={`whitespace-nowrap px-2.5 py-1 text-phx-2xs font-black uppercase tracking-wide transition ${
                        tab === item.key ? "bg-orange-500 text-white" : "bg-slate-800 text-slate-300 hover:text-white"
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <a
                  href={exportHref}
                  className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-slate-600 bg-white px-2.5 text-phx-2xs font-black uppercase tracking-wide text-slate-900 transition hover:border-orange-400 hover:text-orange-600"
                >
                  <Download className="h-3 w-3" />
                  Export
                </a>
              </div>
            }
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2 text-phx-xs font-bold text-slate-600">
              <span>
                {formatUnits(rowCount)} {rowCount === 1 ? "row" : "rows"}
              </span>
              <span className="tabular-nums text-slate-900">Total stock value {formatEgpFull(kpis.stockValue)}</span>
            </div>
            {rowCount === 0 ? (
              <div className="p-8 text-center text-sm font-semibold text-slate-400">No stock rows for this selection.</div>
            ) : tab === "cells" ? (
              <CellsTable rows={view.cells.slice(0, limit)} />
            ) : tab === "products" ? (
              <ProductsTable rows={view.products.slice(0, limit)} onDrill={(code) => drill("products", code)} />
            ) : tab === "distributors" ? (
              <GroupTable
                nameLabel="Distributor"
                rows={view.distributors.slice(0, limit)}
                onDrill={(code) => drill("distributors", code)}
              />
            ) : (
              <GroupTable
                nameLabel={tab === "depots" ? "Depot" : tab === "areas" ? "Area" : "Region"}
                rows={(tab === "depots" ? view.depots : tab === "areas" ? view.areas : view.regions).slice(0, limit)}
                onDrill={
                  tab === "regions" && !vis.region
                    ? undefined
                    : (code) => drill(tab === "depots" ? "depots" : tab === "areas" ? "areas" : "regions", code)
                }
              />
            )}
            {rowCount > limit ? (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-4 py-3">
                <span className="text-phx-xs font-semibold text-slate-500">
                  Showing {formatUnits(limit)} of {formatUnits(rowCount)}
                </span>
                <button
                  type="button"
                  onClick={showMore}
                  className="inline-flex items-center gap-1.5 rounded-sm border border-slate-200 bg-white px-3 py-1.5 text-phx-2xs font-black uppercase tracking-wide text-slate-700 transition hover:border-orange-300 hover:text-orange-600"
                >
                  Show {formatUnits(Math.min(PAGE_SIZE, rowCount - limit))} more
                </button>
              </div>
            ) : null}
          </Panel>

          <p className="text-phx-xs font-semibold leading-relaxed text-slate-500">
            Stock is each distributor&apos;s latest stock file on or before the date chosen, never added across weeks. Weeks of cover is
            stock divided by average weekly net sales over the last {WEEKLY_STOCK_SALES_WINDOW_WEEKS} weeks: low stock under{" "}
            {WEEKLY_STOCK_COVER_LOW_WEEKS} weeks, healthy {WEEKLY_STOCK_COVER_LOW_WEEKS} to {WEEKLY_STOCK_COVER_OVER_WEEKS}, overstock over{" "}
            {WEEKLY_STOCK_COVER_OVER_WEEKS}. Units are shown per product only; every total across products is a value. Head Office products
            are not tracked weekly.
          </p>
        </>
      )}
    </div>
  );
}

// ── Building blocks ──────────────────────────────────────────────────────────
function Panel({
  title,
  action,
  children,
  overflowVisible = false,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  overflowVisible?: boolean;
}) {
  return (
    <div
      className={`${overflowVisible ? "" : "overflow-hidden "}rounded-sm border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.05)] ring-1 ring-slate-200/60`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-slate-900 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-3.5 w-[3px] bg-orange-500" />
          <h2 className="text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-200">{title}</h2>
        </div>
        {action}
      </div>
      {overflowVisible ? <div className="p-4">{children}</div> : children}
    </div>
  );
}

function Kpi({
  accent,
  icon: Icon,
  label,
  value,
  sub,
  onClick,
}: {
  accent: string;
  icon: typeof Coins;
  label: string;
  value: string;
  sub: string;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: accent }} />
      <div className="p-3.5 sm:p-4">
        <span className="flex h-7 w-7 items-center justify-center rounded-sm" style={{ backgroundColor: `${accent}1A`, color: accent }}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <p className="mt-2.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">{label}</p>
        <p className="mt-0.5 text-lg font-black tabular-nums tracking-tight text-slate-900 sm:text-xl">{value}</p>
        <p className="mt-0.5 text-phx-2xs font-semibold text-slate-400">{sub}</p>
      </div>
    </>
  );
  const className =
    "relative block w-full overflow-hidden rounded-sm border border-slate-200 bg-white text-left shadow-[0_8px_22px_rgba(15,23,42,0.04)] ring-1 ring-slate-200/60";
  return onClick ? (
    <button type="button" onClick={onClick} className={`${className} transition hover:border-orange-300`} title={`Show ${label.toLowerCase()} rows`}>
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  );
}

function StatusBadge({ status }: { status: WeeklyStockStatus }) {
  return (
    <span className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-phx-2xs font-black uppercase tracking-wide ${STATUS_BADGE[status]}`}>
      {WEEKLY_STOCK_STATUS_LABELS[status]}
    </span>
  );
}

function CardStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm border border-slate-100 bg-slate-50 px-2 py-1.5">
      <p className="text-phx-3xs font-black uppercase tracking-wide text-slate-400">{label}</p>
      <p className="text-xs font-black tabular-nums text-slate-900">{value}</p>
    </div>
  );
}

// The desktop tables open at 1024 px, where the portal's main column leaves them about 620 px. They fit it
// by merging columns, never by shrinking type: the status badge sits under the name, the weeks of cover
// under the average, and no figure column is narrower than its widest figure.
const TH = "px-3 py-2.5 font-black";
const TH_NUM = "px-3 py-2.5 text-right font-black";
const TD_NUM = "px-3 py-2.5 text-right tabular-nums text-slate-700";

function CellsTable({ rows }: { rows: WeeklyStockCell[] }) {
  return (
    <>
      <div className="hidden lg:block">
        <table className="w-full table-fixed text-left text-sm">
          <colgroup>
            <col className="w-[26%]" />
            <col className="w-[24%]" />
            <col className="w-[16%]" />
            <col className="w-[18%]" />
            <col className="w-[16%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-phx-2xs uppercase tracking-[0.12em] text-slate-500">
              <th className={TH}>Depot</th>
              <th className={TH}>Product</th>
              <th className={TH_NUM}>Stock units</th>
              <th className={TH_NUM}>Stock value</th>
              <th className={TH_NUM}>Avg / week</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((cell) => (
              <tr key={`${cell.branchKey}|${cell.productCode}`} className="border-b border-slate-100 align-top transition hover:bg-orange-50/40">
                <td className="px-3 py-2.5">
                  <p className="break-words font-bold text-slate-900">{cell.branchName}</p>
                  <p className="break-words text-phx-2xs font-semibold text-slate-500">
                    {cell.areaName} · {cell.regionName} · {cell.distributorName}
                  </p>
                </td>
                <td className="px-3 py-2.5">
                  <p className="break-words font-bold text-slate-900">{cell.productName}</p>
                  <p className="break-words text-phx-2xs font-semibold text-slate-500">{cell.line}</p>
                  <div className="mt-1.5">
                    <StatusBadge status={cell.status} />
                  </div>
                </td>
                <td className={`${TD_NUM} font-black text-slate-900`}>{formatUnits(cell.stockUnits)}</td>
                <td className={TD_NUM}>{cell.priceMissing ? <span className="text-phx-2xs font-bold text-slate-400">No price</span> : formatEgpFull(cell.stockValue)}</td>
                <td className={TD_NUM}>
                  <p>{formatAvgUnits(cell.avgWeeklyUnits)}</p>
                  <p className="mt-0.5 text-phx-2xs font-semibold text-slate-500">{formatCoverLine(cell.coverWeeks)}</p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="space-y-2 p-3 lg:hidden">
        {rows.map((cell) => (
          <div key={`${cell.branchKey}|${cell.productCode}`} className="flex overflow-hidden rounded-sm border border-slate-200 bg-white">
            <span className={`w-[3px] shrink-0 ${STATUS_RAIL[cell.status]}`} />
            <div className="min-w-0 flex-1 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-words text-sm font-black text-slate-900">{cell.productName}</p>
                  <p className="break-words text-phx-xs font-bold text-slate-700">{cell.branchName}</p>
                  <p className="break-words text-phx-2xs font-semibold text-slate-500">
                    {cell.areaName} · {cell.regionName} · {cell.distributorName}
                  </p>
                </div>
                <StatusBadge status={cell.status} />
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <CardStat label="Stock units" value={formatUnits(cell.stockUnits)} />
                <CardStat label="Stock value" value={cell.priceMissing ? "No price" : formatEgp(cell.stockValue)} />
                <CardStat label="Avg / week" value={formatAvgUnits(cell.avgWeeklyUnits)} />
                <CardStat label="Cover" value={formatCover(cell.coverWeeks)} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function DrillName({ name, onClick }: { name: string; onClick?: () => void }) {
  return onClick ? (
    <button type="button" onClick={onClick} className="break-words text-left font-bold text-slate-900 underline-offset-2 hover:text-orange-600 hover:underline">
      {name}
    </button>
  ) : (
    <p className="break-words font-bold text-slate-900">{name}</p>
  );
}

function ProductsTable({ rows, onDrill }: { rows: WeeklyStockProductRow[]; onDrill: (code: string) => void }) {
  return (
    <>
      <div className="hidden lg:block">
        <table className="w-full table-fixed text-left text-sm">
          <colgroup>
            <col className="w-[28%]" />
            <col className="w-[16%]" />
            <col className="w-[18%]" />
            <col className="w-[16%]" />
            <col className="w-[22%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-phx-2xs uppercase tracking-[0.12em] text-slate-500">
              <th className={TH}>Product</th>
              <th className={TH_NUM}>Stock units</th>
              <th className={TH_NUM}>Stock value</th>
              <th className={TH_NUM}>Avg / week</th>
              <th className={TH}>Depots</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.productCode} className="border-b border-slate-100 align-top transition hover:bg-orange-50/40">
                <td className="px-3 py-2.5">
                  <DrillName name={row.productName} onClick={() => onDrill(row.productCode)} />
                  <p className="break-words text-phx-2xs font-semibold text-slate-500">{row.line}</p>
                  <div className="mt-1.5">
                    <StatusBadge status={row.status} />
                  </div>
                </td>
                <td className={`${TD_NUM} font-black text-slate-900`}>{formatUnits(row.stockUnits)}</td>
                <td className={TD_NUM}>{formatEgpFull(row.stockValue)}</td>
                <td className={TD_NUM}>
                  <p>{formatAvgUnits(row.avgWeeklyUnits)}</p>
                  <p className="mt-0.5 text-phx-2xs font-semibold text-slate-500">{formatCoverLine(row.coverWeeks)}</p>
                </td>
                <td className="px-3 py-2.5 text-phx-xs font-semibold text-slate-600">
                  <p className="font-black text-slate-900">{formatUnits(row.depotCount)}</p>
                  <p className="break-words">
                    {row.lowDepots} low · {row.overDepots} over · {row.noSalesDepots} no sales
                  </p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="space-y-2 p-3 lg:hidden">
        {rows.map((row) => (
          <div key={row.productCode} className="flex overflow-hidden rounded-sm border border-slate-200 bg-white">
            <span className={`w-[3px] shrink-0 ${STATUS_RAIL[row.status]}`} />
            <div className="min-w-0 flex-1 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <DrillName name={row.productName} onClick={() => onDrill(row.productCode)} />
                  <p className="break-words text-phx-2xs font-semibold text-slate-500">
                    {row.line} · {row.depotCount} depots · {row.lowDepots} low · {row.overDepots} over
                  </p>
                </div>
                <StatusBadge status={row.status} />
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <CardStat label="Stock units" value={formatUnits(row.stockUnits)} />
                <CardStat label="Stock value" value={formatEgp(row.stockValue)} />
                <CardStat label="Avg / week" value={formatAvgUnits(row.avgWeeklyUnits)} />
                <CardStat label="Cover" value={formatCover(row.coverWeeks)} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function groupSubline(row: WeeklyStockGroupRow | WeeklyStockDistributorRow): string {
  if ("asOfWeekStart" in row) return `Stock file ${formatDate(row.asOfWeekStart)}`;
  return row.parentName;
}

function GroupTable({
  nameLabel,
  rows,
  onDrill,
}: {
  nameLabel: string;
  rows: (WeeklyStockGroupRow | WeeklyStockDistributorRow)[];
  onDrill?: (code: string) => void;
}) {
  return (
    <>
      <div className="hidden lg:block">
        <table className="w-full table-fixed text-left text-sm">
          <colgroup>
            <col className="w-[34%]" />
            <col className="w-[20%]" />
            <col className="w-[20%]" />
            <col className="w-[26%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-phx-2xs uppercase tracking-[0.12em] text-slate-500">
              <th className={TH}>{nameLabel}</th>
              <th className={TH_NUM}>Stock value</th>
              <th className={TH_NUM}>Avg weekly sales</th>
              <th className={TH}>Products</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.code} className="border-b border-slate-100 align-top transition hover:bg-orange-50/40">
                <td className="px-3 py-2.5">
                  <DrillName name={row.name} onClick={onDrill ? () => onDrill(row.code) : undefined} />
                  {groupSubline(row) ? <p className="break-words text-phx-2xs font-semibold text-slate-500">{groupSubline(row)}</p> : null}
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <StatusBadge status={row.status} />
                    {"stale" in row && row.stale ? (
                      <span className="inline-flex rounded-sm border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-phx-2xs font-black uppercase tracking-wide text-amber-800">
                        Old stock file
                      </span>
                    ) : null}
                  </div>
                </td>
                <td className={`${TD_NUM} font-black text-slate-900`}>{formatEgpFull(row.stockValue)}</td>
                <td className={TD_NUM}>
                  <p>{formatEgpFull(row.avgWeeklyValue)}</p>
                  <p className="mt-0.5 text-phx-2xs font-semibold text-slate-500">{formatCoverLine(row.coverWeeks)}</p>
                </td>
                <td className="px-3 py-2.5 text-phx-xs font-semibold text-slate-600">
                  <p className="font-black text-slate-900">{formatUnits(row.productCount)}</p>
                  <p className="break-words">
                    {row.lowCount} low · {row.overCount} over · {row.noSalesCount} no sales
                  </p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="space-y-2 p-3 lg:hidden">
        {rows.map((row) => (
          <div key={row.code} className="flex overflow-hidden rounded-sm border border-slate-200 bg-white">
            <span className={`w-[3px] shrink-0 ${STATUS_RAIL[row.status]}`} />
            <div className="min-w-0 flex-1 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <DrillName name={row.name} onClick={onDrill ? () => onDrill(row.code) : undefined} />
                  <p className="break-words text-phx-2xs font-semibold text-slate-500">
                    {[groupSubline(row), `${row.productCount} products`, `${row.lowCount} low`, `${row.overCount} over`]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {"stale" in row && row.stale ? (
                    <span className="mt-1 inline-flex rounded-sm border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-phx-2xs font-black uppercase tracking-wide text-amber-800">
                      Old stock file
                    </span>
                  ) : null}
                </div>
                <StatusBadge status={row.status} />
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2">
                <CardStat label="Stock value" value={formatEgp(row.stockValue)} />
                <CardStat label="Avg / week" value={formatEgp(row.avgWeeklyValue)} />
                <CardStat label="Cover" value={formatCover(row.coverWeeks)} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
