"use client";

import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Banknote,
  BarChart3,
  Boxes,
  Building2,
  Download,
  Eye,
  EyeOff,
  Filter,
  Gauge,
  Layers,
  Lightbulb,
  Loader2,
  MapPinned,
  Minus,
  Network,
  PackageSearch,
  RotateCcw,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Truck,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, Pie, PieChart, Tooltip, XAxis, YAxis } from "recharts";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { SafeResponsiveContainer } from "@/components/charts/safe-responsive-container";
import { CrmCard, CrmCardsOnPhone, CrmFacts, CrmTable } from "@/components/phoenix-crm/ui";
import { MultiSelectFilter, type MultiSelectFilterMode } from "@/components/ui/multi-select-filter";
import { SortableTh, TableNoResults, TableSearchInput, useSortableTable, visibleMax } from "@/components/ui/sortable-table";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/sales/format";
import { periodProseLabel } from "@/lib/sales/periods";
import type {
  SosCustomerRow,
  SosDashboardData,
  SosDelta,
  SosDistributorRow,
  SosGroupRow,
  SosMoverRow,
  SosOption,
} from "@/lib/sales/sos-dashboard";

const CHANNEL_COLORS = ["#F97316", "#0EA5E9", "#8B5CF6", "#10B981", "#F43F5E", "#FACC15", "#14B8A6", "#64748B", "#EC4899", "#22D3EE"];

type Filters = {
  periods: string[];
  lines: string[];
  distributors: string[];
  regions: string[];
  areas: string[];
  products: string[];
};

const EMPTY_FILTERS: Filters = { periods: [], lines: [], distributors: [], regions: [], areas: [], products: [] };

/** A month-over-month or year-over-year change, signed; "—" when there is no baseline. */
function signedPct(value: number | null | undefined): string {
  return value == null ? "—" : `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

function compactEGP(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `EGP ${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `EGP ${(value / 1_000).toFixed(0)}K`;
  return formatCurrency(value);
}

function effectiveList(all: SosOption[], selected: string[], mode: MultiSelectFilterMode): string[] {
  if (selected.length === 0) return [];
  if (mode === "include") return selected;
  const skip = new Set(selected);
  return all.map((option) => option.code).filter((code) => !skip.has(code));
}

function ChartCard({
  title,
  subtitle,
  icon,
  children,
  className,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-[6px] border border-slate-200 bg-white p-5 shadow-sm ${className ?? ""}`}>
      <div className="mb-4 flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-[6px] bg-gradient-to-br from-orange-50 to-orange-100 text-orange-600">{icon}</span>
        <div>
          <h3 className="text-sm font-black tracking-tight text-slate-900">{title}</h3>
          <p className="text-xs text-slate-500">{subtitle}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

function ValueTooltip({ active, payload, label }: { active?: boolean; payload?: Array<Record<string, unknown>>; label?: unknown }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-[6px] border border-slate-200 bg-white p-3 shadow-xl">
      <p className="mb-1 text-phx-2xs font-black uppercase tracking-wider text-slate-400">{String(label ?? "")}</p>
      <div className="space-y-1.5">
        {payload.map((entry, index) => {
          const name = String(entry.name ?? "");
          const raw = Number(entry.value ?? 0);
          const isUnits = /unit/i.test(name);
          const isPct = /%|share|cumulative/i.test(name);
          return (
            <div key={index} className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: String(entry.color ?? "#94A3B8") }} />
                <span className="text-phx-xs font-bold text-slate-600">{name}:</span>
              </div>
              <span className="text-phx-xs font-black text-slate-900">
                {isPct ? `${raw.toFixed(1)}%` : isUnits ? formatNumber(raw) : formatCurrency(raw)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Prose label for the month(s) in scope: one → "June 2026"; several → "3 months (Jun–Apr 2026)". */
function periodsLabel(selected: string[] | undefined, primary: string | null): string {
  if (selected && selected.length > 1) return `${selected.length} months`;
  const one = selected && selected.length === 1 ? selected[0] : primary;
  return one ? periodProseLabel(one) : "No data";
}

function Bar2({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
      <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
    </div>
  );
}

/** ▲ / ▼ / — chip vs the prior month. Hidden entirely when there is no comparison. */
function DeltaChip({ delta, invert = false }: { delta: SosDelta | null | undefined; invert?: boolean }) {
  if (!delta || delta.deltaPct == null) return null;
  const pct = delta.deltaPct;
  const flat = Math.abs(pct) < 0.0005;
  const good = invert ? pct < 0 : pct > 0;
  const tone = flat
    ? "border-slate-200 bg-slate-50 text-slate-500"
    : good
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : "border-rose-200 bg-rose-50 text-rose-700";
  const Icon = flat ? Minus : pct > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-[4px] border px-1.5 py-0.5 text-phx-2xs font-black tabular-nums ${tone}`}>
      <Icon className="h-3 w-3" />
      {`${Math.abs(pct * 100).toFixed(1)}%`}
    </span>
  );
}

/** Command-center KPI tile: square, white, thin orange top rule, slate-900 uppercase label,
 *  large tabular number, inline MoM delta chip, muted sub-line. Matches the black hero. */
function KpiTile({
  label,
  icon,
  value,
  sub,
  delta,
  invertDelta = false,
  emphasis = false,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  sub: string;
  delta?: SosDelta | null;
  invertDelta?: boolean;
  emphasis?: boolean;
}) {
  return (
    <div className="group relative overflow-hidden border border-slate-200 bg-white p-4 shadow-sm transition hover:border-orange-300 hover:shadow-md">
      <span aria-hidden="true" className={`absolute inset-x-0 top-0 h-[3px] ${emphasis ? "bg-orange-500" : "bg-slate-900 group-hover:bg-orange-500"} transition-colors`} />
      <div className="flex items-start justify-between gap-2">
        <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">{label}</p>
        <span className={`shrink-0 ${emphasis ? "text-orange-500" : "text-slate-300 group-hover:text-orange-400"} transition-colors`}>{icon}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-2xl font-black tabular-nums leading-none text-slate-900">{value}</span>
        <DeltaChip delta={delta} invert={invertDelta} />
      </div>
      <p className="mt-1.5 text-phx-xs font-semibold text-slate-400 whitespace-nowrap">{sub}</p>
    </div>
  );
}

function MoverList({ rows, direction }: { rows: SosMoverRow[]; direction: "up" | "down" }) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-xs text-slate-400">No {direction === "up" ? "gainers" : "decliners"} vs prior month.</p>;
  }
  const max = Math.max(...rows.map((row) => Math.abs(row.delta)), 1);
  return (
    <div className="space-y-2.5">
      {rows.map((row) => (
        <div key={row.code} className="flex items-center gap-3">
          <span className="w-32 shrink-0 text-xs font-bold text-slate-700 whitespace-nowrap" title={row.label}>{row.label}</span>
          <div className="flex-1"><Bar2 value={Math.abs(row.delta)} max={max} color={direction === "up" ? "#10B981" : "#F43F5E"} /></div>
          <span className="w-20 shrink-0 text-right text-xs font-black text-slate-900 whitespace-nowrap">{compactEGP(row.value)}</span>
          <span className={`w-16 shrink-0 text-right text-phx-xs font-black tabular-nums whitespace-nowrap ${direction === "up" ? "text-emerald-600" : "text-rose-600"}`}>
            {`${row.deltaPct > 0 ? "+" : ""}${(row.deltaPct * 100).toFixed(1)}%`}
          </span>
        </div>
      ))}
    </div>
  );
}

export function SosDashboard({
  initialData,
  initialError,
  canExport = false,
  canRevealRestricted = false,
}: {
  initialData: SosDashboardData | null;
  initialError: string | null;
  canExport?: boolean;
  /** CEO / Super Admin only — governs whether the confidential-reveal toggle renders at all. */
  canRevealRestricted?: boolean;
}) {
  const [data, setData] = useState<SosDashboardData | null>(initialData);
  const [error, setError] = useState<string | null>(initialError);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [periodMode, setPeriodMode] = useState<MultiSelectFilterMode>("include");
  const [lineMode, setLineMode] = useState<MultiSelectFilterMode>("include");
  const [distMode, setDistMode] = useState<MultiSelectFilterMode>("include");
  const [regionMode, setRegionMode] = useState<MultiSelectFilterMode>("include");
  const [areaMode, setAreaMode] = useState<MultiSelectFilterMode>("include");
  const [productMode, setProductMode] = useState<MultiSelectFilterMode>("include");
  const [moverTab, setMoverTab] = useState<"products" | "regions" | "distributors">("products");
  const [yoyMoverTab, setYoyMoverTab] = useState<"products" | "regions" | "distributors">("products");
  // Confidential-by-default: starts OFF on every load, including for CEO/Super Admin. Only a
  // deliberate click reveals LA003/LA004/SS001 — mirrors the marketing-ROI report's toggle.
  const [revealRestricted, setRevealRestricted] = useState(false);

  // Filter option lists — start from the unfiltered server load, then resync whenever a fresh
  // response arrives. The universe here depends only on scope + the reveal toggle (never on the
  // currently-active distributor/region/product selections), so refreshing it can never cause the
  // "picking a filter collapses the other dropdowns" problem multi-select filters normally guard
  // against — it only ever changes when the reveal toggle flips.
  const [options, setOptions] = useState(
    () =>
      initialData?.filters ?? {
        periods: [],
        lines: [],
        distributors: [],
        regions: [],
        areas: [],
        products: [],
      },
  );
  const lineOptions = useMemo(() => options.lines.map((line) => ({ code: line, label: line })), [options.lines]);
  const periodOptions = useMemo(
    () => options.periods.map((period) => ({ code: period, label: periodProseLabel(period) })),
    [options.periods],
  );

  const queryKey = useMemo(() => {
    const params = new URLSearchParams();
    const periods = effectiveList(periodOptions, filters.periods, periodMode);
    const lines = effectiveList(lineOptions, filters.lines, lineMode);
    const dist = effectiveList(options.distributors, filters.distributors, distMode);
    const region = effectiveList(options.regions, filters.regions, regionMode);
    const area = effectiveList(options.areas, filters.areas, areaMode);
    const product = effectiveList(options.products, filters.products, productMode);
    if (periods.length) params.set("periods", periods.join(","));
    if (lines.length) params.set("lines", lines.join(","));
    if (dist.length) params.set("distributors", dist.join(","));
    if (region.length) params.set("regions", region.join(","));
    if (area.length) params.set("areas", area.join(","));
    if (product.length) params.set("products", product.join(","));
    // Only ever sent when the caller can actually reveal (canRevealRestricted gates the toggle's
    // very existence below) — but the server re-validates against the role regardless, so this
    // can never widen visibility even if tampered with.
    if (revealRestricted) params.set("includeRestricted", "1");
    return params.toString();
  }, [filters, options, periodOptions, lineOptions, periodMode, lineMode, distMode, regionMode, areaMode, productMode, revealRestricted]);

  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    fetch(`/api/sales/sos-dashboard?${queryKey}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = (await response.json()) as { success: boolean; data?: SosDashboardData; error?: string };
        if (!response.ok || !payload.success || !payload.data) throw new Error(payload.error ?? "Failed to load source-of-sales dashboard.");
        setData(payload.data);
        // Resync the filter-option universe (e.g. toggling reveal adds LA003/LA004/SS001 to the
        // Products dropdown so a CEO can filter down to them, not just see them in aggregates).
        setOptions(payload.data.filters);
        setError(null);
      })
      .catch((fetchError: unknown) => {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") return;
        setError(fetchError instanceof Error ? fetchError.message : "Failed to load source-of-sales dashboard.");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [queryKey]);

  const handleExport = async () => {
    setDownloading(true);
    try {
      const response = await fetch(`/api/sales/sos-dashboard/export?${queryKey}`, { cache: "no-store" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
        throw new Error(payload?.message ?? payload?.error ?? "Export failed.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      anchor.href = url;
      anchor.download = match?.[1] ?? "phoenix-sos-dashboard.xlsx";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Export failed.");
    } finally {
      setDownloading(false);
    }
  };

  // Click-to-drill: clicking a region/area/distributor/product row toggles its code into the
  // matching filter — reuses the exact same state the dropdowns write to, so the filter chip
  // count, the queryKey refetch and the export link all stay in sync automatically.
  const handleRowClick = (dimension: "regions" | "areas" | "distributors" | "products", code: string) => {
    // Drilling into a row means "include this code". Reset the dimension's mode to "include" FIRST —
    // otherwise, if the user had toggled that filter to "exclude" mode, adding the clicked code would
    // EXCLUDE it (hiding the row's own data) instead of drilling in. Mirrors the portal dashboards'
    // toggleFilter, which setMode(key, "include") before the toggle (portal-sos-dashboard-impl.tsx,
    // portal-weekly-dashboard-impl.tsx).
    const setModeForDimension =
      dimension === "regions" ? setRegionMode
      : dimension === "areas" ? setAreaMode
      : dimension === "distributors" ? setDistMode
      : setProductMode;
    setModeForDimension("include");
    setFilters((current) => {
      const list = current[dimension];
      const next = list.includes(code) ? list.filter((existing) => existing !== code) : [...list, code];
      return { ...current, [dimension]: next };
    });
  };

  const summary = data?.summary;
  const mom = data?.momComparison ?? null;
  const deltas = mom?.summaryDeltas ?? null;
  const yoy = data?.yoyComparison ?? null;
  const yoyDeltas = yoy?.summaryDeltas ?? null;
  const pareto = useMemo(() => data?.paretoProducts ?? [], [data]);
  const byDistributor = data?.byDistributor ?? [];
  const byRegion = data?.byRegion ?? [];
  const byProduct = data?.byProduct ?? [];
  const byArea = data?.byArea ?? [];
  const topBricks = data?.topBricks ?? [];
  const bottomBricks = data?.bottomBricks ?? [];
  const topCustomers = data?.topCustomers ?? [];
  const trend = useMemo(() => data?.trend ?? [], [data]);
  const channelMix = data?.channelMix ?? [];
  const whiteSpaceAreas = data?.whiteSpaceAreas ?? [];
  const insights = data?.insights ?? [];

  const trendChartData = useMemo(
    () => trend.map((point) => ({ period: periodProseLabel(point.period), Value: Math.round(point.value), Units: Math.round(point.units) })),
    [trend],
  );
  const paretoChartData = useMemo(
    () =>
      pareto.slice(0, 30).map((row) => ({
        name: row.label,
        Value: Math.round(row.value),
        "Cumulative %": Number((row.cumulativeShare * 100).toFixed(1)),
        abc: row.abcClass,
      })),
    [pareto],
  );
  const abcCounts = useMemo(() => {
    const counts = { A: 0, B: 0, C: 0 };
    for (const row of pareto) counts[row.abcClass] += 1;
    return counts;
  }, [pareto]);
  const abcByCode = useMemo(() => {
    const map = new Map<string, "A" | "B" | "C">();
    for (const row of pareto) map.set(row.code.toUpperCase(), row.abcClass);
    return map;
  }, [pareto]);
  // MoM/YoY Δ columns read from deltaPctByCode (EVERY row's delta), not the capped top-5 movers —
  // otherwise any row outside the top gainers/decliners showed "—" despite having valid prior data.
  // Keys are already normalized (upper/trim) server-side; the movers widget still uses .movers.
  const productMomByCode = useMemo(() => new Map(Object.entries(mom?.deltaPctByCode.products ?? {})), [mom]);
  const distributorMomByCode = useMemo(() => new Map(Object.entries(mom?.deltaPctByCode.distributors ?? {})), [mom]);
  const productYoyByCode = useMemo(() => new Map(Object.entries(yoy?.deltaPctByCode.products ?? {})), [yoy]);
  const distributorYoyByCode = useMemo(() => new Map(Object.entries(yoy?.deltaPctByCode.distributors ?? {})), [yoy]);

  const activeFilterCount =
    filters.periods.length +
    filters.lines.length +
    filters.distributors.length +
    filters.regions.length +
    filters.areas.length +
    filters.products.length;

  const distributorTable = useSortableTable<SosDistributorRow>(byDistributor, {
    columns: [
      { key: "label", accessor: (row) => row.label, type: "string" },
      { key: "value", accessor: (row) => row.value, type: "number" },
      { key: "units", accessor: (row) => row.units, type: "number" },
      { key: "regions", accessor: (row) => row.regions, type: "number" },
      { key: "areas", accessor: (row) => row.areas, type: "number" },
      { key: "products", accessor: (row) => row.products, type: "number" },
    ],
    searchAccessors: [(row) => row.label, (row) => row.code],
    initialSort: { key: "value", dir: "desc" },
  });
  const distMax = visibleMax(distributorTable.rows, (row) => row.value);

  const productTable = useSortableTable<SosGroupRow>(byProduct, {
    columns: [
      { key: "label", accessor: (row) => row.label, type: "string" },
      { key: "line", accessor: (row) => row.line ?? "", type: "string" },
      { key: "value", accessor: (row) => row.value, type: "number" },
      { key: "units", accessor: (row) => row.units, type: "number" },
    ],
    searchAccessors: [(row) => row.label, (row) => row.code, (row) => row.line],
    initialSort: { key: "value", dir: "desc" },
  });
  const productMax = visibleMax(productTable.rows, (row) => row.value);

  const customerTable = useSortableTable<SosCustomerRow>(topCustomers, {
    columns: [
      { key: "name", accessor: (row) => row.name, type: "string" },
      { key: "distributor", accessor: (row) => row.distributor, type: "string" },
      { key: "region", accessor: (row) => row.region, type: "string" },
      { key: "value", accessor: (row) => row.value, type: "number" },
      { key: "units", accessor: (row) => row.units, type: "number" },
    ],
    searchAccessors: [(row) => row.name, (row) => row.code, (row) => row.distributor],
    initialSort: { key: "value", dir: "desc" },
  });

  const regionMax = visibleMax(byRegion, (row) => row.value);
  const areaMax = visibleMax(byArea, (row) => row.value);
  const brickMax = visibleMax(topBricks, (row) => row.value);
  const brickBottomMax = visibleMax(bottomBricks, (row) => row.value);

  const hasData = !error && !!summary && summary.totalValue > 0;
  const topDistributor = byDistributor[0];
  const priorLabel = mom ? periodProseLabel(mom.priorPeriod) : null;
  const movers = mom?.movers[moverTab] ?? null;
  const yoyLabel = yoy ? periodProseLabel(yoy.priorPeriod) : null;
  const yoyMovers = yoy?.movers[yoyMoverTab] ?? null;

  return (
    <div className={`space-y-6 pb-12 ${loading ? "pointer-events-none opacity-60" : ""}`}>
      <AdminPageHero
        eyebrow="Sales Intelligence"
        icon={<Network className="h-4 w-4" />}
        title="Source of Sales Dashboard"
        description="Actual sales performance from distributor uploads — month-over-month momentum, channel mix, regional breakdown, Pareto product rankings, top customers, and value trends over time."
        badges={
          <>
            <AdminInsightChip tone="orange">{periodsLabel(data?.selectedPeriods, data?.period ?? null)}</AdminInsightChip>
            {summary ? <AdminInsightChip tone="emerald">{compactEGP(summary.totalValue)}</AdminInsightChip> : null}
            {priorLabel ? <AdminInsightChip tone="slate">vs {priorLabel}</AdminInsightChip> : null}
            {yoyLabel ? <AdminInsightChip tone="slate">YoY vs {yoyLabel}</AdminInsightChip> : null}
            {loading ? <AdminInsightChip tone="slate">Updating…</AdminInsightChip> : null}
          </>
        }
        actions={
          canExport ? (
            <button
              type="button"
              onClick={() => void handleExport()}
              disabled={downloading || loading || !hasData}
              className="inline-flex items-center gap-1.5 rounded-[6px] border border-phx-accent bg-phx-accent px-3.5 py-2 text-sm font-black text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
              title="Download the full BI workbook with the current filters applied (CEO / Super Admin)"
            >
              {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {downloading ? "Preparing…" : "Export BI Workbook"}
            </button>
          ) : undefined
        }
        aside={
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-[6px] border border-white/15 bg-white/10 px-4 py-3 backdrop-blur">
              <p className="text-phx-2xs font-black uppercase tracking-[0.15em] text-slate-300">Total Value</p>
              <p className="mt-1 text-xl font-black text-white">{summary ? compactEGP(summary.totalValue) : "—"}</p>
              {deltas?.totalValue.deltaPct != null ? (
                <p className={`mt-0.5 flex items-center gap-1 text-phx-xs font-black ${deltas.totalValue.deltaPct >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                  {deltas.totalValue.deltaPct >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                  {`${deltas.totalValue.deltaPct >= 0 ? "+" : ""}${(deltas.totalValue.deltaPct * 100).toFixed(1)}% MoM`}
                </p>
              ) : null}
              {yoyDeltas?.totalValue.deltaPct != null ? (
                <p className={`mt-0.5 flex items-center gap-1 text-phx-xs font-black ${yoyDeltas.totalValue.deltaPct >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                  {yoyDeltas.totalValue.deltaPct >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                  {`${yoyDeltas.totalValue.deltaPct >= 0 ? "+" : ""}${(yoyDeltas.totalValue.deltaPct * 100).toFixed(1)}% YoY`}
                </p>
              ) : null}
            </div>
            <div className="rounded-[6px] border border-white/15 bg-white/10 px-4 py-3 backdrop-blur">
              <p className="text-phx-2xs font-black uppercase tracking-[0.15em] text-slate-300">Top Distributor</p>
              <p className="mt-1 text-sm font-black text-white whitespace-nowrap">{topDistributor?.label ?? "—"}</p>
              {topDistributor ? (
                <p className="mt-0.5 text-phx-xs font-bold text-slate-300">{formatPercent(topDistributor.share, { digits: 1 })} of value</p>
              ) : null}
            </div>
          </div>
        }
      />

      {/* Filters */}
      <div className="rounded-[6px] border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-black text-slate-900">
            <Filter className="h-4 w-4 text-orange-500" />
            Filters
            {activeFilterCount > 0 ? <span className="rounded-full bg-phx-warn-bg px-2 py-0.5 text-phx-xs font-black text-phx-warn">{activeFilterCount} active</span> : null}
          </div>
          {activeFilterCount > 0 ? (
            <button
              type="button"
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                setPeriodMode("include");
                setLineMode("include");
                setDistMode("include");
                setRegionMode("include");
                setProductMode("include");
                setAreaMode("include");
                setRevealRestricted(false);
              }}
              className="inline-flex items-center gap-1.5 rounded-[6px] border border-slate-200 px-2.5 py-1.5 text-xs font-bold text-slate-600 transition hover:border-orange-300 hover:text-orange-600"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Reset all
            </button>
          ) : null}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <MultiSelectFilter
            label="Months"
            icon={<BarChart3 className="h-3 w-3" />}
            options={periodOptions}
            selected={filters.periods}
            mode={periodMode}
            onSelectedChange={(next) => setFilters((current) => ({ ...current, periods: next }))}
            onModeChange={setPeriodMode}
            allLabel="Latest month"
          />
          <MultiSelectFilter
            label="Lines"
            icon={<Layers className="h-3 w-3" />}
            options={lineOptions}
            selected={filters.lines}
            mode={lineMode}
            onSelectedChange={(next) => setFilters((current) => ({ ...current, lines: next }))}
            onModeChange={setLineMode}
          />
          <MultiSelectFilter
            label="Distributors"
            icon={<Truck className="h-3 w-3" />}
            options={options.distributors.map((option) => ({ code: option.code, label: option.label }))}
            selected={filters.distributors}
            mode={distMode}
            onSelectedChange={(next) => setFilters((current) => ({ ...current, distributors: next }))}
            onModeChange={setDistMode}
          />
          <MultiSelectFilter
            label="Regions"
            icon={<MapPinned className="h-3 w-3" />}
            options={options.regions.map((option) => ({ code: option.code, label: option.label }))}
            selected={filters.regions}
            mode={regionMode}
            onSelectedChange={(next) => setFilters((current) => ({ ...current, regions: next }))}
            onModeChange={setRegionMode}
          />
          <MultiSelectFilter
            label="Areas"
            icon={<Building2 className="h-3 w-3" />}
            options={options.areas.map((option) => ({ code: option.code, label: option.label }))}
            selected={filters.areas}
            mode={areaMode}
            onSelectedChange={(next) => setFilters((current) => ({ ...current, areas: next }))}
            onModeChange={setAreaMode}
          />
          <MultiSelectFilter
            label="Products"
            icon={<PackageSearch className="h-3 w-3" />}
            options={options.products.map((option) => ({ code: option.code, label: option.label }))}
            selected={filters.products}
            mode={productMode}
            onSelectedChange={(next) => setFilters((current) => ({ ...current, products: next }))}
            onModeChange={setProductMode}
          />
        </div>

        {/* Confidential-by-default: excluded unless a CEO/Super Admin explicitly reveals them. */}
        {canRevealRestricted ? (
          <label className="mt-3 inline-flex cursor-pointer items-center gap-2 rounded-[5px] border border-amber-200 bg-amber-50 px-3 py-1.5 text-phx-sm font-bold text-amber-800 transition hover:border-amber-300">
            <input
              type="checkbox"
              className="h-4 w-4 accent-phx-accent"
              checked={revealRestricted}
              onChange={(event) => setRevealRestricted(event.target.checked)}
            />
            {revealRestricted ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
            Include confidential products (LA003 / LA004 / SS001)
          </label>
        ) : null}
      </div>

      {error ? (
        <AdminCallout tone="danger">
          <div>
            <p className="font-black">Could not load source-of-sales data.</p>
            <p className="mt-1 text-sm">{error}</p>
          </div>
        </AdminCallout>
      ) : null}

      {!error && (!summary || summary.totalValue === 0) ? (
        <AdminCallout tone="neutral">
          <div>
            <p className="font-black">No distributor sales for this selection.</p>
            <p className="mt-1 text-sm">Adjust the filters above, or validate a Source-of-Sales import for this month.</p>
          </div>
        </AdminCallout>
      ) : null}

      {hasData && summary ? (
        <>
          {/* KPI grid — command-center tiles; each carries its month-over-month delta when a prior month exists */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {/* The caveat belongs ON the number, not 500 lines below it in the footnote. A viewer who
                cannot reveal restricted products is also outside canViewHeadOfficeLine (identical
                membership: CEO + Super Admin), and the Head Office line carries the overwhelming
                majority of company value — measured 2026-08-10, this headline reads ~20% of the true
                company total for such a viewer. Stating that beside the figure is the difference
                between a scoped number and a wrong one. One line, no wrap, no ellipsis. */}
            <KpiTile
              emphasis
              label="Total Value"
              icon={<Banknote className="h-4 w-4" />}
              value={compactEGP(summary.totalValue)}
              sub={
                canRevealRestricted
                  ? formatCurrency(summary.totalValue)
                  : `${formatCurrency(summary.totalValue)} — excludes Head Office`
              }
              delta={deltas?.totalValue}
            />
            <KpiTile label="Total Units" icon={<Boxes className="h-4 w-4" />} value={formatNumber(summary.totalUnits)} sub="invoiced units" delta={deltas?.totalUnits} />
            <KpiTile label="Avg Price / Unit" icon={<Gauge className="h-4 w-4" />} value={compactEGP(summary.avgPricePerUnit)} sub="value ÷ units" delta={deltas?.avgPricePerUnit} />
            <KpiTile label="Distributors" icon={<Truck className="h-4 w-4" />} value={formatNumber(summary.distributorCount)} sub="active channels" delta={deltas?.distributorCount} />
            <KpiTile label="Products" icon={<PackageSearch className="h-4 w-4" />} value={formatNumber(summary.productCount)} sub="SKUs sold" delta={deltas?.productCount} />
            <KpiTile label="Customers" icon={<Users className="h-4 w-4" />} value={formatNumber(summary.customerCount)} sub="distributor clients" />
            <KpiTile label="Direct Share" icon={<Building2 className="h-4 w-4" />} value={formatPercent(summary.directShare, { digits: 1 })} sub={`${compactEGP(summary.directValue)} direct`} delta={deltas?.directShare} />
            <KpiTile
              emphasis={summary.totalAreas > 0 && summary.areasReached / summary.totalAreas >= 0.75}
              label="Area Coverage"
              icon={<MapPinned className="h-4 w-4" />}
              value={`${summary.areasReached}/${summary.totalAreas}`}
              sub={`${summary.bricksReached} bricks reached`}
              delta={deltas?.areasReached}
            />
          </div>

          {/* Trend */}
          <ChartCard title="Monthly Value & Units" subtitle="Distributor + direct value (bars) and units (line) by month" icon={<BarChart3 className="h-4 w-4" />}>
            <SafeResponsiveContainer minHeight={300}>
              <ComposedChart data={trendChartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                <XAxis dataKey="period" axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 700, fill: "#94A3B8" }} minTickGap={8} />
                <YAxis yAxisId="left" axisLine={false} tickLine={false} tick={{ fontSize: 9, fontWeight: 700, fill: "#94A3B8" }} width={44} tickFormatter={(v: number) => compactEGP(v)} />
                <YAxis yAxisId="right" orientation="right" axisLine={false} tickLine={false} tick={{ fontSize: 9, fontWeight: 700, fill: "#94A3B8" }} width={40} tickFormatter={(v: number) => formatNumber(v)} />
                <Tooltip content={<ValueTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11, fontWeight: 700 }} />
                <Bar yAxisId="left" dataKey="Value" fill="#F97316" radius={[0, 0, 0, 0]} barSize={22} />
                <Line yAxisId="right" type="monotone" dataKey="Units" stroke="#0EA5E9" strokeWidth={3} dot={{ r: 3, fill: "#0EA5E9" }} />
              </ComposedChart>
            </SafeResponsiveContainer>
          </ChartCard>

          {/* Month-over-month momentum */}
          {mom ? (
            <div className="rounded-[6px] border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 items-center justify-center rounded-[6px] bg-gradient-to-br from-orange-50 to-orange-100 text-orange-600"><Sparkles className="h-4 w-4" /></span>
                  <div>
                    <h3 className="text-sm font-black tracking-tight text-slate-900">Month-over-Month Momentum</h3>
                    <p className="text-xs text-slate-500">{data?.period ? periodProseLabel(data.period) : "—"} vs {priorLabel}</p>
                  </div>
                </div>
                <div className="inline-flex gap-1 rounded-[6px] border border-slate-200 bg-slate-50 p-1">
                  {([["products", "Products"], ["regions", "Regions"], ["distributors", "Distributors"]] as const).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setMoverTab(key)}
                      className={`rounded-[4px] px-3 py-1.5 text-xs font-black transition ${moverTab === key ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-white hover:text-slate-900"}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                <div>
                  <p className="mb-2.5 flex items-center gap-1.5 text-xs font-black uppercase tracking-wide text-emerald-700"><TrendingUp className="h-3.5 w-3.5" /> Top gainers</p>
                  <MoverList rows={movers?.gainers ?? []} direction="up" />
                </div>
                <div>
                  <p className="mb-2.5 flex items-center gap-1.5 text-xs font-black uppercase tracking-wide text-rose-700"><TrendingDown className="h-3.5 w-3.5" /> Top decliners</p>
                  <MoverList rows={movers?.decliners ?? []} direction="down" />
                </div>
              </div>
              {(mom.newProducts.length > 0 || mom.lostProducts.length > 0 || mom.newAreas.length > 0 || mom.lostAreas.length > 0) ? (
                <div className="mt-5 grid grid-cols-1 gap-3 border-t border-slate-100 pt-4 lg:grid-cols-2">
                  {mom.newProducts.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-phx-xs font-black uppercase tracking-wide text-emerald-700">New products:</span>
                      {mom.newProducts.map((row) => (
                        <span key={row.code} className="rounded-[4px] border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-phx-xs font-bold text-emerald-700" title={compactEGP(row.value)}>{row.label}</span>
                      ))}
                    </div>
                  ) : null}
                  {mom.lostProducts.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-phx-xs font-black uppercase tracking-wide text-rose-700">No sales this month:</span>
                      {mom.lostProducts.map((row) => (
                        <span key={row.code} className="rounded-[4px] border border-rose-200 bg-rose-50 px-2 py-0.5 text-phx-xs font-bold text-rose-700" title={`${compactEGP(row.value)} in ${priorLabel}`}>{row.label}</span>
                      ))}
                    </div>
                  ) : null}
                  {mom.newAreas.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-phx-xs font-black uppercase tracking-wide text-emerald-700">Newly covered areas:</span>
                      {mom.newAreas.map((row) => (
                        <span key={row.code} className="rounded-[4px] border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-phx-xs font-bold text-emerald-700">{row.label}</span>
                      ))}
                    </div>
                  ) : null}
                  {mom.lostAreas.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-phx-xs font-black uppercase tracking-wide text-rose-700">Areas lost:</span>
                      {mom.lostAreas.map((row) => (
                        <span key={row.code} className="rounded-[4px] border border-rose-200 bg-rose-50 px-2 py-0.5 text-phx-xs font-bold text-rose-700">{row.label}</span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Year-over-year momentum — compact strip, same shape as MoM but vs the same month last year */}
          {yoy ? (
            <div className="rounded-[6px] border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 items-center justify-center rounded-[6px] bg-gradient-to-br from-orange-50 to-orange-100 text-orange-600"><Sparkles className="h-4 w-4" /></span>
                  <div>
                    <h3 className="text-sm font-black tracking-tight text-slate-900">Year-over-Year Momentum</h3>
                    <p className="text-xs text-slate-500">{data?.period ? periodProseLabel(data.period) : "—"} vs {yoyLabel}</p>
                  </div>
                </div>
                <div className="inline-flex gap-1 rounded-[6px] border border-slate-200 bg-slate-50 p-1">
                  {([["products", "Products"], ["regions", "Regions"], ["distributors", "Distributors"]] as const).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setYoyMoverTab(key)}
                      className={`rounded-[4px] px-3 py-1.5 text-xs font-black transition ${yoyMoverTab === key ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-white hover:text-slate-900"}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                <div>
                  <p className="mb-2.5 flex items-center gap-1.5 text-xs font-black uppercase tracking-wide text-emerald-700"><TrendingUp className="h-3.5 w-3.5" /> Top gainers</p>
                  <MoverList rows={yoyMovers?.gainers ?? []} direction="up" />
                </div>
                <div>
                  <p className="mb-2.5 flex items-center gap-1.5 text-xs font-black uppercase tracking-wide text-rose-700"><TrendingDown className="h-3.5 w-3.5" /> Top decliners</p>
                  <MoverList rows={yoyMovers?.decliners ?? []} direction="down" />
                </div>
              </div>
            </div>
          ) : null}

          {/* Pareto / ABC */}
          {pareto.length > 0 ? (
            <ChartCard
              title="Product Pareto — ABC"
              subtitle={`Class A: ${abcCounts.A} product(s) = 80% of value · B: ${abcCounts.B} · C: ${abcCounts.C}${pareto.length > 30 ? ` — chart shows top 30 of ${pareto.length}` : ""}`}
              icon={<Activity className="h-4 w-4" />}
            >
              <SafeResponsiveContainer minHeight={300}>
                <ComposedChart data={paretoChartData} margin={{ top: 8, right: 8, bottom: 40, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                  <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 9, fontWeight: 700, fill: "#94A3B8" }} interval={0} angle={-35} textAnchor="end" height={70} />
                  <YAxis yAxisId="left" axisLine={false} tickLine={false} tick={{ fontSize: 9, fontWeight: 700, fill: "#94A3B8" }} width={44} tickFormatter={(v: number) => compactEGP(v)} />
                  <YAxis yAxisId="right" orientation="right" domain={[0, 100]} axisLine={false} tickLine={false} tick={{ fontSize: 9, fontWeight: 700, fill: "#94A3B8" }} width={36} tickFormatter={(v: number) => `${v}%`} />
                  <Tooltip content={<ValueTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 11, fontWeight: 700 }} />
                  <Bar yAxisId="left" dataKey="Value" radius={[0, 0, 0, 0]} barSize={16}>
                    {paretoChartData.map((entry) => (
                      <Cell key={entry.name} fill={entry.abc === "A" ? "#F97316" : entry.abc === "B" ? "#FDBA74" : "#E2E8F0"} />
                    ))}
                  </Bar>
                  <Line yAxisId="right" type="monotone" dataKey="Cumulative %" stroke="#0F172A" strokeWidth={2.5} dot={{ r: 2.5, fill: "#0F172A" }} />
                </ComposedChart>
              </SafeResponsiveContainer>
            </ChartCard>
          ) : null}

          {/* Channel + Distributor mix donuts */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <ChartCard title="Channel Mix" subtitle="Distributors vs direct (company) value" icon={<Layers className="h-4 w-4" />}>
              {channelMix.length === 0 ? (
                <p className="py-10 text-center text-sm text-slate-400">No channel data.</p>
              ) : (
                <SafeResponsiveContainer minHeight={260}>
                  <PieChart>
                    <Pie data={channelMix} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={2}>
                      {channelMix.map((slice, index) => (
                        <Cell key={slice.name} fill={CHANNEL_COLORS[index % CHANNEL_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip content={<ValueTooltip />} />
                    <Legend wrapperStyle={{ fontSize: 11, fontWeight: 700 }} />
                  </PieChart>
                </SafeResponsiveContainer>
              )}
            </ChartCard>

            <ChartCard title="Distributor Mix" subtitle="Value share by distributor" icon={<Truck className="h-4 w-4" />}>
              {byDistributor.length === 0 ? (
                <p className="py-10 text-center text-sm text-slate-400">No distributor data.</p>
              ) : (
                <SafeResponsiveContainer minHeight={260}>
                  <PieChart>
                    <Pie data={byDistributor.slice(0, 10)} dataKey="value" nameKey="label" innerRadius={55} outerRadius={90} paddingAngle={2}>
                      {byDistributor.slice(0, 10).map((slice, index) => (
                        <Cell key={slice.code} fill={CHANNEL_COLORS[index % CHANNEL_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip content={<ValueTooltip />} />
                    <Legend wrapperStyle={{ fontSize: 11, fontWeight: 700 }} />
                  </PieChart>
                </SafeResponsiveContainer>
              )}
            </ChartCard>
          </div>

          {/* Region + Area bars */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <ChartCard title="Region Performance" subtitle="Value by region" icon={<MapPinned className="h-4 w-4" />}>
              {byRegion.length === 0 ? (
                <p className="py-10 text-center text-sm text-slate-400">No region data.</p>
              ) : (
                <div className="space-y-3">
                  {byRegion.slice(0, 10).map((row) => (
                    <div
                      key={row.code}
                      onClick={() => handleRowClick("regions", row.code)}
                      className={`flex cursor-pointer items-center gap-3 rounded-[4px] px-1 py-0.5 transition hover:bg-orange-50 ${filters.regions.includes(row.code) ? "bg-orange-100" : ""}`}
                      title={`Click to filter to ${row.label}`}
                    >
                      <span className="w-28 shrink-0 text-xs font-bold text-slate-700 whitespace-nowrap" title={row.label}>{row.label}</span>
                      <div className="flex-1"><Bar2 value={row.value} max={regionMax} color="#0EA5E9" /></div>
                      <span className="w-24 shrink-0 text-right text-xs font-black text-slate-900">{compactEGP(row.value)}</span>
                      <span className="w-12 shrink-0 text-right text-phx-xs font-bold text-slate-500">{formatPercent(row.share, { digits: 0 })}</span>
                    </div>
                  ))}
                </div>
              )}
            </ChartCard>

            <ChartCard title="Area Performance" subtitle="Top areas by value" icon={<Building2 className="h-4 w-4" />}>
              {byArea.length === 0 ? (
                <p className="py-10 text-center text-sm text-slate-400">No area data.</p>
              ) : (
                <div className="space-y-3">
                  {byArea.slice(0, 10).map((row) => (
                    <div
                      key={row.code}
                      onClick={() => handleRowClick("areas", row.code)}
                      className={`flex cursor-pointer items-center gap-3 rounded-[4px] px-1 py-0.5 transition hover:bg-orange-50 ${filters.areas.includes(row.code) ? "bg-orange-100" : ""}`}
                      title={`Click to filter to ${row.label}`}
                    >
                      <span className="w-28 shrink-0 text-xs font-bold text-slate-700 whitespace-nowrap" title={row.label}>{row.label}</span>
                      <div className="flex-1"><Bar2 value={row.value} max={areaMax} color="#8B5CF6" /></div>
                      <span className="w-24 shrink-0 text-right text-xs font-black text-slate-900">{compactEGP(row.value)}</span>
                      <span className="w-12 shrink-0 text-right text-phx-xs font-bold text-slate-500">{formatPercent(row.share, { digits: 0 })}</span>
                    </div>
                  ))}
                </div>
              )}
            </ChartCard>
          </div>

          {/* Insights + white-space */}
          {(insights.length > 0 || whiteSpaceAreas.length > 0) ? (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              <ChartCard title="Insights" subtitle="Auto-generated highlights" icon={<Lightbulb className="h-4 w-4" />}>
                {insights.length === 0 ? (
                  <p className="py-10 text-center text-sm text-slate-400">No insights.</p>
                ) : (
                  <div className="space-y-2.5">
                    {insights.map((bullet, index) => (
                      <AdminCallout key={index} tone={bullet.tone}>
                        <span className="text-sm">{bullet.text}</span>
                      </AdminCallout>
                    ))}
                  </div>
                )}
              </ChartCard>
              <ChartCard title="White-space Areas" subtitle="Master areas with zero distributor sales this month" icon={<Activity className="h-4 w-4" />}>
                {whiteSpaceAreas.length === 0 ? (
                  <p className="py-10 text-center text-sm text-emerald-600">Every area had sales this month. 🎉</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {whiteSpaceAreas.map((row) => (
                      <span key={row.code} className="rounded-[4px] border border-rose-200 bg-rose-50/60 px-2.5 py-1 text-xs font-bold text-rose-700" title={row.region ?? undefined}>
                        {row.label}
                      </span>
                    ))}
                  </div>
                )}
              </ChartCard>
            </div>
          ) : null}

          {/* Distributor table */}
          <AdminTableShell
            title="Distributor Performance"
            description="Channels ranked by value, with month-over-month delta and reach across regions / areas / products"
            action={<TableSearchInput value={distributorTable.query} onChange={distributorTable.setQuery} onClear={distributorTable.clearQuery} placeholder="Search distributors…" className="w-full sm:w-64" />}
          >
            {/* table-fixed + a percentage colgroup: the columns divide the container, so no
                distributor name or figure can push the table sideways. Below `md` the four
                narrowest columns fold away and reappear as a line under the distributor. */}
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col className="w-[34%] md:w-[24%]" />
                <col className="w-[24%] md:w-[16%]" />
                <col className="w-[20%] md:w-[11%]" />
                <col className="hidden md:table-column md:w-[11%]" />
                <col className="w-[22%] md:w-[12%]" />
                <col className="hidden md:table-column md:w-[9%]" />
                <col className="hidden md:table-column md:w-[8%]" />
                <col className="hidden md:table-column md:w-[9%]" />
              </colgroup>
              <thead className="bg-[#020617] text-white">
                  <tr>
                    <SortableTh label="Distributor" sortKey="label" sort={distributorTable.sort} onSort={distributorTable.toggleSort} />
                    <SortableTh label="Value" sortKey="value" sort={distributorTable.sort} onSort={distributorTable.toggleSort} align="right" />
                    <th className="break-words px-3 py-2.5 text-right text-xs font-black uppercase tracking-wide">MoM Δ</th>
                    <th className="hidden break-words px-3 py-2.5 text-right text-xs font-black uppercase tracking-wide md:table-cell">YoY Δ</th>
                    <SortableTh label="Units" sortKey="units" sort={distributorTable.sort} onSort={distributorTable.toggleSort} align="right" />
                    <SortableTh className="hidden md:table-cell" label="Regions" sortKey="regions" sort={distributorTable.sort} onSort={distributorTable.toggleSort} align="right" />
                    <SortableTh className="hidden md:table-cell" label="Areas" sortKey="areas" sort={distributorTable.sort} onSort={distributorTable.toggleSort} align="right" />
                    <SortableTh className="hidden md:table-cell" label="Products" sortKey="products" sort={distributorTable.sort} onSort={distributorTable.toggleSort} align="right" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-orange-100">
                  {distributorTable.rows.length === 0 ? (
                    <TableNoResults colSpan={8} filtered={distributorTable.isFiltered} label="distributors" />
                  ) : (
                    distributorTable.rows.map((row) => {
                      const momPct = distributorMomByCode.get(row.code.toUpperCase());
                      const yoyPct = distributorYoyByCode.get(row.code.toUpperCase());
                      const selected = filters.distributors.includes(row.code);
                      return (
                        <tr
                          key={row.code}
                          onClick={() => handleRowClick("distributors", row.code)}
                          className={`cursor-pointer transition hover:bg-orange-50/40 ${selected ? "bg-orange-100" : ""}`}
                          title={`Click to filter to ${row.label}`}
                        >
                          <td className="break-words px-3 py-2.5 align-top font-bold text-slate-900">
                            {row.label}
                            {/* Below `md` the folded columns come back here, so a phone loses nothing. */}
                            <span className="mt-0.5 block text-xs font-semibold text-slate-500 md:hidden">
                              {`YoY ${yoyPct == null ? "—" : `${yoyPct > 0 ? "+" : ""}${(yoyPct * 100).toFixed(1)}%`} · ${formatNumber(row.regions)} regions · ${formatNumber(row.areas)} areas · ${formatNumber(row.products)} products`}
                            </span>
                          </td>
                          <td className="break-words px-3 py-2.5 text-right align-top">
                            <div className="font-black text-slate-900">{compactEGP(row.value)}</div>
                            <Bar2 value={row.value} max={distMax} color="#F97316" />
                          </td>
                          <td className={`break-words px-3 py-2.5 text-right align-top text-xs font-black tabular-nums ${momPct == null ? "text-slate-300" : momPct >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                            {momPct == null ? "—" : `${momPct > 0 ? "+" : ""}${(momPct * 100).toFixed(1)}%`}
                          </td>
                          <td className={`hidden break-words px-3 py-2.5 text-right align-top text-xs font-black tabular-nums md:table-cell ${yoyPct == null ? "text-slate-300" : yoyPct >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                            {yoyPct == null ? "—" : `${yoyPct > 0 ? "+" : ""}${(yoyPct * 100).toFixed(1)}%`}
                          </td>
                          <td className="break-words px-3 py-2.5 text-right align-top text-slate-600">{formatNumber(row.units)}</td>
                          <td className="hidden break-words px-3 py-2.5 text-right align-top text-slate-600 md:table-cell">{formatNumber(row.regions)}</td>
                          <td className="hidden break-words px-3 py-2.5 text-right align-top text-slate-600 md:table-cell">{formatNumber(row.areas)}</td>
                          <td className="hidden break-words px-3 py-2.5 text-right align-top text-slate-600 md:table-cell">{formatNumber(row.products)}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
            </table>
          </AdminTableShell>

          {/* Product + Customer tables */}
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <AdminTableShell
              title="Product Performance"
              description="Products ranked by distributor value, with ABC class and month-over-month delta"
              action={<TableSearchInput value={productTable.query} onChange={productTable.setQuery} onClear={productTable.clearQuery} placeholder="Search products…" className="w-full sm:w-56" />}
            >
              <div className="max-h-[460px] overflow-y-auto">
                <CrmTable columns={["22%", "12%", "7%", "18%", "14%", "14%", "13%"]}>
                  <thead className="sticky top-0 z-10 bg-[#020617] text-white">
                    <tr>
                      <SortableTh label="Product" sortKey="label" sort={productTable.sort} onSort={productTable.toggleSort} />
                      <SortableTh label="Line" sortKey="line" sort={productTable.sort} onSort={productTable.toggleSort} />
                      <th className="break-words px-2 py-2.5 text-center text-xs font-black uppercase tracking-wide">ABC</th>
                      <SortableTh label="Value" sortKey="value" sort={productTable.sort} onSort={productTable.toggleSort} align="right" />
                      <th className="break-words px-2 py-2.5 text-right text-xs font-black uppercase tracking-wide">MoM Δ</th>
                      <th className="break-words px-2 py-2.5 text-right text-xs font-black uppercase tracking-wide">YoY Δ</th>
                      <SortableTh label="Units" sortKey="units" sort={productTable.sort} onSort={productTable.toggleSort} align="right" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-orange-100">
                    {productTable.rows.length === 0 ? (
                      <TableNoResults colSpan={7} filtered={productTable.isFiltered} label="products" />
                    ) : (
                      productTable.rows.map((row) => {
                        const abc = abcByCode.get(row.code.toUpperCase());
                        const momPct = productMomByCode.get(row.code.toUpperCase());
                        const yoyPct = productYoyByCode.get(row.code.toUpperCase());
                        const selected = filters.products.includes(row.code);
                        return (
                          <tr
                            key={row.code}
                            onClick={() => handleRowClick("products", row.code)}
                            className={`cursor-pointer transition hover:bg-orange-50/40 ${selected ? "bg-orange-100" : ""}`}
                            title={`Click to filter to ${row.label}`}
                          >
                            <td className="break-words px-3 py-2.5 align-top font-bold text-slate-900">{row.label}</td>
                            <td className="break-words px-3 py-2.5 align-top text-slate-600">{row.line ?? "—"}</td>
                            <td className="px-2 py-2.5 text-center align-top">
                              {abc ? (
                                <span className={`inline-flex h-5 w-5 items-center justify-center rounded-[4px] text-phx-2xs font-black ${abc === "A" ? "bg-orange-100 text-orange-700" : abc === "B" ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-500"}`}>
                                  {abc}
                                </span>
                              ) : (
                                <span className="text-slate-300">—</span>
                              )}
                            </td>
                            <td className="break-words px-2 py-2.5 text-right align-top">
                              <div className="font-black text-slate-900">{compactEGP(row.value)}</div>
                              <Bar2 value={row.value} max={productMax} color="#8B5CF6" />
                            </td>
                            <td className={`break-words px-2 py-2.5 text-right align-top text-xs font-black tabular-nums ${momPct == null ? "text-slate-300" : momPct >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                              {momPct == null ? "—" : `${momPct > 0 ? "+" : ""}${(momPct * 100).toFixed(1)}%`}
                            </td>
                            <td className={`break-words px-2 py-2.5 text-right align-top text-xs font-black tabular-nums ${yoyPct == null ? "text-slate-300" : yoyPct >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                              {yoyPct == null ? "—" : `${yoyPct > 0 ? "+" : ""}${(yoyPct * 100).toFixed(1)}%`}
                            </td>
                            <td className="break-words px-2 py-2.5 text-right align-top text-slate-600">{formatNumber(row.units)}</td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </CrmTable>
                <CrmCardsOnPhone>
                  {productTable.rows.length === 0 ? (
                    <p className="px-3 py-6 text-center text-sm text-slate-400">{productTable.isFiltered ? "No products match this filter." : "No products."}</p>
                  ) : (
                    productTable.rows.map((row) => {
                      const abc = abcByCode.get(row.code.toUpperCase());
                      const selected = filters.products.includes(row.code);
                      return (
                        <div className="cursor-pointer" key={`${row.code}-card`} onClick={() => handleRowClick("products", row.code)} title={`Click to filter to ${row.label}`}>
                          <CrmCard className={selected ? "bg-orange-100" : undefined} meta={[row.line, abc ? `Class ${abc}` : null].filter(Boolean).join(" · ") || undefined} title={row.label}>
                            <CrmFacts
                              facts={[
                                { label: "Value", value: compactEGP(row.value) },
                                { label: "Units", value: formatNumber(row.units) },
                                { label: "MoM Δ", value: signedPct(productMomByCode.get(row.code.toUpperCase())) },
                                { label: "YoY Δ", value: signedPct(productYoyByCode.get(row.code.toUpperCase())) },
                              ]}
                            />
                          </CrmCard>
                        </div>
                      );
                    })
                  )}
                </CrmCardsOnPhone>
              </div>
            </AdminTableShell>

            <AdminTableShell
              title="Top Customers"
              description={`Top customers by value${data ? ` — top 10 = ${formatPercent(data.customerTop10Share, { digits: 1 })} of customer value` : ""}`}
              action={<TableSearchInput value={customerTable.query} onChange={customerTable.setQuery} onClear={customerTable.clearQuery} placeholder="Search customers…" className="w-full sm:w-56" />}
            >
              <div className="max-h-[460px] overflow-y-auto">
                <CrmTable columns={["30%", "26%", "22%", "22%"]}>
                  <thead className="sticky top-0 z-10 bg-[#020617] text-white">
                    <tr>
                      <SortableTh label="Customer" sortKey="name" sort={customerTable.sort} onSort={customerTable.toggleSort} />
                      <SortableTh label="Distributor" sortKey="distributor" sort={customerTable.sort} onSort={customerTable.toggleSort} />
                      <SortableTh label="Region" sortKey="region" sort={customerTable.sort} onSort={customerTable.toggleSort} />
                      <SortableTh label="Value" sortKey="value" sort={customerTable.sort} onSort={customerTable.toggleSort} align="right" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-orange-100">
                    {customerTable.rows.length === 0 ? (
                      <TableNoResults colSpan={4} filtered={customerTable.isFiltered} label="customers" />
                    ) : (
                      customerTable.rows.map((row) => (
                        <tr key={`${row.distributor}-${row.code}`} className="transition hover:bg-orange-50/40">
                          <td className="break-words px-3 py-2.5 align-top font-bold text-slate-900">{row.name}</td>
                          <td className="break-words px-3 py-2.5 align-top text-slate-600">{row.distributor}</td>
                          <td className="break-words px-3 py-2.5 align-top text-slate-600">{row.region}</td>
                          <td className="break-words px-3 py-2.5 text-right align-top font-black text-slate-900">{compactEGP(row.value)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </CrmTable>
                <CrmCardsOnPhone>
                  {customerTable.rows.length === 0 ? (
                    <p className="px-3 py-6 text-center text-sm text-slate-400">{customerTable.isFiltered ? "No customers match this filter." : "No customers."}</p>
                  ) : (
                    customerTable.rows.map((row) => (
                      <CrmCard key={`${row.distributor}-${row.code}-card`} meta={[row.distributor, row.region].filter(Boolean).join(" · ") || undefined} title={row.name}>
                        <CrmFacts facts={[{ label: "Value", value: compactEGP(row.value) }]} />
                      </CrmCard>
                    ))
                  )}
                </CrmCardsOnPhone>
              </div>
            </AdminTableShell>
          </div>

          {/* Top bricks */}
          {topBricks.length > 0 ? (
            <ChartCard title="Top Bricks" subtitle="Highest-value territories (excludes direct)" icon={<MapPinned className="h-4 w-4" />}>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {topBricks.map((row) => (
                  <div key={row.code} className="flex items-center gap-3">
                    <span className="w-32 shrink-0 text-xs font-bold text-slate-700 whitespace-nowrap" title={row.label}>{row.label}</span>
                    <div className="flex-1"><Bar2 value={row.value} max={brickMax} color="#10B981" /></div>
                    <span className="w-24 shrink-0 text-right text-xs font-black text-slate-900">{compactEGP(row.value)}</span>
                  </div>
                ))}
              </div>
            </ChartCard>
          ) : null}

          {/* Lowest bricks */}
          {bottomBricks.length > 0 ? (
            <ChartCard title="Lowest Bricks" subtitle="Lowest-value territories (excludes direct)" icon={<MapPinned className="h-4 w-4" />}>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {bottomBricks.map((row) => (
                  <div key={row.code} className="flex items-center gap-3">
                    <span className="w-32 shrink-0 text-xs font-bold text-slate-700 whitespace-nowrap" title={row.label}>{row.label}</span>
                    <div className="flex-1"><Bar2 value={row.value} max={brickBottomMax} color="#F97316" /></div>
                    <span className="w-24 shrink-0 text-right text-xs font-black text-slate-900">{compactEGP(row.value)}</span>
                  </div>
                ))}
              </div>
            </ChartCard>
          ) : null}

          {/* All areas comparison */}
          {byArea.length > 0 ? (
            <div>
              <AdminTableShell
                title="Areas — Full Sales Comparison"
                description={`All ${byArea.length} areas ranked by value, highest to lowest`}
              >
                <CrmTable columns={["5%", "21%", "17%", "17%", "16%", "12%", "12%"]}>
                  <thead>
                    <tr>
                      <th className="break-words px-3 py-3 text-left text-xs font-black uppercase tracking-wide text-white">#</th>
                      <th className="break-words px-3 py-3 text-left text-xs font-black uppercase tracking-wide text-white">Area</th>
                      <th className="break-words px-3 py-3 text-left text-xs font-black uppercase tracking-wide text-white">Region</th>
                      <th className="px-3 py-3 text-xs font-black uppercase tracking-wide text-white" />
                      <th className="break-words px-3 py-3 text-right text-xs font-black uppercase tracking-wide text-white">Value</th>
                      <th className="break-words px-3 py-3 text-right text-xs font-black uppercase tracking-wide text-white">Units</th>
                      <th className="break-words px-3 py-3 text-right text-xs font-black uppercase tracking-wide text-white">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byArea.map((row, index) => (
                      <tr key={row.code} className="border-t border-orange-100 hover:bg-orange-50/40">
                        <td className="px-3 py-2.5 align-top text-xs font-bold text-slate-400">{index + 1}</td>
                        <td className="break-words px-3 py-2.5 align-top text-xs font-bold text-slate-800">{row.label}</td>
                        <td className="break-words px-3 py-2.5 align-top text-xs text-slate-500">{row.line ?? "—"}</td>
                        <td className="px-3 py-2.5 align-top"><Bar2 value={row.value} max={areaMax} color="#8B5CF6" /></td>
                        <td className="break-words px-3 py-2.5 text-right align-top text-xs font-black text-slate-900">{compactEGP(row.value)}</td>
                        <td className="break-words px-3 py-2.5 text-right align-top text-xs font-bold text-slate-600">{formatNumber(row.units)}</td>
                        <td className="break-words px-3 py-2.5 text-right align-top text-xs font-bold text-slate-500">{formatPercent(row.share, { digits: 1 })}</td>
                      </tr>
                    ))}
                  </tbody>
                </CrmTable>
                <CrmCardsOnPhone>
                  {byArea.map((row, index) => (
                    <CrmCard key={`${row.code}-card`} meta={row.line ?? undefined} title={`${index + 1}. ${row.label}`}>
                      <CrmFacts
                        facts={[
                          { label: "Value", value: compactEGP(row.value) },
                          { label: "Units", value: formatNumber(row.units) },
                          { label: "Share", value: formatPercent(row.share, { digits: 1 }) },
                        ]}
                      />
                    </CrmCard>
                  ))}
                </CrmCardsOnPhone>
              </AdminTableShell>
            </div>
          ) : null}

          <p className="px-1 text-center text-xs text-slate-400">
            Source-of-Sales distributor invoices for {periodsLabel(data?.selectedPeriods, data?.period ?? null)}
            {priorLabel ? ` (compared with ${priorLabel})` : ""}.{" "}
            {data?.restrictedRevealed
              ? "Confidential products (LA003 / LA004 / SS001) are included in this view."
              : canRevealRestricted
                ? "Confidential products are excluded by default — use the toggle above to reveal them."
                : "Confidential products (LA003 / LA004 / SS001) and the whole Head Office line are excluded from this view, so every total above is lower than the company total."}
          </p>
        </>
      ) : null}
    </div>
  );
}
