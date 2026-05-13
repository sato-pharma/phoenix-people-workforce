"use client";

import { useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  TrendingUp,
  RefreshCw,
  ArrowDown,
  ArrowUp,
  DollarSign,
  Target,
  AlertCircle,
  Package,
  Search,
  Filter,
  X,
  ChevronDown,
  XCircle,
  CheckCircle,
  AlertTriangle,
  Info,
} from "lucide-react";
import {
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { formatCurrency, formatPercent } from "@/lib/sales/format";
import type {
  SalesDashboardData,
  SalesProductPerformanceRow,
  SalesTrendPoint,
} from "@/lib/sales/types";

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

type TooltipEntryPayload = {
  name?: string;
};

function SalesPerformancePage({ data, isLoading }: SalesPerformancePageProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [comparisonPeriod, setComparisonPeriod] = useState<ComparisonPeriod>("none");
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: "asc" | "desc" }>({ key: "sales", direction: "desc" });
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const parseQueryList = (values: string[]) => {
    return [...new Set(values.flatMap((value) => value.split(",")).map((item) => item.trim()).filter(Boolean))];
  };
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

  // Update URL when filters change to trigger server-side refetch
  const updateFilters = (newPeriods: string[], newFamily: string, newProducts: string[]) => {
    const params = new URLSearchParams(searchParams.toString());
    
    // Remove context params when filters change
    params.delete("source");
    params.delete("month");
    
    // Add filter params
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
  };

  const handlePeriodsChange = (periods: string[]) => {
    updateFilters(periods, selectedFamily, selectedProducts);
  };

  const handleFamilyChange = (family: string) => {
    updateFilters(selectedPeriods, family, selectedProducts);
  };

  const handleProductsChange = (products: string[]) => {
    updateFilters(selectedPeriods, selectedFamily, products);
  };

  // Filter data based on selections (client-side only for search query)
  const filteredData = useMemo<FilteredSalesData | null>(() => {
    if (!data) return null;

    let filteredProducts = data.productPerformance;
    const filteredTrend = data.trend;

    // Only apply search query filter (other filters handled by backend)
    if (searchQuery) {
      filteredProducts = filteredProducts.filter((p) =>
        p.product.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    return {
      ...data,
      productPerformance: filteredProducts,
      trend: filteredTrend,
    };
  }, [data, searchQuery]);

  const salesAnalytics = useMemo(() => {
    if (!filteredData) return null;

    const products = filteredData.productPerformance;
    const totalSales = data?.summary?.totalApprovedSales ?? 0;
    const totalTarget = data?.summary?.totalApprovedTarget ?? 0;

    const achievementRate = totalTarget > 0 ? totalSales / totalTarget : 0;
    const remainingGap = Math.max(0, totalTarget - totalSales);
    const kpis = {
      totalSales,
      totalTarget,
      achievementRate,
      remainingGap,
    };

    const topBySales = [...products].sort((a, b) => b.sales - a.sales);
    const topProducts = topBySales.slice(0, 5);

    const bottomProducts = [...products]
      .sort((a, b) => a.achievementRate - b.achievementRate)
      .slice(0, 5);

    const top5Sales = topBySales.slice(0, 5);
    const top5SalesTotal = top5Sales.reduce((sum, product) => sum + product.sales, 0);
    const others = Math.max(0, totalSales - top5SalesTotal);

    const productMix = [
      ...top5Sales.map((product) => ({
        name: product.product,
        value: product.sales,
        contribution: totalSales > 0 ? (product.sales / totalSales) * 100 : 0,
      })),
      ...(others > 0 ? [{ name: "Remaining Products", value: others, contribution: totalSales > 0 ? (others / totalSales) * 100 : 0 }] : []),
    ];

    const insights: Array<{
      type: "positive" | "warning" | "risk" | "info";
      title: string;
      description: string;
    }> = [];

      if (products.length === 0) {
        insights.push({
          type: "info",
          title: "No Product Data",
          description: "No product performance data available. Adjust filters or check data linkage.",
        });
      } else {
        let topProduct = products[0];
        let belowTargetCount = 0;
        let aboveTargetCount = 0;
        for (const product of products) {
          if ((product.achievementRate ?? 0) < 0.5) belowTargetCount++;
          if ((product.achievementRate ?? 0) >= 1) aboveTargetCount++;
          if (topProduct && (product.sales || 0) > (topProduct.sales || 0)) {
            topProduct = product;
          }
      }

      if (topProduct) {
        const contribution = totalSales > 0 ? (topProduct.sales / totalSales) * 100 : 0;
        insights.push({
          type: "positive",
          title: "Top Performing Product",
          description: `${topProduct.product} contributes ${contribution.toFixed(1)}% of total sales with EGP ${formatCurrency(topProduct.sales)}.`,
        });
      }

      if (belowTargetCount > 0) {
        insights.push({
          type: "risk",
          title: "Products Below 50% Achievement",
          description: `${belowTargetCount} product(s) are below 50% of target. Review performance and support.`,
        });
      }

      if (aboveTargetCount > 0) {
        insights.push({
          type: "positive",
          title: "Exceeding Target",
          description: `${aboveTargetCount} product(s) have achieved or exceeded their target.`,
        });
      }
    }

    return {
      kpis,
      topProducts,
      bottomProducts,
      productMix,
      insights,
    };
  }, [data, filteredData]);

  const kpis = salesAnalytics?.kpis ?? null;
  const topProducts = salesAnalytics?.topProducts ?? [];
  const bottomProducts = salesAnalytics?.bottomProducts ?? [];
  const productMix = salesAnalytics?.productMix ?? [];
  const baseInsights = useMemo(() => salesAnalytics?.insights ?? [], [salesAnalytics?.insights]);

  // Calculate comparison data
  const comparisonData = useMemo(() => {
    if (!data || comparisonPeriod === "none") return null;

    // This would need historical data - for now using trend data
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
      previous = {
        period: "Previous 3 Months",
        sales: previous3Sales,
        target: previous3Target,
        achievementRate: 0,
        linkedEmployees: 0,
      };
      previous.achievementRate = previous.target > 0 ? previous.sales / previous.target : 0;
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
        {
          type: "positive" as const,
          title: "Sales Growth",
          description: `Sales increased by ${comparisonData.salesDeltaPercent.toFixed(1)}% compared to previous period.`,
        },
      ];
    }

    if (comparisonData.salesDeltaPercent < 0) {
      return [
        ...baseInsights,
        {
          type: "warning" as const,
          title: "Sales Decline",
          description: `Sales decreased by ${Math.abs(comparisonData.salesDeltaPercent).toFixed(1)}% compared to previous period.`,
        },
      ];
    }

    return baseInsights;
  }, [baseInsights, comparisonData]);

  // Sort product table
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

  const handleSort = (key: string) => {
    setSortConfig((current) => ({
      key,
      direction: current.key === key && current.direction === "desc" ? "asc" : "desc",
    }));
  };

  const handleResetFilters = () => {
    setComparisonPeriod("none");
    setSearchQuery("");
    updateFilters([], "", []);
  };

  const handleProductClick = (product: string) => {
    const nextProducts = selectedProducts.includes(product)
      ? selectedProducts.filter((p) => p !== product)
      : [...selectedProducts, product];
    updateFilters(selectedPeriods, selectedFamily, nextProducts);
  };

  if (isLoading) {
    return <LoadingState />;
  }

  if (!data) {
    return <EmptyState />;
  }

  return (
    <div className="rounded-[30px] border border-white/75 bg-white/88 p-4 shadow-[0_24px_80px_rgba(15,23,42,0.10)] ring-1 ring-slate-900/5 sm:p-5">
      <div className="mx-auto max-w-none">
        <Header
          onResetFilters={handleResetFilters}
          hasActiveFilters={selectedProducts.length > 0 || selectedPeriods.length > 0 || !!selectedFamily}
          contextSource={contextSource}
          contextMonth={contextMonth}
          onClearContext={() => updateFilters(selectedPeriods, selectedFamily, selectedProducts)}
        />

        {/* Advanced Filter Bar */}
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
          onToggleMoreFilters={() => setShowMoreFilters(!showMoreFilters)}
        />

        {/* KPI Cards */}
        {kpis && (
          <KPICards
            kpis={kpis}
            comparisonData={comparisonData}
          />
        )}

        {/* Monthly Trend Chart */}
        <TrendChart trend={filteredData?.trend || data.trend} />

        {/* Product Performance Table */}
        <ProductTable
          products={sortedProducts}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          sortConfig={sortConfig}
          onSort={handleSort}
          onProductClick={handleProductClick}
          selectedProducts={selectedProducts}
        />

        {/* Top and Bottom Products */}
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
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

        {/* Product Mix Donut Chart */}
        <ProductMixChart data={productMix} onSegmentClick={handleProductClick} />

        {/* Performance Insights */}
        <PerformanceInsights insights={insights} />
      </div>
    </div>
  );
}

// Header Component
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
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4 rounded-[28px] border border-[#FED7AA]/80 bg-[linear-gradient(135deg,#FFF7ED_0%,#FFFFFF_58%,#F8FAFC_100%)] p-5 shadow-[0_18px_45px_rgba(15,23,42,0.08)]">
      <div>
        {(contextSource || contextMonth) && (
          <div className="mt-2 flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[#FED7AA] bg-white px-3 py-1 text-xs font-black text-[#C2410C] shadow-[0_10px_24px_rgba(249,115,22,0.08)]">
              {contextSource && <span>Opened from {contextSource}</span>}
              {contextSource && contextMonth && <span>·</span>}
              {contextMonth && <span>{contextMonth}</span>}
              <button
                onClick={onClearContext}
                className="ml-1 hover:text-[#0F172A]"
              >
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
            className="flex items-center gap-2 rounded-2xl border border-[#FED7AA] bg-white px-4 py-2.5 text-sm font-black text-[#0F172A] shadow-[0_12px_28px_rgba(15,23,42,0.08)] transition hover:-translate-y-0.5 hover:bg-[#FFF7ED]"
          >
            <RefreshCw className="h-4 w-4" />
            Reset Filters
          </button>
        )}
      </div>
    </div>
  );
}

// Filter Bar Component
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
  const [periodPickerOpen, setPeriodPickerOpen] = useState(false);
  const allPeriodsSelected = selectedPeriods.length === 0;
  const selectedPeriodSet = new Set(selectedPeriods);
  const selectedPeriodsLabel = allPeriodsSelected
    ? `All Periods (${availablePeriods.length})`
    : selectedPeriods.length === 1
      ? selectedPeriods[0]
      : `${selectedPeriods.length} periods selected`;
  const togglePeriod = (period: string) => {
    if (allPeriodsSelected) {
      onPeriodsChange(availablePeriods.filter((option) => option !== period));
      return;
    }

    if (selectedPeriodSet.has(period)) {
      onPeriodsChange(selectedPeriods.filter((option) => option !== period));
      return;
    }

    onPeriodsChange(availablePeriods.filter((option) => selectedPeriodSet.has(option) || option === period));
  };

  return (
    <div className="mb-8 rounded-[28px] border border-white/75 bg-white/94 p-5 shadow-[0_22px_60px_rgba(15,23,42,0.09)] ring-1 ring-slate-900/5">
      <div className="flex flex-wrap items-center gap-4">
        {/* Period Filter */}
        <div className="flex-1 min-w-[200px]">
          <label className="mb-2 block text-[11px] font-black uppercase tracking-[0.16em] text-[#64748B]">Period</label>
          <div className="relative">
            <button
              type="button"
              onClick={() => setPeriodPickerOpen((current) => !current)}
              className="flex h-11 w-full items-center justify-between rounded-2xl border border-[#D8E0EA] bg-white/95 px-4 text-left text-sm font-semibold text-[#0F172A] shadow-[0_14px_35px_rgba(15,23,42,0.06)] transition hover:border-[#F97316] hover:bg-[#FFF7ED] focus:border-[#F97316] focus:outline-none focus:ring-2 focus:ring-[#F97316]/15"
            >
              <span className="truncate">{selectedPeriodsLabel}</span>
              <ChevronDown className={`h-4 w-4 text-[#64748B] transition-transform ${periodPickerOpen ? "rotate-180" : ""}`} />
            </button>
            {periodPickerOpen && (
              <div className="absolute z-30 mt-2 w-full rounded-2xl border border-[#E2E8F0] bg-white p-3 shadow-2xl">
                <label className="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-2 text-sm font-semibold text-[#0F172A] hover:bg-[#FFF7ED]">
                  <input
                    checked={allPeriodsSelected}
                    className="h-4 w-4 accent-[#F97316]"
                    onChange={() => onPeriodsChange([])}
                    type="checkbox"
                  />
                  Select All
                </label>
                <div className="mt-1 max-h-56 space-y-1 overflow-auto">
                  {availablePeriods.map((period) => {
                    const selected = allPeriodsSelected || selectedPeriodSet.has(period);
                    return (
                      <label
                        className="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-2 text-sm font-semibold text-[#0F172A] hover:bg-[#FFF7ED]"
                        key={period}
                      >
                        <input
                          checked={selected}
                          className="h-4 w-4 accent-[#F97316]"
                          onChange={() => togglePeriod(period)}
                          type="checkbox"
                        />
                        {period}
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Comparison Filter */}
        <div className="flex-1 min-w-[200px]">
          <label className="mb-2 block text-[11px] font-black uppercase tracking-[0.16em] text-[#64748B]">Compare With</label>
          <div className="relative">
            <select
              value={comparisonPeriod}
              onChange={(e) => onComparisonChange(e.target.value as ComparisonPeriod)}
              className="h-11 w-full appearance-none rounded-2xl border border-[#D8E0EA] bg-white/95 px-4 text-sm font-semibold text-[#0F172A] shadow-[0_14px_35px_rgba(15,23,42,0.06)] focus:border-[#F97316] focus:outline-none focus:ring-2 focus:ring-[#F97316]/15"
            >
              <option value="none">None</option>
              <option value="previous_month">Previous Month</option>
              <option value="previous_3_months">Previous 3 Months</option>
            </select>
            <ChevronDown className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#64748B] pointer-events-none" />
          </div>
        </div>

        {/* Family Filter */}
        <div className="flex-1 min-w-[200px]">
          <label className="mb-2 block text-[11px] font-black uppercase tracking-[0.16em] text-[#64748B]">Family</label>
          <div className="relative">
            <select
              value={selectedFamily}
              onChange={(e) => onFamilyChange(e.target.value)}
              className="h-11 w-full appearance-none rounded-2xl border border-[#D8E0EA] bg-white/95 px-4 text-sm font-semibold text-[#0F172A] shadow-[0_14px_35px_rgba(15,23,42,0.06)] focus:border-[#F97316] focus:outline-none focus:ring-2 focus:ring-[#F97316]/15"
            >
              <option value="">All Families</option>
              {availableFamilies.map((family) => (
                <option key={family} value={family}>
                  {family}
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#64748B] pointer-events-none" />
          </div>
        </div>

        {/* More Filters Toggle */}
        <button
          onClick={onToggleMoreFilters}
          className="mt-6 flex h-11 items-center gap-2 rounded-2xl border border-[#FED7AA] bg-white px-4 text-sm font-black text-[#0F172A] shadow-[0_14px_35px_rgba(15,23,42,0.06)] transition hover:-translate-y-0.5 hover:bg-[#FFF7ED]"
        >
          <Filter className="h-4 w-4" />
          More Filters
        </button>
      </div>

      {/* Expanded Filters */}
      {showMoreFilters && (
        <div className="mt-4 border-t border-[#FED7AA] pt-4">
          <label className="mb-2 block text-[11px] font-black uppercase tracking-[0.16em] text-[#64748B]">Products</label>
          <div className="flex flex-wrap gap-2">
            {availableProducts.slice(0, 10).map((product) => (
              <button
                key={product}
                onClick={() => {
                  if (selectedProducts.includes(product)) {
                    onProductsChange(selectedProducts.filter((p) => p !== product));
                  } else {
                    onProductsChange([...selectedProducts, product]);
                  }
                }}
                className={`px-3 py-1.5 rounded-lg text-sm transition ${
                  selectedProducts.includes(product)
                    ? "bg-[#F97316] text-white shadow-[0_12px_24px_rgba(249,115,22,0.22)]"
                    : "border border-[#E2E8F0] bg-white text-[#0F172A] hover:border-[#F97316] hover:bg-[#FFF7ED]"
                }`}
              >
                {product}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Active Filter Chips */}
      {(selectedPeriods.length > 0 || selectedProducts.length > 0) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {selectedPeriods.map((period) => (
            <div
              key={period}
              className="flex items-center gap-1 rounded-full border border-[#FED7AA] bg-[#FFF7ED] px-3 py-1 text-sm font-black text-[#C2410C]"
            >
              Period: {period}
              <button
                onClick={() => onPeriodsChange(selectedPeriods.filter((item) => item !== period))}
                className="hover:text-[#EA580C]"
                type="button"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          {selectedProducts.map((product) => (
            <div
              key={product}
              className="flex items-center gap-1 rounded-full border border-[#FED7AA] bg-[#FFF7ED] px-3 py-1 text-sm font-black text-[#C2410C]"
            >
              {product}
              <button
                onClick={() => onProductsChange(selectedProducts.filter((p) => p !== product))}
                className="hover:text-[#EA580C]"
                type="button"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// KPI Cards Component
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
  const cards = [
    {
      title: "Total Sales",
      value: formatCurrency(kpis.totalSales),
      icon: DollarSign,
      color: "#F97316",
      delta: comparisonData ? comparisonData.salesDeltaPercent : null,
      deltaType: "percent" as const,
    },
    {
      title: "Total Target",
      value: formatCurrency(kpis.totalTarget),
      icon: Target,
      color: "#64748B",
      delta: comparisonData ? comparisonData.targetDelta : null,
      deltaType: "absolute" as const,
    },
    {
      title: "Achievement %",
      value: formatPercent(kpis.achievementRate),
      icon: TrendingUp,
      color: kpis.achievementRate >= 1 ? "#22C55E" : kpis.achievementRate >= 0.8 ? "#F59E0B" : "#EF4444",
      delta: comparisonData ? comparisonData.achievementDelta : null,
      deltaType: "percent" as const,
    },
    {
      title: "Remaining Gap",
      value: formatCurrency(kpis.remainingGap),
      icon: AlertCircle,
      color: kpis.remainingGap > 0 ? "#EF4444" : "#22C55E",
      delta: null,
      deltaType: "absolute" as const,
    },
  ];

  return (
    <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card, index) => (
        <div
          key={card.title}
          className="rounded-[24px] border border-white/75 bg-white/94 p-6 shadow-[0_18px_45px_rgba(15,23,42,0.08)] ring-1 ring-slate-900/5 transition hover:-translate-y-1 hover:border-[#FDBA74] hover:bg-white hover:shadow-[0_24px_58px_rgba(15,23,42,0.12)]"
          style={{ animationDelay: `${index * 100}ms` }}
        >
          <div className="flex items-start justify-between">
            <div className="rounded-2xl bg-[#FFF7ED] p-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
              <card.icon className="h-5 w-5" style={{ color: card.color }} />
            </div>
            {card.delta !== null && (
              <div
                className={`flex items-center gap-1 text-xs font-medium ${
                  card.deltaType === "percent"
                    ? card.delta > 0
                      ? "text-[#22C55E]"
                      : "text-[#EF4444]"
                    : card.delta > 0
                    ? "text-[#22C55E]"
                    : "text-[#EF4444]"
                }`}
              >
                {card.delta > 0 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
                {card.deltaType === "percent"
                  ? `${Math.abs(card.delta).toFixed(1)}%`
                  : formatCurrency(Math.abs(card.delta))}
              </div>
            )}
          </div>
          <p className="mt-4 text-sm font-medium text-[#64748B]">{card.title}</p>
          <p className="mt-2 text-2xl font-semibold text-[#0F172A]">{card.value}</p>
          {card.title === "Achievement %" && (
            <div className="mt-3 h-1.5 rounded-full bg-[#F8FAFC] overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${Math.min(kpis.achievementRate * 100, 100)}%`,
                  backgroundColor: card.color,
                }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// Trend Chart Component
function TrendChart({
  trend,
}: {
  trend: Array<{ period: string; sales: number; target: number; achievementRate: number }>;
}) {
  const chartData = trend.map((t) => ({
    period: t.period,
    sales: t.sales,
    target: t.target,
    achievement: t.achievementRate * 100,
  }));

  return (
    <div
      className="mb-8 rounded-[28px] border border-white/75 bg-white/94 p-6 shadow-[0_22px_60px_rgba(15,23,42,0.09)] ring-1 ring-slate-900/5"
    >
      <h2 className="text-lg font-semibold text-[#0F172A]">Monthly Sales vs Target</h2>
      <p className="mt-1 text-sm text-[#64748B]">Track your sales performance against target over time</p>
      <div className="mt-6 h-[300px]">
        {chartData && chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
              <XAxis dataKey="period" stroke="#64748B" fontSize={12} />
              <YAxis stroke="#64748B" fontSize={12} tickFormatter={(value) => formatCurrency(value as number)} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#FFFFFF",
                  border: "1px solid #E2E8F0",
                  borderRadius: "8px",
                  boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
                }}
                formatter={(value, name) => {
                  if (value === undefined) return ["--", name];
                  const seriesName = String(name ?? "");
                  if (seriesName.toLowerCase() === "achievement" && typeof value === "number") {
                    return [`${value.toFixed(1)}%`, "Achievement"];
                  }
                  const numericValue = typeof value === "number" ? value : Number(value) || 0;
                  return [
                    formatCurrency(numericValue),
                    seriesName.toLowerCase() === "sales" ? "Sales" : "Target",
                  ];
                }}
              />
              <Legend />
              <Bar dataKey="sales" name="Sales" fill="#F97316" radius={[4, 4, 0, 0]} />
              <Bar dataKey="target" name="Target" fill="#64748B" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-slate-500">No trend data available</p>
          </div>
        )}
      </div>
    </div>
  );
}

// Product Table Component
function ProductTable({
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
  const totalSales = products.reduce((sum, p) => sum + p.sales, 0);

  const columns = [
    { key: "product", label: "Product Name" },
    { key: "sales", label: "Sales EGP" },
    { key: "target", label: "Target EGP" },
    { key: "achievementRate", label: "Achievement %" },
    { key: "contribution", label: "Contribution %" },
  ];

  return (
    <div className="mb-8 overflow-hidden rounded-[28px] border border-white/75 bg-white/94 shadow-[0_22px_60px_rgba(15,23,42,0.09)] ring-1 ring-slate-900/5">
      <div className="border-b border-[#FED7AA] bg-[#FFF7ED]/80 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-[#0F172A]">Product Performance</h2>
            <p className="mt-1 text-sm text-[#64748B]">Detailed breakdown of product sales and targets</p>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#64748B]" />
            <input
              type="text"
              placeholder="Search products..."
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              className="h-10 rounded-2xl border border-[#D8E0EA] bg-white/95 py-2 pl-10 pr-4 text-sm shadow-[0_10px_24px_rgba(15,23,42,0.06)] focus:border-[#F97316] focus:outline-none focus:ring-2 focus:ring-[#F97316]/15"
            />
          </div>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-[#FFF7ED]/80">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  onClick={() => onSort(column.key)}
                  className="cursor-pointer px-6 py-3 text-left text-xs font-black uppercase tracking-[0.16em] text-[#64748B] transition hover:bg-[#FFEDD5]"
                >
                  <div className="flex items-center gap-2">
                    {column.label}
                    {sortConfig.key === column.key && (
                      sortConfig.direction === "asc" ? (
                        <ArrowUp className="h-3 w-3" />
                      ) : (
                        <ArrowDown className="h-3 w-3" />
                      )
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[#E2E8F0]">
            {products.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-6 py-12 text-center text-sm text-[#64748B]">
                  No products found matching your search
                </td>
              </tr>
            ) : (
              products.map((product) => (
                <tr
                  key={product.product}
                  onClick={() => onProductClick(product.product)}
                  className={`cursor-pointer transition hover:bg-[#FFF7ED]/55 ${
                    selectedProducts.includes(product.product) ? "bg-[#F97316]/5" : ""
                  }`}
                >
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="rounded-xl bg-[#FFF7ED] p-2">
                        <Package className="h-4 w-4 text-[#64748B]" />
                      </div>
                      <div>
                        <p className="font-medium text-[#0F172A]">{product.product}</p>
                        <p className="text-xs text-[#64748B]">{product.family}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-sm font-medium text-[#0F172A]">{formatCurrency(product.sales)}</td>
                  <td className="px-6 py-4 text-sm text-[#64748B]">{formatCurrency(product.target)}</td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-sm font-medium ${
                          product.achievementRate >= 1
                            ? "text-[#22C55E]"
                            : product.achievementRate >= 0.8
                            ? "text-[#F59E0B]"
                            : "text-[#EF4444]"
                        }`}
                      >
                        {formatPercent(product.achievementRate)}
                      </span>
                      <div className="h-1.5 w-16 rounded-full bg-[#F8FAFC] overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{
                            width: `${Math.min(product.achievementRate * 100, 100)}%`,
                            backgroundColor:
                              product.achievementRate >= 1
                                ? "#22C55E"
                                : product.achievementRate >= 0.8
                                ? "#F59E0B"
                                : "#EF4444",
                          }}
                        />
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-sm text-[#64748B]">
                    {totalSales > 0 ? ((product.sales / totalSales) * 100).toFixed(1) : 0}%
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Top/Bottom Products Component
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

  return (
    <div className={`rounded-[28px] border border-white/75 bg-white/94 p-6 shadow-[0_22px_60px_rgba(15,23,42,0.09)] ring-1 ring-slate-900/5 ${type === "bottom" ? "border-l-4 border-l-[#EF4444]" : ""}`}>
      <h2 className="text-lg font-semibold text-[#0F172A]">{title}</h2>
      <p className="mt-1 text-sm text-[#64748B]">
        {type === "top" ? "Best performing products by sales" : "Products needing attention"}
      </p>
      <div className="mt-4 space-y-3">
        {products.length === 0 ? (
          <p className="text-sm text-[#64748B]">No data available</p>
        ) : (
          products.map((product) => (
            <div
              key={product.product}
              onClick={() => onProductClick(product.product)}
              className="group cursor-pointer rounded-2xl border border-transparent p-3 transition hover:border-[#FED7AA] hover:bg-[#FFF7ED]/70"
            >
              <div className="flex items-center justify-between mb-2">
                <div>
                  <p className="font-medium text-[#0F172A] text-sm">{product.product}</p>
                  <p className="text-xs text-[#64748B]">{product.family}</p>
                </div>
                <div className="text-right">
                  <p className="font-semibold text-[#0F172A] text-sm">{formatCurrency(product.sales)}</p>
                  <p
                    className={`text-xs font-medium ${
                      product.achievementRate >= 1
                        ? "text-[#22C55E]"
                        : product.achievementRate >= 0.8
                        ? "text-[#F59E0B]"
                        : "text-[#EF4444]"
                    }`}
                  >
                    {formatPercent(product.achievementRate)}
                  </p>
                </div>
              </div>
              <div className="h-1.5 rounded-full bg-[#F8FAFC] overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500 group-hover:bg-[#F97316]"
                  style={{
                    width: `${(product.sales / maxSales) * 100}%`,
                    backgroundColor: type === "top" ? "#F97316" : "#EF4444",
                  }}
                />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// Product Mix Chart Component
function ProductMixChart({
  data,
  onSegmentClick,
}: {
  data: Array<{ name: string; value: number; contribution: number }>;
  onSegmentClick: (product: string) => void;
}) {
  const COLORS = ["#F97316", "#FB923C", "#FDBA74", "#FED7AA", "#FFEDD5", "#E2E8F0"];

  return (
    <div
      className="mb-8 rounded-[28px] border border-white/75 bg-white/94 p-6 shadow-[0_22px_60px_rgba(15,23,42,0.09)] ring-1 ring-slate-900/5"
    >
      <h2 className="text-lg font-semibold text-[#0F172A]">Product Mix</h2>
      <p className="mt-1 text-sm text-[#64748B]">Contribution of top products to total sales</p>
      <div className="mt-6 flex items-center gap-8">
        <div className="h-[250px] w-[250px]">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={100}
                paddingAngle={2}
                dataKey="value"
              >
                {data.map((entry, index) => (
                  <Cell
                    key={`cell-${index}`}
                    fill={COLORS[index % COLORS.length]}
                    className="cursor-pointer hover:opacity-80 transition"
                onClick={() =>
                  entry.name !== "Remaining Products" && onSegmentClick(entry.name)
                }
                  />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  backgroundColor: "#FFFFFF",
                  border: "1px solid #E2E8F0",
                  borderRadius: "8px",
                  boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
                }}
                formatter={(value, name, entry) => {
                  const payload = entry?.payload as TooltipEntryPayload | undefined;
                  const matched = data.find((datum) => datum.name === (payload?.name ?? name));
                  const numericValue = typeof value === "number" ? value : Number(value) || 0;
                  return [
                    matched
                      ? `${formatCurrency(numericValue)} (${matched.contribution.toFixed(1)}%)`
                      : formatCurrency(numericValue),
                    name,
                  ];
                }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="flex-1 space-y-2">
          {data.map((entry, index) => (
            <div
              key={entry.name}
              onClick={() =>
                entry.name !== "Remaining Products" && onSegmentClick(entry.name)
              }
              className="flex cursor-pointer items-center justify-between rounded-2xl border border-transparent p-2 transition hover:border-[#FED7AA] hover:bg-[#FFF7ED]/70"
            >
              <div className="flex items-center gap-2">
                <div
                  className="h-3 w-3 rounded-full"
                  style={{ backgroundColor: COLORS[index % COLORS.length] }}
                />
                <span className="text-sm text-[#0F172A]">{entry.name}</span>
              </div>
              <span className="text-sm font-medium text-[#0F172A]">{entry.contribution.toFixed(1)}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Performance Insights Component
function PerformanceInsights({
  insights,
}: {
  insights: Array<{
    type: "positive" | "warning" | "risk" | "info";
    title: string;
    description: string;
  }>;
}) {
  const getIcon = (type: string) => {
    switch (type) {
      case "positive":
        return CheckCircle;
      case "warning":
        return AlertTriangle;
      case "risk":
        return AlertCircle;
      case "info":
        return Info;
      default:
        return Info;
    }
  };

  const getBorderColor = (type: string) => {
    switch (type) {
      case "positive":
        return "border-l-[#22C55E]";
      case "warning":
        return "border-l-[#F59E0B]";
      case "risk":
        return "border-l-[#EF4444]";
      case "info":
        return "border-l-[#64748B]";
      default:
        return "border-l-[#64748B]";
    }
  };

  const getIconColor = (type: string) => {
    switch (type) {
      case "positive":
        return "text-[#22C55E]";
      case "warning":
        return "text-[#F59E0B]";
      case "risk":
        return "text-[#EF4444]";
      case "info":
        return "text-[#64748B]";
      default:
        return "text-[#64748B]";
    }
  };

  return (
    <div className="rounded-[28px] border border-white/75 bg-white/94 p-6 shadow-[0_22px_60px_rgba(15,23,42,0.09)] ring-1 ring-slate-900/5">
      <h2 className="text-lg font-semibold text-[#0F172A]">Performance Insights</h2>
      <p className="mt-1 text-sm text-[#64748B]">AI-powered analysis of your sales performance</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {insights.map((insight, index) => {
          const Icon = getIcon(insight.type);
          return (
            <div
              key={index}
              className={`border-l-4 ${getBorderColor(insight.type)} rounded-2xl border border-[#E2E8F0] bg-white/95 p-4 shadow-[0_12px_28px_rgba(15,23,42,0.06)] transition hover:-translate-y-0.5 hover:shadow-[0_18px_40px_rgba(15,23,42,0.10)]`}
            >
              <div className="flex items-start gap-3">
                <Icon className={`h-5 w-5 mt-0.5 ${getIconColor(insight.type)}`} />
                <div>
                  <p className="font-medium text-[#0F172A] text-sm">{insight.title}</p>
                  <p className="mt-1 text-xs text-[#64748B]">{insight.description}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Loading State Component
function LoadingState() {
  return (
    <div className="min-h-screen bg-[#F8FAFC]">
      <div className="mx-auto max-w-7xl px-6 py-8">
        <div className="mb-8">
          <div className="h-8 w-48 bg-[#E2E8F0] rounded animate-pulse" />
          <div className="mt-2 h-4 w-96 bg-[#E2E8F0] rounded animate-pulse" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-32 bg-[#E2E8F0] rounded-xl animate-pulse" />
          ))}
        </div>
        <div className="h-[300px] bg-[#E2E8F0] rounded-xl animate-pulse mb-8" />
        <div className="h-[400px] bg-[#E2E8F0] rounded-xl animate-pulse" />
      </div>
    </div>
  );
}

// Empty State Component
function EmptyState() {
  return (
    <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center">
      <div className="text-center">
        <div className="mx-auto h-16 w-16 rounded-full bg-[#F8FAFC] flex items-center justify-center">
          <Package className="h-8 w-8 text-[#64748B]" />
        </div>
        <h2 className="mt-4 text-lg font-semibold text-[#0F172A]">No Sales Data Available</h2>
        <p className="mt-2 text-sm text-[#64748B]">
          Adjust your filters or check your data linkage to view sales performance.
        </p>
      </div>
    </div>
  );
}

export { SalesPerformancePage };
export default SalesPerformancePage;
