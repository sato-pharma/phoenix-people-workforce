"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  LabelList,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ArrowDownRight,
  ArrowUpRight,
  Boxes,
  CalendarRange,
  Coins,
  Download,
  Gauge,
  Layers,
  MapPin,
  Package,
  RefreshCw,
  RotateCcw,
  Sparkles,
  TrendingUp,
  Truck,
} from "lucide-react";

import { MultiSelectFilter, type MultiSelectFilterMode } from "@/components/ui/multi-select-filter";
import type { DistributorUploadStatus } from "@/lib/sales/monthly-distributor-import";
import type { PortalSosComparison, PortalSosScopeView } from "@/lib/sales/portal-sos-dashboard";
import type {
  SosDashboardData,
  SosDistributorRow,
  SosGroupRow,
  SosOption,
} from "@/lib/sales/sos-dashboard";

type Props = {
  initialData: SosDashboardData;
  scope: PortalSosScopeView;
  initialComparison: PortalSosComparison | null;
  initialUploadStatus: DistributorUploadStatus | null;
};

// Categorical palette — orange-led, premium and high-contrast on white.
const CHART_COLORS = ["#F97316", "#0EA5E9", "#22C55E", "#8B5CF6", "#F59E0B", "#EF4444", "#14B8A6", "#6366F1"];

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
function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
function formatPeriod(period: string | null): string {
  if (!period) return "—";
  const match = /^(\d{4})-(\d{2})$/.exec(period.trim());
  if (!match) return period;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  return date.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

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
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.error("Failed to refresh Source of Sales", error);
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
  // Period-over-period delta for the headline value (trend is ascending; last = selected period).
  const valueDelta = useMemo(() => {
    const t = data.trend;
    if (t.length < 2) return null;
    const prev = t[t.length - 2]?.value ?? 0;
    const cur = t[t.length - 1]?.value ?? 0;
    if (prev <= 0) return null;
    return (cur - prev) / prev;
  }, [data.trend]);

  const isEmpty = data.period === null || summary.totalValue <= 0;
  const isProductManager = scope.role === "Product Manager" || scope.role === "Group Product Manager";

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

      {isEmpty ? (
        <EmptyState isProductManager={isProductManager} hasPeriod={data.period !== null} />
      ) : (
        <>
          {/* KPI strip */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
            <StatTile accent="#F97316" icon={Coins} label="Total Value" value={formatEgp(summary.totalValue)} delta={valueDelta} />
            <StatTile accent="#0EA5E9" icon={Boxes} label="Units Sold" value={formatNumber(summary.totalUnits)} sub="net of bonus" />
            <StatTile accent="#8B5CF6" icon={Gauge} label="Avg / Unit" value={formatEgpFull(summary.avgPricePerUnit)} />
            <StatTile accent="#22C55E" icon={Truck} label="Distributors" value={formatNumber(summary.distributorCount)} sub={`${formatNumber(summary.productCount)} products`} />
            <StatTile accent="#F59E0B" icon={Layers} label="Direct Share" value={formatPct(summary.directShare)} sub="vs distributor" />
            <StatTile accent="#14B8A6" icon={MapPin} label="Area Coverage" value={`${formatNumber(summary.areasReached)}/${formatNumber(summary.totalAreas)}`} sub="areas reached" />
          </div>

          {/* Filters */}
          <Section
            title="Filters"
            overflowVisible
            action={
              activeFilterCount > 0 ? (
                <button
                  type="button"
                  onClick={resetFilters}
                  className="inline-flex items-center gap-1.5 rounded-sm bg-white/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-white transition hover:bg-orange-500"
                >
                  <RotateCcw className="h-3 w-3" />
                  Reset {activeFilterCount}
                </button>
              ) : (
                <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">No filters applied</span>
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

          {/* Insights + top movers */}
          {data.insights.length > 0 || (comparison && (comparison.gainers.length > 0 || comparison.decliners.length > 0)) ? (
            <InsightsStrip insights={data.insights} comparison={comparison} />
          ) : null}

          {/* Charts (click a bar to filter by it) */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Section title="Value trend · last 6 months" className="lg:col-span-2">
              <div className="h-60 w-full">
                <TrendChart trend={data.trend} />
              </div>
            </Section>
            <Section title="Channel mix">
              <div className="h-60 w-full">
                <DonutChart slices={data.channelMix} total={summary.totalValue} />
              </div>
            </Section>
            <Section title="Top products">
              <div className="h-60 w-full">
                <RankedBars rows={data.byProduct} gradientId="barProducts" from="#F97316" labelColor="#C2410C" selected={selection.products} onSelect={(code) => toggleFilter("products", code)} />
              </div>
            </Section>
            {scope.isSingleRegion ? (
              // Single-region viewer (DSM): one region vs itself is meaningless, so this slot becomes
              // a vertical "By area" chart of the areas inside his region.
              <Section title="By area">
                <div className="h-60 w-full">
                  <ColumnBars rows={data.byArea} gradientId="barAreasCol" from="#14B8A6" labelColor="#0F766E" selected={selection.areas} onSelect={(code) => toggleFilter("areas", code)} />
                </div>
              </Section>
            ) : (
              <Section title="By region">
                <div className="h-60 w-full">
                  <RankedBars rows={data.byRegion} gradientId="barRegions" from="#0EA5E9" labelColor="#0369A1" selected={selection.regions} onSelect={vis.region ? (code) => toggleFilter("regions", code) : undefined} />
                </div>
              </Section>
            )}
            <Section title="By distributor">
              <div className="h-60 w-full">
                <RankedBars rows={data.byDistributor} gradientId="barDistributors" from="#8B5CF6" labelColor="#6D28D9" selected={selection.distributors} onSelect={(code) => toggleFilter("distributors", code)} />
              </div>
            </Section>
            {scope.isSingleRegion ? null : (
              // Multi-region viewer (RM/NSM/PM/GPM/MM): keep "By region" above and add a full-width
              // horizontal "By area" — many areas read best wide, with the full list in the table below.
              <Section title="By area" className="lg:col-span-3">
                <div className="h-60 w-full">
                  <RankedBars rows={data.byArea} gradientId="barAreas" from="#14B8A6" labelColor="#0F766E" selected={selection.areas} onSelect={(code) => toggleFilter("areas", code)} />
                </div>
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
function formatStamp(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("en-US", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
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
  return (
    <div className="flex flex-col gap-3 rounded-sm border border-slate-200 bg-white px-4 py-3 shadow-[0_10px_30px_rgba(15,23,42,0.05)] ring-1 ring-slate-200/60 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <span className="h-9 w-[3px] shrink-0 bg-orange-500" />
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">Your scope</p>
          <p className="whitespace-nowrap text-sm font-black text-slate-900">{scopeSummary}</p>
          {stamp ? <p className="whitespace-nowrap text-[10px] font-semibold text-slate-400">Data as of {stamp}</p> : null}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-sm border border-slate-200 bg-white px-2.5 py-1.5 text-[10px] font-black uppercase tracking-wide text-slate-700 transition hover:border-orange-300 hover:text-orange-600 disabled:opacity-50"
          title="Sync now — pull the latest uploaded sales"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          Sync now
        </button>
        {uploadStatus && uploadStatus.expectedCount > 0 ? (
          <span
            className={`hidden items-center gap-1.5 whitespace-nowrap rounded-sm border px-2.5 py-1 text-[10px] font-black uppercase tracking-wide sm:inline-flex ${
              uploadStatus.awaitingCount > 0
                ? "border-amber-200 bg-amber-50 text-amber-700"
                : "border-emerald-200 bg-emerald-50 text-emerald-700"
            }`}
            title={uploadStatus.awaitingCount > 0 ? `${uploadStatus.awaitingCount} distributor(s) haven't uploaded for this period yet` : "All distributors uploaded"}
          >
            <Truck className="h-3 w-3" />
            {uploadStatus.uploadedCount}/{uploadStatus.expectedCount} uploaded
            {uploadStatus.awaitingCount > 0 ? ` · ${uploadStatus.awaitingCount} awaiting` : ""}
          </span>
        ) : null}
        {loading ? (
          <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-orange-600">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-orange-500" />
            Updating
          </span>
        ) : null}
        <label className="flex items-center gap-2 rounded-sm border border-slate-200 bg-slate-50 px-3 py-1.5">
          <CalendarRange className="h-3.5 w-3.5 text-slate-400" />
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

// ── Premium section shell (slate-900 header strip + orange tick) ────────────────────
function Section({
  title,
  action,
  className,
  overflowVisible,
  children,
}: {
  title: string;
  action?: ReactNode;
  className?: string;
  /** Let absolutely-positioned children (filter dropdowns) escape the card instead of being clipped. */
  overflowVisible?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`rounded-sm border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.05)] ring-1 ring-slate-200/60 ${
        overflowVisible ? "relative z-30 overflow-visible" : "overflow-hidden"
      } ${className ?? ""}`}
    >
      <div className="flex items-center justify-between gap-3 rounded-t-sm border-b border-slate-800 bg-slate-900 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-3.5 w-[3px] bg-orange-500" />
          <h2 className="whitespace-nowrap text-[10px] font-black uppercase tracking-[0.18em] text-slate-200">{title}</h2>
        </div>
        {action ?? <span className="h-1.5 w-10 bg-orange-500/80" />}
      </div>
      <div className="p-4">{children}</div>
    </div>
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
}: {
  accent: string;
  icon: typeof Coins;
  label: string;
  value: string;
  sub?: string;
  delta?: number | null;
}) {
  return (
    <div className="group relative overflow-hidden rounded-sm border border-slate-200 bg-white shadow-[0_8px_22px_rgba(15,23,42,0.04)] ring-1 ring-slate-200/60 transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_16px_34px_rgba(15,23,42,0.08)]">
      <span className="absolute inset-x-0 top-0 h-1 transition-all duration-200 group-hover:h-1.5" style={{ backgroundColor: accent }} />
      <div className="p-3.5 sm:p-4">
        <div className="flex items-center justify-between">
          <span className="flex h-7 w-7 items-center justify-center rounded-sm" style={{ backgroundColor: `${accent}1A`, color: accent }}>
            <Icon className="h-3.5 w-3.5" />
          </span>
          {delta != null ? <DeltaPill delta={delta} /> : null}
        </div>
        <p className="mt-2.5 whitespace-nowrap text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">{label}</p>
        <p className="mt-0.5 whitespace-nowrap text-lg font-black tabular-nums tracking-tight text-slate-900 sm:text-xl">{value}</p>
        {sub ? <p className="mt-0.5 whitespace-nowrap text-[10px] font-semibold text-slate-400">{sub}</p> : null}
      </div>
    </div>
  );
}

function DeltaPill({ delta }: { delta: number }) {
  const up = delta >= 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-sm px-1.5 py-0.5 text-[10px] font-black tabular-nums ${
        up ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
      }`}
    >
      <Icon className="h-3 w-3" />
      {`${up ? "+" : ""}${(delta * 100).toFixed(1)}%`}
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
    neutral: "border-slate-200 bg-slate-50 text-slate-700",
    success: "border-emerald-200 bg-emerald-50 text-emerald-800",
    warning: "border-amber-200 bg-amber-50 text-amber-800",
    danger: "border-rose-200 bg-rose-50 text-rose-800",
  };
  const hasMovers = comparison && (comparison.gainers.length > 0 || comparison.decliners.length > 0);
  return (
    <Section title="Insights" action={<Sparkles className="h-3.5 w-3.5 text-orange-400" />}>
      {hasMovers ? (
        <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <MoverList title="Top gainers" tone="up" movers={comparison!.gainers} />
          <MoverList title="Top decliners" tone="down" movers={comparison!.decliners} />
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {insights.slice(0, 6).map((insight, index) => (
          <div key={index} className={`flex items-start gap-2 rounded-sm border px-3 py-2 ${toneClass[insight.tone] ?? toneClass.neutral}`}>
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-60" />
            <p className="text-xs font-semibold leading-relaxed">{insight.text}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

function MoverList({ title, tone, movers }: { title: string; tone: "up" | "down"; movers: PortalSosComparison["gainers"] }) {
  if (movers.length === 0) return null;
  return (
    <div className="rounded-sm border border-slate-200 bg-white p-3">
      <p className="mb-2 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-slate-400">
        {tone === "up" ? <ArrowUpRight className="h-3 w-3 text-emerald-600" /> : <ArrowDownRight className="h-3 w-3 text-rose-600" />}
        {title} · vs last month
      </p>
      <div className="space-y-1.5">
        {movers.map((mover) => (
          <div key={mover.code} className="flex items-center justify-between gap-3">
            <span className="whitespace-nowrap text-xs font-bold text-slate-800">{mover.label}</span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="whitespace-nowrap text-[11px] tabular-nums text-slate-500">{formatEgp(mover.value)}</span>
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
    <div className="rounded-sm border border-slate-700 bg-slate-900 px-3 py-2 shadow-xl">
      {title ? <p className="mb-0.5 text-[10px] font-black uppercase tracking-wide text-slate-400">{title}</p> : null}
      {payload.map((entry, index) => (
        <p key={index} className="whitespace-nowrap text-xs font-black tabular-nums text-white">
          {valueOnly ? "" : `${entry.name}: `}
          {formatEgpFull(Number(entry.value ?? 0))}
        </p>
      ))}
    </div>
  );
}

function TrendChart({ trend }: { trend: SosDashboardData["trend"] }) {
  const points = trend.map((point) => ({ label: formatPeriod(point.period), value: point.value }));
  if (points.length === 0) return <NoData />;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={points} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="sosTrend" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#F97316" stopOpacity={0.32} />
            <stop offset="100%" stopColor="#F97316" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#94A3B8" }} axisLine={false} tickLine={false} />
        <YAxis tickFormatter={(value) => formatEgp(Number(value)).replace("EGP ", "")} tick={{ fontSize: 11, fill: "#94A3B8" }} axisLine={false} tickLine={false} width={46} />
        <Tooltip content={<PremiumTooltip valueOnly />} cursor={{ stroke: "#F97316", strokeOpacity: 0.2 }} />
        <Area type="monotone" dataKey="value" stroke="#F97316" strokeWidth={2.5} fill="url(#sosTrend)" dot={{ r: 3, fill: "#F97316", strokeWidth: 0 }} activeDot={{ r: 5 }} />
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
          <Pie data={slices} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="86%" paddingAngle={3} stroke="none">
            {slices.map((slice, index) => (
              <Cell key={slice.name} fill={CHART_COLORS[index % CHART_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip content={<PremiumTooltip />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <p className="text-[10px] font-black uppercase tracking-wide text-slate-400">Total</p>
        <p className="text-base font-black tabular-nums text-slate-900">{formatEgp(total)}</p>
      </div>
    </div>
  );
}

function RankedBars({
  rows,
  gradientId,
  from,
  labelColor,
  selected,
  onSelect,
}: {
  rows: SosGroupRow[];
  gradientId: string;
  from: string;
  labelColor: string;
  selected?: string[];
  onSelect?: (code: string | undefined) => void;
}) {
  const top = rows.slice(0, 8).map((row) => ({ label: row.label, value: row.value, code: row.code }));
  if (top.length === 0) return <NoData />;
  const selectedSet = new Set(selected ?? []);
  const clickable = Boolean(onSelect);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={top} layout="vertical" margin={{ top: 2, right: 56, bottom: 2, left: 4 }} barCategoryGap="22%">
        <defs>
          {/* Excel-style data-bar fade: solid hue on the left → transparent on the right. */}
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={from} stopOpacity={1} />
            <stop offset="60%" stopColor={from} stopOpacity={0.55} />
            <stop offset="100%" stopColor={from} stopOpacity={0.08} />
          </linearGradient>
        </defs>
        <XAxis type="number" hide />
        <YAxis type="category" dataKey="label" width={104} tick={{ fontSize: 10, fill: "#475569", fontWeight: 600 }} axisLine={false} tickLine={false} />
        <Tooltip content={<PremiumTooltip valueOnly />} cursor={{ fill: `${from}12` }} />
        <Bar
          dataKey="value"
          radius={[2, 6, 6, 2]}
          fill={`url(#${gradientId})`}
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
              fill={`url(#${gradientId})`}
              stroke={selectedSet.has(entry.code) ? from : undefined}
              strokeWidth={selectedSet.has(entry.code) ? 2 : 0}
            />
          ))}
          <LabelList
            dataKey="value"
            position="right"
            formatter={(value) => formatEgp(Number(value)).replace("EGP ", "")}
            style={{ fontSize: 10, fontWeight: 800, fill: labelColor }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// Vertical column variant — used for the DSM "By area" chart (few areas within one region read
// better as upright columns than horizontal bars). Same premium gradient + click-to-filter as
// RankedBars. Bars fade top→base; value labels sit above each column.
function ColumnBars({
  rows,
  gradientId,
  from,
  labelColor,
  selected,
  onSelect,
}: {
  rows: SosGroupRow[];
  gradientId: string;
  from: string;
  labelColor: string;
  selected?: string[];
  onSelect?: (code: string | undefined) => void;
}) {
  const top = rows.slice(0, 8).map((row) => ({ label: row.label, value: row.value, code: row.code }));
  if (top.length === 0) return <NoData />;
  const selectedSet = new Set(selected ?? []);
  const clickable = Boolean(onSelect);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={top} margin={{ top: 18, right: 8, bottom: 4, left: 0 }} barCategoryGap="22%">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={from} stopOpacity={1} />
            <stop offset="62%" stopColor={from} stopOpacity={0.55} />
            <stop offset="100%" stopColor={from} stopOpacity={0.1} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="label"
          tick={{ fontSize: 10, fill: "#475569", fontWeight: 600 }}
          axisLine={false}
          tickLine={false}
          interval={0}
          angle={-20}
          textAnchor="end"
          height={52}
        />
        <YAxis type="number" hide />
        <Tooltip content={<PremiumTooltip valueOnly />} cursor={{ fill: `${from}12` }} />
        <Bar
          dataKey="value"
          radius={[6, 6, 2, 2]}
          fill={`url(#${gradientId})`}
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
              fill={`url(#${gradientId})`}
              stroke={selectedSet.has(entry.code) ? from : undefined}
              strokeWidth={selectedSet.has(entry.code) ? 2 : 0}
            />
          ))}
          <LabelList
            dataKey="value"
            position="top"
            formatter={(value) => formatEgp(Number(value)).replace("EGP ", "")}
            style={{ fontSize: 10, fontWeight: 800, fill: labelColor }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

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
    <div className="overflow-hidden rounded-sm border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.05)] ring-1 ring-slate-200/60">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-slate-900 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-3.5 w-[3px] bg-orange-500" />
          <h2 className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-200">Breakdown</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-sm border border-slate-700">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => onViewChange(tab.key)}
                className={`whitespace-nowrap px-2.5 py-1 text-[10px] font-black uppercase tracking-wide transition ${
                  view === tab.key ? "bg-orange-500 text-white" : "bg-slate-800 text-slate-300 hover:text-white"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <a
            href={`/api/employee-portals/source-of-sales/export?${exportQuery}`}
            className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-slate-600 bg-white px-2.5 text-[10px] font-black uppercase tracking-wide text-slate-900 transition hover:border-orange-400 hover:text-orange-600"
          >
            <Download className="h-3 w-3" />
            Export workbook
          </a>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="p-8 text-center text-sm font-semibold text-slate-400">No rows for this selection.</div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-[10px] uppercase tracking-[0.12em] text-slate-500">
                  <th className="px-4 py-2.5 font-black">{viewLabel(view)}</th>
                  <th className="px-4 py-2.5 text-right font-black">Value</th>
                  <th className="px-4 py-2.5 text-right font-black">Units</th>
                  <th className="px-4 py-2.5 text-right font-black">Share</th>
                  {showDelta ? <th className="px-4 py-2.5 text-right font-black">Δ vs last</th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.code} className="border-b border-slate-100 transition hover:bg-orange-50/40">
                    <td className="whitespace-nowrap px-4 py-2.5 font-bold text-slate-900">
                      {row.label}
                      {row.extra ? <span className="ml-2 text-[11px] font-semibold text-slate-400">{row.extra}</span> : null}
                    </td>
                    <td className="px-4 py-2">
                      <div className="relative ml-auto flex h-7 w-48 max-w-full items-center justify-end overflow-hidden rounded-sm">
                        <span
                          className="absolute inset-y-0 left-0 rounded-sm"
                          style={{
                            width: `${Math.max((row.value / maxValue) * 100, 1.5)}%`,
                            background: "linear-gradient(90deg, #EA580C 0%, rgba(249,115,22,0.45) 62%, rgba(249,115,22,0.06) 100%)",
                          }}
                        />
                        <span className="relative z-10 whitespace-nowrap pr-2 text-right text-[13px] font-black tabular-nums text-slate-900">
                          {formatEgpFull(row.value)}
                        </span>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-slate-600">{formatNumber(row.units)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums font-semibold text-slate-600">{formatPct(row.share)}</td>
                    {showDelta ? (
                      <td className="whitespace-nowrap px-4 py-2.5 text-right">
                        {row.deltaPct != null ? <DeltaPill delta={row.deltaPct} /> : <span className="text-[11px] text-slate-300">—</span>}
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
              <div key={row.code} className="flex overflow-hidden rounded-sm border border-slate-200 bg-white">
                <span className="w-[3px] shrink-0 bg-orange-500" />
                <div className="min-w-0 flex-1 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="whitespace-nowrap text-sm font-black text-slate-900">{row.label}</p>
                    {showDelta && row.deltaPct != null ? <DeltaPill delta={row.deltaPct} /> : null}
                  </div>
                  {row.extra ? <p className="whitespace-nowrap text-[11px] font-semibold text-slate-400">{row.extra}</p> : null}
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <CardStat label="Value" value={formatEgp(row.value)} />
                    <CardStat label="Units" value={formatNumber(row.units)} />
                    <CardStat label="Share" value={formatPct(row.share)} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function CardStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm border border-slate-100 bg-slate-50 px-2 py-1.5">
      <p className="whitespace-nowrap text-[9px] font-black uppercase tracking-wide text-slate-400">{label}</p>
      <p className="whitespace-nowrap text-xs font-black tabular-nums text-slate-900">{value}</p>
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

function EmptyState({ isProductManager, hasPeriod }: { isProductManager: boolean; hasPeriod: boolean }) {
  const message = !hasPeriod
    ? "No sales periods have been published yet."
    : isProductManager
      ? "No products are assigned to you yet — ask an admin to set your product scope, or no sales were recorded for this selection."
      : "No sales were recorded for this period and selection.";
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-sm border border-dashed border-slate-200 bg-white p-12 text-center shadow-[0_10px_30px_rgba(15,23,42,0.04)]">
      <span className="flex h-12 w-12 items-center justify-center rounded-sm bg-orange-50 text-orange-500 ring-1 ring-orange-100">
        <TrendingUp className="h-5 w-5" />
      </span>
      <p className="max-w-md text-sm font-semibold text-slate-600">{message}</p>
    </div>
  );
}
