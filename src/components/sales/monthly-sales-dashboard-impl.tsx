"use client";

import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Banknote,
  BarChart3,
  Boxes,
  CalendarRange,
  Download,
  Filter,
  Gauge,
  Layers,
  Lightbulb,
  Loader2,
  Minus,
  PackageSearch,
  RotateCcw,
  Target,
  TrendingUp,
  Trophy,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminStatCard,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { SafeResponsiveContainer } from "@/components/charts/safe-responsive-container";
import {
  MultiSelectFilter,
  type MultiSelectFilterMode,
} from "@/components/ui/multi-select-filter";
import {
  SortableTh,
  TableNoResults,
  TableSearchInput,
  useSortableTable,
  visibleMax,
} from "@/components/ui/sortable-table";
import { formatCurrency, formatNumber, formatPercent, formatUnits } from "@/lib/sales/format";
import { periodProseLabel } from "@/lib/sales/periods";
import type { SalesDashboardData, SalesTrendPoint } from "@/lib/sales/types";

// ---------------------------------------------------------------------------
// Local shapes - the service returns Record<string, any> for several slices, so
// we describe just the fields this view reads. Business rules (ownership, access
// scoping, restricted products, targets) all live in getSalesDashboard().
// ---------------------------------------------------------------------------

type ChannelSlice = { name: string; value: number };
type FamilyRow = { name: string; sales: number; target: number; achievementRate: number; units: number; status: string };
type TerritoryRow = { name: string; sales: number; target: number; achievementRate: number };
type LineRow = { line: string; sales: number; target: number; achievementRate: number; linkedEmployees: number };
type ManagerRow = {
  manager: string;
  line: string;
  sales: number;
  target: number;
  achievementRate: number;
  topProduct: string;
  retailSales: number;
  storesSales: number;
};
type ProductRow = { product: string; family: string; sales: number; target: number; achievementRate: number };
type ParetoRow = { name: string; sales: number; cumulativePercent: number };
type AnomalyRow = { label: string; detail: string; score: number };

type Filters = {
  periods: string[];
  products: string[];
  line: string;
  salesType: string;
  manager: string;
  territory: string;
  family: string;
};

const EMPTY_FILTERS: Filters = {
  periods: [],
  products: [],
  line: "",
  salesType: "",
  manager: "",
  territory: "",
  family: "",
};

const CHANNEL_COLORS = ["#F97316", "#0EA5E9", "#8B5CF6", "#10B981", "#F43F5E", "#FACC15", "#64748B", "#14B8A6"];

function compactEGP(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `EGP ${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `EGP ${(value / 1_000).toFixed(0)}K`;
  return formatCurrency(value);
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

// Empty selection => "All". exclude mode => everything except the picked codes.
function effectiveList(all: string[], selected: string[], mode: MultiSelectFilterMode): string[] {
  if (selected.length === 0) return [];
  if (mode === "include") return selected;
  const skip = new Set(selected);
  return all.filter((code) => !skip.has(code));
}

function achievementTone(rate: number): "emerald" | "orange" | "rose" {
  if (rate >= 1) return "emerald";
  if (rate >= 0.8) return "orange";
  return "rose";
}

function Delta({ ratio, suffix }: { ratio: number | null; suffix: string }) {
  if (ratio === null || !Number.isFinite(ratio)) {
    return (
      <span className="inline-flex items-center gap-1 text-slate-400">
        <Minus className="h-3 w-3" /> no prior month
      </span>
    );
  }
  const up = ratio >= 0;
  const Icon = ratio === 0 ? Minus : up ? ArrowUpRight : ArrowDownRight;
  const color = ratio === 0 ? "text-slate-400" : up ? "text-emerald-600" : "text-rose-600";
  return (
    <span className={`inline-flex items-center gap-1 font-bold ${color}`}>
      <Icon className="h-3 w-3" />
      {formatPercent(Math.abs(ratio), { digits: 1 })} {suffix}
    </span>
  );
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
    <div
      className={`rounded-2xl border border-slate-200/90 bg-white/95 p-5 shadow-[0_12px_30px_rgba(15,23,42,0.06)] ${className ?? ""}`}
    >
      <div className="mb-4 flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-orange-50 to-orange-100 text-orange-600">
          {icon}
        </span>
        <div>
          <h3 className="text-sm font-black tracking-tight text-slate-900">{title}</h3>
          <p className="text-xs text-slate-500">{subtitle}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

function CurrencyTooltip({ active, payload, label }: { active?: boolean; payload?: Array<Record<string, unknown>>; label?: unknown }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-xl">
      <p className="mb-1 text-phx-sm font-black uppercase tracking-wider text-slate-400">{String(label ?? "")}</p>
      <div className="space-y-1.5">
        {payload.map((entry, index) => {
          const name = String(entry.name ?? "");
          const raw = Number(entry.value ?? 0);
          const isPercent = /%|achiev/i.test(name);
          return (
            <div key={index} className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: String(entry.color ?? "#94A3B8") }} />
                <span className="text-phx-xs font-bold text-slate-600">{name}:</span>
              </div>
              <span className="text-phx-xs font-black text-slate-900">
                {isPercent ? formatPercent(raw, { digits: 1 }) : formatCurrency(raw)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  icon,
  value,
  options,
  optionLabels,
  onChange,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  options: string[];
  /** Option value → what the user reads, where the value is a key (the Manager filter's names). */
  optionLabels?: Record<string, string>;
  onChange: (next: string) => void;
}) {
  return (
    <label className="flex h-[58px] cursor-pointer flex-col justify-center rounded-[6px] border border-phx-line bg-white px-3 py-2 shadow-sm transition focus-within:border-phx-accent-line hover:border-phx-accent-line">
      <span className="mb-1 flex items-center gap-1.5 text-phx-sm font-black uppercase tracking-[0.14em] text-phx-ink-faint">
        {icon}
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full truncate bg-transparent text-sm font-black text-phx-ink outline-none"
      >
        <option value="">All</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {optionLabels?.[option] ?? option}
          </option>
        ))}
      </select>
    </label>
  );
}

function AchievementBadge({ rate }: { rate: number }) {
  const tone = achievementTone(rate);
  const cls = {
    emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    orange: "bg-orange-50 text-orange-700 ring-orange-200",
    rose: "bg-rose-50 text-rose-700 ring-rose-200",
  }[tone];
  return (
    <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-black ring-1 ring-inset ${cls}`}>
      {formatPercent(rate, { digits: 0 })}
    </span>
  );
}

function Bar2({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
      <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
    </div>
  );
}

export function MonthlySalesDashboard({
  initialData,
  initialError,
}: {
  initialData: SalesDashboardData | null;
  initialError: string | null;
}) {
  const [data, setData] = useState<SalesDashboardData | null>(initialData);
  const [error, setError] = useState<string | null>(initialError);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [periodMode, setPeriodMode] = useState<MultiSelectFilterMode>("include");
  const [productMode, setProductMode] = useState<MultiSelectFilterMode>("include");

  // Stable, full option lists captured once from the unfiltered server load. The per-request
  // `data.filters` narrows with the slice, so we never source the dropdowns from it. Lazy state
  // init keeps this fixed for the component's lifetime without reading a ref during render.
  const [options] = useState(
    () =>
      initialData?.filters ?? {
        lines: [],
        periods: [],
        salesTypes: [],
        managers: [],
        managerLabels: {},
        territories: [],
        products: [],
        families: [],
      },
  );
  const sortedPeriodOptions = useMemo(() => [...options.periods].sort().reverse(), [options.periods]);

  const effectivePeriods = useMemo(
    () => effectiveList(options.periods, filters.periods, periodMode),
    [options.periods, filters.periods, periodMode],
  );
  const effectiveProducts = useMemo(
    () => effectiveList(options.products, filters.products, productMode),
    [options.products, filters.products, productMode],
  );

  const queryKey = useMemo(() => {
    const params = new URLSearchParams();
    if (filters.line) params.set("line", filters.line);
    if (filters.salesType) params.set("salesType", filters.salesType);
    if (filters.manager) params.set("manager", filters.manager);
    if (filters.territory) params.set("territory", filters.territory);
    if (filters.family) params.set("family", filters.family);
    if (effectivePeriods.length) params.set("periods", effectivePeriods.join(","));
    if (effectiveProducts.length) params.set("products", effectiveProducts.join(","));
    return params.toString();
  }, [filters, effectivePeriods, effectiveProducts]);

  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    fetch(`/api/sales/monthly-dashboard?${queryKey}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = (await response.json()) as { success: boolean; data?: SalesDashboardData; error?: string };
        if (!response.ok || !payload.success || !payload.data) {
          throw new Error(payload.error ?? "Failed to load monthly sales dashboard.");
        }
        setData(payload.data);
        setError(null);
      })
      .catch((fetchError: unknown) => {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") return;
        setError(fetchError instanceof Error ? fetchError.message : "Failed to load monthly sales dashboard.");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [queryKey]);

  const handleExport = async () => {
    setDownloading(true);
    try {
      const response = await fetch(`/api/sales/monthly-dashboard/export?${queryKey}`, { cache: "no-store" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
        throw new Error(payload?.message ?? payload?.error ?? "Export failed.");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = match?.[1] ?? "phoenix-monthly-sales-dashboard.xlsx";
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

  const summary = (data?.summary ?? {}) as Record<string, number | string>;
  const trend = useMemo(
    () => [...asArray<SalesTrendPoint>(data?.trend)].sort((a, b) => a.period.localeCompare(b.period)),
    [data?.trend],
  );
  const channelMix = asArray<ChannelSlice>(data?.channelMix);
  const familyMatrix = asArray<FamilyRow>(data?.familyMatrix);
  const territories = asArray<TerritoryRow>(data?.territories);
  const linePerformance = asArray<LineRow>(data?.linePerformance);
  const managerPerformance = asArray<ManagerRow>(data?.managerPerformance);
  const productPerformance = asArray<ProductRow>(data?.productPerformance);
  const pareto = asArray<ParetoRow>(data?.pareto);
  const anomalies = asArray<AnomalyRow>(data?.anomalies);

  // Month-over-month deltas from the last two points of the (possibly filtered) trend.
  const last = trend.at(-1);
  const prev = trend.at(-2);
  const ratio = (a: number | undefined, b: number | undefined): number | null =>
    a === undefined || b === undefined || b === 0 ? null : (a - b) / b;
  const salesDelta = ratio(last?.sales, prev?.sales);
  const achievementDelta = last && prev ? last.achievementRate - prev.achievementRate : null;
  const deltaSuffix = prev ? `vs ${periodProseLabel(prev.period)}` : "";

  const totalSales = Number(summary.totalApprovedSales ?? 0);
  const totalTarget = Number(summary.totalApprovedTarget ?? 0);
  const achievementRate = Number(summary.achievementRate ?? 0);
  const unitsSold = Number(summary.unitsSold ?? 0);
  const avgFactoryPrice = Number(summary.averageFactoryPrice ?? 0);
  const activeProducts = Number(summary.activeProducts ?? 0);
  const linkedEmployees = Number(summary.linkedEmployees ?? 0);
  const dataQuality = Number(summary.dataQualityRate ?? 0);
  const topManager = String(summary.topManager ?? "-");

  const trendChartData = useMemo(
    () =>
      trend.map((point) => ({
        period: periodProseLabel(point.period),
        Sales: Math.round(point.sales),
        Target: Math.round(point.target),
        "Achievement %": Math.round(point.achievementRate * 1000) / 10,
      })),
    [trend],
  );

  const paretoChartData = useMemo(
    () =>
      pareto.slice(0, 12).map((row) => ({
        name: row.name.length > 14 ? `${row.name.slice(0, 13)}...` : row.name,
        Sales: Math.round(row.sales),
        "Cumulative %": Math.round(row.cumulativePercent * 1000) / 10,
      })),
    [pareto],
  );

  const activeFilterCount =
    filters.periods.length +
    filters.products.length +
    [filters.line, filters.salesType, filters.manager, filters.territory, filters.family].filter(Boolean).length;

  const insights = useMemo(() => {
    const bullets: Array<{ tone: "success" | "warning" | "danger" | "neutral"; text: string }> = [];
    if (last) {
      bullets.push({
        tone: achievementRate >= 1 ? "success" : achievementRate >= 0.8 ? "warning" : "danger",
        text: `Overall achievement is ${formatPercent(achievementRate, { digits: 1 })} - ${formatCurrency(totalSales)} against a ${formatCurrency(totalTarget)} target.`,
      });
    }
    const topProductRow = productPerformance[0];
    if (topProductRow) {
      bullets.push({
        tone: "neutral",
        text: `Top product is ${topProductRow.product} (${topProductRow.family}) at ${formatCurrency(topProductRow.sales)}.`,
      });
    }
    const topTerritory = [...territories].sort((a, b) => b.sales - a.sales)[0];
    if (topTerritory) {
      bullets.push({ tone: "neutral", text: `Leading territory is ${topTerritory.name} with ${formatCurrency(topTerritory.sales)}.` });
    }
    const laggards = familyMatrix.filter((row) => row.target > 0 && row.achievementRate < 0.8);
    if (laggards.length > 0) {
      bullets.push({
        tone: "warning",
        text: `${laggards.length} famil${laggards.length === 1 ? "y is" : "ies are"} below 80% of target: ${laggards
          .slice(0, 3)
          .map((row) => row.name)
          .join(", ")}.`,
      });
    }
    if (salesDelta !== null) {
      bullets.push({
        tone: salesDelta >= 0 ? "success" : "danger",
        text: `Sales ${salesDelta >= 0 ? "grew" : "fell"} ${formatPercent(Math.abs(salesDelta), { digits: 1 })} ${deltaSuffix}.`,
      });
    }
    return bullets;
  }, [achievementRate, deltaSuffix, familyMatrix, last, productPerformance, salesDelta, territories, totalSales, totalTarget]);

  // -------------------------------------------------------------------------
  // Sortable tables
  // -------------------------------------------------------------------------
  const managerTable = useSortableTable<ManagerRow>(managerPerformance, {
    columns: [
      { key: "manager", accessor: (row) => row.manager, type: "string" },
      { key: "line", accessor: (row) => row.line, type: "string" },
      { key: "sales", accessor: (row) => row.sales, type: "number" },
      { key: "target", accessor: (row) => row.target, type: "number" },
      { key: "achievementRate", accessor: (row) => row.achievementRate, type: "number" },
    ],
    searchAccessors: [(row) => row.manager, (row) => row.line, (row) => row.topProduct],
    initialSort: { key: "sales", dir: "desc" },
  });
  const managerMax = visibleMax(managerTable.rows, (row) => row.sales);

  const productTable = useSortableTable<ProductRow>(productPerformance, {
    columns: [
      { key: "product", accessor: (row) => row.product, type: "string" },
      { key: "family", accessor: (row) => row.family, type: "string" },
      { key: "sales", accessor: (row) => row.sales, type: "number" },
      { key: "target", accessor: (row) => row.target, type: "number" },
      { key: "achievementRate", accessor: (row) => row.achievementRate, type: "number" },
    ],
    searchAccessors: [(row) => row.product, (row) => row.family],
    initialSort: { key: "sales", dir: "desc" },
  });
  const productMax = visibleMax(productTable.rows, (row) => row.sales);

  const lineTable = useSortableTable<LineRow>(linePerformance, {
    columns: [
      { key: "line", accessor: (row) => row.line, type: "string" },
      { key: "sales", accessor: (row) => row.sales, type: "number" },
      { key: "target", accessor: (row) => row.target, type: "number" },
      { key: "achievementRate", accessor: (row) => row.achievementRate, type: "number" },
      { key: "linkedEmployees", accessor: (row) => row.linkedEmployees, type: "number" },
    ],
    initialSort: { key: "sales", dir: "desc" },
  });
  const lineMax = visibleMax(lineTable.rows, (row) => row.sales);

  const familyMax = visibleMax(familyMatrix, (row) => row.sales);
  const territoryMax = visibleMax(territories, (row) => row.sales);

  const hasData = !error && trend.length > 0;

  return (
    <div className="space-y-6 pb-12">
      <AdminPageHero
        eyebrow="Sales Intelligence"
        icon={<CalendarRange className="h-4 w-4" />}
        title="Achievement Dashboard"
        description="Approved Source of Sales data — targets, channel mix, territories and trends, fully filterable across every dimension."
        actions={
          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={downloading || loading || !hasData}
            className="inline-flex items-center gap-1.5 rounded-[6px] border border-phx-accent bg-phx-accent px-3.5 py-2 text-sm font-black text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
            title="Download a detailed multi-sheet Excel workbook with the current filters applied"
          >
            {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {downloading ? "Preparing…" : "Export Detailed XLSX"}
          </button>
        }
        badges={
          <>
            <AdminInsightChip tone="orange">
              {effectivePeriods.length === 1
                ? periodProseLabel(effectivePeriods[0])
                : `${trend.length} month${trend.length === 1 ? "" : "s"}`}
            </AdminInsightChip>
            <AdminInsightChip tone="emerald">Achievement {formatPercent(achievementRate, { digits: 1 })}</AdminInsightChip>
            {loading ? <AdminInsightChip tone="slate">Updating...</AdminInsightChip> : null}
          </>
        }
        aside={
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-white/15 bg-white/10 px-4 py-3 backdrop-blur">
              <p className="text-phx-sm font-black uppercase tracking-[0.15em] text-slate-300">Total Sales</p>
              <p className="mt-1 text-xl font-black text-white">{compactEGP(totalSales)}</p>
            </div>
            <div className="rounded-xl border border-white/15 bg-white/10 px-4 py-3 backdrop-blur">
              <p className="text-phx-sm font-black uppercase tracking-[0.15em] text-slate-300">Top Manager</p>
              <p className="mt-1 truncate text-sm font-black text-white">{topManager}</p>
            </div>
          </div>
        }
      />

      {/* Filter bar */}
      <div className="rounded-2xl border border-slate-200/90 bg-white/95 p-4 shadow-[0_12px_30px_rgba(15,23,42,0.06)]">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-black text-slate-900">
            <Filter className="h-4 w-4 text-orange-500" />
            Filters
            {activeFilterCount > 0 ? (
              <span className="rounded-full bg-phx-warn-bg px-2 py-0.5 text-phx-xs font-black text-phx-warn">
                {activeFilterCount} active
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {activeFilterCount > 0 ? (
              <button
                type="button"
                onClick={() => {
                  setFilters(EMPTY_FILTERS);
                  setPeriodMode("include");
                  setProductMode("include");
                }}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-bold text-slate-600 transition hover:border-orange-300 hover:text-orange-600"
              >
                <RotateCcw className="h-3.5 w-3.5" /> Reset all
              </button>
            ) : null}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          <MultiSelectFilter
            label="Months"
            icon={<CalendarRange className="h-3 w-3" />}
            options={sortedPeriodOptions.map((code) => ({ code, label: periodProseLabel(code) }))}
            selected={filters.periods}
            mode={periodMode}
            onSelectedChange={(next) => setFilters((current) => ({ ...current, periods: next }))}
            onModeChange={setPeriodMode}
          />
          <FilterSelect
            label="Line"
            icon={<Layers className="h-3 w-3" />}
            value={filters.line}
            options={options.lines}
            onChange={(next) => setFilters((current) => ({ ...current, line: next }))}
          />
          <FilterSelect
            label="Sales Type"
            icon={<Activity className="h-3 w-3" />}
            value={filters.salesType}
            options={options.salesTypes}
            onChange={(next) => setFilters((current) => ({ ...current, salesType: next }))}
          />
          <FilterSelect
            label="Territory"
            icon={<BarChart3 className="h-3 w-3" />}
            value={filters.territory}
            options={options.territories}
            onChange={(next) => setFilters((current) => ({ ...current, territory: next }))}
          />
          <FilterSelect
            label="Manager"
            icon={<Users className="h-3 w-3" />}
            value={filters.manager}
            options={options.managers}
            optionLabels={options.managerLabels}
            onChange={(next) => setFilters((current) => ({ ...current, manager: next }))}
          />
          <MultiSelectFilter
            label="Products"
            icon={<PackageSearch className="h-3 w-3" />}
            options={options.products.map((code) => ({ code, label: code }))}
            selected={filters.products}
            mode={productMode}
            onSelectedChange={(next) => setFilters((current) => ({ ...current, products: next }))}
            onModeChange={setProductMode}
          />
          <FilterSelect
            label="Family"
            icon={<Boxes className="h-3 w-3" />}
            value={filters.family}
            options={options.families}
            onChange={(next) => setFilters((current) => ({ ...current, family: next }))}
          />
        </div>
      </div>

      {error ? (
        <AdminCallout tone="danger">
          <div>
            <p className="font-black">Could not load monthly sales data.</p>
            <p className="mt-1 text-sm">{error}</p>
          </div>
        </AdminCallout>
      ) : null}

      {!error && trend.length === 0 ? (
        <AdminCallout tone="neutral">
          <div>
            <p className="font-black">No approved sales for this selection.</p>
            <p className="mt-1 text-sm">Adjust the filters above or import and approve a monthly sales batch.</p>
          </div>
        </AdminCallout>
      ) : null}

      {hasData ? (
        <>
          {/* KPI grid */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <AdminStatCard
              tone="orange"
              icon={<Banknote className="h-5 w-5" />}
              label="Total Sales"
              value={compactEGP(totalSales)}
              description={`${formatCurrency(totalSales)}`}
            />
            <AdminStatCard
              tone="blue"
              icon={<Target className="h-5 w-5" />}
              label="Total Target"
              value={compactEGP(totalTarget)}
              description={formatCurrency(totalTarget)}
            />
            <AdminStatCard
              tone={achievementTone(achievementRate) === "rose" ? "rose" : achievementTone(achievementRate) === "orange" ? "orange" : "emerald"}
              icon={<Gauge className="h-5 w-5" />}
              label="Achievement"
              value={formatPercent(achievementRate, { digits: 1 })}
              description={achievementDelta === null ? "vs target" : `${achievementDelta >= 0 ? "+" : "-"} ${formatPercent(Math.abs(achievementDelta), { digits: 1 })} ${deltaSuffix}`}
            />
            <AdminStatCard
              tone="violet"
              icon={<Boxes className="h-5 w-5" />}
              label="Units Sold"
              value={formatNumber(unitsSold)}
              description="approved units"
            />
            <AdminStatCard
              tone="orange"
              icon={<TrendingUp className="h-5 w-5" />}
              label="MoM Sales"
              value={<Delta ratio={salesDelta} suffix="" />}
              description={deltaSuffix || "single month"}
            />
            <AdminStatCard
              tone="blue"
              icon={<PackageSearch className="h-5 w-5" />}
              label="Active Products"
              value={formatNumber(activeProducts)}
              description={`avg price ${compactEGP(avgFactoryPrice)}`}
            />
            <AdminStatCard
              tone="emerald"
              icon={<Users className="h-5 w-5" />}
              label="Linked Employees"
              value={formatNumber(linkedEmployees)}
              description="attributed reps"
            />
            <AdminStatCard
              tone={dataQuality >= 0.9 ? "emerald" : dataQuality >= 0.7 ? "orange" : "rose"}
              icon={<Trophy className="h-5 w-5" />}
              label="Data Quality"
              value={formatPercent(dataQuality, { digits: 0 })}
              description="DSM linkage rate"
            />
          </div>

          {/* Trend */}
          <ChartCard
            title="Monthly Sales vs Target"
            subtitle="Sales and target by month with achievement overlay"
            icon={<TrendingUp className="h-4 w-4" />}
          >
            <SafeResponsiveContainer minHeight={300}>
              <ComposedChart data={trendChartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                <XAxis dataKey="period" axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 700, fill: "#94A3B8" }} minTickGap={8} />
                <YAxis yAxisId="left" axisLine={false} tickLine={false} tick={{ fontSize: 9, fontWeight: 700, fill: "#94A3B8" }} width={44} tickFormatter={(v: number) => compactEGP(v)} />
                <YAxis yAxisId="right" orientation="right" axisLine={false} tickLine={false} tick={{ fontSize: 9, fontWeight: 700, fill: "#94A3B8" }} width={36} tickFormatter={(v: number) => `${v}%`} />
                <Tooltip content={<CurrencyTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11, fontWeight: 700 }} />
                <Bar yAxisId="left" dataKey="Target" fill="#CBD5E1" radius={[0, 0, 0, 0]} barSize={18} />
                <Bar yAxisId="left" dataKey="Sales" fill="#F97316" radius={[0, 0, 0, 0]} barSize={18} />
                <Line yAxisId="right" type="monotone" dataKey="Achievement %" stroke="#0EA5E9" strokeWidth={3} dot={{ r: 3, fill: "#0EA5E9" }} />
              </ComposedChart>
            </SafeResponsiveContainer>
          </ChartCard>

          {/* Channel mix + Family performance */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <ChartCard title="Channel Mix" subtitle="Sales value by sales type" icon={<Layers className="h-4 w-4" />}>
              {channelMix.length === 0 ? (
                <p className="py-10 text-center text-sm text-slate-400">No channel data.</p>
              ) : (
                <SafeResponsiveContainer minHeight={260}>
                  <PieChart>
                    <Pie
                      data={channelMix}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={55}
                      outerRadius={90}
                      paddingAngle={2}
                    >
                      {channelMix.map((slice, index) => (
                        <Cell key={slice.name} fill={CHANNEL_COLORS[index % CHANNEL_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip content={<CurrencyTooltip />} />
                    <Legend wrapperStyle={{ fontSize: 11, fontWeight: 700 }} />
                  </PieChart>
                </SafeResponsiveContainer>
              )}
            </ChartCard>

            <ChartCard
              title="Product Family Performance"
              subtitle="Sales by family with achievement"
              icon={<Boxes className="h-4 w-4" />}
              className="lg:col-span-2"
            >
              {familyMatrix.length === 0 ? (
                <p className="py-10 text-center text-sm text-slate-400">No family data.</p>
              ) : (
                <div className="space-y-3">
                  {[...familyMatrix].sort((a, b) => b.sales - a.sales).slice(0, 8).map((row) => (
                    <div key={row.name} className="flex items-center gap-3">
                      <span className="w-32 shrink-0 truncate text-xs font-bold text-slate-700" title={row.name}>
                        {row.name}
                      </span>
                      <div className="flex-1">
                        <Bar2 value={row.sales} max={familyMax} color="#F97316" />
                      </div>
                      <span className="w-24 shrink-0 text-right text-xs font-black text-slate-900">{compactEGP(row.sales)}</span>
                      <span className="w-12 shrink-0 text-right">
                        <AchievementBadge rate={row.achievementRate} />
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </ChartCard>
          </div>

          {/* Pareto + Territories */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <ChartCard title="Top Products (Pareto)" subtitle="Sales with cumulative contribution" icon={<BarChart3 className="h-4 w-4" />}>
              {paretoChartData.length === 0 ? (
                <p className="py-10 text-center text-sm text-slate-400">No product data.</p>
              ) : (
                <SafeResponsiveContainer minHeight={280}>
                  <ComposedChart data={paretoChartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                    <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 8, fontWeight: 700, fill: "#94A3B8" }} interval={0} angle={-30} textAnchor="end" height={56} />
                    <YAxis yAxisId="left" axisLine={false} tickLine={false} tick={{ fontSize: 9, fontWeight: 700, fill: "#94A3B8" }} width={44} tickFormatter={(v: number) => compactEGP(v)} />
                    <YAxis yAxisId="right" orientation="right" domain={[0, 100]} axisLine={false} tickLine={false} tick={{ fontSize: 9, fontWeight: 700, fill: "#94A3B8" }} width={36} tickFormatter={(v: number) => `${v}%`} />
                    <Tooltip content={<CurrencyTooltip />} />
                    <Bar yAxisId="left" dataKey="Sales" fill="#8B5CF6" radius={[0, 0, 0, 0]} barSize={16} />
                    <Line yAxisId="right" type="monotone" dataKey="Cumulative %" stroke="#F97316" strokeWidth={3} dot={{ r: 3, fill: "#F97316" }} />
                  </ComposedChart>
                </SafeResponsiveContainer>
              )}
            </ChartCard>

            <ChartCard title="Territory Performance" subtitle="Top territories by sales value" icon={<BarChart3 className="h-4 w-4" />}>
              {territories.length === 0 ? (
                <p className="py-10 text-center text-sm text-slate-400">No territory data.</p>
              ) : (
                <div className="space-y-3">
                  {[...territories].sort((a, b) => b.sales - a.sales).slice(0, 10).map((row) => (
                    <div key={row.name} className="flex items-center gap-3">
                      <span className="w-28 shrink-0 truncate text-xs font-bold text-slate-700" title={row.name}>
                        {row.name}
                      </span>
                      <div className="flex-1">
                        <Bar2 value={row.sales} max={territoryMax} color="#0EA5E9" />
                      </div>
                      <span className="w-24 shrink-0 text-right text-xs font-black text-slate-900">{compactEGP(row.sales)}</span>
                      <span className="w-12 shrink-0 text-right">
                        <AchievementBadge rate={row.achievementRate} />
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </ChartCard>
          </div>

          {/* Insights */}
          {(insights.length > 0 || anomalies.length > 0) ? (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              <ChartCard title="Insights" subtitle="Auto-generated highlights" icon={<Lightbulb className="h-4 w-4" />}>
                <div className="space-y-2.5">
                  {insights.map((bullet, index) => (
                    <AdminCallout key={index} tone={bullet.tone}>
                      <span className="text-sm">{bullet.text}</span>
                    </AdminCallout>
                  ))}
                </div>
              </ChartCard>
              <ChartCard title="Anomalies" subtitle="Product x territory outliers" icon={<Activity className="h-4 w-4" />}>
                {anomalies.length === 0 ? (
                  <p className="py-10 text-center text-sm text-slate-400">No significant anomalies detected.</p>
                ) : (
                  <div className="space-y-2.5">
                    {anomalies.map((row, index) => (
                      <div key={index} className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3">
                        <div>
                          <p className="text-sm font-black text-slate-900">{row.label}</p>
                          <p className="text-xs text-slate-500">{row.detail}</p>
                        </div>
                        <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-black ${row.score >= 0 ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
                          {row.score >= 0 ? "+" : ""}
                          {row.score >= 0 ? "+" : ""}{row.score.toFixed(1)} Sigma
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </ChartCard>
            </div>
          ) : null}

          {/* Manager performance */}
          <AdminTableShell
            title="Manager Performance"
            description="District/sales managers ranked by approved sales"
            action={
              <TableSearchInput
                value={managerTable.query}
                onChange={managerTable.setQuery}
                onClear={managerTable.clearQuery}
                placeholder="Search managers..."
                className="w-full sm:w-64"
              />
            }
          >
            <div>
              <table className="w-full table-fixed text-sm">
                {/* Six columns do not fit 349px: measured at 375px, Achv. got 38px for a
                    badge that wants 59px with its cell padding, and the table sat at 369px
                    inside a 349px container with nothing to scroll it. Top Product folds
                    below `md` and comes back as a sub-line under the manager, and the
                    padding halves on a phone, which is what buys the numeric columns room. */}
                <colgroup>
                  <col className="w-[30%] md:w-[22%]" />
                  <col className="w-[14%] md:w-[14%]" />
                  <col className="hidden md:table-column md:w-[22%]" />
                  <col className="w-[18%] md:w-[18%]" />
                  <col className="w-[18%] md:w-[13%]" />
                  <col className="w-[20%] md:w-[11%]" />
                </colgroup>
                <thead className="bg-[#020617] text-white">
                  <tr>
                    <SortableTh className="px-2 md:px-3" label="Manager" sortKey="manager" sort={managerTable.sort} onSort={managerTable.toggleSort} />
                    <SortableTh className="px-2 md:px-3" label="Line" sortKey="line" sort={managerTable.sort} onSort={managerTable.toggleSort} />
                    <SortableTh className="hidden md:table-cell" label="Top Product" />
                    <SortableTh className="px-2 md:px-3" label="Sales" sortKey="sales" sort={managerTable.sort} onSort={managerTable.toggleSort} align="right" />
                    <SortableTh className="px-2 md:px-3" label="Target" sortKey="target" sort={managerTable.sort} onSort={managerTable.toggleSort} align="right" />
                    <SortableTh className="px-2 md:px-3" label="Achv." sortKey="achievementRate" sort={managerTable.sort} onSort={managerTable.toggleSort} align="right" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {managerTable.rows.length === 0 ? (
                    <TableNoResults colSpan={6} filtered={managerTable.isFiltered} label="managers" />
                  ) : (
                    managerTable.rows.map((row) => (
                      <tr key={`${row.manager}-${row.line}`} className="transition hover:bg-orange-50/40">
                        <td className="break-words px-2 py-2.5 align-top font-bold text-slate-900 md:px-3">
                          {row.manager}
                          <span className="mt-0.5 block text-xs font-medium text-slate-500 md:hidden">
                            {row.topProduct}
                          </span>
                        </td>
                        <td className="break-words px-2 py-2.5 align-top text-slate-600 md:px-3">{row.line}</td>
                        <td className="hidden break-words px-3 py-2.5 align-top text-slate-600 md:table-cell">{row.topProduct}</td>
                        <td className="px-2 py-2.5 text-right align-top md:px-3">
                          <div className="font-black text-slate-900">{compactEGP(row.sales)}</div>
                          <Bar2 value={row.sales} max={managerMax} color="#F97316" />
                        </td>
                        <td className="px-2 py-2.5 text-right align-top text-slate-600 md:px-3">{compactEGP(row.target)}</td>
                        <td className="px-2 py-2.5 text-right align-top md:px-3">
                          <AchievementBadge rate={row.achievementRate} />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </AdminTableShell>

          {/* Line + Product tables */}
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <AdminTableShell title="Line Performance" description="Approved sales by product line">
              <div>
                <table className="w-full table-fixed text-sm">
                  <colgroup>
                    <col className="w-[28%]" />
                    <col className="w-[24%]" />
                    <col className="w-[18%]" />
                    <col className="w-[16%]" />
                    <col className="w-[14%]" />
                  </colgroup>
                  <thead className="bg-[#020617] text-white">
                    <tr>
                      <SortableTh label="Line" sortKey="line" sort={lineTable.sort} onSort={lineTable.toggleSort} />
                      <SortableTh label="Sales" sortKey="sales" sort={lineTable.sort} onSort={lineTable.toggleSort} align="right" />
                      <SortableTh label="Target" sortKey="target" sort={lineTable.sort} onSort={lineTable.toggleSort} align="right" />
                      <SortableTh label="Achv." sortKey="achievementRate" sort={lineTable.sort} onSort={lineTable.toggleSort} align="right" />
                      <SortableTh label="Reps" sortKey="linkedEmployees" sort={lineTable.sort} onSort={lineTable.toggleSort} align="right" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {lineTable.rows.length === 0 ? (
                      <TableNoResults colSpan={5} filtered={lineTable.isFiltered} label="lines" />
                    ) : (
                      lineTable.rows.map((row) => (
                        <tr key={row.line} className="transition hover:bg-orange-50/40">
                          <td className="break-words px-3 py-2.5 align-top font-bold text-slate-900">{row.line}</td>
                          <td className="px-3 py-2.5 text-right">
                            <div className="font-black text-slate-900">{compactEGP(row.sales)}</div>
                            <Bar2 value={row.sales} max={lineMax} color="#10B981" />
                          </td>
                          <td className="px-3 py-2.5 text-right text-slate-600">{compactEGP(row.target)}</td>
                          <td className="px-3 py-2.5 text-right">
                            <AchievementBadge rate={row.achievementRate} />
                          </td>
                          <td className="px-3 py-2.5 text-right font-bold text-slate-700">{formatNumber(row.linkedEmployees)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </AdminTableShell>

            <AdminTableShell
              title="Product Performance"
              description="Approved sales by product / SKU"
              action={
                <TableSearchInput
                  value={productTable.query}
                  onChange={productTable.setQuery}
                  onClear={productTable.clearQuery}
                  placeholder="Search products..."
                  className="w-full sm:w-56"
                />
              }
            >
              <div className="max-h-[460px] overflow-y-auto">
                {/* `table-fixed` + a colgroup, not a plain `w-full`: without them the product
                    names set the width and the table reached 357px inside a 349px wrapper at
                    375px, which the `overflow-auto` above then scrolled sideways. */}
                <table className="w-full table-fixed text-sm">
                  <colgroup>
                    <col className="w-[34%]" />
                    <col className="w-[24%]" />
                    <col className="w-[21%]" />
                    <col className="w-[21%]" />
                  </colgroup>
                  <thead className="sticky top-0 z-10 bg-[#020617] text-white">
                    <tr>
                      <SortableTh label="Product" sortKey="product" sort={productTable.sort} onSort={productTable.toggleSort} />
                      <SortableTh label="Family" sortKey="family" sort={productTable.sort} onSort={productTable.toggleSort} />
                      <SortableTh label="Sales" sortKey="sales" sort={productTable.sort} onSort={productTable.toggleSort} align="right" />
                      <SortableTh label="Achv." sortKey="achievementRate" sort={productTable.sort} onSort={productTable.toggleSort} align="right" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {productTable.rows.length === 0 ? (
                      <TableNoResults colSpan={4} filtered={productTable.isFiltered} label="products" />
                    ) : (
                      productTable.rows.map((row) => (
                        <tr key={row.product} className="transition hover:bg-orange-50/40">
                          <td className="break-words px-3 py-2.5 align-top font-bold text-slate-900">{row.product}</td>
                          <td className="break-words px-3 py-2.5 align-top text-slate-600">{row.family}</td>
                          <td className="px-3 py-2.5 text-right">
                            <div className="font-black text-slate-900">{compactEGP(row.sales)}</div>
                            <Bar2 value={row.sales} max={productMax} color="#8B5CF6" />
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <AchievementBadge rate={row.achievementRate} />
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </AdminTableShell>
          </div>

          <p className="px-1 text-center text-xs text-slate-400">
            Showing {formatUnits(Number(summary.approvedRecords ?? 0))} approved records across {trend.length} month
            {trend.length === 1 ? "" : "s"}. All totals respect your access scope and restricted-product rules.
          </p>
        </>
      ) : null}
    </div>
  );
}
