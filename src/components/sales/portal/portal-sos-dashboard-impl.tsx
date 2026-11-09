"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Boxes,
  CalendarRange,
  Coins,
  Download,
  Gauge,
  Globe,
  Layers,
  MapPin,
  Package,
  PieChart as PieChartIcon,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Table2,
  TrendingUp,
  Truck,
  type LucideIcon,
} from "lucide-react";

import {
  CHART_TOOLTIP_CLASS,
  ProportionBar,
  SectionCard,
  SURFACE_CLASS,
  TABLE_HEAD_CLASS,
  TABLE_ROW_CLASS,
  chipClass,
} from "@/components/sales/target-visuals";
import { MultiSelectFilter, type MultiSelectFilterMode } from "@/components/ui/multi-select-filter";
import { cairoDateTime12h } from "@/lib/format/cairo-datetime";
import type { DistributorUploadStatus } from "@/lib/sales/monthly-distributor-import";
import type { PortalSosComparison, PortalSosScopeView } from "@/lib/sales/portal-sos-dashboard";
import type {
  SosDashboardData,
  SosDistributorRow,
  SosGroupRow,
  SosOption,
} from "@/lib/sales/sos-dashboard";
import {
  AXIS_LINE_HEIGHT,
  REFRESH_FAILED,
  deltaWords,
  monthName,
  rankedChartHeight,
  sharePercentText,
  trendTitle,
  uploadWords,
  versusMonth,
  wrapAxisLabel,
} from "@/lib/sales/sos-portal-words";

// The look is the shared light sales language (target-visuals.tsx): white cards, thin slate
// borders, orange accents, calm dark numbers, square edges, no gradients. classNames are plain
// strings, never cn(): tailwind-merge treats the custom `text-phx-*` sizes as colours and silently
// drops one of the pair.

type Props = {
  initialData: SosDashboardData;
  scope: PortalSosScopeView;
  initialComparison: PortalSosComparison | null;
  initialUploadStatus: DistributorUploadStatus | null;
};

// Categorical palette — orange-led, premium and high-contrast on white.
const CHART_COLORS = ["#F97316", "#0EA5E9", "#22C55E", "#8B5CF6", "#F59E0B", "#EF4444", "#14B8A6", "#6366F1"];

/** Chart chrome on the light surface. */
const GRID_STROKE = "#E2E8F0";
const TICK_FILL = "#64748B";

// ── Formatting ──────────────────────────────────────────────────────────────
function formatEgp(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `EGP ${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `EGP ${(value / 1_000).toFixed(1)}K`;
  return `EGP ${Math.round(value).toLocaleString("en-US")}`;
}
function formatEgpFull(value: number): string {
  return `EGP ${Math.round(value).toLocaleString("en-US")}`;
}
function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}
// A share is cut toward zero at one decimal (sos-portal-words.ts), so 99.96% never reads "100.0%".
const formatPct = sharePercentText;
// "Sep 2026", worked out from the text: no Date, so no timezone can move it a month.
const formatPeriod = monthName;

type MultiKey = "lines" | "regions" | "areas" | "products" | "distributors";
type DetailView = "product" | "region" | "area" | "distributor";

const EMPTY_SELECTION: string[] = [];

type CachedPayload = {
  data: SosDashboardData;
  comparison: PortalSosComparison | null;
  uploadStatus: DistributorUploadStatus | null;
};

export function PortalSosDashboard({ initialData, scope, initialComparison, initialUploadStatus }: Props) {
  // Filter option universes are stable for the session (scope-trimmed by the server).
  const options = initialData.filters;
  const lineOptions: SosOption[] = useMemo(
    () => options.lines.map((line) => ({ code: line, label: line })),
    [options.lines],
  );

  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initList = (key: string): string[] => {
    const raw = searchParams.get(key);
    return raw ? raw.split(",").map((value) => value.trim()).filter(Boolean) : EMPTY_SELECTION;
  };

  const [data, setData] = useState<SosDashboardData>(initialData);
  const [comparison, setComparison] = useState<PortalSosComparison | null>(initialComparison);
  const [uploadStatus, setUploadStatus] = useState<DistributorUploadStatus | null>(initialUploadStatus);
  const [loading, setLoading] = useState(false);
  // A filter change that could not be loaded leaves the old figures on screen; this says so above them.
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [period, setPeriod] = useState<string | null>(searchParams.get("period") || initialData.period);
  const [selection, setSelection] = useState<Record<MultiKey, string[]>>({
    lines: initList("lines"),
    regions: initList("regions"),
    areas: initList("areas"),
    products: initList("products"),
    distributors: initList("distributors"),
  });
  const [modes, setModes] = useState<Record<MultiKey, MultiSelectFilterMode>>({
    lines: "include",
    regions: "include",
    areas: "include",
    products: "include",
    distributors: "include",
  });
  // Single-region viewers (DSM) lose the Region breakdown tab, so default them to Area instead.
  const [view, setView] = useState<DetailView>(scope.isSingleRegion ? "area" : "product");

  const vis = scope.visibility;
  const firstRun = useRef(true);
  // Client cache: same filter signature → instant restore (no network), key win on Vercel serverless.
  const cacheRef = useRef<Map<string, CachedPayload>>(new Map());

  const resolve = useCallback(
    (key: MultiKey, allCodes: string[]): string[] => {
      const sel = selection[key];
      if (sel.length === 0) return [];
      return modes[key] === "exclude" ? allCodes.filter((code) => !sel.includes(code)) : sel;
    },
    [selection, modes],
  );

  const buildQuery = useCallback((): string => {
    const params = new URLSearchParams();
    if (period) params.set("period", period);
    const add = (key: MultiKey, allCodes: string[]) => {
      const resolved = resolve(key, allCodes);
      if (resolved.length > 0) params.set(key, resolved.join(","));
    };
    if (vis.line) add("lines", options.lines);
    if (vis.region) add("regions", options.regions.map((o) => o.code));
    if (vis.area) add("areas", options.areas.map((o) => o.code));
    if (vis.product) add("products", options.products.map((o) => o.code));
    if (vis.distributor) add("distributors", options.distributors.map((o) => o.code));
    return params.toString();
  }, [period, resolve, vis, options]);

  useEffect(() => {
    const query = buildQuery();
    if (firstRun.current) {
      firstRun.current = false;
      // Seed the cache with the server-rendered payload so toggling back is instant.
      cacheRef.current.set(query, { data: initialData, comparison: initialComparison, uploadStatus: initialUploadStatus });
      return;
    }
    // Shareable, refresh-safe URL — replaceState avoids re-running the server component.
    window.history.replaceState(null, "", query ? `${pathname}?${query}` : pathname);

    const cached = cacheRef.current.get(query);
    if (cached) {
      setData(cached.data);
      setComparison(cached.comparison);
      setUploadStatus(cached.uploadStatus);
      setRefreshFailed(false);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/employee-portals/source-of-sales?${query}`, {
          signal: controller.signal,
        });
        const json = await response.json();
        if (json?.success && json.data) {
          const payload: CachedPayload = {
            data: json.data as SosDashboardData,
            comparison: (json.comparison ?? null) as PortalSosComparison | null,
            uploadStatus: (json.uploadStatus ?? null) as DistributorUploadStatus | null,
          };
          cacheRef.current.set(query, payload);
          setData(payload.data);
          setComparison(payload.comparison);
          setUploadStatus(payload.uploadStatus);
          setRefreshFailed(false);
        } else {
          setRefreshFailed(true);
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.error("Failed to refresh Source of Sales", error);
          setRefreshFailed(true);
        }
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [buildQuery, pathname, initialData, initialComparison, initialUploadStatus, refreshTick]);

  const setSel = (key: MultiKey, next: string[]) => setSelection((prev) => ({ ...prev, [key]: next }));
  const setMode = (key: MultiKey, next: MultiSelectFilterMode) => setModes((prev) => ({ ...prev, [key]: next }));

  // "Sync now" — drop the client cache and refetch the current view so a freshly uploaded batch
  // shows immediately without a full page reload.
  const refresh = () => {
    cacheRef.current.clear();
    setRefreshTick((tick) => tick + 1);
  };

  // Drill-down: clicking a chart value toggles it into the matching filter (no-op if that filter
  // isn't applicable to the viewer's scope).
  const toggleFilter = (key: MultiKey, code: string | undefined) => {
    if (!code || !vis[key === "lines" ? "line" : key === "regions" ? "region" : key === "areas" ? "area" : key === "products" ? "product" : "distributor"]) return;
    setMode(key, "include");
    setSelection((prev) => {
      const current = prev[key];
      const next = current.includes(code) ? current.filter((value) => value !== code) : [...current, code];
      return { ...prev, [key]: next };
    });
  };

  const activeFilterCount =
    (vis.line ? selection.lines.length : 0) +
    (vis.region ? selection.regions.length : 0) +
    (vis.area ? selection.areas.length : 0) +
    (vis.product ? selection.products.length : 0) +
    (vis.distributor ? selection.distributors.length : 0);

  const resetFilters = () =>
    setSelection({ lines: [], regions: [], areas: [], products: [], distributors: [] });

  const summary = data.summary;
  // The selected month against the calendar month before it, worked out on the server from the
  // same comparison that fills the breakdown's change column. Never from the trend: its last two
  // points are the newest month and the one before, whatever month is picked.
  const valueDelta = comparison?.totalValueDelta ?? null;

  const isEmpty = data.period === null || summary.totalValue <= 0;
  const isProductManager = scope.role === "Product Manager" || scope.role === "Group Product Manager";

  const filtersSection = (
    <Section
      title="Filters"
      icon={SlidersHorizontal}
      overflowVisible
      action={
        activeFilterCount > 0 ? (
          <button type="button" onClick={resetFilters} className={`inline-flex items-center gap-1.5 ${chipClass(false)}`}>
            <RotateCcw className="h-3 w-3" />
            Reset {activeFilterCount}
          </button>
        ) : (
          <span className="text-phx-xs font-bold uppercase tracking-widest text-slate-400">No filters applied</span>
        )
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {vis.line ? (
          <MultiSelectFilter label="Line" icon={<Layers className="h-3 w-3" />} options={lineOptions} selected={selection.lines} mode={modes.lines} onSelectedChange={(n) => setSel("lines", n)} onModeChange={(m) => setMode("lines", m)} />
        ) : null}
        {vis.region ? (
          <MultiSelectFilter label="Region" icon={<MapPin className="h-3 w-3" />} options={options.regions} selected={selection.regions} mode={modes.regions} onSelectedChange={(n) => setSel("regions", n)} onModeChange={(m) => setMode("regions", m)} />
        ) : null}
        {vis.area ? (
          <MultiSelectFilter label="Area" icon={<MapPin className="h-3 w-3" />} options={options.areas} selected={selection.areas} mode={modes.areas} onSelectedChange={(n) => setSel("areas", n)} onModeChange={(m) => setMode("areas", m)} />
        ) : null}
        {vis.product ? (
          <MultiSelectFilter label="Product" icon={<Package className="h-3 w-3" />} options={options.products} selected={selection.products} mode={modes.products} onSelectedChange={(n) => setSel("products", n)} onModeChange={(m) => setMode("products", m)} />
        ) : null}
        {vis.distributor ? (
          <MultiSelectFilter label="Distributor" icon={<Truck className="h-3 w-3" />} options={options.distributors} selected={selection.distributors} mode={modes.distributors} onSelectedChange={(n) => setSel("distributors", n)} onModeChange={(m) => setMode("distributors", m)} />
        ) : null}
      </div>
    </Section>
  );

  return (
    <div className="space-y-5">
      <ScopeBar
        scopeSummary={scope.scopeSummary}
        period={period}
        periods={data.availablePeriods}
        onPeriodChange={setPeriod}
        loading={loading}
        uploadStatus={uploadStatus}
        onRefresh={refresh}
      />

      {refreshFailed ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border border-l-[3px] border-amber-200 border-l-amber-500 bg-amber-50/60 px-4 py-3">
          <p className="min-w-0 break-words text-sm font-semibold text-amber-800">{REFRESH_FAILED}</p>
          <button type="button" onClick={refresh} className={`inline-flex items-center gap-1.5 ${chipClass(false)}`}>
            <RefreshCw className="h-3 w-3" />
            Try again
          </button>
        </div>
      ) : null}

      {isEmpty ? (
        <>
          {/* A selection that leaves nothing keeps its filters on screen, so it can be undone here
              rather than only by editing the address. */}
          {data.period !== null && activeFilterCount > 0 ? filtersSection : null}
          <EmptyState isProductManager={isProductManager} hasPeriod={data.period !== null} filtered={activeFilterCount > 0} />
        </>
      ) : (
        <>
          {/* KPI strip */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
            <StatTile accent="#F97316" icon={Coins} label="Total Value" value={formatEgp(summary.totalValue)} delta={valueDelta} deltaLabel={valueDelta != null ? versusMonth(comparison?.previousPeriod) : undefined} />
            <StatTile accent="#0EA5E9" icon={Boxes} label="Units Sold" value={formatNumber(summary.totalUnits)} sub="net of bonus" />
            <StatTile accent="#8B5CF6" icon={Gauge} label="Avg / Unit" value={formatEgpFull(summary.avgPricePerUnit)} />
            <StatTile accent="#22C55E" icon={Truck} label="Distributors" value={formatNumber(summary.distributorCount)} sub={`${formatNumber(summary.productCount)} products`} />
            <StatTile accent="#F59E0B" icon={Layers} label="Direct Share" value={formatPct(summary.directShare)} sub="vs distributor" />
            <StatTile accent="#14B8A6" icon={MapPin} label="Area Coverage" value={`${formatNumber(summary.areasReached)}/${formatNumber(summary.totalAreas)}`} sub="areas reached" />
          </div>

          {filtersSection}

          {/* Insights + top movers */}
          {data.insights.length > 0 || (comparison && (comparison.gainers.length > 0 || comparison.decliners.length > 0)) ? (
            <InsightsStrip insights={data.insights} comparison={comparison} />
          ) : null}

          {/* Charts (click a bar to filter by it) */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Section title={trendTitle(data.trend.map((point) => point.period), data.period)} icon={TrendingUp} className="lg:col-span-2">
              <div className="h-60 w-full">
                <TrendChart trend={data.trend} selected={data.period} />
              </div>
            </Section>
            <Section title="Channel mix" icon={PieChartIcon}>
              <div className="h-60 w-full">
                <DonutChart slices={data.channelMix} total={summary.totalValue} />
              </div>
            </Section>
            <Section title="Top products" icon={Package}>
              <RankedBars rows={data.byProduct} from="#F97316" labelColor="#C2410C" selected={selection.products} onSelect={(code) => toggleFilter("products", code)} />
            </Section>
            {scope.isSingleRegion ? (
              // Single-region viewer (DSM): one region vs itself is meaningless, so this slot becomes
              // a vertical "By area" chart of the areas inside his region.
              <Section title="By area" icon={MapPin}>
                <ColumnBars rows={data.byArea} from="#14B8A6" labelColor="#0F766E" selected={selection.areas} onSelect={(code) => toggleFilter("areas", code)} />
              </Section>
            ) : (
              <Section title="By region" icon={Globe}>
                <RankedBars rows={data.byRegion} from="#0EA5E9" labelColor="#0369A1" selected={selection.regions} onSelect={vis.region ? (code) => toggleFilter("regions", code) : undefined} />
              </Section>
            )}
            <Section title="By distributor" icon={Truck}>
              <RankedBars rows={data.byDistributor} from="#8B5CF6" labelColor="#6D28D9" selected={selection.distributors} onSelect={(code) => toggleFilter("distributors", code)} />
            </Section>
            {scope.isSingleRegion ? null : (
              // Multi-region viewer (RM/NSM/PM/GPM/MM): keep "By region" above and add a full-width
              // horizontal "By area" — many areas read best wide, with the full list in the table below.
              <Section title="By area" icon={MapPin} className="lg:col-span-3">
                <RankedBars rows={data.byArea} from="#14B8A6" labelColor="#0F766E" selected={selection.areas} onSelect={(code) => toggleFilter("areas", code)} wide />
              </Section>
            )}
          </div>

          {/* Detail breakdown */}
          <DetailSection data={data} view={view} onViewChange={setView} comparison={comparison} exportQuery={buildQuery()} singleRegion={scope.isSingleRegion} />
        </>
      )}
    </div>
  );
}

// ── Scope + period control bar ──────────────────────────────────────────────────
// Cairo time through the shared formatter: a client-side `toLocaleString` with an hour prints the
// 12-hour clock's narrow space differently on the server and on an Apple device (React #418).
function formatStamp(iso: string | null): string | null {
  if (!iso || Number.isNaN(new Date(iso).getTime())) return null;
  return cairoDateTime12h(iso);
}

function ScopeBar({
  scopeSummary,
  period,
  periods,
  onPeriodChange,
  loading,
  uploadStatus,
  onRefresh,
}: {
  scopeSummary: string;
  period: string | null;
  periods: string[];
  onPeriodChange: (next: string) => void;
  loading: boolean;
  uploadStatus: DistributorUploadStatus | null;
  onRefresh: () => void;
}) {
  const stamp = formatStamp(uploadStatus?.lastUploadedAt ?? null);
  const upload = uploadWords(uploadStatus);
  return (
    <div className={`flex flex-col gap-3 border-t-[3px] border-t-orange-500 px-4 py-3 sm:flex-row sm:items-center sm:justify-between ${SURFACE_CLASS}`}>
      <div className="min-w-0">
        <p className="text-phx-xs font-black uppercase tracking-[0.18em] text-orange-600">Your scope</p>
        <p className="break-words text-sm font-black text-slate-900">{scopeSummary}</p>
        {stamp ? (
          <p className="text-phx-xs font-semibold text-slate-500">
            Latest {formatPeriod(period)} upload: {stamp}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className={`inline-flex items-center gap-1.5 disabled:opacity-50 ${chipClass(false)}`}
          title="Sync now — pull the latest uploaded sales"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          Sync now
        </button>
        {upload ? (
          // Shown at every width (it was hidden on a phone), and it wraps rather than run off the bar.
          <span
            className={`inline-flex min-w-0 max-w-full items-center gap-1.5 break-words border px-2.5 py-1 text-phx-xs font-black ${
              upload.tone === "waiting"
                ? "border-amber-200 bg-amber-50 text-amber-700"
                : "border-emerald-200 bg-emerald-50 text-emerald-700"
            }`}
          >
            <Truck className="h-3 w-3 shrink-0" />
            {upload.text}
          </span>
        ) : null}
        {loading ? (
          <span className="flex items-center gap-1.5 text-phx-xs font-bold uppercase tracking-wide text-orange-600">
            <span className="h-1.5 w-1.5 animate-pulse bg-orange-500" />
            Updating
          </span>
        ) : null}
        <label className="flex items-center gap-2 border border-slate-200 bg-white px-3 py-1.5 transition-colors hover:border-orange-300">
          <CalendarRange className="h-3.5 w-3.5 text-orange-500" />
          <select
            value={period ?? ""}
            onChange={(event) => onPeriodChange(event.target.value)}
            className="cursor-pointer border-0 bg-transparent p-0 text-sm font-black text-slate-900 outline-none"
          >
            {periods.map((value) => (
              <option key={value} value={value}>
                {formatPeriod(value)}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

// ── Section shell — the shared light SectionCard, with the card body padded ────────────
function Section({
  title,
  icon,
  action,
  className,
  overflowVisible,
  children,
}: {
  title: string;
  icon: LucideIcon;
  action?: ReactNode;
  className?: string;
  /** Let absolutely-positioned children (filter dropdowns) escape the card instead of being clipped. */
  overflowVisible?: boolean;
  children: ReactNode;
}) {
  return (
    <SectionCard
      title={title}
      icon={icon}
      actions={action}
      className={`${overflowVisible ? "relative z-30 overflow-visible" : "overflow-hidden"} ${className ?? ""}`}
    >
      <div className="p-4">{children}</div>
    </SectionCard>
  );
}

// ── KPI tile ────────────────────────────────────────────────────────────────────
function StatTile({
  accent,
  icon: Icon,
  label,
  value,
  sub,
  delta,
  deltaLabel,
}: {
  accent: string;
  icon: typeof Coins;
  label: string;
  value: string;
  sub?: string;
  delta?: number | null;
  /** What the arrow compares against ("vs Sep 2026"), so a bare percentage is never left to be guessed. */
  deltaLabel?: string;
}) {
  return (
    <div className={`relative transition-colors hover:border-orange-300 ${SURFACE_CLASS}`}>
      <span aria-hidden className="absolute inset-x-0 top-0 h-[3px]" style={{ backgroundColor: accent }} />
      <div className="p-3.5 pt-4 sm:p-4 sm:pt-5">
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <span className="flex h-7 w-7 items-center justify-center" style={{ backgroundColor: `${accent}14`, color: accent }}>
            <Icon className="h-3.5 w-3.5" />
          </span>
          {delta != null ? <DeltaPill delta={delta} /> : null}
        </div>
        <p className="mt-2.5 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">{label}</p>
        <p className="mt-0.5 break-words text-lg font-black tabular-nums tracking-tight text-slate-900 sm:text-xl">{value}</p>
        {sub ? <p className="mt-0.5 text-phx-xs font-semibold text-slate-500">{sub}</p> : null}
        {delta != null && deltaLabel ? <p className="mt-0.5 text-phx-xs font-semibold text-slate-500">{deltaLabel}</p> : null}
      </div>
    </div>
  );
}

const DELTA_TONE_CLASS = {
  up: "bg-emerald-50 text-emerald-600 ring-emerald-100",
  down: "bg-red-50 text-red-600 ring-red-100",
  flat: "bg-slate-50 text-slate-500 ring-slate-200",
} as const;

function DeltaPill({ delta }: { delta: number }) {
  const words = deltaWords(delta);
  return (
    <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 text-phx-xs font-black tabular-nums ring-1 ring-inset ${DELTA_TONE_CLASS[words.tone]}`}>
      {words.tone === "up" ? <ArrowUpRight className="h-3 w-3" /> : words.tone === "down" ? <ArrowDownRight className="h-3 w-3" /> : null}
      {words.text}
    </span>
  );
}

// ── Insights + top movers ──────────────────────────────────────────────────────────
function InsightsStrip({
  insights,
  comparison,
}: {
  insights: SosDashboardData["insights"];
  comparison: PortalSosComparison | null;
}) {
  const toneClass: Record<string, string> = {
    neutral: "border-slate-200 border-l-slate-400 bg-white text-slate-700",
    success: "border-emerald-100 border-l-emerald-500 bg-emerald-50/50 text-emerald-800",
    warning: "border-amber-100 border-l-amber-500 bg-amber-50/50 text-amber-800",
    danger: "border-red-100 border-l-red-500 bg-red-50/50 text-red-800",
  };
  const hasMovers = comparison && (comparison.gainers.length > 0 || comparison.decliners.length > 0);
  return (
    <Section title="Insights" icon={Sparkles}>
      {hasMovers ? (
        <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <MoverList title="Top gainers" tone="up" movers={comparison!.gainers} versus={versusMonth(comparison!.previousPeriod)} />
          <MoverList title="Top decliners" tone="down" movers={comparison!.decliners} versus={versusMonth(comparison!.previousPeriod)} />
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {insights.slice(0, 6).map((insight, index) => (
          <div key={index} className={`border border-l-[3px] px-3 py-2 ${toneClass[insight.tone] ?? toneClass.neutral}`}>
            <p className="text-xs font-semibold leading-relaxed">{insight.text}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

function MoverList({ title, tone, movers, versus }: { title: string; tone: "up" | "down"; movers: PortalSosComparison["gainers"]; versus: string }) {
  if (movers.length === 0) return null;
  return (
    <div className="border border-slate-200 bg-white p-3">
      <p className="mb-2 flex items-center gap-1.5 text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">
        {tone === "up" ? <ArrowUpRight className="h-3 w-3 text-emerald-600" /> : <ArrowDownRight className="h-3 w-3 text-red-600" />}
        {`${title} · ${versus}`}
      </p>
      <div className="divide-y divide-slate-100">
        {movers.map((mover) => (
          <div key={mover.code} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5">
            <span className="min-w-0 break-words text-xs font-bold text-slate-800">{mover.label}</span>
            <span className="flex items-center gap-2">
              <span className="text-phx-xs tabular-nums text-slate-500">{formatEgp(mover.value)}</span>
              <DeltaPill delta={mover.deltaPct} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Charts ──────────────────────────────────────────────────────────────────────
function PremiumTooltip({ active, payload, label, valueOnly }: { active?: boolean; payload?: Array<{ name?: string; value?: number; payload?: { label?: string } }>; label?: string; valueOnly?: boolean }) {
  if (!active || !payload || payload.length === 0) return null;
  const title = label ?? payload[0]?.payload?.label ?? payload[0]?.name ?? "";
  return (
    <div className={CHART_TOOLTIP_CLASS}>
      {title ? <p className="mb-0.5 text-phx-xs font-black uppercase tracking-wide text-slate-500">{title}</p> : null}
      {payload.map((entry, index) => (
        <p key={index} className="text-xs font-black tabular-nums text-slate-900">
          {valueOnly ? "" : `${entry.name}: `}
          {formatEgpFull(Number(entry.value ?? 0))}
        </p>
      ))}
    </div>
  );
}

function TrendChart({ trend, selected }: { trend: SosDashboardData["trend"]; selected: string | null }) {
  const points = trend.map((point) => ({ label: formatPeriod(point.period), value: point.value }));
  if (points.length === 0) return <NoData />;
  const selectedLabel = selected && trend.some((point) => point.period === selected) ? formatPeriod(selected) : null;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={points} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: TICK_FILL }} axisLine={{ stroke: GRID_STROKE }} tickLine={false} />
        <YAxis tickFormatter={(value) => formatEgp(Number(value)).replace("EGP ", "")} tick={{ fontSize: 11, fill: TICK_FILL }} axisLine={false} tickLine={false} width={46} />
        <Tooltip content={<PremiumTooltip valueOnly />} cursor={{ stroke: "#F97316", strokeOpacity: 0.3 }} />
        {/* The month the figures above are for, so a picked older month is never read as the newest. */}
        {selectedLabel ? (
          <ReferenceLine x={selectedLabel} stroke="#0F172A" strokeDasharray="4 3" label={{ value: "Selected", position: "insideTopRight", fontSize: 11, fontWeight: 800, fill: "#0F172A" }} />
        ) : null}
        <Area type="monotone" dataKey="value" stroke="#F97316" strokeWidth={2.5} fill="#F97316" fillOpacity={0.08} dot={{ r: 3, fill: "#F97316", strokeWidth: 0 }} activeDot={{ r: 5, fill: "#F97316", stroke: "#FFFFFF", strokeWidth: 2 }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function DonutChart({ slices, total }: { slices: SosDashboardData["channelMix"]; total: number }) {
  if (slices.length === 0) return <NoData />;
  return (
    <div className="relative h-full w-full">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={slices} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="86%" paddingAngle={3} stroke="#FFFFFF" strokeWidth={2}>
            {slices.map((slice, index) => (
              <Cell key={slice.name} fill={CHART_COLORS[index % CHART_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip content={<PremiumTooltip />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <p className="text-phx-xs font-black uppercase tracking-wide text-slate-500">Total</p>
        <p className="text-base font-black tabular-nums text-slate-900">{formatEgp(total)}</p>
      </div>
    </div>
  );
}

type TickProps = { x?: number | string; y?: number | string; payload?: { value?: unknown } };

/**
 * A chart label drawn as whole lines (sos-portal-words.ts `wrapAxisLabel`): recharts draws a tick as
 * one SVG line, and the chart's edge cut long product and distributor names mid-word.
 */
function WrappedTick({ x, y, payload, maxChars, anchor }: TickProps & { maxChars: number; anchor: "end" | "middle" }) {
  const lines = wrapAxisLabel(String(payload?.value ?? ""), maxChars);
  // Beside a bar the block is centred on the bar; under a column it hangs from the axis.
  const first = anchor === "end" ? -((lines.length - 1) * AXIS_LINE_HEIGHT) / 2 : AXIS_LINE_HEIGHT;
  return (
    <g transform={`translate(${Number(x ?? 0)},${Number(y ?? 0)})`}>
      <text textAnchor={anchor} fill={TICK_FILL} fontSize={11} fontWeight={600} dominantBaseline={anchor === "end" ? "central" : "auto"}>
        {lines.map((line, index) => (
          <tspan key={index} x={anchor === "end" ? -4 : 0} dy={index === 0 ? first : AXIS_LINE_HEIGHT}>
            {line}
          </tspan>
        ))}
      </text>
    </g>
  );
}

/** Characters per label line: the 124px label column fits about 18 at 11px, a full-width card more. */
const RANKED_LABEL_CHARS = 18;
const RANKED_LABEL_CHARS_WIDE = 28;

function RankedBars({
  rows,
  from,
  labelColor,
  selected,
  onSelect,
  wide,
}: {
  rows: SosGroupRow[];
  from: string;
  labelColor: string;
  selected?: string[];
  onSelect?: (code: string | undefined) => void;
  /** Spans the whole row, so names get a wider label column. */
  wide?: boolean;
}) {
  const top = rows.slice(0, 8).map((row) => ({ label: row.label, value: row.value, code: row.code }));
  if (top.length === 0) {
    return (
      <div className="h-60 w-full">
        <NoData />
      </div>
    );
  }
  const selectedSet = new Set(selected ?? []);
  const clickable = Boolean(onSelect);
  const maxChars = wide ? RANKED_LABEL_CHARS_WIDE : RANKED_LABEL_CHARS;
  // Each bar gets the room its own wrapped name needs; never below the 240px the cards were drawn at.
  const height = rankedChartHeight(top.map((row) => wrapAxisLabel(row.label, maxChars).length));
  return (
    <div className="w-full" style={{ height }}>
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={top} layout="vertical" margin={{ top: 2, right: 56, bottom: 2, left: 4 }} barCategoryGap="22%">
        <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="label"
          width={wide ? 180 : 124}
          tick={(props: TickProps) => <WrappedTick {...props} anchor="end" maxChars={maxChars} />}
          axisLine={false}
          tickLine={false}
          interval={0}
        />
        <Tooltip content={<PremiumTooltip valueOnly />} cursor={{ fill: `${from}12` }} />
        <Bar
          dataKey="value"
          radius={[0, 0, 0, 0]}
          fill={from}
          isAnimationActive
          cursor={clickable ? "pointer" : undefined}
          onClick={
            clickable
              ? (((entry: { code?: string; payload?: { code?: string } }) =>
                  onSelect?.(entry?.code ?? entry?.payload?.code)) as never)
              : undefined
          }
        >
          {top.map((entry) => (
            <Cell
              key={entry.code}
              fill={from}
              fillOpacity={selectedSet.size > 0 && !selectedSet.has(entry.code) ? 0.45 : 0.9}
              stroke={selectedSet.has(entry.code) ? "#0F172A" : undefined}
              strokeWidth={selectedSet.has(entry.code) ? 2 : 0}
            />
          ))}
          <LabelList
            dataKey="value"
            position="right"
            formatter={(value) => formatEgp(Number(value)).replace("EGP ", "")}
            style={{ fontSize: 11, fontWeight: 800, fill: labelColor }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
    </div>
  );
}

// Vertical column variant — used for the DSM "By area" chart (few areas within one region read
// better as upright columns than horizontal bars). Same flat fill + click-to-filter as RankedBars;
// value labels sit above each column.
function ColumnBars({
  rows,
  from,
  labelColor,
  selected,
  onSelect,
}: {
  rows: SosGroupRow[];
  from: string;
  labelColor: string;
  selected?: string[];
  onSelect?: (code: string | undefined) => void;
}) {
  const top = rows.slice(0, 8).map((row) => ({ label: row.label, value: row.value, code: row.code }));
  if (top.length === 0) {
    return (
      <div className="h-60 w-full">
        <NoData />
      </div>
    );
  }
  const selectedSet = new Set(selected ?? []);
  const clickable = Boolean(onSelect);
  const labelLines = Math.max(...top.map((row) => wrapAxisLabel(row.label, COLUMN_LABEL_CHARS).length));
  const axisHeight = labelLines * AXIS_LINE_HEIGHT + 12;
  return (
    <div className="w-full" style={{ height: 200 + axisHeight }}>
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={top} margin={{ top: 18, right: 8, bottom: 4, left: 0 }} barCategoryGap="22%">
        <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="label"
          tick={(props: TickProps) => <WrappedTick {...props} anchor="middle" maxChars={COLUMN_LABEL_CHARS} />}
          axisLine={{ stroke: GRID_STROKE }}
          tickLine={false}
          interval={0}
          height={axisHeight}
        />
        <YAxis type="number" hide />
        <Tooltip content={<PremiumTooltip valueOnly />} cursor={{ fill: `${from}12` }} />
        <Bar
          dataKey="value"
          radius={[0, 0, 0, 0]}
          fill={from}
          isAnimationActive
          cursor={clickable ? "pointer" : undefined}
          onClick={
            clickable
              ? (((entry: { code?: string; payload?: { code?: string } }) =>
                  onSelect?.(entry?.code ?? entry?.payload?.code)) as never)
              : undefined
          }
        >
          {top.map((entry) => (
            <Cell
              key={entry.code}
              fill={from}
              fillOpacity={selectedSet.size > 0 && !selectedSet.has(entry.code) ? 0.45 : 0.9}
              stroke={selectedSet.has(entry.code) ? "#0F172A" : undefined}
              strokeWidth={selectedSet.has(entry.code) ? 2 : 0}
            />
          ))}
          <LabelList
            dataKey="value"
            position="top"
            formatter={(value) => formatEgp(Number(value)).replace("EGP ", "")}
            style={{ fontSize: 11, fontWeight: 800, fill: labelColor }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
    </div>
  );
}

/** Characters per line under a column: up to eight columns share the card's width. */
const COLUMN_LABEL_CHARS = 12;

function NoData() {
  return <div className="flex h-full items-center justify-center text-xs font-semibold text-slate-400">No data for this selection.</div>;
}

// ── Detail breakdown (table desktop / cards mobile) ─────────────────────────────
type DetailRow = { code: string; label: string; value: number; units: number; share: number; extra?: string; deltaPct: number | null };

function DetailSection({
  data,
  view,
  onViewChange,
  comparison,
  exportQuery,
  singleRegion,
}: {
  data: SosDashboardData;
  view: DetailView;
  onViewChange: (next: DetailView) => void;
  comparison: PortalSosComparison | null;
  exportQuery: string;
  /** DSM (one region) — drop the Region tab; comparing a single region is meaningless. */
  singleRegion: boolean;
}) {
  const rows: DetailRow[] = useMemo(() => {
    const prevByCode = comparison?.prevValueByCode[view] ?? {};
    const deltaOf = (code: string, value: number): number | null => {
      const prev = prevByCode[code];
      return prev != null && prev > 0 ? (value - prev) / prev : null;
    };
    const map = (list: SosGroupRow[]): DetailRow[] =>
      list.map((row) => ({ code: row.code, label: row.label, value: row.value, units: row.units, share: row.share, deltaPct: deltaOf(row.code, row.value) }));
    switch (view) {
      case "region":
        return map(data.byRegion);
      case "area":
        return map(data.byArea);
      case "distributor":
        return (data.byDistributor as SosDistributorRow[]).map((row) => ({
          code: row.code,
          label: row.label,
          value: row.value,
          units: row.units,
          share: row.share,
          extra: `${row.regions} reg · ${row.areas} areas · ${row.products} prod`,
          deltaPct: deltaOf(row.code, row.value),
        }));
      case "product":
      default:
        return map(data.byProduct);
    }
  }, [data, view, comparison]);

  const maxValue = rows.reduce((max, row) => Math.max(max, row.value), 0) || 1;
  const showDelta = comparison != null;

  const tabs: { key: DetailView; label: string }[] = [
    { key: "product", label: "Product" },
    ...(singleRegion ? [] : [{ key: "region" as const, label: "Region" }]),
    { key: "area", label: "Area" },
    { key: "distributor", label: "Distributor" },
  ];

  return (
    <SectionCard
      title="Breakdown"
      icon={Table2}
      actions={
        <div className="flex flex-wrap items-center gap-1.5">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              aria-pressed={view === tab.key}
              onClick={() => onViewChange(tab.key)}
              className={chipClass(view === tab.key)}
            >
              {tab.label}
            </button>
          ))}
          <a
            href={`/api/employee-portals/source-of-sales/export?${exportQuery}`}
            className="ml-1 inline-flex items-center gap-1.5 border border-orange-300 bg-white px-3 py-1 text-xs font-bold text-orange-700 transition-colors hover:border-orange-500 hover:bg-orange-50"
          >
            <Download className="h-3 w-3" />
            Export workbook
          </a>
        </div>
      }
    >
      {rows.length === 0 ? (
        <div className="p-8 text-center text-sm font-semibold text-slate-400">No rows for this selection.</div>
      ) : (
        <>
          {/* Desktop table — fixed layout with a colgroup: it fits its card, it never scrolls sideways. */}
          <div className="hidden md:block">
            <table className="w-full table-fixed text-left text-sm">
              <colgroup>
                <col style={{ width: showDelta ? "32%" : "38%" }} />
                <col style={{ width: "28%" }} />
                <col style={{ width: showDelta ? "14%" : "18%" }} />
                <col style={{ width: showDelta ? "12%" : "16%" }} />
                {showDelta ? <col style={{ width: "14%" }} /> : null}
              </colgroup>
              <thead>
                <tr className={TABLE_HEAD_CLASS}>
                  <th className="px-4 py-2.5">{viewLabel(view)}</th>
                  <th className="px-4 py-2.5 text-right">Value</th>
                  <th className="px-4 py-2.5 text-right">Units</th>
                  <th className="px-4 py-2.5 text-right">Share</th>
                  {showDelta ? <th className="break-words px-4 py-2.5 text-right">{versusMonth(comparison?.previousPeriod)}</th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.code} className={`${TABLE_ROW_CLASS} align-top`}>
                    <td className="px-4 py-3">
                      <p className="break-words font-bold text-slate-900">{row.label}</p>
                      {row.extra ? <p className="break-words text-phx-xs font-semibold text-slate-500">{row.extra}</p> : null}
                    </td>
                    <td className="px-4 py-3">
                      <p className="break-words text-right text-phx-md font-black tabular-nums text-slate-900">{formatEgpFull(row.value)}</p>
                      <span className="mt-1.5 block">
                        <ProportionBar fraction={Math.max(row.value / maxValue, 0.015)} color="#F97316" />
                      </span>
                    </td>
                    <td className="break-words px-4 py-3 text-right tabular-nums text-slate-600">{formatNumber(row.units)}</td>
                    <td className="break-words px-4 py-3 text-right font-semibold tabular-nums text-slate-600">{formatPct(row.share)}</td>
                    {showDelta ? (
                      <td className="px-4 py-3 text-right">
                        {row.deltaPct != null ? <DeltaPill delta={row.deltaPct} /> : <span className="text-phx-xs text-slate-300">—</span>}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="space-y-2 p-3 md:hidden">
            {rows.map((row) => (
              <div key={row.code} className="border border-l-[3px] border-slate-200 border-l-orange-500 bg-white p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 break-words text-sm font-black text-slate-900">{row.label}</p>
                  {showDelta && row.deltaPct != null ? <DeltaPill delta={row.deltaPct} /> : null}
                </div>
                {row.extra ? <p className="break-words text-phx-xs font-semibold text-slate-500">{row.extra}</p> : null}
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <CardStat label="Value" value={formatEgp(row.value)} />
                  <CardStat label="Units" value={formatNumber(row.units)} />
                  <CardStat label="Share" value={formatPct(row.share)} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </SectionCard>
  );
}

function CardStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border border-slate-100 bg-slate-50 px-2 py-1.5">
      <p className="text-phx-xs font-black uppercase tracking-wide text-slate-500">{label}</p>
      <p className="break-words text-xs font-black tabular-nums text-slate-900">{value}</p>
    </div>
  );
}

function viewLabel(view: DetailView): string {
  switch (view) {
    case "region":
      return "Region";
    case "area":
      return "Area";
    case "distributor":
      return "Distributor";
    case "product":
    default:
      return "Product";
  }
}

function EmptyState({ isProductManager, hasPeriod, filtered }: { isProductManager: boolean; hasPeriod: boolean; filtered: boolean }) {
  const message = !hasPeriod
    ? "No sales month has been published yet."
    : filtered
      ? "No sales match these filters in this month. Reset the filters above, or pick another month."
      : isProductManager
        ? "No sales were recorded for your products in this month. If you expected some, your product list may not be set yet."
        : "No sales were recorded in your scope for this month.";
  return (
    <div className="flex flex-col items-center justify-center gap-3 border border-dashed border-slate-200 bg-white p-12 text-center">
      <span className="flex h-12 w-12 items-center justify-center bg-orange-50 text-orange-500 ring-1 ring-inset ring-orange-100">
        <BarChart3 className="h-5 w-5" />
      </span>
      <p className="max-w-md text-sm font-semibold text-slate-600">{message}</p>
    </div>
  );
}
