"use client";

import {
  Activity,
  Banknote,
  BarChart3,
  Boxes,
  Building2,
  Filter,
  Gauge,
  Layers,
  Lightbulb,
  MapPinned,
  Network,
  PackageSearch,
  RotateCcw,
  Truck,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, Pie, PieChart, Tooltip, XAxis, YAxis } from "recharts";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminStatCard,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { SafeResponsiveContainer } from "@/components/charts/safe-responsive-container";
import { MultiSelectFilter, type MultiSelectFilterMode } from "@/components/ui/multi-select-filter";
import { SortableTh, TableNoResults, TableSearchInput, useSortableTable, visibleMax } from "@/components/ui/sortable-table";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/sales/format";
import { periodProseLabel } from "@/lib/sales/periods";
import type { SosCustomerRow, SosDashboardData, SosDistributorRow, SosGroupRow, SosOption } from "@/lib/sales/sos-dashboard";

const CHANNEL_COLORS = ["#F97316", "#0EA5E9", "#8B5CF6", "#10B981", "#F43F5E", "#FACC15", "#14B8A6", "#64748B", "#EC4899", "#22D3EE"];

type Filters = {
  period: string;
  line: string;
  distributors: string[];
  regions: string[];
  areas: string[];
  products: string[];
};

const EMPTY_FILTERS: Filters = { period: "", line: "", distributors: [], regions: [], areas: [], products: [] };

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
    <div className={`rounded-2xl border border-slate-200/90 bg-white/95 p-5 shadow-[0_12px_30px_rgba(15,23,42,0.06)] ${className ?? ""}`}>
      <div className="mb-4 flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-orange-50 to-orange-100 text-orange-600">{icon}</span>
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
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-xl">
      <p className="mb-1 text-[10px] font-black uppercase tracking-wider text-slate-400">{String(label ?? "")}</p>
      <div className="space-y-1.5">
        {payload.map((entry, index) => {
          const name = String(entry.name ?? "");
          const raw = Number(entry.value ?? 0);
          const isUnits = /unit/i.test(name);
          return (
            <div key={index} className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: String(entry.color ?? "#94A3B8") }} />
                <span className="text-[11px] font-bold text-slate-600">{name}:</span>
              </div>
              <span className="text-[11px] font-black text-slate-900">{isUnits ? formatNumber(raw) : formatCurrency(raw)}</span>
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
  onChange,
  render,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  options: string[];
  onChange: (next: string) => void;
  render?: (value: string) => string;
}) {
  return (
    <label className="flex h-[58px] cursor-pointer flex-col justify-center rounded-[6px] border border-[#E2E8F0] bg-white px-3 py-2 shadow-sm transition focus-within:border-[#FDBA74] hover:border-[#FDBA74]">
      <span className="mb-1 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-[#94A3B8]">
        {icon}
        {label}
      </span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="w-full truncate bg-transparent text-sm font-black text-[#0F172A] outline-none">
        <option value="">All</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {render ? render(option) : option}
          </option>
        ))}
      </select>
    </label>
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

export function SosDashboard({ initialData, initialError }: { initialData: SosDashboardData | null; initialError: string | null }) {
  const [data, setData] = useState<SosDashboardData | null>(initialData);
  const [error, setError] = useState<string | null>(initialError);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [distMode, setDistMode] = useState<MultiSelectFilterMode>("include");
  const [regionMode, setRegionMode] = useState<MultiSelectFilterMode>("include");
  const [areaMode, setAreaMode] = useState<MultiSelectFilterMode>("include");
  const [productMode, setProductMode] = useState<MultiSelectFilterMode>("include");

  // Stable filter option lists, captured once from the unfiltered server load.
  const [options] = useState(
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

  const queryKey = useMemo(() => {
    const params = new URLSearchParams();
    if (filters.period) params.set("period", filters.period);
    if (filters.line) params.set("line", filters.line);
    const dist = effectiveList(options.distributors, filters.distributors, distMode);
    const region = effectiveList(options.regions, filters.regions, regionMode);
    const area = effectiveList(options.areas, filters.areas, areaMode);
    const product = effectiveList(options.products, filters.products, productMode);
    if (dist.length) params.set("distributors", dist.join(","));
    if (region.length) params.set("regions", region.join(","));
    if (area.length) params.set("areas", area.join(","));
    if (product.length) params.set("products", product.join(","));
    return params.toString();
  }, [filters, options, distMode, regionMode, areaMode, productMode]);

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
        setError(null);
      })
      .catch((fetchError: unknown) => {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") return;
        setError(fetchError instanceof Error ? fetchError.message : "Failed to load source-of-sales dashboard.");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [queryKey]);

  const summary = data?.summary;
  const byDistributor = data?.byDistributor ?? [];
  const byRegion = data?.byRegion ?? [];
  const byProduct = data?.byProduct ?? [];
  const byArea = data?.byArea ?? [];
  const topBricks = data?.topBricks ?? [];
  const topCustomers = data?.topCustomers ?? [];
  const trend = useMemo(() => data?.trend ?? [], [data]);
  const channelMix = data?.channelMix ?? [];
  const whiteSpaceAreas = data?.whiteSpaceAreas ?? [];
  const insights = data?.insights ?? [];

  const trendChartData = useMemo(
    () => trend.map((point) => ({ period: periodProseLabel(point.period), Value: Math.round(point.value), Units: Math.round(point.units) })),
    [trend],
  );

  const activeFilterCount =
    filters.distributors.length +
    filters.regions.length +
    filters.areas.length +
    filters.products.length +
    [filters.period, filters.line].filter(Boolean).length;

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

  const hasData = !error && !!summary && summary.totalValue > 0;
  const topDistributor = byDistributor[0];

  return (
    <div className="space-y-6 pb-12">
      <AdminPageHero
        eyebrow="Sales Intelligence"
        icon={<Network className="h-4 w-4" />}
        title="M.Closing Dashboard"
        description="Monthly closing data from the Sales Queue pipeline — channels, distributors, regions, products, customers and trends."
        badges={
          <>
            <AdminInsightChip tone="orange">{data?.period ? periodProseLabel(data.period) : "No data"}</AdminInsightChip>
            {summary ? <AdminInsightChip tone="emerald">{compactEGP(summary.totalValue)}</AdminInsightChip> : null}
            {loading ? <AdminInsightChip tone="slate">Updating…</AdminInsightChip> : null}
          </>
        }
        aside={
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-white/15 bg-white/10 px-4 py-3 backdrop-blur">
              <p className="text-[10px] font-black uppercase tracking-[0.15em] text-slate-300">Total Value</p>
              <p className="mt-1 text-xl font-black text-white">{summary ? compactEGP(summary.totalValue) : "—"}</p>
            </div>
            <div className="rounded-xl border border-white/15 bg-white/10 px-4 py-3 backdrop-blur">
              <p className="text-[10px] font-black uppercase tracking-[0.15em] text-slate-300">Top Distributor</p>
              <p className="mt-1 truncate text-sm font-black text-white">{topDistributor?.label ?? "—"}</p>
            </div>
          </div>
        }
      />

      {/* Filters */}
      <div className="rounded-2xl border border-slate-200/90 bg-white/95 p-4 shadow-[0_12px_30px_rgba(15,23,42,0.06)]">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-black text-slate-900">
            <Filter className="h-4 w-4 text-orange-500" />
            Filters
            {activeFilterCount > 0 ? <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-black text-orange-700">{activeFilterCount} active</span> : null}
          </div>
          {activeFilterCount > 0 ? (
            <button
              type="button"
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                setDistMode("include");
                setRegionMode("include");
                setAreaMode("include");
                setProductMode("include");
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-bold text-slate-600 transition hover:border-orange-300 hover:text-orange-600"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Reset all
            </button>
          ) : null}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <FilterSelect
            label="Month"
            icon={<BarChart3 className="h-3 w-3" />}
            value={filters.period}
            options={options.periods}
            onChange={(next) => setFilters((current) => ({ ...current, period: next }))}
            render={(value) => periodProseLabel(value)}
          />
          <FilterSelect label="Line" icon={<Layers className="h-3 w-3" />} value={filters.line} options={options.lines} onChange={(next) => setFilters((current) => ({ ...current, line: next }))} />
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
          {/* KPI grid */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <AdminStatCard tone="orange" icon={<Banknote className="h-5 w-5" />} label="Total Value" value={compactEGP(summary.totalValue)} description={formatCurrency(summary.totalValue)} />
            <AdminStatCard tone="violet" icon={<Boxes className="h-5 w-5" />} label="Total Units" value={formatNumber(summary.totalUnits)} description="invoiced units" />
            <AdminStatCard tone="blue" icon={<Gauge className="h-5 w-5" />} label="Avg Price / Unit" value={compactEGP(summary.avgPricePerUnit)} description="value ÷ units" />
            <AdminStatCard tone="emerald" icon={<Truck className="h-5 w-5" />} label="Distributors" value={formatNumber(summary.distributorCount)} description="active channels" />
            <AdminStatCard tone="blue" icon={<PackageSearch className="h-5 w-5" />} label="Products" value={formatNumber(summary.productCount)} description="SKUs sold" />
            <AdminStatCard tone="violet" icon={<Users className="h-5 w-5" />} label="Customers" value={formatNumber(summary.customerCount)} description="distributor clients" />
            <AdminStatCard tone="orange" icon={<Building2 className="h-5 w-5" />} label="Direct Share" value={formatPercent(summary.directShare, { digits: 1 })} description={`${compactEGP(summary.directValue)} direct`} />
            <AdminStatCard
              tone={summary.totalAreas > 0 && summary.areasReached / summary.totalAreas >= 0.75 ? "emerald" : "orange"}
              icon={<MapPinned className="h-5 w-5" />}
              label="Area Coverage"
              value={`${summary.areasReached}/${summary.totalAreas}`}
              description={`${summary.bricksReached} bricks reached`}
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
                <Bar yAxisId="left" dataKey="Value" fill="#F97316" radius={[3, 3, 0, 0]} barSize={22} />
                <Line yAxisId="right" type="monotone" dataKey="Units" stroke="#0EA5E9" strokeWidth={3} dot={{ r: 3, fill: "#0EA5E9" }} />
              </ComposedChart>
            </SafeResponsiveContainer>
          </ChartCard>

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
                    <div key={row.code} className="flex items-center gap-3">
                      <span className="w-28 shrink-0 truncate text-xs font-bold text-slate-700" title={row.label}>{row.label}</span>
                      <div className="flex-1"><Bar2 value={row.value} max={regionMax} color="#0EA5E9" /></div>
                      <span className="w-24 shrink-0 text-right text-xs font-black text-slate-900">{compactEGP(row.value)}</span>
                      <span className="w-12 shrink-0 text-right text-[11px] font-bold text-slate-500">{formatPercent(row.share, { digits: 0 })}</span>
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
                    <div key={row.code} className="flex items-center gap-3">
                      <span className="w-28 shrink-0 truncate text-xs font-bold text-slate-700" title={row.label}>{row.label}</span>
                      <div className="flex-1"><Bar2 value={row.value} max={areaMax} color="#8B5CF6" /></div>
                      <span className="w-24 shrink-0 text-right text-xs font-black text-slate-900">{compactEGP(row.value)}</span>
                      <span className="w-12 shrink-0 text-right text-[11px] font-bold text-slate-500">{formatPercent(row.share, { digits: 0 })}</span>
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
                      <span key={row.code} className="rounded-md border border-rose-200 bg-rose-50/60 px-2.5 py-1 text-xs font-bold text-rose-700" title={row.region ?? undefined}>
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
            description="Channels ranked by value, with reach across regions / areas / products"
            action={<TableSearchInput value={distributorTable.query} onChange={distributorTable.setQuery} onClear={distributorTable.clearQuery} placeholder="Search distributors…" className="w-full sm:w-64" />}
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[#020617] text-white">
                  <tr>
                    <SortableTh label="Distributor" sortKey="label" sort={distributorTable.sort} onSort={distributorTable.toggleSort} />
                    <SortableTh label="Value" sortKey="value" sort={distributorTable.sort} onSort={distributorTable.toggleSort} align="right" />
                    <SortableTh label="Units" sortKey="units" sort={distributorTable.sort} onSort={distributorTable.toggleSort} align="right" />
                    <SortableTh label="Regions" sortKey="regions" sort={distributorTable.sort} onSort={distributorTable.toggleSort} align="right" />
                    <SortableTh label="Areas" sortKey="areas" sort={distributorTable.sort} onSort={distributorTable.toggleSort} align="right" />
                    <SortableTh label="Products" sortKey="products" sort={distributorTable.sort} onSort={distributorTable.toggleSort} align="right" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {distributorTable.rows.length === 0 ? (
                    <TableNoResults colSpan={6} filtered={distributorTable.isFiltered} label="distributors" />
                  ) : (
                    distributorTable.rows.map((row) => (
                      <tr key={row.code} className="transition hover:bg-orange-50/40">
                        <td className="px-3 py-2.5 font-bold text-slate-900">{row.label}</td>
                        <td className="px-3 py-2.5 text-right">
                          <div className="font-black text-slate-900">{compactEGP(row.value)}</div>
                          <Bar2 value={row.value} max={distMax} color="#F97316" />
                        </td>
                        <td className="px-3 py-2.5 text-right text-slate-600">{formatNumber(row.units)}</td>
                        <td className="px-3 py-2.5 text-right text-slate-600">{formatNumber(row.regions)}</td>
                        <td className="px-3 py-2.5 text-right text-slate-600">{formatNumber(row.areas)}</td>
                        <td className="px-3 py-2.5 text-right text-slate-600">{formatNumber(row.products)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </AdminTableShell>

          {/* Product + Customer tables */}
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <AdminTableShell
              title="Product Performance"
              description="Products ranked by distributor value"
              action={<TableSearchInput value={productTable.query} onChange={productTable.setQuery} onClear={productTable.clearQuery} placeholder="Search products…" className="w-full sm:w-56" />}
            >
              <div className="max-h-[460px] overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-[#020617] text-white">
                    <tr>
                      <SortableTh label="Product" sortKey="label" sort={productTable.sort} onSort={productTable.toggleSort} />
                      <SortableTh label="Line" sortKey="line" sort={productTable.sort} onSort={productTable.toggleSort} />
                      <SortableTh label="Value" sortKey="value" sort={productTable.sort} onSort={productTable.toggleSort} align="right" />
                      <SortableTh label="Units" sortKey="units" sort={productTable.sort} onSort={productTable.toggleSort} align="right" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {productTable.rows.length === 0 ? (
                      <TableNoResults colSpan={4} filtered={productTable.isFiltered} label="products" />
                    ) : (
                      productTable.rows.map((row) => (
                        <tr key={row.code} className="transition hover:bg-orange-50/40">
                          <td className="px-3 py-2.5 font-bold text-slate-900">{row.label}</td>
                          <td className="px-3 py-2.5 text-slate-600">{row.line ?? "—"}</td>
                          <td className="px-3 py-2.5 text-right">
                            <div className="font-black text-slate-900">{compactEGP(row.value)}</div>
                            <Bar2 value={row.value} max={productMax} color="#8B5CF6" />
                          </td>
                          <td className="px-3 py-2.5 text-right text-slate-600">{formatNumber(row.units)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </AdminTableShell>

            <AdminTableShell
              title="Top Customers"
              description={`Top customers by value${data ? ` — top 10 = ${formatPercent(data.customerTop10Share, { digits: 1 })} of customer value` : ""}`}
              action={<TableSearchInput value={customerTable.query} onChange={customerTable.setQuery} onClear={customerTable.clearQuery} placeholder="Search customers…" className="w-full sm:w-56" />}
            >
              <div className="max-h-[460px] overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-[#020617] text-white">
                    <tr>
                      <SortableTh label="Customer" sortKey="name" sort={customerTable.sort} onSort={customerTable.toggleSort} />
                      <SortableTh label="Distributor" sortKey="distributor" sort={customerTable.sort} onSort={customerTable.toggleSort} />
                      <SortableTh label="Region" sortKey="region" sort={customerTable.sort} onSort={customerTable.toggleSort} />
                      <SortableTh label="Value" sortKey="value" sort={customerTable.sort} onSort={customerTable.toggleSort} align="right" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {customerTable.rows.length === 0 ? (
                      <TableNoResults colSpan={4} filtered={customerTable.isFiltered} label="customers" />
                    ) : (
                      customerTable.rows.map((row) => (
                        <tr key={`${row.distributor}-${row.code}`} className="transition hover:bg-orange-50/40">
                          <td className="px-3 py-2.5 font-bold text-slate-900">{row.name}</td>
                          <td className="px-3 py-2.5 text-slate-600">{row.distributor}</td>
                          <td className="px-3 py-2.5 text-slate-600">{row.region}</td>
                          <td className="px-3 py-2.5 text-right font-black text-slate-900">{compactEGP(row.value)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </AdminTableShell>
          </div>

          {/* Top bricks */}
          {topBricks.length > 0 ? (
            <ChartCard title="Top Bricks" subtitle="Highest-value territories (excludes direct)" icon={<MapPinned className="h-4 w-4" />}>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {topBricks.map((row) => (
                  <div key={row.code} className="flex items-center gap-3">
                    <span className="w-32 shrink-0 truncate text-xs font-bold text-slate-700" title={row.label}>{row.label}</span>
                    <div className="flex-1"><Bar2 value={row.value} max={brickMax} color="#10B981" /></div>
                    <span className="w-24 shrink-0 text-right text-xs font-black text-slate-900">{compactEGP(row.value)}</span>
                  </div>
                ))}
              </div>
            </ChartCard>
          ) : null}

          <p className="px-1 text-center text-xs text-slate-400">
            Source-of-Sales distributor invoices for {data?.period ? periodProseLabel(data.period) : "—"}. Confidential products are hidden unless you are CEO / Super Admin.
          </p>
        </>
      ) : null}
    </div>
  );
}
