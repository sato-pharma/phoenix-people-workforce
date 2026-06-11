"use client";

import {
  AlertTriangle,
  BarChart3,
  Boxes,
  Layers,
  MapPin,
  Package,
  ShieldAlert,
  ShieldCheck,
  Table2,
  TrendingDown,
  TrendingUp,
  Truck,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { InsightCard } from "@/components/cards/insight-card";
import { KPICard } from "@/components/cards/kpi-card";
import { StackedChart } from "@/components/charts/stacked-chart";
import { SiFilterBar } from "@/components/sales/intelligence/si-filter-bar";
import { SiGeoHeatmap } from "@/components/sales/intelligence/si-geo-heatmap";
import { SiTrendChart } from "@/components/sales/intelligence/si-trend-chart";
import { formatCurrency, formatNumber } from "@/lib/sales/format";
import type { SiCustomerInsights, SiDashboardBundle, SiRanked } from "@/lib/sales/intelligence/types";

const LINE_COLORS = ["#F97316", "#0F172A", "#3B82F6", "#22C55E", "#8B5CF6", "#EF4444", "#14B8A6", "#EAB308"];

function pctDelta(points: { value: number }[]): string {
  if (points.length < 2) return "Single month";
  const latest = points[points.length - 1].value;
  const prior = points[points.length - 2].value;
  if (prior <= 0) return "New month";
  const delta = ((latest - prior) / prior) * 100;
  return `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}% MoM`;
}

function ShareBars({ rows, max }: { rows: SiRanked[]; max: number }) {
  return (
    <div className="space-y-2 p-4 md:p-5">
      {rows.map((row) => (
        <div className="flex items-center gap-3" key={row.name}>
          <span className="w-40 shrink-0 truncate text-xs font-bold text-[#0F172A]" title={row.name}>{row.name}</span>
          <div className="relative h-6 flex-1 bg-[#F1F5F9]">
            <div className="absolute inset-y-0 left-0 bg-[#F97316]" style={{ width: `${Math.max((row.value / max) * 100, 1.5)}%` }} />
          </div>
          <span className="w-24 shrink-0 text-right text-xs font-black text-[#0F172A]">{formatCurrency(row.value)}</span>
          <span className="w-12 shrink-0 text-right text-[11px] font-bold text-[#64748B]">{(row.share * 100).toFixed(1)}%</span>
        </div>
      ))}
    </div>
  );
}

export function SalesIntelligenceDashboard({ bundle, error }: { bundle: SiDashboardBundle | null; error: string | null }) {
  if (error || !bundle) {
    return (
      <div className="min-h-[60vh] p-5">
        <AdminCallout tone="danger">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="font-semibold">Sales Intelligence could not load.</p>
            <p className="mt-1 text-sm">{error ?? "No data available."}</p>
          </div>
        </AdminCallout>
      </div>
    );
  }
  return <DashboardInner bundle={bundle} />;
}

function DashboardInner({ bundle }: { bundle: SiDashboardBundle }) {
  const { kpis, products, geography, distributors, trend, access } = bundle;
  const spark = trend.points.map((point) => point.value);
  const momDelta = pctDelta(trend.points);
  const momPositive = momDelta.startsWith("+");

  const lineMixData = useMemo(
    () => products.lineMix.slice(0, 8).map((line, index) => ({
      name: line.name,
      value: Math.round(line.value),
      color: LINE_COLORS[index % LINE_COLORS.length],
      percent: Number((line.share * 100).toFixed(1)),
    })),
    [products.lineMix],
  );
  const topProducts = products.products.slice(0, 12);
  const maxDistributor = Math.max(...distributors.distributors.map((distributor) => distributor.value), 1);

  // Customer insights are the heaviest aggregate — load them lazily after first paint. State is
  // keyed by (period, restricted) so "loading" is derived (no synchronous setState in the effect)
  // and a stale month's customers never flash under a newly selected month.
  const customerKey = `${bundle.period ?? ""}|${access.restrictedIncluded ? "1" : "0"}`;
  const [customerState, setCustomerState] = useState<{ key: string; data: SiCustomerInsights | null }>({ key: "", data: null });
  const customersLoading = customerState.key !== customerKey;
  const customers = customerState.key === customerKey ? customerState.data : null;
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (bundle.period) params.set("period", bundle.period);
    if (access.restrictedIncluded) params.set("includeRestricted", "1");
    fetch(`/api/sales/intelligence/customers?${params.toString()}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (!cancelled) setCustomerState({ key: customerKey, data: payload?.success ? (payload.data as SiCustomerInsights) : null });
      })
      .catch(() => {
        if (!cancelled) setCustomerState({ key: customerKey, data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [customerKey, bundle.period, access.restrictedIncluded]);

  const insights = useMemo(() => {
    const items: { l: string; s: string; c: string }[] = [];
    if (products.lineMix[0]) {
      items.push({ l: `${products.lineMix[0].name} leads the mix`, s: `${(products.lineMix[0].share * 100).toFixed(1)}% of value`, c: "bg-orange-100 text-orange-600" });
    }
    if (geography.regions[0]) {
      items.push({ l: `${geography.regions[0].name} is the top region`, s: `${formatCurrency(geography.regions[0].value)} · ${(geography.regions[0].share * 100).toFixed(1)}%`, c: "bg-blue-100 text-blue-600" });
    }
    if (distributors.distributors[0] && distributors.distributors[0].share > 0.4) {
      items.push({ l: `Distributor concentration risk`, s: `${distributors.distributors[0].name} carries ${(distributors.distributors[0].share * 100).toFixed(0)}% of value`, c: "bg-rose-100 text-rose-600" });
    }
    if (!kpis.monthComplete) {
      items.push({ l: `${bundle.period} is incomplete`, s: `Missing: ${kpis.missingDistributors.join(", ") || "—"}`, c: "bg-amber-100 text-amber-600" });
    }
    if (topProducts[0]) {
      items.push({ l: `${topProducts[0].name} is the top product`, s: `${formatCurrency(topProducts[0].value)}`, c: "bg-emerald-100 text-emerald-600" });
    }
    return items;
  }, [products.lineMix, geography.regions, distributors.distributors, kpis.monthComplete, kpis.missingDistributors, bundle.period, topProducts]);

  return (
    <div className="space-y-5 p-4 sm:p-5 xl:p-6">
      <AdminPageHero
        actions={(
          <div className="flex flex-wrap gap-2">
            <Link href="/sales-intelligence/details">
              <span className="inline-flex h-10 items-center gap-2 border border-white/20 bg-white/10 px-3 text-xs font-black text-white transition hover:bg-white/20">
                <Table2 className="h-4 w-4" /> Sales Details
              </span>
            </Link>
            <Link href="/sales-intelligence/data-quality">
              <span className="inline-flex h-10 items-center gap-2 border border-white/20 bg-white/10 px-3 text-xs font-black text-white transition hover:bg-white/20">
                <ShieldCheck className="h-4 w-4" /> Data Quality
              </span>
            </Link>
          </div>
        )}
        badges={(
          <>
            <AdminInsightChip tone="orange">{bundle.period ?? "No month"}</AdminInsightChip>
            <AdminInsightChip>{formatNumber(kpis.distributorCount)} distributors</AdminInsightChip>
            <AdminInsightChip>{formatNumber(kpis.lineCount)} lines</AdminInsightChip>
            {access.restrictedIncluded ? (
              <AdminInsightChip tone="slate"><ShieldAlert className="mr-1 inline h-3 w-3" />Including Lacto Basic 1 &amp; 2</AdminInsightChip>
            ) : (
              <AdminInsightChip tone="emerald">Restricted products excluded</AdminInsightChip>
            )}
          </>
        )}
        description="Distributor-sourced sales, scoped to your line and region and shown by name. Restricted products are excluded by default."
        eyebrow="Sales Intelligence"
        icon={<BarChart3 className="h-5 w-5" />}
        title="Executive Sales Dashboard"
      />

      <SiFilterBar access={access} availablePeriods={bundle.availablePeriods} period={bundle.period} />

      {!kpis.monthComplete && (
        <AdminCallout tone="warning">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="font-semibold">{bundle.period} is incomplete.</p>
            <p className="mt-1 text-sm">
              Not every expected distributor has uploaded a validated file yet. Missing: {kpis.missingDistributors.join(", ") || "—"}.
              Totals below understate the real month.
            </p>
          </div>
        </AdminCallout>
      )}

      {/* KPI strip */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <KPICard delta={momDelta} icon={momPositive ? TrendingUp : TrendingDown} label="Net Sales" spark={spark} tone="orange" value={formatCurrency(kpis.totals.value)} />
        <KPICard delta={`${formatNumber(kpis.totals.units)} units`} icon={Boxes} label="Total Units" spark={spark} tone="blue" value={formatNumber(kpis.totals.units)} />
        <KPICard delta="in scope" icon={Package} label="Products" spark={spark} tone="violet" value={formatNumber(kpis.productCount)} />
        <KPICard delta="reporting" icon={Truck} label="Distributors" spark={spark} tone="emerald" value={formatNumber(kpis.distributorCount)} />
        <KPICard delta={kpis.topRegion?.name ?? "—"} icon={MapPin} label="Top Region" spark={spark} tone="slate" value={kpis.topRegion ? formatCurrency(kpis.topRegion.value) : "—"} />
        <KPICard delta={kpis.topProduct?.name ?? "—"} icon={Layers} label="Top Product" spark={spark} tone="rose" value={kpis.topProduct ? formatCurrency(kpis.topProduct.value) : "—"} />
      </div>

      {/* Trend */}
      <AdminTableShell description="Monthly net sales value (bars) and units (line). Amber bars are incomplete months." title="Sales Trend">
        <SiTrendChart points={trend.points} />
      </AdminTableShell>

      {/* Product mix + top products */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <AdminTableShell description="Share of net sales value by line." title="Line Mix">
          <div className="p-5">
            <StackedChart centerLabel={`${(kpis.totals.value / 1_000_000).toFixed(1)}M`} centerSub="Total" data={lineMixData} type="donut" />
          </div>
        </AdminTableShell>
        <AdminTableShell description="Top products by net sales value, with contribution and running share." title="Top Products">
          <div className="overflow-x-auto p-4 md:p-5">
            <table className="w-full min-w-[460px] text-left text-sm">
              <thead>
                <tr>
                  <th className="px-3 py-2 text-xs font-black uppercase tracking-wide">Product</th>
                  <th className="px-3 py-2 text-xs font-black uppercase tracking-wide">Line</th>
                  <th className="px-3 py-2 text-right text-xs font-black uppercase tracking-wide">Value</th>
                  <th className="px-3 py-2 text-right text-xs font-black uppercase tracking-wide">Share</th>
                  <th className="px-3 py-2 text-right text-xs font-black uppercase tracking-wide">Cum.</th>
                </tr>
              </thead>
              <tbody>
                {topProducts.map((product) => (
                  <tr key={`${product.name}:${product.officialLine}`}>
                    <td className="px-3 py-2 font-bold text-[#0F172A]">{product.name}</td>
                    <td className="px-3 py-2 text-[#64748B]">{product.officialLine}</td>
                    <td className="px-3 py-2 text-right font-black text-[#0F172A]">{formatCurrency(product.value)}</td>
                    <td className="px-3 py-2 text-right text-[#64748B]">{(product.share * 100).toFixed(1)}%</td>
                    <td className="px-3 py-2 text-right text-[#94A3B8]">{(product.cumulativeShare * 100).toFixed(0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminTableShell>
      </div>

      {/* Geography heatmap */}
      <AdminTableShell description="Net sales value by area, shaded by intensity and grouped by region. Hover for detail." title="Geographic Performance">
        <SiGeoHeatmap areas={geography.areas} regions={geography.regions} />
      </AdminTableShell>

      {/* Distributor performance */}
      <AdminTableShell description="Net sales value by distributor with contribution share." title="Distributor Performance">
        <ShareBars max={maxDistributor} rows={distributors.distributors} />
      </AdminTableShell>

      {/* Customers + executive insights */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <AdminTableShell
          description={customers ? `${formatNumber(customers.customerCount)} active customers · top 10 hold ${(customers.top10Share * 100).toFixed(0)}% of value` : "Loading customer concentration…"}
          title="Top Customers / Pharmacies"
        >
          <div className="overflow-x-auto p-4 md:p-5">
            {customersLoading ? (
              <p className="py-8 text-center text-sm text-[#94A3B8]">Loading customers…</p>
            ) : !customers || customers.customers.length === 0 ? (
              <p className="py-8 text-center text-sm text-[#94A3B8]">No customers in scope for this month.</p>
            ) : (
              <table className="w-full min-w-[460px] text-left text-sm">
                <thead>
                  <tr>
                    <th className="px-3 py-2 text-xs font-black uppercase tracking-wide">Customer</th>
                    <th className="px-3 py-2 text-xs font-black uppercase tracking-wide">Distributor</th>
                    <th className="px-3 py-2 text-right text-xs font-black uppercase tracking-wide">Value</th>
                    <th className="px-3 py-2 text-right text-xs font-black uppercase tracking-wide">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {customers.customers.slice(0, 15).map((customer, index) => (
                    <tr key={`${customer.name}:${customer.distributorName}:${index}`}>
                      <td className="px-3 py-2 font-bold text-[#0F172A]">{customer.name}</td>
                      <td className="px-3 py-2 text-[#64748B]">{customer.distributorName}</td>
                      <td className="px-3 py-2 text-right font-black text-[#0F172A]">{formatCurrency(customer.value)}</td>
                      <td className="px-3 py-2 text-right text-[#64748B]">{(customer.share * 100).toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </AdminTableShell>

        <InsightCard
          className="h-fit"
          insights={insights.length > 0 ? insights : [{ l: "No signals yet", s: "Upload a validated month to generate insights", c: "bg-slate-100 text-slate-500" }]}
          title="Executive Insights"
        />
      </div>
    </div>
  );
}
