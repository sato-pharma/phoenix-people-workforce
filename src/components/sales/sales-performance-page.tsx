"use client";

import {
  Component,
  memo,
  useCallback,
  useMemo,
  useState,
} from "react";
import type { ErrorInfo, ReactNode } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  TrendingUp,
  RefreshCw,
  ArrowDown,
  ArrowUp,
  Search,
  Filter,
  X,
  ChevronDown,
  XCircle,
  CheckCircle,
  AlertTriangle,
  Info,
  BarChart3,
  Activity,
  Layers,
  Zap,
} from "lucide-react";
import {
  Bar,
  Area,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCurrency, formatPercent } from "@/lib/sales/format";
import { buildSalesProductAnalytics } from "@/lib/sales/metrics";
import type {
  SalesDashboardData,
  SalesProductPerformanceRow,
  SalesTrendPoint,
} from "@/lib/sales/types";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { reportClientError } from "@/lib/error-monitor/report-client-error";
import {
  isStaleDeployChunkError,
  isTransientRouterMountError,
  recoverFromStaleDeployOnce,
} from "@/lib/utils/stale-deploy-recovery";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";


/* ─── Error Boundary ──────────────────────────────────────────────────── */

interface ChartErrorBoundaryProps {
  children: ReactNode;
  fallbackLabel?: string;
}

interface ChartErrorBoundaryState {
  hasError: boolean;
  staleDeploy: boolean;
}

// Recharts arrives through next/dynamic, so a deploy that lands while this dashboard is open makes
// the chart's own chunk 404 — the same failure the portal shell's boundary had (see
// workspace-error-boundary.tsx). "Try again" cannot fix a file that is gone; a reload can.
class ChartErrorBoundary extends Component<ChartErrorBoundaryProps, ChartErrorBoundaryState> {
  constructor(props: ChartErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, staleDeploy: false };
  }

  static getDerivedStateFromError(error: Error): ChartErrorBoundaryState {
    return {
      hasError: true,
      staleDeploy: isStaleDeployChunkError(error) || isTransientRouterMountError(error),
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (typeof window !== "undefined" && window.console) {
      window.console.error("[ChartErrorBoundary]", error, info.componentStack);
    }
    reportClientError({ error, componentStack: info.componentStack });
    if (isStaleDeployChunkError(error) || isTransientRouterMountError(error)) {
      recoverFromStaleDeployOnce();
    }
  }

  render() {
    if (this.state.hasError) {
      const stale = this.state.staleDeploy;
      return (
        <div className="flex h-full min-h-[220px] flex-col items-center justify-center gap-3 rounded border border-dashed border-slate-200 bg-slate-50/60 p-6 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded bg-amber-50 text-amber-500 ring-1 ring-amber-100">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <p className="text-sm font-semibold text-slate-700">
            {stale
              ? "Phoenix was just updated — reload to see this chart"
              : (this.props.fallbackLabel ?? "Chart could not be rendered")}
          </p>
          <button
            type="button"
            onClick={() => {
              if (stale) {
                if (typeof window !== "undefined") window.location.reload();
                return;
              }
              this.setState({ hasError: false, staleDeploy: false });
            }}
            className="rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 transition-colors hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700"
          >
            {stale ? "Reload" : "Try again"}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

interface SalesPerformancePageProps {
  data: SalesDashboardData | null;
  isLoading?: boolean;
}

type ComparisonPeriod = "none" | "previous_period" | "previous_month" | "previous_3_months";

type PerformanceRow = {
  achievementRate: number;
  family: string;
  product: string;
  sales: number;
  target: number;
};

type FilteredSalesData = SalesDashboardData & {
  productPerformance: SalesProductPerformanceRow[];
  trend: SalesTrendPoint[];
};

type TrendChartDatum = {
  achievement: number;
  gap: number;
  label: string;
  period: string;
  sales: number;
  target: number;
};

type ProductMixDatum = {
  contribution: number;
  name: string;
  value: number;
};

type ChartTooltipEntry<TPayload> = {
  color?: string;
  dataKey?: string;
  fill?: string;
  name?: string;
  payload?: TPayload;
  value?: number | string;
};

/* ─── Design tokens ────────────────────────────────────────────────── */

const panelClass =
  "relative overflow-hidden rounded border border-slate-200/80 bg-white p-4 shadow-sm sm:p-5";

const surfaceClass =
  "rounded border border-slate-100 bg-gradient-to-b from-white to-slate-50/80 p-3 sm:p-4";

const mixColors = ["#f97316", "#0ea5e9", "#10b981", "#f59e0b", "#e11d48", "#64748b"];

const productTableColumns = [
  { key: "product", label: "Product" },
  { key: "sales", label: "Sales EGP" },
  { key: "target", label: "Target EGP" },
  { key: "achievementRate", label: "Achievement %" },
  { key: "contribution", label: "Mix %" },
];

function parseQueryList(values: string[]) {
  return [...new Set(values.flatMap((value) => value.split(",")).map((item) => item.trim()).filter(Boolean))];
}

function formatCompactCurrency(value: number) {
  const safe = Number.isFinite(value) ? value : 0;
  const abs = Math.abs(safe);
  if (abs >= 1_000_000) return `EGP ${(safe / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`;
  if (abs >= 1_000) return `EGP ${(safe / 1_000).toFixed(0)}K`;
  return formatCurrency(safe);
}

function formatPeriodLabel(period: string) {
  const [year, month] = period.split("-");
  const index = Number(month) - 1;
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return monthNames[index] && year ? `${monthNames[index]} ${year}` : period;
}

function achievementColor(rate: number) {
  if (rate >= 1) return "#10b981";
  if (rate >= 0.8) return "#f59e0b";
  return "#e11d48";
}

function ChartEmptyState({ label }: { label: string }) {
  return (
    <div className="flex h-full min-h-[220px] items-center justify-center rounded border border-dashed border-slate-200 bg-white/70 text-sm font-semibold text-slate-500">
      {label}
    </div>
  );
}

/* ─── Main Component ─────────────────────────────────────────────────── */

function SalesPerformancePage({ data, isLoading }: SalesPerformancePageProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [comparisonPeriod, setComparisonPeriod] = useState<ComparisonPeriod>("none");
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: "asc" | "desc" }>({ key: "sales", direction: "desc" });
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const selectedPeriods = useMemo(
    () => parseQueryList(searchParams.getAll("period")),
    [searchParams],
  );
  const selectedFamily = searchParams.get("family") ?? "";
  const selectedProducts = useMemo(
    () => parseQueryList(searchParams.getAll("products")),
    [searchParams],
  );
  const contextSource = searchParams.get("source") === "dashboard" ? "Dashboard" : null;
  const contextMonth = searchParams.get("month");

  const updateFilters = useCallback((newPeriods: string[], newFamily: string, newProducts: string[]) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("source");
    params.delete("month");
    if (newPeriods.length > 0) {
      params.set("period", newPeriods.join(","));
    } else {
      params.delete("period");
    }
    if (newFamily) {
      params.set("family", newFamily);
    } else {
      params.delete("family");
    }
    if (newProducts.length > 0) {
      params.set("products", newProducts.join(","));
    } else {
      params.delete("products");
    }
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    router.push(newUrl);
  }, [router, searchParams]);

  const handlePeriodsChange = useCallback((periods: string[]) => {
    updateFilters(periods, selectedFamily, selectedProducts);
  }, [selectedFamily, selectedProducts, updateFilters]);

  const handleFamilyChange = useCallback((family: string) => {
    updateFilters(selectedPeriods, family, selectedProducts);
  }, [selectedPeriods, selectedProducts, updateFilters]);

  const handleProductsChange = useCallback((products: string[]) => {
    updateFilters(selectedPeriods, selectedFamily, products);
  }, [selectedFamily, selectedPeriods, updateFilters]);

  const normalizedSearchQuery = useMemo(() => searchQuery.trim().toLowerCase(), [searchQuery]);

  const filteredData = useMemo<FilteredSalesData | null>(() => {
    if (!data) return null;
    let filteredProducts = data.productPerformance;
    const filteredTrend = data.trend;
    if (normalizedSearchQuery) {
      filteredProducts = filteredProducts.filter((p) =>
        p.product.toLowerCase().includes(normalizedSearchQuery)
      );
    }
    return { ...data, productPerformance: filteredProducts, trend: filteredTrend };
  }, [data, normalizedSearchQuery]);

  const salesAnalytics = useMemo(
    () => data ? buildSalesProductAnalytics(data, normalizedSearchQuery) : null,
    [data, normalizedSearchQuery],
  );

  const kpis = salesAnalytics?.kpis ?? null;
  const topProducts = salesAnalytics?.topProducts ?? [];
  const bottomProducts = salesAnalytics?.bottomProducts ?? [];
  const productMix = salesAnalytics?.productMix ?? [];
  const baseInsights = useMemo(() => salesAnalytics?.insights ?? [], [salesAnalytics?.insights]);

  const comparisonData = useMemo(() => {
    if (!data || comparisonPeriod === "none") return null;
    const trend = filteredData?.trend || data.trend;
    if (trend.length < 2) return null;
    const current = trend[trend.length - 1];
    let previous: typeof current | null = null;
    if (comparisonPeriod === "previous_month" && trend.length >= 2) {
      previous = trend[trend.length - 2];
    } else if (comparisonPeriod === "previous_3_months" && trend.length >= 4) {
      const previous3 = trend.slice(trend.length - 4, trend.length - 1);
      let previous3Sales = 0;
      let previous3Target = 0;
      for (let i = 0; i < previous3.length; i += 1) {
        previous3Sales += previous3[i].sales || 0;
        previous3Target += previous3[i].target || 0;
      }
      // Compare the latest month against the AVERAGE of the previous 3 months (like-for-like) —
      // comparing one month against the 3-month SUM made the delta structurally ~ -200%.
      const months = previous3.length || 1;
      const avgSales = previous3Sales / months;
      const avgTarget = previous3Target / months;
      previous = {
        period: "Avg of Previous 3 Months",
        sales: avgSales,
        target: avgTarget,
        achievementRate: avgTarget > 0 ? avgSales / avgTarget : 0,
        linkedEmployees: 0,
      };
    }
    if (!previous) return null;
    return {
      salesDelta: current.sales - previous.sales,
      salesDeltaPercent: previous.sales > 0 ? ((current.sales - previous.sales) / previous.sales) * 100 : 0,
      targetDelta: current.target - previous.target,
      achievementDelta: current.achievementRate - previous.achievementRate,
    };
  }, [filteredData, data, comparisonPeriod]);

  const insights = useMemo(() => {
    if (!comparisonData) return baseInsights;
    if (comparisonData.salesDeltaPercent > 0) {
      return [
        ...baseInsights,
        { type: "positive" as const, title: "Sales Growth", description: `Sales increased by ${comparisonData.salesDeltaPercent.toFixed(1)}% compared to previous period.` },
      ];
    }
    if (comparisonData.salesDeltaPercent < 0) {
      return [
        ...baseInsights,
        { type: "warning" as const, title: "Sales Decline", description: `Sales decreased by ${Math.abs(comparisonData.salesDeltaPercent).toFixed(1)}% compared to previous period.` },
      ];
    }
    return baseInsights;
  }, [baseInsights, comparisonData]);

  const sortedProducts = useMemo<PerformanceRow[]>(() => {
    if (!filteredData) return [];
    return [...filteredData.productPerformance].sort((a, b) => {
      const key = sortConfig.key as keyof PerformanceRow;
      const aValue = typeof a[key] === "number" ? a[key] : 0;
      const bValue = typeof b[key] === "number" ? b[key] : 0;
      if (sortConfig.direction === "asc") return aValue - bValue;
      return bValue - aValue;
    });
  }, [filteredData, sortConfig]);

  const handleSort = useCallback((key: string) => {
    setSortConfig((current) => ({
      key,
      direction: current.key === key && current.direction === "desc" ? "asc" : "desc",
    }));
  }, []);

  const handleResetFilters = useCallback(() => {
    setComparisonPeriod("none");
    setSearchQuery("");
    updateFilters([], "", []);
  }, [updateFilters]);

  const handleProductClick = useCallback((product: string) => {
    const nextProducts = selectedProducts.includes(product)
      ? selectedProducts.filter((p) => p !== product)
      : [...selectedProducts, product];
    updateFilters(selectedPeriods, selectedFamily, nextProducts);
  }, [selectedFamily, selectedPeriods, selectedProducts, updateFilters]);

  const handleClearContext = useCallback(() => {
    updateFilters(selectedPeriods, selectedFamily, selectedProducts);
  }, [selectedFamily, selectedPeriods, selectedProducts, updateFilters]);

  const handleToggleMoreFilters = useCallback(() => {
    setShowMoreFilters((current) => !current);
  }, []);

  // Family performance data for the new chart
  const familyPerformance = useMemo(() => {
    if (!data) return [];
    const familyMap = new Map<string, { sales: number; target: number }>();
    for (const p of data.productPerformance) {
      const existing = familyMap.get(p.family) ?? { sales: 0, target: 0 };
      existing.sales += p.sales;
      existing.target += p.target;
      familyMap.set(p.family, existing);
    }
    return Array.from(familyMap.entries()).map(([family, vals]) => ({
      family,
      sales: vals.sales,
      target: vals.target,
      achievementRate: vals.target > 0 ? vals.sales / vals.target : 0,
      gap: vals.sales - vals.target,
    })).sort((a, b) => b.sales - a.sales);
  }, [data]);

  if (isLoading) {
    return <LoadingState />;
  }

  if (!data) {
    return <EmptyState />;
  }

  return (
    <div className="mx-auto max-w-none space-y-4 employee-portal-page-transition" dir="auto">
      <Header
        onResetFilters={handleResetFilters}
        hasActiveFilters={selectedProducts.length > 0 || selectedPeriods.length > 0 || !!selectedFamily}
        contextSource={contextSource}
        contextMonth={contextMonth}
        onClearContext={handleClearContext}
      />

      <FilterBar
        availableProducts={data.filters.products}
        availablePeriods={data.filters.periods}
        availableFamilies={data.filters.families}
        selectedProducts={selectedProducts}
        selectedPeriods={selectedPeriods}
        selectedFamily={selectedFamily}
        comparisonPeriod={comparisonPeriod}
        onProductsChange={handleProductsChange}
        onPeriodsChange={handlePeriodsChange}
        onFamilyChange={handleFamilyChange}
        onComparisonChange={setComparisonPeriod}
        showMoreFilters={showMoreFilters}
        onToggleMoreFilters={handleToggleMoreFilters}
      />

      {kpis && (
        <KPICards kpis={kpis} comparisonData={comparisonData} />
      )}

      <ChartErrorBoundary fallbackLabel="Trend chart could not be rendered">
        <TrendChart trend={filteredData?.trend || data.trend} />
      </ChartErrorBoundary>

      {familyPerformance.length > 0 && (
        <ChartErrorBoundary fallbackLabel="Family chart could not be rendered">
          <FamilyPerformanceChart families={familyPerformance} />
        </ChartErrorBoundary>
      )}

      <ProductTable
        products={sortedProducts}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        sortConfig={sortConfig}
        onSort={handleSort}
        onProductClick={handleProductClick}
        selectedProducts={selectedProducts}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <TopBottomProducts
          title="Top 5 Products"
          products={topProducts}
          type="top"
          onProductClick={handleProductClick}
        />
        <TopBottomProducts
          title="Bottom 5 Products"
          products={bottomProducts}
          type="bottom"
          onProductClick={handleProductClick}
        />
      </div>

      <ChartErrorBoundary fallbackLabel="Product mix chart could not be rendered">
        <ProductMixChart data={productMix} onSegmentClick={handleProductClick} />
      </ChartErrorBoundary>

      <PerformanceInsights insights={insights} />
    </div>
  );
}

/* ─── Header ─────────────────────────────────────────────────────────── */

function Header({
  onResetFilters,
  hasActiveFilters,
  contextSource,
  contextMonth,
  onClearContext,
}: {
  onResetFilters: () => void;
  hasActiveFilters: boolean;
  contextSource: string | null;
  contextMonth: string | null;
  onClearContext: () => void;
}) {
  if (!hasActiveFilters && !contextSource && !contextMonth) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-orange-200/60 bg-gradient-to-r from-orange-50/40 to-white p-3 sm:p-4 rtl:bg-gradient-to-l">
      <div>
        {(contextSource || contextMonth) && (
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded border border-orange-200 bg-white px-3 py-1 text-xs font-semibold text-orange-700">
              {contextSource && <span>From {contextSource}</span>}
              {contextSource && contextMonth && <span>-</span>}
              {contextMonth && <span>{contextMonth}</span>}
              <button onClick={onClearContext} className="ml-1 hover:text-slate-900">
                <XCircle className="h-3 w-3" />
              </button>
            </span>
          </div>
        )}
      </div>
      <div className="flex gap-3">
        {hasActiveFilters && (
          <button
            onClick={onResetFilters}
            className="flex items-center gap-2 rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 transition-colors hover:border-orange-200 hover:bg-orange-50/60 hover:text-orange-700"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Reset Filters
          </button>
        )}
      </div>
    </div>
  );
}

/* ─── Filter Bar — Period pills + selects ────────────────────────────── */

function FilterBar({
  availableProducts,
  availablePeriods,
  availableFamilies,
  selectedProducts,
  selectedPeriods,
  selectedFamily,
  comparisonPeriod,
  onProductsChange,
  onPeriodsChange,
  onFamilyChange,
  onComparisonChange,
  showMoreFilters,
  onToggleMoreFilters,
}: {
  availableProducts: string[];
  availablePeriods: string[];
  availableFamilies: string[];
  selectedProducts: string[];
  selectedPeriods: string[];
  selectedFamily: string;
  comparisonPeriod: ComparisonPeriod;
  onProductsChange: (products: string[]) => void;
  onPeriodsChange: (periods: string[]) => void;
  onFamilyChange: (family: string) => void;
  onComparisonChange: (period: ComparisonPeriod) => void;
  showMoreFilters: boolean;
  onToggleMoreFilters: () => void;
}) {
  const allPeriodsSelected = selectedPeriods.length === 0;
  const selectedPeriodSet = new Set(selectedPeriods);

  const togglePeriod = (period: string) => {
    if (allPeriodsSelected) {
      // Selecting one means deselecting it from "all"
      onPeriodsChange(availablePeriods.filter((p) => p !== period));
      return;
    }
    if (selectedPeriodSet.has(period)) {
      const next = selectedPeriods.filter((p) => p !== period);
      // If removing would bring us back to all, reset
      onPeriodsChange(next.length === 0 ? [] : next);
      return;
    }
    const next = [...selectedPeriods, period];
    // If all are selected now, reset to "all"
    if (next.length === availablePeriods.length) {
      onPeriodsChange([]);
    } else {
      onPeriodsChange(next);
    }
  };

  return (
    <div className="space-y-3 rounded border border-slate-200/80 bg-white p-4 shadow-sm">
      {/* Period pills — horizontally scrollable on mobile */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-phx-sm font-bold uppercase tracking-widest text-slate-400">Period</span>
          {!allPeriodsSelected && (
            <button
              type="button"
              onClick={() => onPeriodsChange([])}
              className="text-phx-sm font-bold uppercase tracking-wide text-orange-600 hover:text-orange-700"
            >
              All Periods
            </button>
          )}
        </div>
        <div className="-mx-1 flex flex-wrap gap-1.5 px-1 pb-1">
          {availablePeriods.map((period) => {
            const isActive = allPeriodsSelected || selectedPeriodSet.has(period);
            return (
              <button
                key={period}
                type="button"
                onClick={() => togglePeriod(period)}
                className={`shrink-0 rounded px-3 py-1.5 text-xs font-bold transition-all ${
                  isActive
                    ? "bg-orange-500 text-white shadow-sm"
                    : "border border-slate-200 bg-slate-50 text-slate-600 hover:border-orange-300 hover:bg-orange-50"
                }`}
              >
                {formatPeriodLabel(period)}
              </button>
            );
          })}
        </div>
      </div>

      {/* Filter row */}
      <div className="grid gap-3 sm:grid-cols-3">
        {/* Comparison */}
        <div>
          <label className="mb-1 block text-phx-sm font-bold uppercase tracking-widest text-slate-400">Compare</label>
          <div className="relative">
            <SearchableSelect
              value={comparisonPeriod}
              onChange={(e) => onComparisonChange(e.target.value as ComparisonPeriod)}
              className="w-full appearance-none px-3 pr-8"
            >
              <option value="none">No comparison</option>
              <option value="previous_month">Previous Month</option>
              <option value="previous_3_months">Previous 3 Months</option>
            </SearchableSelect>
            <ChevronDown className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400 pointer-events-none" />
          </div>
        </div>

        {/* Family */}
        <div>
          <label className="mb-1 block text-phx-sm font-bold uppercase tracking-widest text-slate-400">Family</label>
          <div className="relative">
            <SearchableSelect
              value={selectedFamily}
              onChange={(e) => onFamilyChange(e.target.value)}
              className="w-full appearance-none px-3 pr-8"
            >
              <option value="">All Families</option>
              {availableFamilies.map((family) => (
                <option key={family} value={family}>{family}</option>
              ))}
            </SearchableSelect>
            <ChevronDown className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400 pointer-events-none" />
          </div>
        </div>

        {/* More Filters */}
        <div className="flex items-end">
          <button
            onClick={onToggleMoreFilters}
            className="flex h-10 w-full items-center justify-center gap-2 rounded border border-slate-200 bg-white text-sm font-bold text-slate-700 transition-colors hover:border-orange-300 hover:bg-orange-50"
          >
            <Filter className="h-3.5 w-3.5" />
            More Filters
          </button>
        </div>
      </div>

      {/* Expanded product chips */}
      {showMoreFilters && (
        <div className="border-t border-slate-100 pt-3">
          <span className="mb-2 block text-phx-sm font-bold uppercase tracking-widest text-slate-400">Products</span>
          <div className="flex flex-wrap gap-1.5">
            {availableProducts.map((product) => (
              <button
                key={product}
                onClick={() => {
                  if (selectedProducts.includes(product)) {
                    onProductsChange(selectedProducts.filter((p) => p !== product));
                  } else {
                    onProductsChange([...selectedProducts, product]);
                  }
                }}
                className={`rounded px-2.5 py-1 text-xs font-semibold transition ${
                  selectedProducts.includes(product)
                    ? "bg-orange-500 text-white"
                    : "border border-slate-200 bg-white text-slate-700 hover:border-orange-300 hover:bg-orange-50"
                }`}
              >
                {product}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Active filter chips */}
      {(selectedPeriods.length > 0 || selectedProducts.length > 0) && (
        <div className="flex flex-wrap gap-1.5 border-t border-slate-100 pt-3">
          {selectedPeriods.map((period) => (
            <div
              key={period}
              className="flex items-center gap-1 rounded border border-orange-200 bg-orange-50/60 px-2 py-0.5 text-phx-xs font-semibold text-orange-700"
            >
              {formatPeriodLabel(period)}
              <button onClick={() => onPeriodsChange(selectedPeriods.filter((p) => p !== period))} type="button" className="hover:text-orange-900">
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          {selectedProducts.map((product) => (
            <div
              key={product}
              className="flex items-center gap-1 rounded border border-orange-200 bg-orange-50/60 px-2 py-0.5 text-phx-xs font-semibold text-orange-700"
            >
              {product}
              <button onClick={() => onProductsChange(selectedProducts.filter((p) => p !== product))} type="button" className="hover:text-orange-900">
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── KPI Cards — clean, no icons, color-coded left accent ───────────── */

function KPICards({
  kpis,
  comparisonData,
}: {
  kpis: { totalSales: number; totalTarget: number; achievementRate: number; remainingGap: number };
  comparisonData: {
    salesDelta: number;
    salesDeltaPercent: number;
    targetDelta: number;
    achievementDelta: number;
  } | null;
}) {
  const achievementStatus = kpis.achievementRate >= 1 ? "above" : kpis.achievementRate >= 0.8 ? "near" : "below";

  const cards = [
    {
      title: "Total Sales",
      value: formatCurrency(kpis.totalSales),
      accent: "border-l-orange-500",
      accentBg: "bg-orange-500",
      delta: comparisonData ? comparisonData.salesDeltaPercent : null,
      deltaType: "percent" as const,
      sub: null,
    },
    {
      title: "Total Target",
      value: formatCurrency(kpis.totalTarget),
      accent: "border-l-slate-400",
      accentBg: "bg-slate-400",
      delta: comparisonData ? comparisonData.targetDelta : null,
      deltaType: "absolute" as const,
      sub: null,
    },
    {
      title: "Achievement",
      value: formatPercent(kpis.achievementRate),
      accent: achievementStatus === "above" ? "border-l-emerald-500" : achievementStatus === "near" ? "border-l-amber-500" : "border-l-rose-500",
      accentBg: achievementStatus === "above" ? "bg-emerald-500" : achievementStatus === "near" ? "bg-amber-500" : "bg-rose-500",
      delta: comparisonData ? comparisonData.achievementDelta * 100 : null,
      deltaType: "percent" as const,
      sub: achievementStatus === "above" ? "On track" : achievementStatus === "near" ? "Near target" : "Below target",
    },
    {
      title: "Gap to Target",
      value: formatCurrency(Math.abs(kpis.remainingGap)),
      accent: kpis.remainingGap <= 0 ? "border-l-emerald-500" : "border-l-rose-500",
      accentBg: kpis.remainingGap <= 0 ? "bg-emerald-500" : "bg-rose-500",
      delta: null,
      deltaType: "absolute" as const,
      sub: kpis.remainingGap <= 0 ? "Target exceeded" : "Shortfall",
    },
  ];

  return (
    <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
      {cards.map((card, index) => (
        <div
          key={card.title}
          className={`ep-fade-in-up border-l-[3px] ${card.accent} rounded border border-slate-200/80 bg-white p-3 sm:p-4 shadow-sm`}
          style={{ animationDelay: `${index * 60}ms` }}
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-phx-sm font-bold uppercase tracking-widest text-slate-400">{card.title}</p>
            {card.delta !== null && (
              <span
                className={`inline-flex items-center gap-0.5 text-phx-sm font-bold ${
                  card.delta > 0 ? "text-emerald-600" : "text-rose-600"
                }`}
              >
                {card.delta > 0 ? <ArrowUp className="h-2.5 w-2.5" /> : <ArrowDown className="h-2.5 w-2.5" />}
                {card.deltaType === "percent"
                  ? `${Math.abs(card.delta).toFixed(1)}%`
                  : formatCompactCurrency(Math.abs(card.delta)).replace("EGP ", "")}
              </span>
            )}
          </div>
          <p className="mt-2 text-lg font-black text-slate-900 sm:text-xl leading-tight">{card.value}</p>
          {card.sub && (
            <p className="mt-1 text-phx-xs font-semibold text-slate-500">{card.sub}</p>
          )}
        </div>
      ))}
    </div>
  );
}

/* ─── Trend Chart ────────────────────────────────────────────────────── */

function TrendTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<ChartTooltipEntry<TrendChartDatum>>;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;

  return (
    <div className="min-w-48 rounded border border-slate-200 bg-white p-3 shadow-lg">
      <p className="text-phx-sm font-bold uppercase tracking-widest text-slate-400">{row.label}</p>
      <div className="mt-2 space-y-1.5 text-xs">
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 font-medium text-slate-600">
            <span className="h-2 w-2 rounded-sm bg-orange-500" />Sales
          </span>
          <span className="font-bold text-slate-900">{formatCompactCurrency(row.sales)}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 font-medium text-slate-600">
            <span className="h-2 w-2 rounded-sm bg-slate-400" />Target
          </span>
          <span className="font-bold text-slate-900">{formatCompactCurrency(row.target)}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 font-medium text-slate-600">
            <span className="h-2 w-2 rounded-sm bg-sky-500" />Achievement
          </span>
          <span className="font-bold" style={{ color: achievementColor(row.achievement / 100) }}>
            {row.achievement.toFixed(1)}%
          </span>
        </div>
      </div>
      <div className="mt-2 border-t border-slate-100 pt-2 text-xs font-medium text-slate-600">
        Gap: <span className={row.gap >= 0 ? "font-bold text-emerald-600" : "font-bold text-rose-600"}>{formatCompactCurrency(row.gap)}</span>
      </div>
    </div>
  );
}

const TrendChart = memo(function TrendChart({
  trend,
}: {
  trend: Array<{ period: string; sales: number; target: number; achievementRate: number }>;
}) {
  const chartData = useMemo<TrendChartDatum[]>(() => trend.map((t) => ({
    label: formatPeriodLabel(t.period),
    period: t.period,
    sales: t.sales,
    target: t.target,
    achievement: t.achievementRate * 100,
    gap: t.sales - t.target,
  })), [trend]);

  const hasData = chartData.length > 0;
  const totalSales = useMemo(() => chartData.reduce((sum, item) => sum + item.sales, 0), [chartData]);
  const totalTarget = useMemo(() => chartData.reduce((sum, item) => sum + item.target, 0), [chartData]);
  const blendedAchievement = totalTarget > 0 ? (totalSales / totalTarget) * 100 : 0;
  const latest = chartData[chartData.length - 1] ?? null;
  const best = useMemo(
    () => chartData.reduce<TrendChartDatum | null>((current, item) => {
      if (!current || item.achievement > current.achievement) return item;
      return current;
    }, null),
    [chartData],
  );

  return (
    <div className={panelClass}>
      <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-orange-500 to-orange-300" />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-orange-500" />
            <p className="text-phx-sm font-bold uppercase tracking-widest text-orange-600">Sales vs target trajectory</p>
          </div>
          <h2 className="mt-1 text-base font-black text-slate-900 sm:text-lg">Monthly control chart</h2>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded border border-slate-100 bg-slate-50 px-2 py-1.5 sm:px-3">
            <p className="text-phx-xs font-bold uppercase tracking-widest text-slate-400">Sales</p>
            <p className="mt-0.5 text-xs font-black text-slate-900 sm:text-sm">{formatCompactCurrency(totalSales)}</p>
          </div>
          <div className="rounded border border-slate-100 bg-slate-50 px-2 py-1.5 sm:px-3">
            <p className="text-phx-xs font-bold uppercase tracking-widest text-slate-400">Ach.</p>
            <p className="mt-0.5 text-xs font-black sm:text-sm" style={{ color: achievementColor(blendedAchievement / 100) }}>
              {blendedAchievement.toFixed(1)}%
            </p>
          </div>
          <div className="rounded border border-slate-100 bg-slate-50 px-2 py-1.5 sm:px-3">
            <p className="text-phx-xs font-bold uppercase tracking-widest text-slate-400">Best</p>
            <p className="mt-0.5 text-xs font-black text-slate-900 sm:text-sm">{best ? best.label : "-"}</p>
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_200px]">
        <div className={surfaceClass}>
          {hasData ? (
            <div className="h-[260px] min-w-0 sm:h-[320px]">
              <ResponsiveContainer height="100%" width="100%">
                <ComposedChart data={chartData} margin={{ bottom: 4, left: -16, right: -10, top: 12 }}>
                  <defs>
                    <linearGradient id="salesBarGradient" x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" stopColor="#f97316" />
                      <stop offset="100%" stopColor="#fdba74" />
                    </linearGradient>
                    <linearGradient id="targetAreaGradient" x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" stopColor="#64748b" stopOpacity={0.12} />
                      <stop offset="100%" stopColor="#64748b" stopOpacity={0.01} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#e2e8f0" strokeDasharray="4 10" vertical={false} />
                  <XAxis
                    axisLine={false}
                    dataKey="label"
                    interval="preserveStartEnd"
                    minTickGap={10}
                    tick={{ fill: "#64748b", fontSize: 10, fontWeight: 600 }}
                    tickLine={false}
                    tickMargin={8}
                  />
                  <YAxis
                    axisLine={false}
                    tick={{ fill: "#94a3b8", fontSize: 10, fontWeight: 600 }}
                    tickFormatter={(value) => formatCompactCurrency(Number(value)).replace("EGP ", "")}
                    tickLine={false}
                    width={44}
                    yAxisId="money"
                  />
                  <YAxis
                    axisLine={false}
                    domain={[0, Math.max(120, Math.ceil(Math.max(...chartData.map((d) => d.achievement), 100) / 10) * 10)]}
                    orientation="right"
                    tick={{ fill: "#0ea5e9", fontSize: 10, fontWeight: 700 }}
                    tickFormatter={(value) => `${Number(value).toFixed(0)}%`}
                    tickLine={false}
                    width={32}
                    yAxisId="achievement"
                  />
                  <Tooltip content={<TrendTooltip />} cursor={{ fill: "rgba(15,23,42,0.03)" }} />
                  <ReferenceLine
                    ifOverflow="extendDomain"
                    label={{ value: "100%", fill: "#10b981", fontSize: 9, fontWeight: 700, position: "insideTopRight" }}
                    stroke="#10b981"
                    strokeDasharray="4 4"
                    y={100}
                    yAxisId="achievement"
                  />
                  <Area
                    dataKey="target"
                    fill="url(#targetAreaGradient)"
                    name="Target"
                    stroke="#94a3b8"
                    strokeWidth={1.5}
                    type="monotone"
                    yAxisId="money"
                  />
                  <Bar
                    barSize={16}
                    dataKey="sales"
                    fill="url(#salesBarGradient)"
                    name="Sales"
                    radius={[0, 0, 0, 0]}
                    yAxisId="money"
                  />
                  <Line
                    activeDot={{ fill: "#fff", r: 5, stroke: "#0ea5e9", strokeWidth: 3 }}
                    dataKey="achievement"
                    dot={{ fill: "#fff", r: 3, stroke: "#0ea5e9", strokeWidth: 2 }}
                    name="Achievement"
                    stroke="#0ea5e9"
                    strokeWidth={2.5}
                    type="monotone"
                    yAxisId="achievement"
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <ChartEmptyState label="No trend data available" />
          )}
        </div>

        {/* Sidebar stats */}
        <div className="grid grid-cols-2 gap-2 xl:grid-cols-1 xl:gap-3">
          <div className="rounded border border-slate-100 bg-slate-50 p-3">
            <p className="text-phx-xs font-bold uppercase tracking-widest text-slate-400">Latest</p>
            <p className="mt-1 text-sm font-black text-slate-900">{latest ? latest.label : "-"}</p>
            <p className="text-xs font-semibold text-slate-500">
              {latest ? `${latest.achievement.toFixed(1)}%` : "-"}
            </p>
          </div>
          <div className="rounded border border-slate-100 bg-slate-50 p-3">
            <p className="text-phx-xs font-bold uppercase tracking-widest text-slate-400">Gap</p>
            <p className={`mt-1 text-sm font-black ${totalSales - totalTarget >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
              {formatCompactCurrency(totalSales - totalTarget)}
            </p>
          </div>
          <div className="col-span-2 flex items-center gap-4 rounded border border-slate-100 bg-slate-50 p-3 xl:col-span-1">
            <span className="flex items-center gap-1 text-phx-sm font-bold text-slate-500">
              <span className="h-2 w-2 rounded-sm bg-orange-500" />Sales
            </span>
            <span className="flex items-center gap-1 text-phx-sm font-bold text-slate-500">
              <span className="h-2 w-2 rounded-sm bg-slate-400" />Target
            </span>
            <span className="flex items-center gap-1 text-phx-sm font-bold text-slate-500">
              <span className="h-2 w-2 rounded-sm bg-sky-500" />Ach%
            </span>
          </div>
        </div>
      </div>
    </div>
  );
});

/* ─── Family Performance Chart (NEW) ────────────────────────────────── */

function FamilyPerformanceChart({
  families,
}: {
  families: Array<{ family: string; sales: number; target: number; achievementRate: number; gap: number }>;
}) {
  const maxSales = Math.max(...families.map((f) => f.sales), 1);
  const familyColors = ["#f97316", "#0ea5e9", "#10b981", "#8b5cf6", "#e11d48", "#f59e0b"];

  return (
    <div className={panelClass}>
      <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-violet-500 to-violet-300" />
      <div className="flex items-center gap-2">
        <Layers className="h-4 w-4 text-violet-500" />
        <p className="text-phx-sm font-bold uppercase tracking-widest text-violet-600">Family breakdown</p>
      </div>
      <h2 className="mt-1 text-base font-black text-slate-900 sm:text-lg">Performance by Product Family</h2>
      <p className="mt-0.5 text-xs text-slate-500">Aggregate sales and target achievement across product families</p>

      <div className="mt-4 space-y-3">
        {families.map((fam, i) => {
          const salesPct = (fam.sales / maxSales) * 100;
          const targetPct = (fam.target / maxSales) * 100;
          const color = familyColors[i % familyColors.length];
          return (
            <div key={fam.family} className="rounded border border-slate-100 bg-slate-50/50 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="h-3 w-1 rounded-sm" style={{ backgroundColor: color }} />
                  <span className="text-sm font-bold text-slate-800">{fam.family}</span>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <span className="font-bold text-slate-900">{formatCompactCurrency(fam.sales)}</span>
                  <span
                    className="font-black"
                    style={{ color: achievementColor(fam.achievementRate) }}
                  >
                    {(fam.achievementRate * 100).toFixed(0)}%
                  </span>
                </div>
              </div>
              {/* Layered bar — target as background, sales as foreground */}
              <div className="relative mt-2 h-3 overflow-hidden rounded-sm bg-slate-200/60">
                <div
                  className="absolute inset-y-0 left-0 rounded-sm bg-slate-300/50"
                  style={{ width: `${targetPct}%` }}
                />
                <div
                  className="absolute inset-y-0 left-0 rounded-sm transition-all duration-500"
                  style={{
                    width: `${salesPct}%`,
                    background: `linear-gradient(90deg, ${color} 0%, ${color}99 100%)`,
                  }}
                />
              </div>
              <div className="mt-1.5 flex items-center justify-between text-phx-sm font-semibold text-slate-400">
                <span>Target: {formatCompactCurrency(fam.target)}</span>
                <span className={fam.gap >= 0 ? "text-emerald-600" : "text-rose-500"}>
                  {fam.gap >= 0 ? "+" : ""}{formatCompactCurrency(fam.gap)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Product Table ──────────────────────────────────────────────────── */

const ProductTable = memo(function ProductTable({
  products,
  searchQuery,
  onSearchChange,
  sortConfig,
  onSort,
  onProductClick,
  selectedProducts,
}: {
  products: Array<{
    product: string;
    family: string;
    sales: number;
    target: number;
    achievementRate: number;
  }>;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  sortConfig: { key: string; direction: "asc" | "desc" };
  onSort: (key: string) => void;
  onProductClick: (product: string) => void;
  selectedProducts: string[];
}) {
  const totalSales = useMemo(() => products.reduce((sum, p) => sum + p.sales, 0), [products]);

  const tableEmptyState = products.length === 0 ? (
    <div className="px-6 py-12 text-center">
      <Search className="mx-auto h-5 w-5 text-slate-300" />
      <p className="mt-2 text-sm font-semibold text-slate-700">No products found</p>
      <p className="mt-1 text-xs text-slate-500">Adjust your search or filters</p>
    </div>
  ) : null;

  return (
    <div className="overflow-hidden rounded border border-slate-200/80 bg-white shadow-sm">
      {/* Header with search */}
      <div className="border-b border-slate-100 bg-slate-50/50 p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-orange-500" />
              <p className="text-phx-sm font-bold uppercase tracking-widest text-orange-600">Product performance</p>
            </div>
            <p className="mt-0.5 text-xs text-slate-500">Revenue, target, achievement, and contribution</p>
          </div>
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400 rtl:left-auto rtl:right-3" />
            <input
              type="text"
              placeholder="Search products..."
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              className={cn(phxFieldClassName, "pl-9 rtl:pl-3 rtl:pr-9")}
            />
          </div>
        </div>
      </div>

      {/* ───── Mobile Card View (< 480px) ───── */}
      <div className="block xs:hidden">
        {tableEmptyState ?? (
          <div className="p-3">
            {/* Mobile sort control */}
            <div className="mb-3 flex items-center gap-2">
              <span className="text-phx-sm font-bold uppercase tracking-widest text-slate-400">Sort by</span>
              <SearchableSelect
                value={sortConfig.key}
                onChange={(e) => onSort(e.target.value)}
                className="px-2 py-1 text-xs"
              >
                {productTableColumns.map((col) => (
                  <option key={col.key} value={col.key}>{col.label}</option>
                ))}
              </SearchableSelect>
              <button
                type="button"
                onClick={() => onSort(sortConfig.key)}
                className="rounded border border-slate-200 bg-white p-1 text-slate-500 hover:bg-orange-50 hover:text-orange-600"
                aria-label={`Sort ${sortConfig.direction === "asc" ? "descending" : "ascending"}`}
              >
                {sortConfig.direction === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
              </button>
            </div>

            <div className="space-y-2">
              {products.map((product) => {
                const contribution = totalSales > 0 ? ((product.sales / totalSales) * 100).toFixed(1) : "0";
                const achColor = achievementColor(product.achievementRate);
                const isSelected = selectedProducts.includes(product.product);

                return (
                  <button
                    key={product.product}
                    type="button"
                    onClick={() => onProductClick(product.product)}
                    className={`block w-full rounded border p-3 text-left transition ${
                      isSelected
                        ? "border-orange-300 bg-orange-50/70"
                        : "border-slate-200 bg-white hover:border-orange-200 hover:bg-orange-50/30"
                    }`}
                  >
                    {/* Name + achievement */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-bold text-slate-900 leading-snug">{product.product}</p>
                        <p className="text-phx-xs font-medium text-slate-500">{product.family}</p>
                      </div>
                      <span className="shrink-0 text-sm font-black" style={{ color: achColor }}>
                        {formatPercent(product.achievementRate)}
                      </span>
                    </div>

                    {/* Gradient achievement bar */}
                    <div className="mt-2 h-1.5 overflow-hidden rounded-sm bg-slate-100">
                      <div
                        className="h-full rounded-sm transition-all duration-500"
                        style={{
                          width: `${Math.min(product.achievementRate * 100, 100)}%`,
                          background: `linear-gradient(90deg, ${achColor} 0%, ${achColor}80 100%)`,
                        }}
                      />
                    </div>

                    {/* Compact metrics row */}
                    <div className="mt-2 grid grid-cols-3 gap-1 text-center">
                      <div>
                        <p className="text-phx-xs font-bold uppercase text-slate-400">Sales</p>
                        <p className="text-phx-xs font-black text-slate-900">{formatCompactCurrency(product.sales)}</p>
                      </div>
                      <div>
                        <p className="text-phx-xs font-bold uppercase text-slate-400">Target</p>
                        <p className="text-phx-xs font-semibold text-slate-500">{formatCompactCurrency(product.target)}</p>
                      </div>
                      <div>
                        <p className="text-phx-xs font-bold uppercase text-slate-400">Mix</p>
                        <p className="text-phx-xs font-semibold text-slate-600">{contribution}%</p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ───── Desktop/Tablet Table View (>= 480px) ───── */}
      <div className="hidden xs:block">
        {tableEmptyState ? (
          <div className="p-5">{tableEmptyState}</div>
        ) : (
          <div>
            <table className="w-full table-fixed border-collapse">
              <colgroup>
                <col className="w-[30%]" />
                <col className="w-[17%]" />
                <col className="w-[17%]" />
                <col className="w-[22%]" />
                <col className="w-[14%]" />
              </colgroup>
              <thead className="bg-slate-50/80">
                <tr>
                  {productTableColumns.map((column) => (
                    <th
                      key={column.key}
                      onClick={() => onSort(column.key)}
                      aria-sort={sortConfig.key === column.key ? (sortConfig.direction === "asc" ? "ascending" : "descending") : "none"}
                      className="cursor-pointer border border-slate-100 px-4 py-2.5 text-left text-phx-sm font-bold uppercase tracking-widest text-slate-500 transition hover:bg-orange-50 rtl:text-right"
                    >
                      <span className="inline-flex items-center gap-1">
                        {column.label}
                        {sortConfig.key === column.key && (
                          sortConfig.direction === "asc" ? <ArrowUp className="h-2.5 w-2.5" /> : <ArrowDown className="h-2.5 w-2.5" />
                        )}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {products.map((product, index) => {
                  const contribution = totalSales > 0 ? ((product.sales / totalSales) * 100).toFixed(1) : "0";
                  return (
                    <tr
                      key={product.product}
                      onClick={() => onProductClick(product.product)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onProductClick(product.product);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                      aria-label={`${product.product} — ${formatPercent(product.achievementRate)} achievement`}
                      className={`cursor-pointer transition focus:bg-orange-50 focus:outline-none hover:bg-orange-50/60 ${
                        selectedProducts.includes(product.product)
                          ? "bg-orange-50/70"
                          : index % 2 === 1 ? "bg-slate-50/30" : ""
                      }`}
                    >
                      <td className="border border-slate-100 px-4 py-3 align-top">
                        <p className="break-words text-sm font-semibold text-slate-900 leading-snug">{product.product}</p>
                        <p className="break-words text-phx-xs text-slate-500">{product.family}</p>
                      </td>
                      <td className="border border-slate-100 px-4 py-3 align-top text-sm font-bold text-slate-900">{formatCompactCurrency(product.sales)}</td>
                      <td className="border border-slate-100 px-4 py-3 align-top text-sm font-medium text-slate-500">{formatCompactCurrency(product.target)}</td>
                      <td className="border border-slate-100 px-4 py-3 align-top">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span
                            className="text-sm font-black"
                            style={{ color: achievementColor(product.achievementRate) }}
                          >
                            {formatPercent(product.achievementRate)}
                          </span>
                          <div className="h-1.5 w-full max-w-[5rem] overflow-hidden rounded-sm bg-slate-100">
                            <div
                              className="h-full rounded-sm transition-all duration-500"
                              style={{
                                width: `${Math.min(product.achievementRate * 100, 100)}%`,
                                background: `linear-gradient(90deg, ${achievementColor(product.achievementRate)}, ${achievementColor(product.achievementRate)}80)`,
                              }}
                            />
                          </div>
                        </div>
                      </td>
                      <td className="border border-slate-100 px-4 py-3 text-sm font-medium text-slate-500">{contribution}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
});

/* ─── Top/Bottom Products ────────────────────────────────────────────── */

function TopBottomProducts({
  title,
  products,
  type,
  onProductClick,
}: {
  title: string;
  products: Array<{
    product: string;
    family: string;
    sales: number;
    target: number;
    achievementRate: number;
  }>;
  type: "top" | "bottom";
  onProductClick: (product: string) => void;
}) {
  const maxSales = products.length > 0 ? Math.max(...products.map((p) => p.sales)) : 0;
  const isTop = type === "top";
  const accentColor = isTop ? "#10b981" : "#e11d48";
  const badge = isTop ? "Revenue leaders" : "Recovery watch";

  return (
    <div className={panelClass}>
      <div className="absolute inset-x-0 top-0 h-[2px]" style={{ background: `linear-gradient(90deg, ${accentColor}, ${accentColor}60)` }} />
      <div>
        <div className="flex items-center gap-2">
          {isTop ? <TrendingUp className="h-4 w-4 text-emerald-500" /> : <Zap className="h-4 w-4 text-rose-500" />}
          <p className="text-phx-sm font-bold uppercase tracking-widest" style={{ color: accentColor }}>{badge}</p>
        </div>
        <h2 className="mt-1 text-base font-black text-slate-900">{title}</h2>
      </div>
      <div className="mt-4 space-y-2">
        {products.length === 0 ? (
          <ChartEmptyState label="No product ranking data" />
        ) : (
          products.map((product, index) => {
            const salesWidth = maxSales > 0 ? Math.max(4, (product.sales / maxSales) * 100) : 0;
            const barGradient = isTop
              ? "linear-gradient(90deg, #f97316 0%, #fdba74 100%)"
              : `linear-gradient(90deg, ${achievementColor(product.achievementRate)} 0%, ${achievementColor(product.achievementRate)}60 100%)`;
            return (
              <button
                key={product.product}
                onClick={() => onProductClick(product.product)}
                className="group block w-full rounded border border-slate-100 bg-white p-2.5 text-left transition hover:border-orange-200 hover:bg-orange-50/30 focus:outline-none focus:ring-1 focus:ring-orange-400/20"
                type="button"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-phx-sm font-black text-white"
                      style={{ backgroundColor: accentColor }}
                    >
                      {index + 1}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-slate-900 leading-snug">{product.product}</p>
                      <p className="text-phx-sm font-medium text-slate-500">{product.family}</p>
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-xs font-black text-slate-900">{formatCompactCurrency(product.sales)}</p>
                    <p className="text-phx-sm font-bold" style={{ color: achievementColor(product.achievementRate) }}>
                      {formatPercent(product.achievementRate)}
                    </p>
                  </div>
                </div>
                {/* Gradient bar */}
                <div className="mt-2 h-1.5 overflow-hidden rounded-sm bg-slate-100">
                  <div
                    className="h-full rounded-sm transition-all duration-500"
                    style={{ width: `${salesWidth}%`, background: barGradient }}
                  />
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ─── Product Mix Chart ──────────────────────────────────────────────── */

function ProductMixTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<ChartTooltipEntry<ProductMixDatum>>;
}) {
  const item = payload?.[0]?.payload;
  if (!active || !item) return null;

  return (
    <div className="rounded border border-slate-200 bg-white p-2.5 shadow-lg">
      <p className="text-sm font-bold text-slate-900">{item.name}</p>
      <p className="mt-0.5 text-xs font-medium text-slate-500">{formatCurrency(item.value)}</p>
      <p className="mt-1 text-xs font-bold text-slate-700">{item.contribution.toFixed(1)}% of sales</p>
    </div>
  );
}

function ProductMixChart({
  data,
  onSegmentClick,
}: {
  data: ProductMixDatum[];
  onSegmentClick: (product: string) => void;
}) {
  const total = data.reduce((sum, item) => sum + item.value, 0);
  const leading = data[0] ?? null;
  const concentration = data.slice(0, 3).reduce((sum, item) => sum + item.contribution, 0);

  return (
    <div className={panelClass}>
      <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-sky-500 to-sky-300" />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-sky-500" />
            <p className="text-phx-sm font-bold uppercase tracking-widest text-sky-600">Product mix</p>
          </div>
          <h2 className="mt-1 text-base font-black text-slate-900 sm:text-lg">Revenue concentration</h2>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded border border-slate-100 bg-slate-50 px-2.5 py-1.5">
            <p className="text-phx-xs font-bold uppercase tracking-widest text-slate-400">Leader</p>
            <p className="mt-0.5 text-xs font-bold text-slate-900">{leading?.name ?? "-"}</p>
          </div>
          <div className="rounded border border-slate-100 bg-slate-50 px-2.5 py-1.5">
            <p className="text-phx-xs font-bold uppercase tracking-widest text-slate-400">Top 3</p>
            <p className="mt-0.5 text-xs font-bold text-sky-600">{concentration.toFixed(1)}%</p>
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className={surfaceClass}>
          {data.length > 0 ? (
            <div className="relative mx-auto h-[240px] max-w-[280px]">
              <ResponsiveContainer height="100%" width="100%">
                <PieChart>
                  <Pie
                    cornerRadius={3}
                    cx="50%"
                    cy="50%"
                    data={data}
                    dataKey="value"
                    innerRadius={60}
                    nameKey="name"
                    outerRadius={95}
                    paddingAngle={1}
                    stroke="#ffffff"
                    strokeWidth={2}
                  >
                    {data.map((entry, index) => (
                      <Cell
                        className={entry.name === "Remaining Products" ? "" : "cursor-pointer outline-none transition hover:opacity-80"}
                        fill={mixColors[index % mixColors.length]}
                        key={`cell-${entry.name}`}
                        onClick={() => entry.name !== "Remaining Products" && onSegmentClick(entry.name)}
                      />
                    ))}
                  </Pie>
                  <Tooltip content={<ProductMixTooltip />} wrapperStyle={{ zIndex: 20 }} position={{ x: 0, y: -10 }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center z-[1]">
                <div className="rounded border border-slate-100 bg-white/95 px-3 py-2 text-center shadow-sm">
                  <p className="text-lg font-black text-slate-900">{formatCompactCurrency(total).replace("EGP ", "")}</p>
                  <p className="text-phx-xs font-bold uppercase tracking-widest text-slate-400">EGP total</p>
                </div>
              </div>
            </div>
          ) : (
            <ChartEmptyState label="No mix data" />
          )}
        </div>
        <div className="grid content-start gap-1.5">
          {data.length === 0 ? (
            <p className="rounded border border-slate-100 bg-slate-50 p-3 text-xs font-medium text-slate-500">
              Product mix will appear after sales data is linked.
            </p>
          ) : (
            data.map((entry, index) => {
              const isClickable = entry.name !== "Remaining Products";
              return (
                <button
                  className={`flex items-center gap-2 rounded border border-slate-100 bg-white px-3 py-2 text-left transition ${
                    isClickable ? "hover:border-orange-200 hover:bg-orange-50/30 focus:outline-none focus:ring-1 focus:ring-orange-400/20" : "cursor-default"
                  }`}
                  disabled={!isClickable}
                  key={entry.name}
                  onClick={() => isClickable && onSegmentClick(entry.name)}
                  type="button"
                >
                  <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: mixColors[index % mixColors.length] }} />
                  <span className="min-w-0 flex-1 text-xs font-semibold text-slate-800">{entry.name}</span>
                  <span className="shrink-0 text-xs font-black text-slate-900">{entry.contribution.toFixed(1)}%</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Performance Insights ───────────────────────────────────────────── */

function PerformanceInsights({
  insights,
}: {
  insights: Array<{
    type: "positive" | "warning" | "risk" | "info";
    title: string;
    description: string;
  }>;
}) {
  const config: Record<string, { icon: typeof Info; border: string; color: string }> = {
    positive: { icon: CheckCircle, border: "border-l-emerald-500", color: "text-emerald-500" },
    warning: { icon: AlertTriangle, border: "border-l-amber-500", color: "text-amber-500" },
    risk: { icon: AlertTriangle, border: "border-l-rose-500", color: "text-rose-500" },
    info: { icon: Info, border: "border-l-slate-400", color: "text-slate-400" },
  };
  const fallback = config.info;

  return (
    <div className={panelClass}>
      <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-amber-500 to-amber-300" />
      <div className="flex items-center gap-2">
        <Zap className="h-4 w-4 text-amber-500" />
        <p className="text-phx-sm font-bold uppercase tracking-widest text-amber-600">Diagnostics</p>
      </div>
      <h2 className="mt-1 text-base font-black text-slate-900 sm:text-lg">Performance Insights</h2>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {insights.map((insight) => {
          const c = config[insight.type] ?? fallback;
          const Icon = c.icon;
          return (
            <div
              key={`${insight.type}-${insight.title}`}
              className={`border-l-[3px] ${c.border} rounded border border-slate-100 bg-white p-3 transition hover:shadow-sm`}
            >
              <div className="flex items-start gap-2.5">
                <Icon className={`h-4 w-4 shrink-0 mt-0.5 ${c.color}`} />
                <div className="min-w-0">
                  <p className="text-sm font-bold text-slate-900">{insight.title}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{insight.description}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Loading State ──────────────────────────────────────────────────── */

function LoadingState() {
  return (
    <div className="employee-portal-route-loading space-y-4">
      <span className="sr-only">Loading sales performance data</span>

      {/* KPI skeleton */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded border border-slate-200 bg-white p-4">
            <div className="employee-portal-skeleton h-3 w-16 rounded" />
            <div className="employee-portal-skeleton mt-3 h-6 w-28 rounded" />
          </div>
        ))}
      </div>

      {/* Trend chart skeleton */}
      <div className="rounded border border-slate-200 bg-white p-4 sm:p-5">
        <div className="space-y-2">
          <div className="employee-portal-skeleton h-3 w-24 rounded" />
          <div className="employee-portal-skeleton h-5 w-48 rounded" />
        </div>
        <div className="employee-portal-skeleton mt-4 h-[260px] rounded sm:h-[320px]" />
      </div>

      {/* Product table skeleton */}
      <div className="rounded border border-slate-200 bg-white">
        <div className="border-b border-slate-100 p-4">
          <div className="employee-portal-skeleton h-3 w-28 rounded" />
          <div className="employee-portal-skeleton mt-2 h-5 w-40 rounded" />
        </div>
        <div className="divide-y divide-slate-100">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <div className="flex-1 space-y-1.5">
                <div className="employee-portal-skeleton h-3.5 w-36 rounded" />
                <div className="employee-portal-skeleton h-2.5 w-20 rounded" />
              </div>
              <div className="employee-portal-skeleton h-3.5 w-16 rounded" />
            </div>
          ))}
        </div>
      </div>

      {/* Top/bottom skeleton */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="employee-portal-skeleton h-[240px] rounded" />
        <div className="employee-portal-skeleton h-[240px] rounded" />
      </div>

      {/* Mix skeleton */}
      <div className="rounded border border-slate-200 bg-white p-4">
        <div className="employee-portal-skeleton h-3 w-20 rounded" />
        <div className="employee-portal-skeleton mt-2 h-5 w-44 rounded" />
        <div className="mt-4 grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <div className="employee-portal-skeleton h-[240px] rounded" />
          <div className="space-y-1.5">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="employee-portal-skeleton h-9 rounded" />
            ))}
          </div>
        </div>
      </div>

      {/* Insights skeleton */}
      <div className="rounded border border-slate-200 bg-white p-4">
        <div className="employee-portal-skeleton h-3 w-20 rounded" />
        <div className="employee-portal-skeleton mt-2 h-5 w-40 rounded" />
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <div className="employee-portal-skeleton h-14 rounded" />
          <div className="employee-portal-skeleton h-14 rounded" />
        </div>
      </div>
    </div>
  );
}

/* ─── Empty State ────────────────────────────────────────────────────── */

function EmptyState() {
  return (
    <div className="flex items-center justify-center rounded border border-dashed border-slate-200 bg-slate-50/60 px-6 py-16">
      <div className="text-center">
        <BarChart3 className="mx-auto h-8 w-8 text-slate-300" />
        <h2 className="mt-3 text-sm font-bold text-slate-900">No Sales Data Available</h2>
        <p className="mt-1 text-xs text-slate-500">
          Adjust your filters or check data linkage to view performance.
        </p>
      </div>
    </div>
  );
}

export { SalesPerformancePage };
export default SalesPerformancePage;
