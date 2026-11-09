"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Building2,
  CalendarRange,
  ChevronDown,
  Coins,
  Download,
  MapPin,
  Package,
  RotateCcw,
  SlidersHorizontal,
  Split,
  TrendingUp,
  TriangleAlert,
  Truck,
  Undo2,
} from "lucide-react";

import { MultiSelectFilter, type MultiSelectFilterMode, type MultiSelectFilterOption } from "@/components/ui/multi-select-filter";
import { formatEgp, formatEgpFull } from "@/components/sales/target-visuals";
import { WeeklyUnitProductPicker } from "@/components/sales/weekly/weekly-unit-product-picker";
import { weeklyAreaLabel, weeklyDistributorLabel, weeklyRegionLabel } from "@/lib/sales/weekly/display-labels";
import {
  WEEKLY_SALES_DETAIL_BASIS_LABELS,
  WEEKLY_SALES_DETAIL_MOVEMENT_LABELS,
  WEEKLY_SALES_DETAIL_NOTHING,
  WEEKLY_SALES_DETAIL_UNMAPPED_AREA,
  weeklySalesDetailProductUnitsByGroup,
  weeklySalesDetailShowsBasis,
  weeklySalesDetailUnitProduct,
  weeklySalesMovement,
  type WeeklySalesDepotDetailPayload,
  type WeeklySalesDetailAudience,
  type WeeklySalesDetailBasis,
  type WeeklySalesDetailCell,
  type WeeklySalesDetailGroupCut,
  type WeeklySalesDetailGroupRow,
  type WeeklySalesDetailMovement,
  type WeeklySalesDetailProductRow,
  type WeeklySalesDetailProductUnits,
  type WeeklySalesDetailStatus,
} from "@/lib/sales/weekly/sales-depot-detail";

// Weekly Sales — Branch Detail (the code still says depot; the screen says branch, owner 2026-09-19). The
// owner asked for Weekly Sales "detailed exactly as Weekly Stock" (2026-09-16), so this is Weekly Stock's
// screen, table for table and class for class, over net sales: every product at every branch, then
// products, branches, areas, regions and distributors.
//
// It is a tab on both portal Weekly Sales pages:
//   • the managers' page (and its admin twin for CEO and Super Admin). The page's own filter fields are
//     folded into this panel, so the tab still has exactly one filter bar;
//   • a Medical Rep's own page, where it shows his own area's share of each depot and nothing wider. The
//     server hands this component only his parts (portal-weekly-rep-depot-detail.ts), so there is no
//     other area, rep or region total here to hide.
//
// Units appear ONLY against a single product; every figure spanning products is a value (owner rule). A
// branch, area, region or distributor row shows, beside its value, ONE product's own units — the one
// picked in its "Units for" bar (owner, 2026-09-19). The export link carries the feed's exact query, so
// the download is the screen.

type HostDrillKey = "products" | "regions" | "distributors";

type Props = {
  audience: WeeklySalesDetailAudience;
  /** JSON feed: `/api/employee-portals/weekly-sales/depot-detail` or `/rep-depot-detail`. */
  feedPath: string;
  /** XLSX export for the same audience — same query string, so the download matches the screen. */
  exportPath: string;
  /** The host page's own filters as a query string (a manager's months, weeks, lines…; a rep's month). */
  hostQuery: string;
  /** The host page's filter fields, shown first inside this panel. */
  hostFields?: ReactNode;
  hostActiveCount?: number;
  onHostReset?: () => void;
  /** Drill handlers for filters the host owns; a key the viewer may not filter on is left out. */
  hostDrill?: Partial<Record<HostDrillKey, (code: string) => void>>;
  /** Bumped by the host's Sync now: the cache is dropped and the detail loads again. */
  refreshKey?: number;
  /**
   * False while the host shows another tab. The detail stays mounted, so its own filters and cache
   * survive a trip to another tab, but it neither fetches nor renders until it is shown again.
   */
  active?: boolean;
};

type LocalKey = "weeks" | "distributors" | "areas" | "depots" | "products" | "movements";
type DetailTab = "cells" | "products" | "depots" | "areas" | "regions" | "distributors";

const ALL_KEYS: LocalKey[] = ["weeks", "distributors", "areas", "depots", "products", "movements"];
/** A manager's week, distributor and product filters are the page's own; a rep's page has none, so they live here. */
const MANAGER_KEYS: LocalKey[] = ["areas", "depots", "movements"];
const PAGE_SIZE = 100;

const blankSelection = () => Object.fromEntries(ALL_KEYS.map((key) => [key, [] as string[]])) as Record<LocalKey, string[]>;
const includeModes = () =>
  Object.fromEntries(ALL_KEYS.map((key) => [key, "include"])) as Record<LocalKey, MultiSelectFilterMode>;
const blankResolved = () => Object.fromEntries(ALL_KEYS.map((key) => [key, null])) as Record<LocalKey, string[] | null>;

const MOVEMENT_OPTIONS: MultiSelectFilterOption[] = (
  Object.keys(WEEKLY_SALES_DETAIL_MOVEMENT_LABELS) as WeeklySalesDetailMovement[]
).map((code) => ({ code, label: WEEKLY_SALES_DETAIL_MOVEMENT_LABELS[code] }));

const MOVEMENT_BADGE: Record<WeeklySalesDetailMovement, string> = {
  sold: "border-emerald-200 bg-emerald-50 text-emerald-700",
  returns: "border-rose-200 bg-rose-50 text-rose-700",
};
const MOVEMENT_RAIL: Record<WeeklySalesDetailMovement, string> = {
  sold: "bg-emerald-500",
  returns: "bg-rose-500",
};
const BASIS_TONE: Record<WeeklySalesDetailBasis, string> = {
  whole: "text-slate-500",
  mapped: "text-emerald-700",
  allocated: "text-amber-700",
  mixed: "text-amber-700",
};

const STATUS_COPY: Record<Exclude<WeeklySalesDetailStatus, "ok">, string> = {
  no_access: "Your account has no sales line on record, so no weekly figures can be shown.",
  seat_index_unavailable: "Your area comes from the organogram, which did not answer just now. Try again in a moment.",
  no_seat: "No filled rep seat lists you on your line yet, so no branch can be credited to your area.",
  no_data: "No distributor sheet has been validated yet.",
};

// ── Formatting ───────────────────────────────────────────────────────────────
// Money (formatEgp, formatEgpFull) comes from the shared sales formatters in target-visuals.tsx.
function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}
/** A rep's allocated share can be a fraction of a unit; a whole number stays whole. */
function formatUnits(value: number): string {
  const whole = Math.round(value);
  if (Math.abs(value - whole) < 0.05 || Math.abs(value) >= 100) return whole.toLocaleString("en-US");
  return value.toFixed(1);
}
function formatAvgUnits(value: number | null): string {
  if (value == null) return "—";
  return Math.abs(value) >= 10 ? Math.round(value).toLocaleString("en-US") : value.toFixed(1);
}
function formatShare(value: number | null): string {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}
function formatWeeks(sold: number, covered: number): string {
  return covered > 0 ? `${sold} of ${covered}` : "—";
}
/** The weeks line under a desktop average: the workbook's Weeks Sold and Weeks Covered, in words. */
function formatWeeksSold(sold: number, covered: number): string {
  return covered > 0 ? `Sold ${sold} of ${covered} ${covered === 1 ? "week" : "weeks"}` : "No week uploaded";
}

export function WeeklySalesDepotDetail({
  audience,
  feedPath,
  exportPath,
  hostQuery,
  hostFields,
  hostActiveCount = 0,
  onHostReset,
  hostDrill,
  refreshKey = 0,
  active = true,
}: Props) {
  const isRep = audience === "rep";
  const keys = isRep ? ALL_KEYS : MANAGER_KEYS;

  const [payload, setPayload] = useState<WeeklySalesDepotDetailPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState(blankSelection);
  const [modes, setModes] = useState(includeModes);
  // Every local filter reaches the builder as an include list. An exclude choice is turned into "every
  // option shown except these" at the moment it is made, exactly as Weekly Stock does, so the query never
  // depends on option lists that themselves change with the response.
  const [resolved, setResolved] = useState(blankResolved);
  const [tab, setTab] = useState<DetailTab>("cells");
  const [pager, setPager] = useState({ key: "", limit: PAGE_SIZE });
  // The "Units for" pick. null until one is picked: the product with the most value is shown.
  const [unitProduct, setUnitProduct] = useState<string | null>(null);
  // Below `md` the filter grid folds behind a "Filters · n" toggle, so a phone reaches the figures
  // without scrolling past five or six stacked filters first. Every filter stays; from `md` up the
  // grid is always open.
  const [filtersOpen, setFiltersOpen] = useState(false);

  const cacheRef = useRef(new Map<string, WeeklySalesDepotDetailPayload>());
  const refreshRef = useRef(refreshKey);

  const view = payload?.view ?? null;

  const weekOptions = useMemo(() => (view?.availableWeeks ?? []).map((o) => ({ code: o.code, label: o.name })), [view]);
  const distributorOptions = useMemo(
    () => (view?.availableDistributors ?? []).map((o) => ({ code: o.code, label: weeklyDistributorLabel(o.name, o.code) })),
    [view],
  );
  const areaOptions = useMemo(
    () => (view?.availableAreas ?? []).map((o) => ({ code: o.code, label: weeklyAreaLabel(o.name) })),
    [view],
  );
  const depotOptions = useMemo(() => (view?.availableBranches ?? []).map((o) => ({ code: o.code, label: o.name })), [view]);
  const productOptions = useMemo(() => (view?.availableProducts ?? []).map((o) => ({ code: o.code, label: o.name })), [view]);

  const optionsFor = (key: LocalKey): MultiSelectFilterOption[] => {
    switch (key) {
      case "weeks":
        return weekOptions;
      case "distributors":
        return distributorOptions;
      case "areas":
        return areaOptions;
      case "depots":
        return depotOptions;
      case "products":
        return productOptions;
      case "movements":
        return MOVEMENT_OPTIONS;
    }
  };
  const resolveLocal = (key: LocalKey, selected: string[], mode: MultiSelectFilterMode): string[] | null => {
    if (selected.length === 0) return null;
    if (mode === "include") return selected;
    return optionsFor(key)
      .map((option) => option.code)
      .filter((code) => !selected.includes(code));
  };

  const changeSelection = (key: LocalKey, next: string[]) => {
    setSelection((prev) => ({ ...prev, [key]: next }));
    setResolved((prev) => ({ ...prev, [key]: resolveLocal(key, next, modes[key]) }));
  };
  const changeMode = (key: LocalKey, next: MultiSelectFilterMode) => {
    setModes((prev) => ({ ...prev, [key]: next }));
    setResolved((prev) => ({ ...prev, [key]: resolveLocal(key, selection[key], next) }));
  };
  const drill = (key: LocalKey, code: string) => {
    setSelection((prev) => ({ ...prev, [key]: [code] }));
    setModes((prev) => ({ ...prev, [key]: "include" }));
    setResolved((prev) => ({ ...prev, [key]: [code] }));
    setTab("cells");
  };
  const drillHost = (key: HostDrillKey) => {
    const handler = hostDrill?.[key];
    return handler
      ? (code: string) => {
          handler(code);
          setTab("cells");
        }
      : undefined;
  };
  const resetFilters = () => {
    onHostReset?.();
    setSelection(blankSelection());
    setModes(includeModes());
    setResolved(blankResolved());
  };

  const query = useMemo(() => {
    const params = new URLSearchParams(hostQuery);
    let matchesNothing = false;
    for (const key of keys) {
      const codes = resolved[key];
      if (codes == null) continue;
      if (codes.length === 0) {
        matchesNothing = true;
        continue;
      }
      // Depot keys travel as a repeated parameter: a depot with no code is keyed by its name, which can hold a comma.
      if (key === "depots") for (const code of codes) params.append("depot", code);
      else params.set(key, codes.join(","));
    }
    if (matchesNothing) {
      params.delete("depot");
      params.append("depot", WEEKLY_SALES_DETAIL_NOTHING);
    }
    return params.toString();
  }, [hostQuery, keys, resolved]);

  useEffect(() => {
    if (refreshRef.current !== refreshKey) {
      refreshRef.current = refreshKey;
      cacheRef.current.clear();
    }
    if (!active) return;
    const cached = cacheRef.current.get(query);
    if (cached) {
      setPayload(cached);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(`${feedPath}${query ? `?${query}` : ""}`, { signal: controller.signal, cache: "no-store" });
        const json = await response.json().catch(() => null);
        if (response.ok && json?.success) {
          const next: WeeklySalesDepotDetailPayload = {
            view: json.view,
            scope: json.scope,
            status: json.status,
            allocationUnavailable: json.allocationUnavailable === true,
          };
          cacheRef.current.set(query, next);
          setPayload(next);
          setError(null);
        } else {
          setError(typeof json?.error === "string" ? json.error : "The branch detail could not be loaded.");
        }
      } catch (caught) {
        if (!(caught instanceof DOMException && caught.name === "AbortError")) {
          setError("The branch detail could not be loaded. Check your connection and try again.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, feedPath, refreshKey, active]);

  if (!active) return null;

  const activeFilterCount = hostActiveCount + keys.reduce((sum, key) => sum + selection[key].length, 0);

  const filterField = (key: LocalKey, label: string, icon: ReactNode) => (
    <MultiSelectFilter
      label={label}
      icon={icon}
      options={optionsFor(key)}
      selected={selection[key]}
      mode={modes[key]}
      onSelectedChange={(next) => changeSelection(key, next)}
      onModeChange={(next) => changeMode(key, next)}
    />
  );

  const filtersPanel = (
    <Panel
      title="Filters"
      overflowVisible
      bodyClassName={filtersOpen ? undefined : "hidden md:block"}
      action={
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setFiltersOpen((open) => !open)}
            aria-expanded={filtersOpen}
            className="inline-flex min-h-10 items-center gap-1.5 border border-slate-600 bg-white/10 px-2.5 text-phx-sm font-black uppercase tracking-wide text-white transition hover:bg-orange-500 md:hidden"
          >
            <SlidersHorizontal className="h-3 w-3" />
            {`Filters · ${activeFilterCount}`}
            <ChevronDown className={`h-3 w-3 transition-transform ${filtersOpen ? "rotate-180" : ""}`} />
          </button>
          {activeFilterCount > 0 ? (
            <button
              type="button"
              onClick={resetFilters}
              className="inline-flex min-h-10 items-center gap-1.5 bg-white/10 px-2.5 py-1 text-phx-sm font-black uppercase tracking-wide text-white transition hover:bg-orange-500 md:min-h-0"
            >
              <RotateCcw className="h-3 w-3" />
              Reset {activeFilterCount}
            </button>
          ) : (
            <span className="hidden text-phx-sm font-bold uppercase tracking-widest text-slate-400 md:inline">No filters applied</span>
          )}
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {hostFields}
        {isRep ? filterField("weeks", "Week", <CalendarRange className="h-3 w-3" />) : null}
        {isRep ? filterField("distributors", "Distributor", <Truck className="h-3 w-3" />) : null}
        {/* A rep with one area has nothing to choose between. */}
        {!isRep || areaOptions.length > 1 || selection.areas.length > 0
          ? filterField("areas", "Area", <MapPin className="h-3 w-3" />)
          : null}
        {filterField("depots", "Branch", <Building2 className="h-3 w-3" />)}
        {isRep ? filterField("products", "Product", <Package className="h-3 w-3" />) : null}
        {filterField("movements", "Movement", <TrendingUp className="h-3 w-3" />)}
      </div>
    </Panel>
  );

  const tabs: { key: DetailTab; label: string }[] = [
    { key: "cells", label: "Branch × Product" },
    { key: "products", label: "Products" },
    { key: "depots", label: "Branches" },
    // A rep sees his areas only when he holds more than one, and never a region total.
    ...(!isRep || areaOptions.length > 1 ? [{ key: "areas" as const, label: "Areas" }] : []),
    ...(!isRep ? [{ key: "regions" as const, label: "Regions" }] : []),
    { key: "distributors", label: "Distributors" },
  ];
  const activeTab: DetailTab = tabs.some((item) => item.key === tab) ? tab : "cells";

  const pageKey = `${query}|${activeTab}`;
  const limit = pager.key === pageKey ? pager.limit : PAGE_SIZE;
  const showMore = () => setPager({ key: pageKey, limit: limit + PAGE_SIZE });
  const exportHref = `${exportPath}${query ? `?${query}` : ""}`;

  // A group row adds several products, so beside its value it shows ONE product's own units there
  // (weeklySalesDetailProductUnitsByGroup), worked out from the same cells the row is.
  const groupCut: WeeklySalesDetailGroupCut | null = activeTab === "cells" || activeTab === "products" ? null : activeTab;
  const unitsProduct = view ? weeklySalesDetailUnitProduct(view.products, unitProduct) : null;
  // Built inline, not memoised: this sits below the `active` early return, where a hook may not be called.
  const groupUnits: GroupUnits = {
    productName: unitsProduct?.productName ?? "",
    byCode:
      view && groupCut && unitsProduct
        ? weeklySalesDetailProductUnitsByGroup(view.cells, unitsProduct.productCode, groupCut)
        : {},
  };

  if (!payload || !view) {
    return (
      <div className="space-y-5">
        {error ? <ErrorBanner message={error} /> : null}
        {filtersPanel}
        <div className="flex flex-col items-center justify-center gap-3 border border-dashed border-slate-200 bg-white p-12 text-center">
          <span className="flex h-12 w-12 items-center justify-center bg-orange-50 text-orange-500 ring-1 ring-orange-100">
            <Building2 className={`h-5 w-5 ${loading ? "animate-pulse" : ""}`} />
          </span>
          <p className="max-w-md text-sm font-semibold text-slate-600">
            {loading ? "Loading every product at every branch…" : "The branch detail could not be loaded."}
          </p>
        </div>
      </div>
    );
  }

  if (payload.status !== "ok") {
    return (
      <div className="space-y-5">
        {error ? <ErrorBanner message={error} /> : null}
        <EmptyPanel message={STATUS_COPY[payload.status]} />
      </div>
    );
  }

  const kpis = view.kpis;
  const soldCount = view.cells.length - kpis.returnsCount;
  const rowCount =
    activeTab === "cells"
      ? view.cells.length
      : activeTab === "products"
        ? view.products.length
        : activeTab === "depots"
          ? view.depots.length
          : activeTab === "areas"
            ? view.areas.length
            : activeTab === "regions"
              ? view.regions.length
              : view.distributors.length;
  const hasAnySales = view.availableBranches.length > 0 || view.cells.length > 0;
  const hasUnmappedArea = areaOptions.some((option) => option.code === WEEKLY_SALES_DETAIL_UNMAPPED_AREA);
  // A manager's figures are whole depots unless his own areas' share of a depot-split depot reached him.
  const managerHasShares = !isRep && weeklySalesDetailShowsBasis(view);
  const shareOfTotal = (part: number) => (kpis.value > 0 ? `${formatShare(part / kpis.value)} of your total` : "Nothing sold yet");
  const drillArea = (code: string) =>
    drill("areas", code.startsWith(`${WEEKLY_SALES_DETAIL_UNMAPPED_AREA}|`) ? WEEKLY_SALES_DETAIL_UNMAPPED_AREA : code);

  return (
    <div className="space-y-5">
      {error ? <ErrorBanner message={error} /> : null}

      {payload.allocationUnavailable ? (
        <div className="flex gap-3 border border-amber-200 bg-amber-50 px-4 py-3">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="text-phx-md font-semibold text-amber-900">
            {isRep
              ? "The branch-to-area map did not load just now, so only branches mapped to your area by hand are counted and your figures read low."
              : "The branch-to-area map did not load just now, so branches serving several areas are not split: one filed under your own region counts whole, and one filed under another region is not counted."}{" "}
            Press Sync now in a moment.
          </p>
        </div>
      ) : null}

      {filtersPanel}

      {!hasAnySales && activeFilterCount === 0 ? (
        <EmptyPanel
          message={
            isRep
              ? "No weekly sales reached your area in this month yet. This is a missing sheet or a quiet month, not a measured zero."
              : "No weekly sales reached your scope yet. This is a missing sheet, not a measured zero."
          }
        />
      ) : (
        <>
          {/* KPIs — every total here is a value, never a unit count across products. */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi
              accent="#F97316"
              icon={Coins}
              label="Sales value"
              value={formatEgp(kpis.value)}
              sub={managerHasShares ? `Net of returns · ${formatEgp(kpis.allocatedValue)} allocated` : "Net of returns"}
            />
            <Kpi
              accent="#0EA5E9"
              icon={CalendarRange}
              label="Avg per week"
              value={formatEgp(kpis.avgWeeklyValue)}
              sub={
                kpis.weeksCovered > 0
                  ? `Across ${kpis.weeksCovered} ${kpis.weeksCovered === 1 ? "week" : "weeks"} uploaded`
                  : "No week uploaded"
              }
            />
            <Kpi
              accent="#0F172A"
              icon={Building2}
              label="Branches"
              value={formatCount(kpis.depotCount)}
              sub={`${formatCount(kpis.productCount)} products`}
            />
            {isRep ? (
              <Kpi
                accent="#6366F1"
                icon={Truck}
                label="Distributors"
                value={formatCount(kpis.distributorCount)}
                sub="Selling into your area"
              />
            ) : (
              <Kpi
                accent="#6366F1"
                icon={MapPin}
                label="Areas"
                value={formatCount(kpis.areaCount)}
                sub={`${formatCount(kpis.regionCount)} ${kpis.regionCount === 1 ? "region" : "regions"}`}
              />
            )}
            <Kpi
              accent="#10B981"
              icon={TrendingUp}
              label="Sold"
              value={formatCount(soldCount)}
              sub="Product-branch rows"
              onClick={() => drill("movements", "sold")}
            />
            <Kpi
              accent="#E11D48"
              icon={Undo2}
              label="Net returns"
              value={formatCount(kpis.returnsCount)}
              sub={kpis.returnsCount > 0 ? formatEgp(kpis.returnsValue) : "More back than out"}
              onClick={() => drill("movements", "returns")}
            />
            {isRep ? (
              <>
                <Kpi
                  accent="#22C55E"
                  icon={MapPin}
                  label="Mapped by hand"
                  value={formatEgp(kpis.mappedValue)}
                  sub={shareOfTotal(kpis.mappedValue)}
                />
                <Kpi
                  accent="#F59E0B"
                  icon={Split}
                  label="Allocated share"
                  value={formatEgp(kpis.allocatedValue)}
                  sub={shareOfTotal(kpis.allocatedValue)}
                />
              </>
            ) : (
              <>
                <Kpi
                  accent="#F59E0B"
                  icon={TriangleAlert}
                  label="Area not mapped"
                  value={formatEgp(kpis.unmappedValue)}
                  sub={managerHasShares ? "Branches no rule places" : "Branches serving several areas"}
                  onClick={hasUnmappedArea ? () => drill("areas", WEEKLY_SALES_DETAIL_UNMAPPED_AREA) : undefined}
                />
                <Kpi
                  accent="#64748B"
                  icon={Truck}
                  label="Distributors"
                  value={formatCount(kpis.distributorCount)}
                  sub="Selling in your scope"
                />
              </>
            )}
          </div>

          <Panel
            title="Sales"
            action={
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex flex-wrap border border-slate-700">
                  {tabs.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => setTab(item.key)}
                      className={`min-h-10 whitespace-nowrap px-2.5 py-1 text-phx-sm font-black uppercase tracking-wide transition md:min-h-0 ${
                        activeTab === item.key ? "bg-orange-500 text-white" : "bg-slate-800 text-slate-300 hover:text-white"
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <a
                  href={exportHref}
                  className="inline-flex h-10 items-center gap-1.5 border border-slate-600 bg-white px-2.5 text-phx-sm font-black uppercase tracking-wide text-slate-900 transition hover:border-orange-400 hover:text-orange-600 md:h-7"
                >
                  <Download className="h-3 w-3" />
                  Export
                </a>
              </div>
            }
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2 text-phx-xs font-bold text-slate-600">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>
                  {formatCount(rowCount)} {rowCount === 1 ? "row" : "rows"} · {payload.scope.periodLabel}
                </span>
                {loading ? (
                  <span className="flex items-center gap-1.5 text-phx-sm font-bold uppercase tracking-wide text-orange-600">
                    <span className="h-1.5 w-1.5 animate-pulse bg-orange-500" />
                    Updating
                  </span>
                ) : null}
              </span>
              <span className="tabular-nums text-slate-900">Total sales value {formatEgpFull(kpis.value)}</span>
            </div>
            {groupCut && unitsProduct && view.products.length > 1 && rowCount > 0 ? (
              <WeeklyUnitProductPicker
                tone="inset"
                products={view.products.map((product) => ({ code: product.productCode, name: product.productName }))}
                value={unitsProduct.productCode}
                onChange={setUnitProduct}
                note="Each row holds several products, so its totals are values. Units of different products are never added, so the Units column shows the product picked here at each row."
              />
            ) : null}
            {rowCount === 0 ? (
              <div className="p-8 text-center text-sm font-semibold text-slate-400">No sales rows for this selection.</div>
            ) : activeTab === "cells" ? (
              <CellsTable rows={view.cells.slice(0, limit)} isRep={isRep} />
            ) : activeTab === "products" ? (
              <ProductsTable
                rows={view.products.slice(0, limit)}
                onDrill={isRep ? (code) => drill("products", code) : drillHost("products")}
              />
            ) : activeTab === "distributors" ? (
              <GroupTable
                nameLabel="Distributor"
                rows={view.distributors.slice(0, limit)}
                onDrill={isRep ? (code) => drill("distributors", code) : drillHost("distributors")}
                units={groupUnits}
              />
            ) : activeTab === "depots" ? (
              <GroupTable
                nameLabel="Branch"
                rows={view.depots.slice(0, limit)}
                onDrill={(code) => drill("depots", code)}
                units={groupUnits}
              />
            ) : activeTab === "areas" ? (
              <GroupTable nameLabel="Area" rows={view.areas.slice(0, limit)} onDrill={drillArea} units={groupUnits} />
            ) : (
              <GroupTable nameLabel="Region" rows={view.regions.slice(0, limit)} onDrill={drillHost("regions")} units={groupUnits} />
            )}
            {rowCount > limit ? (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-4 py-3">
                <span className="text-phx-xs font-semibold text-slate-500">
                  Showing {formatCount(limit)} of {formatCount(rowCount)}
                </span>
                <button
                  type="button"
                  onClick={showMore}
                  className="inline-flex min-h-10 items-center gap-1.5 border border-slate-200 bg-white px-3 py-1.5 text-phx-sm font-black uppercase tracking-wide text-slate-700 transition hover:border-orange-300 hover:text-orange-600 md:min-h-0"
                >
                  Show {formatCount(Math.min(PAGE_SIZE, rowCount - limit))} more
                </button>
              </div>
            ) : null}
          </Panel>

          <p className="text-phx-xs font-semibold leading-relaxed text-slate-500">
            Sales are net of returns. Most distributors restate the month to date, so each sheet is reduced by the sheet
            before it. Avg / week divides by the weeks each distributor&apos;s uploads cover, so a missed upload never reads
            as a week with no sales, and Weeks shows the weeks a product sold at a branch out of those covered. Units are
            one product&apos;s only: every total across products is a value, and beside a branch, area, region or
            distributor&apos;s value the Units column is the one product picked in Units for.{" "}
            {isRep
              ? "A branch mapped to your area by hand credits you exactly. Any other branch has its money spread evenly across the governorates its name states, then evenly again across that governorate's areas on your line, so an allocated share is an allocation of branch shipments, not a record of sales observed in your territory. "
              : managerHasShares
                ? "Branches no rule places in an area, such as warehouses and tenders, are listed under Area not mapped. "
                : "Branches that serve several areas are listed under Area not mapped. "}
            {managerHasShares
              ? "A branch serving several areas has its money spread evenly across the governorates its name states, then across their areas on your line, and reaches you only as the share in your own areas, marked Allocated share (Part allocated where the branch's mapping changed inside the period); the shares in other managers' areas are not counted. That is an allocation of branch shipments, not a record of sales observed in your territory. Every other figure is the branch's whole sale. "
              : null}
            Products with no Product Master mapping are left out, and Head Office products are not tracked weekly. The
            Monthly Closing remains the official number.
          </p>
        </>
      )}
    </div>
  );
}

// ── Building blocks (Weekly Stock's, class for class) ─────────────────────────
function Panel({
  title,
  action,
  children,
  overflowVisible = false,
  bodyClassName,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  overflowVisible?: boolean;
  /** Extra classes on the padded body of an `overflowVisible` panel (the Filters panel folds it on a phone). */
  bodyClassName?: string;
}) {
  return (
    <div
      className={`${overflowVisible ? "" : "overflow-hidden "}border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.05)] ring-1 ring-slate-200/60`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-slate-900 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-3.5 w-[3px] bg-orange-500" />
          <h2 className="text-phx-sm font-black uppercase tracking-[0.18em] text-slate-200">{title}</h2>
        </div>
        {action}
      </div>
      {overflowVisible ? <div className={bodyClassName ? `${bodyClassName} p-4` : "p-4"}>{children}</div> : children}
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return <div className="border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-800">{message}</div>;
}

function EmptyPanel({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 border border-dashed border-slate-200 bg-white p-12 text-center">
      <span className="flex h-12 w-12 items-center justify-center bg-orange-50 text-orange-500 ring-1 ring-orange-100">
        <Building2 className="h-5 w-5" />
      </span>
      <p className="max-w-md text-sm font-semibold text-slate-600">{message}</p>
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
        <span className="flex h-7 w-7 items-center justify-center" style={{ backgroundColor: `${accent}1A`, color: accent }}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <p className="mt-2.5 text-phx-sm font-black uppercase tracking-[0.12em] text-slate-400">{label}</p>
        <p className="mt-0.5 text-lg font-black tabular-nums tracking-tight text-slate-900 sm:text-xl">{value}</p>
        <p className="mt-0.5 text-phx-sm font-semibold text-slate-400">{sub}</p>
      </div>
    </>
  );
  const className =
    "relative block w-full overflow-hidden border border-slate-200 bg-white text-left shadow-[0_8px_22px_rgba(15,23,42,0.04)] ring-1 ring-slate-200/60";
  return onClick ? (
    <button type="button" onClick={onClick} className={`${className} transition hover:border-orange-300`} title={`Show ${label.toLowerCase()} rows`}>
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  );
}

function MovementBadge({ movement }: { movement: WeeklySalesDetailMovement }) {
  return (
    <span className={`inline-flex items-center border px-1.5 py-0.5 text-phx-sm font-black uppercase tracking-wide ${MOVEMENT_BADGE[movement]}`}>
      {WEEKLY_SALES_DETAIL_MOVEMENT_LABELS[movement]}
    </span>
  );
}

function BasisNote({ basis }: { basis: WeeklySalesDetailBasis }) {
  return <p className={`mt-1 break-words text-phx-sm font-bold ${BASIS_TONE[basis]}`}>{WEEKLY_SALES_DETAIL_BASIS_LABELS[basis]}</p>;
}

function CardStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border border-slate-100 bg-slate-50 px-2 py-1.5">
      <p className="break-words text-phx-sm font-black uppercase tracking-wide text-slate-400">{label}</p>
      <p className="text-xs font-black tabular-nums text-slate-900">{value}</p>
    </div>
  );
}

// The desktop tables open at `md` (768 px), where a tablet's column is about 736 px; their narrowest home
// is 1024 px with the sidebar open, about 620 px. They fit it by merging columns, never by shrinking
// type: the movement badge sits under the name, the weeks under the average, and no figure column is
// narrower than its widest figure. Below `md` a phone reads cards.
const TH = "px-3 py-2.5 font-black";
const TH_NUM = "px-3 py-2.5 text-right font-black";
const TD_NUM = "px-3 py-2.5 text-right tabular-nums text-slate-700";

const cellKey = (cell: WeeklySalesDetailCell) => `${cell.branchKey}|${cell.productCode}|${cell.areaCode ?? ""}`;

function cellPlace(cell: WeeklySalesDetailCell, isRep: boolean): string {
  const area = cell.areaName ? weeklyAreaLabel(cell.areaName) : "";
  const region = cell.regionName ? weeklyRegionLabel(cell.regionName) : "";
  const distributor = weeklyDistributorLabel(cell.distributorName, cell.distributorCode);
  return (isRep ? [area, distributor] : [area, region, distributor])
    .filter(Boolean)
    .join(" · ");
}

function CellsTable({ rows, isRep }: { rows: WeeklySalesDetailCell[]; isRep: boolean }) {
  return (
    <>
      <div className="hidden md:block">
        <table className="w-full table-fixed text-left text-sm">
          <colgroup>
            <col className="w-[26%]" />
            <col className="w-[24%]" />
            <col className="w-[16%]" />
            <col className="w-[18%]" />
            <col className="w-[16%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-phx-sm uppercase tracking-[0.12em] text-slate-500">
              <th className={TH}>Branch</th>
              <th className={TH}>Product</th>
              <th className={TH_NUM}>Units</th>
              <th className={TH_NUM}>Value</th>
              <th className={TH_NUM}>Avg / week</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((cell) => (
              <tr key={cellKey(cell)} className="border-b border-slate-100 align-top transition hover:bg-orange-50/40">
                <td className="px-3 py-2.5">
                  <p className="break-words font-bold text-slate-900">{cell.branchName}</p>
                  <p className="break-words text-phx-sm font-semibold text-slate-500">{cellPlace(cell, isRep)}</p>
                </td>
                <td className="px-3 py-2.5">
                  <p className="break-words font-bold text-slate-900">{cell.productName}</p>
                  <p className="break-words text-phx-sm font-semibold text-slate-500">{cell.line}</p>
                  <div className="mt-1.5">
                    <MovementBadge movement={cell.movement} />
                  </div>
                  {isRep || cell.basis !== "whole" ? <BasisNote basis={cell.basis} /> : null}
                </td>
                <td className={`${TD_NUM} font-black text-slate-900`}>{formatUnits(cell.units)}</td>
                <td className={TD_NUM}>{formatEgpFull(cell.value)}</td>
                <td className={TD_NUM}>
                  <p>{formatAvgUnits(cell.avgWeeklyUnits)}</p>
                  <p className="mt-0.5 text-phx-sm font-semibold text-slate-500">{formatWeeksSold(cell.weeksSold, cell.weeksCovered)}</p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="space-y-2 p-3 md:hidden">
        {rows.map((cell) => (
          <div key={cellKey(cell)} className="flex overflow-hidden border border-slate-200 bg-white">
            <span className={`w-[3px] shrink-0 ${MOVEMENT_RAIL[cell.movement]}`} />
            <div className="min-w-0 flex-1 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-words text-sm font-black text-slate-900">{cell.productName}</p>
                  <p className="break-words text-phx-xs font-bold text-slate-700">{cell.branchName}</p>
                  <p className="break-words text-phx-sm font-semibold text-slate-500">{cellPlace(cell, isRep)}</p>
                  {isRep || cell.basis !== "whole" ? <BasisNote basis={cell.basis} /> : null}
                </div>
                <MovementBadge movement={cell.movement} />
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <CardStat label="Units" value={formatUnits(cell.units)} />
                <CardStat label="Value" value={formatEgp(cell.value)} />
                <CardStat label="Avg / week" value={formatAvgUnits(cell.avgWeeklyUnits)} />
                <CardStat label="Weeks" value={formatWeeks(cell.weeksSold, cell.weeksCovered)} />
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

function ProductsTable({ rows, onDrill }: { rows: WeeklySalesDetailProductRow[]; onDrill?: (code: string) => void }) {
  return (
    <>
      <div className="hidden md:block">
        <table className="w-full table-fixed text-left text-sm">
          <colgroup>
            <col className="w-[26%]" />
            <col className="w-[16%]" />
            <col className="w-[18%]" />
            <col className="w-[16%]" />
            <col className="w-[12%]" />
            <col className="w-[12%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-phx-sm uppercase tracking-[0.12em] text-slate-500">
              <th className={TH}>Product</th>
              <th className={TH_NUM}>Units</th>
              <th className={TH_NUM}>Value</th>
              <th className={TH_NUM}>Avg / week</th>
              <th className={TH_NUM}>Share</th>
              <th className={TH}>Branches</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.productCode} className="border-b border-slate-100 align-top transition hover:bg-orange-50/40">
                <td className="px-3 py-2.5">
                  <DrillName name={row.productName} onClick={onDrill ? () => onDrill(row.productCode) : undefined} />
                  <p className="break-words text-phx-sm font-semibold text-slate-500">{row.line}</p>
                  <div className="mt-1.5">
                    <MovementBadge movement={weeklySalesMovement(row.units, row.value)} />
                  </div>
                </td>
                <td className={`${TD_NUM} font-black text-slate-900`}>{formatUnits(row.units)}</td>
                <td className={TD_NUM}>{formatEgpFull(row.value)}</td>
                <td className={TD_NUM}>{formatAvgUnits(row.avgWeeklyUnits)}</td>
                <td className={TD_NUM}>{formatShare(row.share)}</td>
                <td className="px-3 py-2.5 text-phx-xs font-semibold text-slate-600">
                  <p className="font-black text-slate-900">{formatCount(row.depotCount)}</p>
                  <p className="break-words">
                    {row.soldDepots} sold · {row.returnsDepots} returns
                  </p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="space-y-2 p-3 md:hidden">
        {rows.map((row) => {
          const movement = weeklySalesMovement(row.units, row.value);
          return (
            <div key={row.productCode} className="flex overflow-hidden border border-slate-200 bg-white">
              <span className={`w-[3px] shrink-0 ${MOVEMENT_RAIL[movement]}`} />
              <div className="min-w-0 flex-1 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <DrillName name={row.productName} onClick={onDrill ? () => onDrill(row.productCode) : undefined} />
                    <p className="break-words text-phx-sm font-semibold text-slate-500">
                      {row.line} · {row.depotCount} branches · {row.soldDepots} sold · {row.returnsDepots} returns
                    </p>
                  </div>
                  <MovementBadge movement={movement} />
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <CardStat label="Units" value={formatUnits(row.units)} />
                  <CardStat label="Value" value={formatEgp(row.value)} />
                  <CardStat label="Avg / week" value={formatAvgUnits(row.avgWeeklyUnits)} />
                  <CardStat label="Share" value={formatShare(row.share)} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/** One product's own units at each group row, by the row's code (weeklySalesDetailProductUnitsByGroup). */
type GroupUnits = { productName: string; byCode: Record<string, WeeklySalesDetailProductUnits> };

/** A group row's name for the screen: distributors, areas and regions are relabelled, a branch is as filed (display only). */
function groupName(nameLabel: string, row: WeeklySalesDetailGroupRow): string {
  if (nameLabel === "Distributor") return weeklyDistributorLabel(row.name, row.code);
  if (nameLabel === "Area") return weeklyAreaLabel(row.name);
  if (nameLabel === "Region") return weeklyRegionLabel(row.name);
  return row.name;
}

/** The line under a group's name: an area's region, or a depot's "Region · Distributor" (the rep's view has the distributor alone). */
function groupParent(nameLabel: string, row: WeeklySalesDetailGroupRow): string {
  if (!row.parentName) return "";
  if (nameLabel === "Area") return weeklyRegionLabel(row.parentName);
  if (nameLabel !== "Branch") return row.parentName;
  const parts = row.parentName.split(" · ");
  if (parts.length === 1) return weeklyDistributorLabel(parts[0]);
  return [weeklyRegionLabel(parts[0]), ...parts.slice(1).map((part) => weeklyDistributorLabel(part))].join(" · ");
}

/** A row with no code of its own ("Region not mapped") has nothing to filter the page by, so its name is not a link. */
function GroupTable({
  nameLabel,
  rows,
  onDrill,
  units,
}: {
  nameLabel: string;
  rows: WeeklySalesDetailGroupRow[];
  onDrill?: (code: string) => void;
  /** the "Units for" product's own net units at each row */
  units: GroupUnits;
}) {
  const unitsOf = (code: string): WeeklySalesDetailProductUnits => units.byCode[code] ?? { units: 0, avgWeeklyUnits: 0 };
  return (
    <>
      <div className="hidden md:block">
        <table className="w-full table-fixed text-left text-sm">
          {/* The unit column is fitted by merging Share under the value, never by shrinking type. */}
          <colgroup>
            <col className="w-[28%]" />
            <col className="w-[20%]" />
            <col className="w-[18%]" />
            <col className="w-[16%]" />
            <col className="w-[18%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-phx-sm uppercase tracking-[0.12em] text-slate-500">
              <th className={TH}>{nameLabel}</th>
              <th className={TH_NUM}>Sales value</th>
              <th className={TH_NUM}>Avg weekly sales</th>
              <th className={TH_NUM}>
                <span className="block">Units</span>
                <span className="block break-words font-bold normal-case tracking-normal text-slate-400">{units.productName}</span>
              </th>
              <th className={TH}>Products</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.code}|${row.parentName}`} className="border-b border-slate-100 align-top transition hover:bg-orange-50/40">
                <td className="px-3 py-2.5">
                  <DrillName name={groupName(nameLabel, row)} onClick={onDrill && row.code ? () => onDrill(row.code) : undefined} />
                  {row.parentName ? <p className="break-words text-phx-sm font-semibold text-slate-500">{groupParent(nameLabel, row)}</p> : null}
                  <div className="mt-1.5">
                    <MovementBadge movement={weeklySalesMovement(0, row.value)} />
                  </div>
                </td>
                <td className={`${TD_NUM} font-black text-slate-900`}>
                  <p>{formatEgpFull(row.value)}</p>
                  <p className="mt-0.5 text-phx-sm font-semibold text-slate-500">{`${formatShare(row.share)} share`}</p>
                </td>
                <td className={TD_NUM}>{formatEgpFull(row.avgWeeklyValue)}</td>
                <td className={TD_NUM}>
                  <p className="font-black text-slate-900">{formatUnits(unitsOf(row.code).units)}</p>
                  <p className="mt-0.5 text-phx-sm font-semibold text-slate-500">{`${formatAvgUnits(unitsOf(row.code).avgWeeklyUnits)} / wk`}</p>
                </td>
                <td className="px-3 py-2.5 text-phx-xs font-semibold text-slate-600">
                  <p className="font-black text-slate-900">{formatCount(row.productCount)}</p>
                  <p className="break-words">
                    {row.soldCount} sold · {row.returnsCount} returns
                  </p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="space-y-2 p-3 md:hidden">
        {rows.map((row) => {
          const movement = weeklySalesMovement(0, row.value);
          return (
            <div key={`${row.code}|${row.parentName}`} className="flex overflow-hidden border border-slate-200 bg-white">
              <span className={`w-[3px] shrink-0 ${MOVEMENT_RAIL[movement]}`} />
              <div className="min-w-0 flex-1 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <DrillName name={groupName(nameLabel, row)} onClick={onDrill && row.code ? () => onDrill(row.code) : undefined} />
                    <p className="break-words text-phx-sm font-semibold text-slate-500">
                      {[groupParent(nameLabel, row), `${row.productCount} products`, `${row.soldCount} sold`, `${row.returnsCount} returns`]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  <MovementBadge movement={movement} />
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <CardStat label="Value" value={formatEgp(row.value)} />
                  <CardStat label="Avg / week" value={formatEgp(row.avgWeeklyValue)} />
                  <CardStat label="Share" value={formatShare(row.share)} />
                  <CardStat label={`Units · ${units.productName}`} value={formatUnits(unitsOf(row.code).units)} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
