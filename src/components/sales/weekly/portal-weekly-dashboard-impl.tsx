"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  LabelList,
  Legend,
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
  CheckCircle2,
  Clock,
  Coins,
  Download,
  Layers,
  MapPin,
  Package,
  RefreshCw,
  RotateCcw,
  Sparkles,
  TrendingUp,
  Truck,
  Users,
} from "lucide-react";

import { MultiSelectFilter, type MultiSelectFilterMode } from "@/components/ui/multi-select-filter";
import { PortalWeeklyFieldForceView } from "@/components/sales/weekly/portal-weekly-field-force-view";
import type {
  PortalWeeklyComparison,
  PortalWeeklyScopeView,
} from "@/lib/sales/weekly/portal-weekly-dashboard";
import type { PortalWeeklyFieldForce } from "@/lib/sales/weekly/portal-weekly-field-force";
import type { WeeklyDashboard, WeeklyRanked } from "@/lib/sales/weekly/types";

type Props = {
  initialData: WeeklyDashboard;
  scope: PortalWeeklyScopeView;
  initialComparison: PortalWeeklyComparison | null;
  initialFieldForce: PortalWeeklyFieldForce | null;
};

/**
 * Which tab is showing. "field" is the DEFAULT by the owner's instruction (2026-09-01): opening
 * Weekly Sales must land on the medical reps, because that is what the screen is read for. The
 * distributor view it used to open on is still one click away and is otherwise unchanged.
 */
type WeeklyTab = "field" | "distribution";

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
function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}
function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
function formatWeekLabel(weekStart: string, weekNumber: number | null, cycleMonth: string | null): string {
  if (weekNumber && cycleMonth) {
    const match = /^(\d{4})-(\d{2})-01$/.exec(cycleMonth);
    if (match) {
      const date = new Date(Number(match[1]), Number(match[2]) - 1, 1);
      const monthShort = date.toLocaleDateString("en-US", { month: "short" });
      return `W${weekNumber} ${monthShort}`;
    }
  }
  // Fallback to short date
  const d = new Date(weekStart);
  return isNaN(d.getTime()) ? weekStart : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function formatCycleMonth(code: string): string {
  const match = /^(\d{4})-(\d{2})-01$/.exec(code);
  if (!match) return code;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

type MultiKey = "months" | "weeks" | "regions" | "products" | "lines" | "distributors";
type DetailView = "product" | "region" | "distributor";

const EMPTY_SELECTION: string[] = [];
const EMPTY_INT_SELECTION: string[] = [];

type CachedPayload = {
  data: WeeklyDashboard;
  comparison: PortalWeeklyComparison | null;
  fieldForce: PortalWeeklyFieldForce | null;
};

export function PortalWeeklyDashboard({ initialData, scope, initialComparison, initialFieldForce }: Props) {
  const vis = scope.visibility;

  const [data, setData] = useState<WeeklyDashboard>(initialData);
  const [comparison, setComparison] = useState<PortalWeeklyComparison | null>(initialComparison);
  const [fieldForce, setFieldForce] = useState<PortalWeeklyFieldForce | null>(initialFieldForce);
  const [activeTab, setActiveTab] = useState<WeeklyTab>("field");
  const [loading, setLoading] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  const [selection, setSelection] = useState<Record<MultiKey, string[]>>({
    months: EMPTY_SELECTION,
    weeks: EMPTY_INT_SELECTION,
    regions: EMPTY_SELECTION,
    products: EMPTY_SELECTION,
    lines: EMPTY_SELECTION,
    distributors: EMPTY_SELECTION,
  });
  const [modes, setModes] = useState<Record<MultiKey, MultiSelectFilterMode>>({
    months: "include",
    weeks: "include",
    regions: "include",
    products: "include",
    lines: "include",
    distributors: "include",
  });

  const [view, setView] = useState<DetailView>(scope.isSingleRegion ? "product" : "product");

  const firstRun = useRef(true);
  const cacheRef = useRef<Map<string, CachedPayload>>(new Map());

  const setSel = (key: MultiKey, next: string[]) => setSelection((prev) => ({ ...prev, [key]: next }));
  const setMode = (key: MultiKey, next: MultiSelectFilterMode) => setModes((prev) => ({ ...prev, [key]: next }));

  const buildQuery = useCallback((): string => {
    const params = new URLSearchParams();
    const addList = (paramKey: string, modeKey: string, key: MultiKey) => {
      const sel = selection[key];
      if (sel.length > 0) {
        params.set(paramKey, sel.join(","));
        if (modes[key] === "exclude") params.set(modeKey, "exclude");
      }
    };
    addList("months", "monthsMode", "months");
    addList("weeks", "weeksMode", "weeks");
    if (vis.distributor) addList("distributors", "distributorsMode", "distributors");
    if (vis.region) addList("regions", "regionsMode", "regions");
    if (vis.product) addList("products", "productsMode", "products");
    if (vis.line) addList("lines", "linesMode", "lines");
    return params.toString();
  }, [selection, modes, vis]);

  useEffect(() => {
    const query = buildQuery();
    if (firstRun.current) {
      firstRun.current = false;
      cacheRef.current.set(query, {
        data: initialData,
        comparison: initialComparison,
        fieldForce: initialFieldForce,
      });
      return;
    }

    const cached = cacheRef.current.get(query);
    if (cached) {
      setData(cached.data);
      setComparison(cached.comparison);
      setFieldForce(cached.fieldForce);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/employee-portals/weekly-sales?${query}`, {
          signal: controller.signal,
        });
        const json = await response.json();
        if (json?.success && json.data) {
          const payload: CachedPayload = {
            data: json.data as WeeklyDashboard,
            comparison: (json.comparison ?? null) as PortalWeeklyComparison | null,
            fieldForce: (json.fieldForce ?? null) as PortalWeeklyFieldForce | null,
          };
          cacheRef.current.set(query, payload);
          setData(payload.data);
          setComparison(payload.comparison);
          setFieldForce(payload.fieldForce);
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.error("Failed to refresh Weekly Sales", error);
        }
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [buildQuery, initialData, initialComparison, initialFieldForce, refreshTick]);

  const refresh = () => {
    cacheRef.current.clear();
    setRefreshTick((tick) => tick + 1);
  };

  const toggleFilter = (key: MultiKey, code: string | undefined) => {
    if (!code) return;
    const visKey = key === "regions" ? "region" : key === "products" ? "product" : key === "distributors" ? "distributor" : null;
    if (visKey && !vis[visKey]) return;
    setMode(key, "include");
    setSelection((prev) => {
      const current = prev[key];
      const next = current.includes(code) ? current.filter((v) => v !== code) : [...current, code];
      return { ...prev, [key]: next };
    });
  };

  const activeFilterCount =
    selection.months.length +
    selection.weeks.length +
    (vis.region ? selection.regions.length : 0) +
    (vis.product ? selection.products.length : 0) +
    (vis.distributor ? selection.distributors.length : 0) +
    (vis.line ? selection.lines.length : 0);

  const resetFilters = () =>
    setSelection({ months: [], weeks: [], regions: [], products: [], lines: [], distributors: [] });

  const monthOptions = useMemo(
    () => data.availableMonths.map((m) => ({ code: m.code, label: m.name })),
    [data.availableMonths],
  );
  const weekOptions = useMemo(
    () => data.availableWeekNumbers.map((n) => ({ code: String(n), label: `Week ${n}` })),
    [data.availableWeekNumbers],
  );
  const regionOptions = useMemo(
    () => data.availableRegions.map((r) => ({ code: r.code, label: r.name })),
    [data.availableRegions],
  );
  const productOptions = useMemo(
    () => data.availableProducts.map((p) => ({ code: p.code, label: p.name })),
    [data.availableProducts],
  );
  const lineOptions = useMemo(
    () => data.availableLines.map((l) => ({ code: l, label: l })),
    [data.availableLines],
  );
  const distributorOptions = useMemo(
    () => data.distributors.map((d) => ({ code: d.code, label: d.name })),
    [data.distributors],
  );

  const isEmpty = data.kpis.salesValue === 0 && data.kpis.salesUnits === 0;
  const isProductScoped = scope.role === "Product Manager" || scope.role === "Group Product Manager";

  // Upload status chip — derived from sources vs distributors list
  const uploadedCount = new Set(data.sources.map((s) => s.distributorCode)).size;
  const totalDistributors = data.distributors.length;
  const allUploaded = totalDistributors > 0 && uploadedCount >= totalDistributors;

  // The filter bar governs BOTH tabs, so it is defined once and rendered inside each. Rendering it
  // here rather than above the tab content keeps the Distribution tab's own order (KPIs, then
  // filters) exactly as it shipped — the owner asked for a new default tab, not a re-laid-out old one.
  const filtersSection = (
          <Section
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
              <MultiSelectFilter
                label="Month"
                icon={<CalendarRange className="h-3 w-3" />}
                options={monthOptions}
                selected={selection.months}
                mode={modes.months}
                onSelectedChange={(n) => setSel("months", n)}
                onModeChange={(m) => setMode("months", m)}
              />
              <MultiSelectFilter
                label="Week"
                icon={<CalendarRange className="h-3 w-3" />}
                options={weekOptions}
                selected={selection.weeks}
                mode={modes.weeks}
                onSelectedChange={(n) => setSel("weeks", n)}
                onModeChange={(m) => setMode("weeks", m)}
              />
              {vis.line ? (
                <MultiSelectFilter
                  label="Line"
                  icon={<Layers className="h-3 w-3" />}
                  options={lineOptions}
                  selected={selection.lines}
                  mode={modes.lines}
                  onSelectedChange={(n) => setSel("lines", n)}
                  onModeChange={(m) => setMode("lines", m)}
                />
              ) : null}
              {vis.region ? (
                <MultiSelectFilter
                  label="Region"
                  icon={<MapPin className="h-3 w-3" />}
                  options={regionOptions}
                  selected={selection.regions}
                  mode={modes.regions}
                  onSelectedChange={(n) => setSel("regions", n)}
                  onModeChange={(m) => setMode("regions", m)}
                />
              ) : null}
              {vis.product ? (
                <MultiSelectFilter
                  label="Product"
                  icon={<Package className="h-3 w-3" />}
                  options={productOptions}
                  selected={selection.products}
                  mode={modes.products}
                  onSelectedChange={(n) => setSel("products", n)}
                  onModeChange={(m) => setMode("products", m)}
                />
              ) : null}
              {vis.distributor ? (
                <MultiSelectFilter
                  label="Distributor"
                  icon={<Truck className="h-3 w-3" />}
                  options={distributorOptions}
                  selected={selection.distributors}
                  mode={modes.distributors}
                  onSelectedChange={(n) => setSel("distributors", n)}
                  onModeChange={(m) => setMode("distributors", m)}
                />
              ) : null}
            </div>
          </Section>
  );

  return (
    <div className="space-y-5">
      {/* Scope bar */}
      <div className="flex flex-col gap-3 rounded-sm border border-slate-200 bg-white px-4 py-3 shadow-[0_10px_30px_rgba(15,23,42,0.05)] ring-1 ring-slate-200/60 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="h-9 w-[3px] shrink-0 bg-orange-500" />
          <div className="min-w-0">
            <p className="text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-400">Your scope</p>
            <p className="whitespace-nowrap text-sm font-black text-slate-900">{scope.scopeSummary}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-sm border border-slate-200 bg-white px-2.5 py-1.5 text-phx-2xs font-black uppercase tracking-wide text-slate-700 transition hover:border-orange-300 hover:text-orange-600 disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            Sync now
          </button>
          {totalDistributors > 0 ? (
            <span
              className={`hidden items-center gap-1.5 whitespace-nowrap rounded-sm border px-2.5 py-1 text-phx-2xs font-black uppercase tracking-wide sm:inline-flex ${
                allUploaded
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-amber-200 bg-amber-50 text-amber-700"
              }`}
            >
              {allUploaded ? <CheckCircle2 className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
              {uploadedCount}/{totalDistributors} uploaded
            </span>
          ) : null}
          {loading ? (
            <span className="flex items-center gap-1.5 text-phx-2xs font-bold uppercase tracking-wide text-orange-600">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-orange-500" />
              Updating
            </span>
          ) : null}
        </div>
      </div>

      {/* Tabs. Field Force is the default landing view — see WeeklyTab. */}
      <WeeklyTabBar active={activeTab} onChange={setActiveTab} repCount={fieldForce?.totals.repsWithSales ?? 0} />

      {isEmpty ? (
        <EmptyState isProductScoped={isProductScoped} isEmpty={data.scopeEmpty} />
      ) : activeTab === "field" ? (
        <>
          {filtersSection}
          <PortalWeeklyFieldForceView fieldForce={fieldForce} scopeSummary={scope.scopeSummary} />
        </>
      ) : (
        <>
          {/* KPI strip */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
            <StatTile
              accent="#F97316"
              icon={Coins}
              label="Sales Value"
              value={formatEgp(data.kpis.salesValue)}
              delta={
                comparison
                  ? (() => {
                      const prevTotal = Object.values(comparison.prevValueByCode.product).reduce((a, b) => a + b, 0);
                      return prevTotal > 0 ? (data.kpis.salesValue - prevTotal) / prevTotal : null;
                    })()
                  : null
              }
            />
            <StatTile accent="#0EA5E9" icon={Boxes} label="Sales Units" value={formatNumber(data.kpis.salesUnits)} sub="net of returns" />
            <StatTile accent="#8B5CF6" icon={Package} label="Stock Units" value={formatNumber(data.kpis.stockUnits)} />
            <StatTile accent="#22C55E" icon={Truck} label="Distributors" value={formatNumber(data.kpis.distributorCount)} />
            <StatTile accent="#F59E0B" icon={MapPin} label="Regions" value={formatNumber(data.kpis.regionCount)} />
            <StatTile accent="#14B8A6" icon={Layers} label="Products" value={formatNumber(data.kpis.productCount)} />
          </div>

          {filtersSection}

          {/* Top movers */}
          {comparison && (comparison.gainers.length > 0 || comparison.decliners.length > 0) ? (
            <MoversStrip comparison={comparison} />
          ) : null}

          {/* Charts */}
          <div className="space-y-4">
            {/* Trend — full width */}
            <Section title="Value trend · de-cumulated weeks">
              <div className="h-72 w-full">
                <WeeklyTrendChart trend={data.trend} />
              </div>
            </Section>

            {/* Cross-month week comparison — full width, below trend */}
            <Section title="Week comparison · same week across months">
              <div className="h-72 w-full">
                <WeekCrossMonthChart weekComparison={data.weekComparison} />
              </div>
            </Section>

            {/* Ranked breakdown charts */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <Section title="Top products">
                <div className="h-60 w-full">
                  <RankedBars
                    rows={data.products}
                    gradientId="barWeekProducts"
                    from="#F97316"
                    labelColor="#C2410C"
                    selected={selection.products}
                    onSelect={(code) => toggleFilter("products", code)}
                  />
                </div>
              </Section>
              {scope.isSingleRegion ? (
                // DSM: a single region bar is meaningless — widen the distributor chart
                <Section title="By distributor" className="lg:col-span-2">
                  <div className="h-60 w-full">
                    <RankedBars
                      rows={data.distributorBreakdown}
                      gradientId="barWeekDistributorsDsm"
                      from="#8B5CF6"
                      labelColor="#6D28D9"
                      selected={selection.distributors}
                      onSelect={(code) => toggleFilter("distributors", code)}
                    />
                  </div>
                </Section>
              ) : (
                <>
                  <Section title="By region">
                    <div className="h-60 w-full">
                      <RankedBars
                        rows={data.regions}
                        gradientId="barWeekRegions"
                        from="#0EA5E9"
                        labelColor="#0369A1"
                        selected={selection.regions}
                        onSelect={vis.region ? (code) => toggleFilter("regions", code) : undefined}
                      />
                    </div>
                  </Section>
                  <Section title="By distributor">
                    <div className="h-60 w-full">
                      <RankedBars
                        rows={data.distributorBreakdown}
                        gradientId="barWeekDistributors"
                        from="#8B5CF6"
                        labelColor="#6D28D9"
                        selected={selection.distributors}
                        onSelect={(code) => toggleFilter("distributors", code)}
                      />
                    </div>
                  </Section>
                </>
              )}
            </div>
          </div>

          {/* Detail breakdown */}
          <WeeklyDetailSection
            data={data}
            view={view}
            onViewChange={setView}
            comparison={comparison}
            exportQuery={buildQuery()}
            singleRegion={scope.isSingleRegion}
          />

          {/* Completeness tracker */}
          <CompletenessTracker data={data} />
        </>
      )}
    </div>
  );
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

/**
 * The two views of one week's sales.
 *
 * "Field Force" leads because it answers the question the screen is opened for — how each medical
 * rep is doing, week by week, per product. "Distribution" is the original dashboard: the same
 * numbers cut by distributor, region and product, which is the supply-side view of the same sheet.
 */
function WeeklyTabBar({
  active,
  onChange,
  repCount,
}: {
  active: WeeklyTab;
  onChange: (next: WeeklyTab) => void;
  repCount: number;
}) {
  const tabs: { key: WeeklyTab; label: string; hint: string; icon: typeof Users }[] = [
    { key: "field", label: "Field Force", hint: "Reps week by week, per product", icon: Users },
    { key: "distribution", label: "Distribution", hint: "Distributors, regions and products", icon: Truck },
  ];
  return (
    <div className="overflow-hidden rounded-sm border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.05)] ring-1 ring-slate-200/60">
      <div className="flex flex-col sm:flex-row">
        {tabs.map((tab) => {
          const isActive = active === tab.key;
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => onChange(tab.key)}
              aria-current={isActive ? "page" : undefined}
              className={`relative flex flex-1 items-center gap-3 px-4 py-3 text-left transition ${
                isActive ? "bg-slate-900" : "bg-white hover:bg-slate-50"
              }`}
            >
              <span
                className={`absolute inset-x-0 bottom-0 h-0.5 transition-all ${
                  isActive ? "bg-orange-500" : "bg-transparent"
                }`}
              />
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-sm ${
                  isActive ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-400"
                }`}
              >
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span
                  className={`block whitespace-nowrap text-sm font-black tracking-tight ${
                    isActive ? "text-white" : "text-slate-900"
                  }`}
                >
                  {tab.label}
                </span>
                <span
                  className={`block whitespace-nowrap text-phx-2xs font-bold uppercase tracking-wide ${
                    isActive ? "text-slate-400" : "text-slate-400"
                  }`}
                >
                  {tab.key === "field" && repCount > 0 ? `${repCount} reps selling` : tab.hint}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Primitives ───────────────────────────────────────────────────────────────

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
          <h2 className="whitespace-nowrap text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-200">{title}</h2>
        </div>
        {action ?? <span className="h-1.5 w-10 bg-orange-500/80" />}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

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
        <p className="mt-2.5 whitespace-nowrap text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">{label}</p>
        <p className="mt-0.5 whitespace-nowrap text-lg font-black tabular-nums tracking-tight text-slate-900 sm:text-xl">{value}</p>
        {sub ? <p className="mt-0.5 whitespace-nowrap text-phx-2xs font-semibold text-slate-400">{sub}</p> : null}
      </div>
    </div>
  );
}

function DeltaPill({ delta }: { delta: number }) {
  const up = delta >= 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-sm px-1.5 py-0.5 text-phx-2xs font-black tabular-nums ${
        up ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
      }`}
    >
      <Icon className="h-3 w-3" />
      {`${up ? "+" : ""}${(delta * 100).toFixed(1)}%`}
    </span>
  );
}

function NoData() {
  return <div className="flex h-full items-center justify-center text-xs font-semibold text-slate-400">No data for this selection.</div>;
}

// ── Top movers ───────────────────────────────────────────────────────────────
function MoversStrip({ comparison }: { comparison: PortalWeeklyComparison }) {
  const hasMovers = comparison.gainers.length > 0 || comparison.decliners.length > 0;
  if (!hasMovers) return null;
  return (
    <Section title="Insights · vs last month" action={<Sparkles className="h-3.5 w-3.5 text-orange-400" />}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {comparison.gainers.length > 0 ? (
          <MoverList title="Top gainers" tone="up" movers={comparison.gainers} />
        ) : null}
        {comparison.decliners.length > 0 ? (
          <MoverList title="Top decliners" tone="down" movers={comparison.decliners} />
        ) : null}
      </div>
    </Section>
  );
}

function MoverList({ title, tone, movers }: { title: string; tone: "up" | "down"; movers: PortalWeeklyComparison["gainers"] }) {
  if (movers.length === 0) return null;
  return (
    <div className="rounded-sm border border-slate-200 bg-white p-3">
      <p className="mb-2 flex items-center gap-1.5 text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">
        {tone === "up" ? <ArrowUpRight className="h-3 w-3 text-emerald-600" /> : <ArrowDownRight className="h-3 w-3 text-rose-600" />}
        {title} · vs last month
      </p>
      <div className="space-y-1.5">
        {movers.map((mover) => (
          <div key={mover.code} className="flex items-center justify-between gap-3">
            <span className="whitespace-nowrap text-xs font-bold text-slate-800">{mover.label}</span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="whitespace-nowrap text-phx-xs tabular-nums text-slate-500">{formatEgp(mover.value)}</span>
              <DeltaPill delta={mover.deltaPct} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Charts ───────────────────────────────────────────────────────────────────
function PremiumTooltip({
  active,
  payload,
  label,
  valueOnly,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; payload?: { label?: string } }>;
  label?: string;
  valueOnly?: boolean;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const title = label ?? payload[0]?.payload?.label ?? payload[0]?.name ?? "";
  return (
    <div className="rounded-sm border border-slate-700 bg-slate-900 px-3 py-2 shadow-xl">
      {title ? <p className="mb-0.5 text-phx-2xs font-black uppercase tracking-wide text-slate-400">{title}</p> : null}
      {payload.map((entry, index) => (
        <p key={index} className="whitespace-nowrap text-xs font-black tabular-nums text-white">
          {valueOnly ? "" : `${entry.name}: `}
          {formatEgpFull(Number(entry.value ?? 0))}
        </p>
      ))}
    </div>
  );
}

function WeeklyTrendChart({ trend }: { trend: WeeklyDashboard["trend"] }) {
  const points = trend.map((point) => ({
    label: formatWeekLabel(point.weekStart, point.weekNumber, point.cycleMonth),
    value: point.salesValue,
  }));
  if (points.length === 0) return <NoData />;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={points} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="weeklyTrend" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#F97316" stopOpacity={0.32} />
            <stop offset="100%" stopColor="#F97316" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#94A3B8" }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
        <YAxis
          tickFormatter={(value) => formatEgp(Number(value)).replace("EGP ", "")}
          tick={{ fontSize: 11, fill: "#94A3B8" }}
          axisLine={false}
          tickLine={false}
          width={46}
        />
        <Tooltip content={<PremiumTooltip valueOnly />} cursor={{ stroke: "#F97316", strokeOpacity: 0.2 }} />
        <Area type="monotone" dataKey="value" stroke="#F97316" strokeWidth={2.5} fill="url(#weeklyTrend)" dot={{ r: 3, fill: "#F97316", strokeWidth: 0 }} activeDot={{ r: 5 }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function WeekCrossMonthChart({ weekComparison }: { weekComparison: WeeklyDashboard["weekComparison"] }) {
  if (weekComparison.length === 0) return <NoData />;

  // Derive distinct months sorted chronologically, take last 2 (prior + current)
  const allMonths = [...new Set(weekComparison.map((r) => r.cycleMonth).filter(Boolean) as string[])].sort();
  const months = allMonths.slice(-2);
  if (months.length === 0) return <NoData />;

  const monthShort = (code: string): string => {
    const match = /^(\d{4})-(\d{2})-01$/.exec(code);
    if (!match) return code;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, 1);
    return date.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  };

  const labels = months.map(monthShort);
  // Prior month = slate, current month = orange
  const MONTH_COLORS = ["#94A3B8", "#F97316"];
  const LABEL_COLORS = ["#64748B", "#C2410C"];

  // Build W1–W4 rows; a row with all zeros is shown as 0 but not hidden
  const chartData = [1, 2, 3, 4].map((wn) => {
    const row: Record<string, string | number> = { week: `W${wn}` };
    months.forEach((m, i) => {
      const entry = weekComparison.find((r) => r.weekNumber === wn && r.cycleMonth === m);
      row[labels[i] as string] = entry?.salesValue ?? 0;
    });
    return row;
  });

  const hasAnyData = chartData.some((row) => labels.some((l) => (row[l] as number) > 0));
  if (!hasAnyData) return <NoData />;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={chartData} margin={{ top: 28, right: 16, bottom: 4, left: 0 }} barCategoryGap="28%" barGap={5}>
        <defs>
          {months.map((_, i) => (
            <linearGradient key={i} id={`barCrossMonth${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={MONTH_COLORS[i]} stopOpacity={1} />
              <stop offset="100%" stopColor={MONTH_COLORS[i]} stopOpacity={0.35} />
            </linearGradient>
          ))}
        </defs>
        <XAxis
          dataKey="week"
          tick={{ fontSize: 12, fill: "#1E293B", fontWeight: 800 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis type="number" hide />
        <Tooltip content={<PremiumTooltip />} cursor={{ fill: "#F9731612" }} />
        <Legend
          wrapperStyle={{ fontSize: 10, fontWeight: 700, paddingTop: 8 }}
          formatter={(value: string) => <span style={{ color: "#475569" }}>{value}</span>}
        />
        {labels.map((label, i) => (
          <Bar key={label} dataKey={label} fill={`url(#barCrossMonth${i})`} radius={[5, 5, 2, 2]} isAnimationActive>
            <LabelList
              dataKey={label}
              position="top"
              formatter={(value) => (Number(value) > 0 ? formatEgp(Number(value)).replace("EGP ", "") : "")}
              style={{ fontSize: 9, fontWeight: 800, fill: LABEL_COLORS[i] }}
            />
          </Bar>
        ))}
      </BarChart>
    </ResponsiveContainer>
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
  rows: WeeklyRanked[];
  gradientId: string;
  from: string;
  labelColor: string;
  selected?: string[];
  onSelect?: (code: string | undefined) => void;
}) {
  const top = rows.slice(0, 8).map((row) => ({ label: row.name, value: row.salesValue, code: row.code }));
  if (top.length === 0) return <NoData />;
  const selectedSet = new Set(selected ?? []);
  const clickable = Boolean(onSelect);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={top} layout="vertical" margin={{ top: 2, right: 56, bottom: 2, left: 4 }} barCategoryGap="22%">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={from} stopOpacity={1} />
            <stop offset="60%" stopColor={from} stopOpacity={0.55} />
            <stop offset="100%" stopColor={from} stopOpacity={0.08} />
          </linearGradient>
        </defs>
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="label"
          width={104}
          tick={{ fontSize: 10, fill: "#475569", fontWeight: 600 }}
          axisLine={false}
          tickLine={false}
        />
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

// ── Detail breakdown ─────────────────────────────────────────────────────────
type DetailRow = { code: string; label: string; value: number; units: number; share: number; deltaPct: number | null };

function WeeklyDetailSection({
  data,
  view,
  onViewChange,
  comparison,
  exportQuery,
  singleRegion,
}: {
  data: WeeklyDashboard;
  view: DetailView;
  onViewChange: (next: DetailView) => void;
  comparison: PortalWeeklyComparison | null;
  exportQuery: string;
  singleRegion: boolean;
}) {
  const rows: DetailRow[] = useMemo(() => {
    const prevByCode = comparison?.prevValueByCode[view] ?? {};
    const deltaOf = (code: string, value: number): number | null => {
      const prev = prevByCode[code];
      return prev != null && prev > 0 ? (value - prev) / prev : null;
    };
    const map = (list: WeeklyRanked[]): DetailRow[] =>
      list.map((row) => ({
        code: row.code,
        label: row.name,
        value: row.salesValue,
        units: row.salesUnits,
        share: row.share,
        deltaPct: deltaOf(row.code, row.salesValue),
      }));
    switch (view) {
      case "region":
        return map(data.regions);
      case "distributor":
        return map(data.distributorBreakdown);
      case "product":
      default:
        return map(data.products);
    }
  }, [data, view, comparison]);

  const maxValue = rows.reduce((max, row) => Math.max(max, row.value), 0) || 1;
  const showDelta = comparison != null;

  const tabs: { key: DetailView; label: string }[] = [
    { key: "product", label: "Product" },
    ...(singleRegion ? [] : [{ key: "region" as const, label: "Region" }]),
    { key: "distributor", label: "Distributor" },
  ];

  const viewLabel = (v: DetailView): string => {
    if (v === "region") return "Region";
    if (v === "distributor") return "Distributor";
    return "Product";
  };

  return (
    <div className="overflow-hidden rounded-sm border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.05)] ring-1 ring-slate-200/60">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-slate-900 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-3.5 w-[3px] bg-orange-500" />
          <h2 className="text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-200">Breakdown</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-sm border border-slate-700">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => onViewChange(tab.key)}
                className={`whitespace-nowrap px-2.5 py-1 text-phx-2xs font-black uppercase tracking-wide transition ${
                  view === tab.key ? "bg-orange-500 text-white" : "bg-slate-800 text-slate-300 hover:text-white"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <a
            href={`/api/employee-portals/weekly-sales/export?${exportQuery}`}
            className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-slate-600 bg-white px-2.5 text-phx-2xs font-black uppercase tracking-wide text-slate-900 transition hover:border-orange-400 hover:text-orange-600"
          >
            <Download className="h-3 w-3" />
            Export
          </a>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="p-8 text-center text-sm font-semibold text-slate-400">No rows for this selection.</div>
      ) : (
        <>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-phx-2xs uppercase tracking-[0.12em] text-slate-500">
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
                    <td className="whitespace-nowrap px-4 py-2.5 font-bold text-slate-900">{row.label}</td>
                    <td className="px-4 py-2">
                      <div className="relative ml-auto flex h-7 w-48 max-w-full items-center justify-end overflow-hidden rounded-sm">
                        <span
                          className="absolute inset-y-0 left-0 rounded-sm"
                          style={{
                            width: `${Math.max((row.value / maxValue) * 100, 1.5)}%`,
                            background: "linear-gradient(90deg, #EA580C 0%, rgba(249,115,22,0.45) 62%, rgba(249,115,22,0.06) 100%)",
                          }}
                        />
                        <span className="relative z-10 whitespace-nowrap pr-2 text-right text-phx-md font-black tabular-nums text-slate-900">
                          {formatEgpFull(row.value)}
                        </span>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-slate-600">{formatNumber(row.units)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums font-semibold text-slate-600">{formatPct(row.share)}</td>
                    {showDelta ? (
                      <td className="whitespace-nowrap px-4 py-2.5 text-right">
                        {row.deltaPct != null ? <DeltaPill delta={row.deltaPct} /> : <span className="text-phx-xs text-slate-300">—</span>}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="space-y-2 p-3 md:hidden">
            {rows.map((row) => (
              <div key={row.code} className="flex overflow-hidden rounded-sm border border-slate-200 bg-white">
                <span className="w-[3px] shrink-0 bg-orange-500" />
                <div className="min-w-0 flex-1 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="whitespace-nowrap text-sm font-black text-slate-900">{row.label}</p>
                    {showDelta && row.deltaPct != null ? <DeltaPill delta={row.deltaPct} /> : null}
                  </div>
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
      <p className="whitespace-nowrap text-phx-3xs font-black uppercase tracking-wide text-slate-400">{label}</p>
      <p className="whitespace-nowrap text-xs font-black tabular-nums text-slate-900">{value}</p>
    </div>
  );
}

// ── Completeness tracker ──────────────────────────────────────────────────────
function CompletenessTracker({ data }: { data: WeeklyDashboard }) {
  // Build a Set of "distributorCode-cycleMonth-weekNumber" keys from sources
  const uploadedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const s of data.sources) {
      if (s.cycleMonth && s.weekNumber != null) {
        keys.add(`${s.distributorCode}-${s.cycleMonth}-${s.weekNumber}`);
      }
    }
    return keys;
  }, [data.sources]);

  // Only show tracker when we have month + distributor context
  const months = useMemo(
    () => [...new Set(data.sources.map((s) => s.cycleMonth).filter(Boolean) as string[])].sort().reverse().slice(0, 3),
    [data.sources],
  );

  if (data.distributors.length === 0 || months.length === 0) return null;

  const weeks = [1, 2, 3, 4];

  return (
    <Section title="Upload completeness · current period">
      {/* Mobile: per-distributor completeness cards (wide matrix is desktop-only) */}
      <div className="space-y-2 md:hidden">
        {data.distributors.map((dist) => (
          <div className="border border-slate-100 bg-white px-3 py-2.5" key={`m-${dist.code}`}>
            <p className="text-phx-md font-semibold text-slate-800">{dist.name}</p>
            <div className="mt-2 space-y-1.5">
              {months.map((m) => {
                const done = weeks.filter((w) => uploadedKeys.has(`${dist.code}-${m}-${w}`)).length;
                return (
                  <div className="flex items-center justify-between gap-2" key={`m-${dist.code}-${m}`}>
                    <span className="text-phx-xs font-medium text-slate-500">{formatCycleMonth(m).slice(0, 3)}</span>
                    <div className="flex items-center gap-1">
                      {weeks.map((w) => {
                        const uploaded = uploadedKeys.has(`${dist.code}-${m}-${w}`);
                        return (
                          <span
                            className={`inline-flex h-5 w-5 items-center justify-center rounded-sm text-phx-2xs font-black ${
                              uploaded ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-400"
                            }`}
                            key={w}
                            title={`W${w} ${uploaded ? "Uploaded" : "Pending"}`}
                          >
                            {uploaded ? "✓" : "·"}
                          </span>
                        );
                      })}
                      <span className="ml-1 text-phx-xs font-bold text-slate-600 tabular-nums">{done}/4</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Desktop: full matrix */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-phx-2xs uppercase tracking-wide text-slate-500">
              <th className="whitespace-nowrap px-3 py-2 font-black">Distributor</th>
              {months.map((m) =>
                weeks.map((w) => (
                  <th key={`${m}-w${w}`} className="whitespace-nowrap px-2 py-2 text-center font-black">
                    {`${formatCycleMonth(m).slice(0, 3)} W${w}`}
                  </th>
                )),
              )}
            </tr>
          </thead>
          <tbody>
            {data.distributors.map((dist) => (
              <tr key={dist.code} className="border-b border-slate-100">
                <td className="whitespace-nowrap px-3 py-2 font-semibold text-slate-800">{dist.name}</td>
                {months.map((m) =>
                  weeks.map((w) => {
                    const key = `${dist.code}-${m}-${w}`;
                    const uploaded = uploadedKeys.has(key);
                    return (
                      <td key={key} className="px-2 py-2 text-center">
                        <span
                          className={`inline-flex h-5 w-5 items-center justify-center rounded-sm text-phx-2xs font-black ${
                            uploaded ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-400"
                          }`}
                          title={uploaded ? "Uploaded" : "Pending"}
                        >
                          {uploaded ? "✓" : "·"}
                        </span>
                      </td>
                    );
                  }),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-phx-xs font-semibold text-slate-400">
        Advisory only — based on validated batches. Green = uploaded; gray = not yet uploaded for that period.
      </p>
    </Section>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────
function EmptyState({ isProductScoped, isEmpty }: { isProductScoped: boolean; isEmpty?: boolean }) {
  const message = isEmpty
    ? "No products are assigned to your account yet — ask an admin to configure your product scope."
    : isProductScoped
      ? "No weekly sales were recorded for your assigned products and this selection."
      : "No weekly sales were recorded for this selection.";
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-sm border border-dashed border-slate-200 bg-white p-12 text-center shadow-[0_10px_30px_rgba(15,23,42,0.04)]">
      <span className="flex h-12 w-12 items-center justify-center rounded-sm bg-orange-50 text-orange-500 ring-1 ring-orange-100">
        <TrendingUp className="h-5 w-5" />
      </span>
      <p className="max-w-md text-sm font-semibold text-slate-600">{message}</p>
    </div>
  );
}
