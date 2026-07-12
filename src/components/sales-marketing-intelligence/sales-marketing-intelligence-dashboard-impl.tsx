"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  BadgeDollarSign,
  Building2,
  Filter,
  Gauge,
  LineChart,
  RefreshCcw,
  Search,
  ShieldCheck,
  Target,
  TrendingUp,
  UsersRound,
} from "lucide-react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
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
import { RoiRefreshPanel } from "@/components/sales-marketing-intelligence/roi-refresh-panel";
import { SafeResponsiveContainer } from "@/components/charts/safe-responsive-container";
import { Button } from "@/components/ui/button";
import type {
  SalesMarketingAttributionQuality,
  SalesMarketingCustomerImpactRow,
  SalesMarketingDashboardFilters,
  SalesMarketingDashboardSnapshot,
  SalesMarketingFilterOption,
  SalesMarketingRecommendedAction,
  SalesMarketingRequestRow,
  SalesMarketingRoiComparisonRow,
  SalesMarketingRoiStatus,
} from "@/lib/sales-marketing-intelligence/types";
import { cn } from "@/lib/utils";

const moneyFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
});

const numberFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
});

function money(value: number) {
  return moneyFormatter.format(Math.round(Number.isFinite(value) ? value : 0));
}

function compactMoney(value: number) {
  const safe = Number.isFinite(value) ? value : 0;
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: safe >= 1_000_000 ? 1 : 0,
    notation: safe >= 1_000_000 ? "compact" : "standard",
  }).format(safe);
}

function number(value: number) {
  return numberFormatter.format(Math.round(Number.isFinite(value) ? value : 0));
}

function percent(value: number) {
  const safe = Number.isFinite(value) ? value : 0;
  return `${Math.round(safe * 100)}%`;
}

function chartFormatter(value: unknown, name: unknown) {
  const label = String(name ?? "");
  const numeric = Number(value ?? 0);
  const isCount = /count|requests/i.test(label);
  return [isCount ? number(numeric) : money(numeric), label];
}

function selectedValue(values: string[]) {
  return values[0] ?? "";
}

function FilterSelect({
  label,
  name,
  options,
  value,
}: {
  label: string;
  name: string;
  options: SalesMarketingFilterOption[];
  value: string;
}) {
  return (
    <label className="min-w-0 space-y-1">
      <span className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">{label}</span>
      <select
        className="h-10 w-full min-w-0 rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none transition focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
        defaultValue={value}
        name={name}
      >
        <option value="">All</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function DashboardFilters({
  basePath,
  chrome,
  filters,
  snapshot,
}: {
  basePath: string;
  chrome: "admin" | "portal";
  filters: SalesMarketingDashboardFilters;
  snapshot: SalesMarketingDashboardSnapshot;
}) {
  // The portal ROI view (Product / Group Product Managers) is product-and-line centric; the
  // distributor filter is corporate-only noise there, so it is hidden in portal chrome.
  const showDistributor = chrome !== "portal";
  return (
    <form
      action={basePath}
      className="grid gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm md:grid-cols-4 xl:grid-cols-[repeat(4,minmax(0,1fr))_repeat(2,145px)_120px_auto_auto]"
    >
      <FilterSelect label="Line" name="line" options={snapshot.filters.lines} value={selectedValue(filters.lines)} />
      <FilterSelect label="Region" name="region" options={snapshot.filters.regions} value={selectedValue(filters.regions)} />
      {showDistributor ? (
        <FilterSelect label="Distributor" name="distributor" options={snapshot.filters.distributors} value={selectedValue(filters.distributors)} />
      ) : null}
      <FilterSelect label="Product" name="product" options={snapshot.filters.products} value={selectedValue(filters.products)} />
      <FilterSelect label="ROI status" name="roiStatus" options={snapshot.filters.roiStatuses} value={selectedValue(filters.roiStatuses)} />
      <FilterSelect label="Attribution" name="attribution" options={snapshot.filters.attributionQualities} value={selectedValue(filters.attributionQualities)} />
      <label className="min-w-0 space-y-1">
        <span className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">From</span>
        <input
          className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none transition focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
          defaultValue={filters.fromMonth}
          name="fromMonth"
          type="month"
        />
      </label>
      <label className="min-w-0 space-y-1">
        <span className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">To</span>
        <input
          className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none transition focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
          defaultValue={filters.toMonth}
          name="toMonth"
          type="month"
        />
      </label>
      <label className="min-w-0 space-y-1">
        <span className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">Rows</span>
        <select
          className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none transition focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
          defaultValue={String(filters.limit)}
          name="limit"
        >
          <option value="25">25</option>
          <option value="50">50</option>
          <option value="100">100</option>
        </select>
      </label>
      <label className="min-w-0 space-y-1 xl:col-span-2">
        <span className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">Customer or request</span>
        <span className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            className="h-10 w-full rounded-md border border-slate-200 bg-white pl-9 pr-3 text-sm font-semibold text-slate-700 outline-none transition focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
            defaultValue={filters.customerSearch}
            name="customer"
            placeholder="Search customer or request"
          />
        </span>
      </label>
      <div className="flex items-end">
        <Button className="h-10 w-full gap-2 rounded-md" type="submit">
          <Filter className="h-4 w-4" />
          Apply
        </Button>
      </div>
      <div className="flex items-end">
        <Link
          className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-4 text-sm font-bold text-slate-600 transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700"
          href={basePath}
        >
          <RefreshCcw className="h-4 w-4" />
          Reset
        </Link>
      </div>
    </form>
  );
}

function ChartPanel({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3">
        <h2 className="text-base font-black tracking-tight text-slate-900">{title}</h2>
        <p className="mt-1 text-xs font-medium leading-5 text-slate-500">{description}</p>
      </div>
      {children}
    </div>
  );
}

function RoiTrendChart({ snapshot }: { snapshot: SalesMarketingDashboardSnapshot }) {
  return (
    <ChartPanel
      description="Marketing cost, required ROI, expected ROI, actual attributed sales, and gap by pay month."
      title="Marketing ROI trend"
    >
      <SafeResponsiveContainer className="h-[310px]" minHeight={310}>
        <ComposedChart data={snapshot.roiTrend} margin={{ bottom: 0, left: 8, right: 10, top: 12 }}>
          <CartesianGrid stroke="#E2E8F0" strokeDasharray="3 3" />
          <XAxis dataKey="period" tick={{ fill: "#64748B", fontSize: 11 }} tickLine={false} />
          <YAxis tick={{ fill: "#64748B", fontSize: 11 }} tickFormatter={(value) => compactMoney(Number(value))} tickLine={false} width={56} />
          <Tooltip formatter={chartFormatter} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="marketingCost" fill="#0EA5E9" name="Marketing cost" radius={[4, 4, 0, 0]} />
          <Bar dataKey="actualSalesValue" fill="#10B981" name="Actual attributed sales" radius={[4, 4, 0, 0]} />
          <Bar dataKey="coverageGap" fill="#F59E0B" name="Coverage gap" radius={[4, 4, 0, 0]} />
          <Line dataKey="requiredRoiValue" dot={false} name="Required ROI" stroke="#EF4444" strokeWidth={2} type="monotone" />
          <Line dataKey="expectedRoiValue" dot={false} name="Expected ROI" stroke="#7C3AED" strokeWidth={2} type="monotone" />
        </ComposedChart>
      </SafeResponsiveContainer>
    </ChartPanel>
  );
}

function RoiStatusBadge({ status }: { status: SalesMarketingRoiStatus }) {
  const config = {
    behind: "border-amber-200 bg-amber-50 text-amber-700",
    no_data: "border-slate-200 bg-slate-50 text-slate-500",
    on_track: "border-emerald-200 bg-emerald-50 text-emerald-700",
  }[status];
  const label = {
    behind: "Behind",
    no_data: "No data",
    on_track: "On track",
  }[status];

  return <span className={cn("inline-flex rounded-sm border px-2 py-0.5 text-[10px] font-black uppercase tracking-wide", config)}>{label}</span>;
}

function AttributionBadge({ quality }: { quality: SalesMarketingAttributionQuality }) {
  const config = {
    brick_fallback: "border-amber-200 bg-amber-50 text-amber-700",
    exact_customer: "border-emerald-200 bg-emerald-50 text-emerald-700",
    mixed: "border-sky-200 bg-sky-50 text-sky-700",
    no_sales: "border-slate-200 bg-slate-50 text-slate-500",
  }[quality];
  const label = {
    brick_fallback: "Brick fallback",
    exact_customer: "Exact",
    mixed: "Mixed",
    no_sales: "No sales",
  }[quality];

  return <span className={cn("inline-flex rounded-sm border px-2 py-0.5 text-[10px] font-black uppercase tracking-wide", config)}>{label}</span>;
}

function ActionBadge({ action }: { action: SalesMarketingRecommendedAction }) {
  const config = {
    follow_up: "border-blue-200 bg-blue-50 text-blue-700",
    high_risk_gap: "border-rose-200 bg-rose-50 text-rose-700",
    mapping_review: "border-amber-200 bg-amber-50 text-amber-700",
    monitor: "border-emerald-200 bg-emerald-50 text-emerald-700",
  }[action];
  const label = {
    follow_up: "Follow up",
    high_risk_gap: "High-risk gap",
    mapping_review: "Mapping review",
    monitor: "Monitor",
  }[action];

  return <span className={cn("inline-flex rounded-sm border px-2 py-0.5 text-[10px] font-black uppercase tracking-wide", config)}>{label}</span>;
}

function DecisionSummaryPanel({ snapshot }: { snapshot: SalesMarketingDashboardSnapshot }) {
  const decision = snapshot.decisionSummary;
  const topRisk = decision.topRiskRequest;

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_1.4fr]">
      <AdminCallout tone={decision.actionRequiredRequests > 0 ? "warning" : "success"}>
        <div className="grid w-full gap-3 text-sm sm:grid-cols-4">
          <span><strong>{number(decision.actionRequiredRequests)}</strong> action needed</span>
          <span><strong>{money(decision.spendAtRisk)}</strong> spend at risk</span>
          <span><strong>{money(decision.coverageGap)}</strong> ROI gap</span>
          <span><strong>{money(decision.noDataSpend)}</strong> no-data spend</span>
        </div>
      </AdminCallout>
      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <h2 className="text-base font-black tracking-tight text-slate-900">Highest priority request</h2>
        </div>
        {topRisk ? (
          <div className="grid gap-3 text-sm md:grid-cols-[1.2fr_repeat(4,minmax(0,1fr))]">
            <div className="min-w-0">
              <p className="truncate font-mono text-xs font-black text-slate-900">{topRisk.requestCode}</p>
              <p className="truncate font-bold text-slate-700">{topRisk.customerName}</p>
              <p className="truncate text-xs font-semibold text-slate-500">{topRisk.line ?? "Unassigned"}</p>
            </div>
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">Required</p>
              <p className="font-black text-slate-900">{money(topRisk.requiredRoiValue)}</p>
            </div>
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">Actual</p>
              <p className="font-black text-emerald-700">{money(topRisk.actualSalesValue)}</p>
            </div>
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">Gap</p>
              <p className="font-black text-amber-700">{money(topRisk.coverageGap)}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <RoiStatusBadge status={topRisk.actualRoiStatus} />
              <ActionBadge action={topRisk.recommendedAction} />
            </div>
          </div>
        ) : (
          <p className="text-sm font-semibold text-slate-500">No approved paid requests are available for the selected filters.</p>
        )}
      </div>
    </div>
  );
}

function RoiComparisonTable({
  description,
  kind,
  rows,
  title,
}: {
  description: string;
  kind: "line" | "product" | "standard";
  rows: SalesMarketingRoiComparisonRow[];
  title: string;
}) {
  return (
    <AdminTableShell description={description} title={title}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1180px] border-collapse text-left text-[13px]">
          <thead className="bg-slate-50 text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">
            <tr>
              <th className="border-r border-slate-100 px-3 py-2.5">{kind === "product" ? "Product" : kind === "line" ? "Line" : "Segment"}</th>
              {kind === "product" ? <th className="border-r border-slate-100 px-3 py-2.5">Line</th> : null}
              <th className="border-r border-slate-100 px-3 py-2.5 text-right">Requests</th>
              <th className="border-r border-slate-100 px-3 py-2.5 text-right">Customers</th>
              <th className="border-r border-slate-100 px-3 py-2.5 text-right">Pharmacies</th>
              <th className="border-r border-slate-100 px-3 py-2.5 text-right">Cost</th>
              <th className="border-r border-slate-100 px-3 py-2.5 text-right">Required</th>
              <th className="border-r border-slate-100 px-3 py-2.5 text-right">Actual</th>
              <th className="border-r border-slate-100 px-3 py-2.5 text-right">Gap</th>
              <th className="border-r border-slate-100 px-3 py-2.5 text-right">Coverage</th>
              <th className="px-3 py-2.5 text-right">Behind / No data</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-center text-sm font-semibold text-slate-500" colSpan={kind === "product" ? 11 : 10}>
                  No ROI comparison rows for the current filters.
                </td>
              </tr>
            ) : rows.map((row) => (
              <tr className="border-t border-slate-100" key={`${title}-${row.value}`}>
                <td className="border-r border-slate-100 px-3 py-2.5 font-bold text-slate-900">{row.label}</td>
                {kind === "product" ? <td className="border-r border-slate-100 px-3 py-2.5 font-semibold text-slate-600">{row.line ?? "-"}</td> : null}
                <td className="border-r border-slate-100 px-3 py-2.5 text-right font-semibold text-slate-600">{number(row.requestCount)}</td>
                <td className="border-r border-slate-100 px-3 py-2.5 text-right font-semibold text-slate-600">{number(row.customerCount)}</td>
                <td className="border-r border-slate-100 px-3 py-2.5 text-right font-semibold text-slate-600">{number(row.pharmacyCount)}</td>
                <td className="border-r border-slate-100 px-3 py-2.5 text-right font-semibold text-slate-600">{money(row.marketingCost)}</td>
                <td className="border-r border-slate-100 px-3 py-2.5 text-right font-semibold text-slate-700">{money(row.requiredRoiValue)}</td>
                <td className="border-r border-slate-100 px-3 py-2.5 text-right font-black text-emerald-700">{money(row.actualSalesValue)}</td>
                <td className="border-r border-slate-100 px-3 py-2.5 text-right font-black text-amber-700">{money(row.coverageGap)}</td>
                <td className="border-r border-slate-100 px-3 py-2.5 text-right font-black text-slate-900">{percent(row.actualRoiCoverage)}</td>
                <td className="px-3 py-2.5 text-right font-semibold text-slate-600">{number(row.behindRequests)} / {number(row.noDataRequests)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminTableShell>
  );
}

function RequestReportTable({ rows }: { rows: SalesMarketingRequestRow[] }) {
  return (
    <AdminTableShell
      description="Priority rows are sorted by no-data risk, coverage gap, and spend. Exact customer attribution is preferred before brick fallback."
      title="Request ROI decision report"
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1480px] border-collapse text-left text-[13px]">
          <thead className="bg-slate-50 text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">
            <tr>
              <th className="border-r border-slate-100 px-3 py-2.5">Request</th>
              <th className="border-r border-slate-100 px-3 py-2.5">Customer</th>
              <th className="border-r border-slate-100 px-3 py-2.5">Line</th>
              <th className="border-r border-slate-100 px-3 py-2.5">Pay date</th>
              <th className="border-r border-slate-100 px-3 py-2.5 text-right">Cost</th>
              <th className="border-r border-slate-100 px-3 py-2.5 text-right">Required</th>
              <th className="border-r border-slate-100 px-3 py-2.5 text-right">Expected</th>
              <th className="border-r border-slate-100 px-3 py-2.5 text-right">Actual</th>
              <th className="border-r border-slate-100 px-3 py-2.5 text-right">Gap</th>
              <th className="border-r border-slate-100 px-3 py-2.5 text-right">Coverage</th>
              <th className="border-r border-slate-100 px-3 py-2.5">Attribution</th>
              <th className="border-r border-slate-100 px-3 py-2.5">Status</th>
              <th className="px-3 py-2.5">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-center text-sm font-semibold text-slate-500" colSpan={13}>
                  No approved paid requests for the current filters.
                </td>
              </tr>
            ) : rows.map((row) => (
              <tr className="border-t border-slate-100" key={row.id}>
                <td className="border-r border-slate-100 px-3 py-2.5 font-mono text-xs font-black text-slate-900">{row.requestCode}</td>
                <td className="border-r border-slate-100 px-3 py-2.5">
                  <p className="font-bold text-slate-800">{row.customerName}</p>
                  {row.customerCode ? <p className="text-[11px] font-semibold text-slate-500">{row.customerCode}</p> : null}
                </td>
                <td className="border-r border-slate-100 px-3 py-2.5 font-semibold text-slate-600">{row.line ?? "-"}</td>
                <td className="border-r border-slate-100 px-3 py-2.5 font-semibold text-slate-600">{row.payDate ?? row.payMonth ?? "-"}</td>
                <td className="border-r border-slate-100 px-3 py-2.5 text-right font-semibold text-slate-600">{money(row.estimatedCost)}</td>
                <td className="border-r border-slate-100 px-3 py-2.5 text-right font-semibold text-slate-700">{money(row.requiredRoiValue)}</td>
                <td className="border-r border-slate-100 px-3 py-2.5 text-right font-semibold text-slate-600">{money(row.expectedRoiValue)}</td>
                <td className="border-r border-slate-100 px-3 py-2.5 text-right font-black text-emerald-700">{money(row.actualSalesValue)}</td>
                <td className="border-r border-slate-100 px-3 py-2.5 text-right font-black text-amber-700">{money(row.coverageGap)}</td>
                <td className="border-r border-slate-100 px-3 py-2.5 text-right font-black text-slate-900">{percent(row.actualRoiCoverage)}</td>
                <td className="border-r border-slate-100 px-3 py-2.5">
                  <AttributionBadge quality={row.attributionQuality} />
                </td>
                <td className="border-r border-slate-100 px-3 py-2.5">
                  <RoiStatusBadge status={row.actualRoiStatus} />
                </td>
                <td className="px-3 py-2.5">
                  <ActionBadge action={row.recommendedAction} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminTableShell>
  );
}

function CustomerImpactTable({ rows }: { rows: SalesMarketingCustomerImpactRow[] }) {
  return (
    <AdminTableShell
      description="Customers and pharmacies ranked by ROI decision impact. Fallback rows remain visible so leadership can judge attribution trust."
      title="Customer and pharmacy impact report"
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1280px] border-collapse text-left text-[13px]">
          <thead className="bg-slate-50 text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">
            <tr>
              <th className="border-r border-slate-100 px-3 py-2.5">Customer / Pharmacy</th>
              <th className="border-r border-slate-100 px-3 py-2.5">Distributor</th>
              <th className="border-r border-slate-100 px-3 py-2.5">Region</th>
              <th className="border-r border-slate-100 px-3 py-2.5 text-right">Requests</th>
              <th className="border-r border-slate-100 px-3 py-2.5 text-right">Cost</th>
              <th className="border-r border-slate-100 px-3 py-2.5 text-right">Required</th>
              <th className="border-r border-slate-100 px-3 py-2.5 text-right">Actual</th>
              <th className="border-r border-slate-100 px-3 py-2.5 text-right">Gap</th>
              <th className="border-r border-slate-100 px-3 py-2.5 text-right">Coverage</th>
              <th className="border-r border-slate-100 px-3 py-2.5 text-right">Exact Rows</th>
              <th className="px-3 py-2.5 text-right">Fallback Rows</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-center text-sm font-semibold text-slate-500" colSpan={11}>
                  No customer impact rows for the current filters.
                </td>
              </tr>
            ) : rows.map((row) => (
              <tr className="border-t border-slate-100" key={row.value}>
                <td className="border-r border-slate-100 px-3 py-2.5 font-bold text-slate-900">{row.label}</td>
                <td className="border-r border-slate-100 px-3 py-2.5 font-semibold text-slate-600">{row.distributorName ?? row.distributorCode ?? "-"}</td>
                <td className="border-r border-slate-100 px-3 py-2.5 font-semibold text-slate-600">{row.regionName ?? "-"}</td>
                <td className="border-r border-slate-100 px-3 py-2.5 text-right font-semibold text-slate-600">{number(row.requestCount)}</td>
                <td className="border-r border-slate-100 px-3 py-2.5 text-right font-semibold text-slate-600">{money(row.marketingCost)}</td>
                <td className="border-r border-slate-100 px-3 py-2.5 text-right font-semibold text-slate-700">{money(row.requiredRoiValue)}</td>
                <td className="border-r border-slate-100 px-3 py-2.5 text-right font-black text-emerald-700">{money(row.actualSalesValue)}</td>
                <td className="border-r border-slate-100 px-3 py-2.5 text-right font-black text-amber-700">{money(row.coverageGap)}</td>
                <td className="border-r border-slate-100 px-3 py-2.5 text-right font-black text-slate-900">{percent(row.actualRoiCoverage)}</td>
                <td className="border-r border-slate-100 px-3 py-2.5 text-right font-semibold text-emerald-700">{number(row.exactSalesRows)}</td>
                <td className="px-3 py-2.5 text-right font-semibold text-amber-700">{number(row.fallbackSalesRows)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminTableShell>
  );
}

const SMI_ADMIN_BASE_PATH = "/admin/sales-marketing-intelligence";

export function SalesMarketingIntelligenceDashboard({
  basePath = SMI_ADMIN_BASE_PATH,
  canRefreshRoi = false,
  chrome = "admin",
  filters,
  hideLineRoiReport = false,
  snapshot,
}: {
  /** Where the filter form/reset post to. Defaults to the admin route; the employee
   *  portal passes its own route so filters stay inside the portal shell. */
  basePath?: string;
  /** Show the "Refresh ROI" button — CEO / Super Admin only, admin chrome only. */
  canRefreshRoi?: boolean;
  /** "admin" keeps the dark AdminPageHero + page padding. "portal" drops both so the
   *  dashboard sits cleanly inside EmployeePortalPageShell's own hero. */
  chrome?: "admin" | "portal";
  filters: SalesMarketingDashboardFilters;
  /** Drop the "Line ROI report" (by-line breakdown). Meaningless for single-line
   *  viewers such as National Sales Manager, whose ROI scope is exactly one line,
   *  so the Region ROI report then spans full width. */
  hideLineRoiReport?: boolean;
  snapshot: SalesMarketingDashboardSnapshot;
}) {
  const summary = snapshot.summary;
  const attribution = snapshot.attributionHealth;

  return (
    <div className={chrome === "portal" ? "space-y-6" : "space-y-6 p-4 sm:p-6 lg:p-8"}>
      {chrome === "admin" ? (
        <AdminPageHero
          actions={canRefreshRoi ? <RoiRefreshPanel generatedAt={snapshot.generatedAt} /> : undefined}
          badges={(
            <>
              <AdminInsightChip surface="dark">All paid approved history</AdminInsightChip>
              <AdminInsightChip surface="dark" tone="emerald">Raw rows returned: {snapshot.limits.rawRowsReturned}</AdminInsightChip>
              <AdminInsightChip surface="dark" tone="slate">Tables capped at {snapshot.limits.tableLimit}</AdminInsightChip>
            </>
          )}
          description="Corporate decision view for Marketing ROI, request spend, customer and pharmacy impact, and attribution trust. Source of Sales powers attribution only."
          eyebrow="Marketing ROI"
          icon={<Target className="h-4 w-4" />}
          title="Marketing ROI & Customer Intelligence"
        />
      ) : (
        <div className="flex justify-end">
          <RoiRefreshPanel generatedAt={snapshot.generatedAt} showRefreshButton={false} />
        </div>
      )}

      <DashboardFilters basePath={basePath} chrome={chrome} filters={filters} snapshot={snapshot} />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <AdminStatCard description="Total cost of approved paid marketing requests in scope." icon={<BadgeDollarSign className="h-5 w-5" />} label="Marketing Spend" size="compact" tone="blue" value={money(summary.totalMarketingCost)} />
        <AdminStatCard description="Approved paid requests included in ROI attribution." icon={<Target className="h-5 w-5" />} label="Paid Requests" size="compact" tone="violet" value={number(summary.paidRequestCount)} />
        <AdminStatCard description="Sales value required to cover the marketing investment." icon={<Gauge className="h-5 w-5" />} label="Required ROI" size="compact" tone="rose" value={money(summary.requiredRoiValue)} />
        <AdminStatCard description="Forecasted return from request product plans." icon={<LineChart className="h-5 w-5" />} label="Expected ROI" size="compact" tone="orange" value={money(summary.expectedRoiValue)} />
        <AdminStatCard description="Actual Source-of-Sales value attributed to request products and pharmacies." icon={<TrendingUp className="h-5 w-5" />} label="Actual ROI" size="compact" tone="emerald" value={money(summary.actualAttributedSalesValue)} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <AdminStatCard description="Actual attributed sales divided by required ROI." icon={<Gauge className="h-5 w-5" />} label="ROI Coverage" size="compact" tone={summary.actualRoiCoverage >= 1 ? "emerald" : "rose"} value={percent(summary.actualRoiCoverage)} />
        <AdminStatCard description="Required ROI that is not yet covered by attributed sales." icon={<AlertTriangle className="h-5 w-5" />} label="Coverage Gap" size="compact" tone={summary.coverageGap > 0 ? "orange" : "emerald"} value={money(summary.coverageGap)} />
        <AdminStatCard description="Marketing spend tied to behind or no-data requests." icon={<ShieldCheck className="h-5 w-5" />} label="Spend At Risk" size="compact" tone={summary.spendAtRisk > 0 ? "rose" : "emerald"} value={money(summary.spendAtRisk)} />
        <AdminStatCard description="Distinct request customers represented in the selected scope." icon={<UsersRound className="h-5 w-5" />} label="Customers" size="compact" tone="blue" value={number(summary.activeCustomers)} />
        <AdminStatCard description="Distinct pharmacies targeted by included requests." icon={<Building2 className="h-5 w-5" />} label="Pharmacies" size="compact" tone="violet" value={number(summary.activePharmacies)} />
      </div>

      <DecisionSummaryPanel snapshot={snapshot} />

      <AdminCallout tone={attribution.unmatchedMappingWarnings > 0 || attribution.noSalesRequests > 0 ? "warning" : "success"}>
        <div className="grid w-full gap-2 text-sm sm:grid-cols-5">
          <span><strong>{number(attribution.exactSalesRows)}</strong> exact rows</span>
          <span><strong>{number(attribution.fallbackSalesRows)}</strong> fallback rows</span>
          <span><strong>{number(attribution.mixedRequests)}</strong> mixed requests</span>
          <span><strong>{number(attribution.noSalesRequests)}</strong> no-sales requests</span>
          <span><strong>{number(attribution.unmatchedMappingWarnings)}</strong> mapping warnings</span>
        </div>
      </AdminCallout>

      <RoiTrendChart snapshot={snapshot} />

      {hideLineRoiReport ? (
        <RoiComparisonTable
          description="Regional request footprint, spend, actual attribution, coverage gap, and behind/no-data counts."
          kind="standard"
          rows={snapshot.regionRoi}
          title="Region ROI report"
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <RoiComparisonTable
            description="ROI coverage by product line, using marketing cost allocation and attributed actual sales."
            kind="line"
            rows={snapshot.lineRoi}
            title="Line ROI report"
          />
          <RoiComparisonTable
            description="Regional request footprint, spend, actual attribution, coverage gap, and behind/no-data counts."
            kind="standard"
            rows={snapshot.regionRoi}
            title="Region ROI report"
          />
        </div>
      )}

      <RoiComparisonTable
        description="Distributor request footprint and ROI coverage. This is marketing attribution reporting, not broad distributor sales."
        kind="standard"
        rows={snapshot.distributorRoi}
        title="Distributor ROI report"
      />

      <RoiComparisonTable
        description="Product-level marketing spend, required ROI, actual attributed sales, and coverage gap."
        kind="product"
        rows={snapshot.productRoi}
        title="Product ROI report"
      />

      <RequestReportTable rows={snapshot.requestReport} />
      <CustomerImpactTable rows={snapshot.customerImpact} />
    </div>
  );
}
