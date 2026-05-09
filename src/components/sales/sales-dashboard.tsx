"use client";

import {
  AlertTriangle,
  BarChart3,
  Boxes,
  ChevronDown,
  FileSpreadsheet,
  FileUp,
  Link2,
  MapPinned,
  Package,
  Target,
  TrendingUp,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import {
  AdminCallout,
  AdminPageHero,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { adminPanelClassName } from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/sales/format";
import type { SalesDashboardData } from "@/lib/sales/types";
import { cn } from "@/lib/utils";

type Props = {
  initialData: SalesDashboardData | null;
  initialError: string | null;
  portalMode?: boolean;
};

type AnyRow = Record<string, unknown>;

type Filters = {
  area: string;
  line: string;
  manager: string;
  medicalRep: string;
  periods: string[];
  product: string;
  salesType: string;
};

type DashboardView = {
  channelMix: AnyRow[];
  currentPeriod?: AnyRow;
  familyRows: AnyRow[];
  lineRows: AnyRow[];
  managerRows: AnyRow[];
  previousPeriod?: AnyRow;
  productRows: AnyRow[];
  repRows: AnyRow[];
  summary: AnyRow;
  territoryRows: AnyRow[];
  trendRows: AnyRow[];
};

const panelClassName = adminPanelClassName;
const adminTableHeaderClassName = "px-3 py-2 text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]";

function valueAsNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function valueAsText(value: unknown) {
  return String(value ?? "");
}

function shortCurrency(value: unknown) {
  const number = valueAsNumber(value);
  if (Math.abs(number) >= 1_000_000) return `EGP ${(number / 1_000_000).toFixed(1)}M`;
  if (Math.abs(number) >= 1_000) return `EGP ${(number / 1_000).toFixed(0)}K`;
  return formatCurrency(number);
}

function compactPeriod(period: string) {
  const [year, month] = period.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const index = Number(month) - 1;
  return names[index] && year ? `${names[index]} ${year}` : period;
}

function periodRangeLabel(periods: string[]) {
  if (periods.length === 0) return "All Months";
  if (periods.length === 1) return compactPeriod(periods[0]);
  return `${compactPeriod(periods[0])} - ${compactPeriod(periods[periods.length - 1])}`;
}

function deltaPercent(current: number, previous: number) {
  if (!previous) return current ? 1 : 0;
  return (current - previous) / previous;
}

function uniqueSorted(rows: AnyRow[], key: string) {
  return [...new Set(rows.map((row) => valueAsText(row[key]).trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function aggregateRows(rows: AnyRow[], key: string) {
  const map = new Map<string, AnyRow[]>();
  rows.forEach((row) => {
    const value = valueAsText(row[key]) || "Unassigned";
    map.set(value, [...(map.get(value) ?? []), row]);
  });
  return map;
}

function sumRows(rows: AnyRow[], key: string) {
  return rows.reduce((total, row) => total + valueAsNumber(row[key]), 0);
}

function achievement(sales: number, target: number) {
  return target > 0 ? sales / target : 0;
}

function isC01Row(row: AnyRow) {
  return valueAsText(row.managerHrId).trim().toLowerCase() === "c-o1" || valueAsText(row.employeeHrId).trim().toLowerCase() === "c-o1";
}

function cleanPersonName(value: unknown) {
  return valueAsText(value).replace(/\s*\[HR\s+[^\]]+\]/gi, "").replace(/\s*\[[^\]]+\]/g, "").trim();
}

function areaLabel(items: AnyRow[]) {
  const areas = uniqueSorted(items, "territory");
  if (areas.length === 0) return "-";
  if (areas.length <= 2) return areas.join(", ");
  return `${areas.slice(0, 2).join(", ")} +${areas.length - 2}`;
}

function calculateView(rows: AnyRow[], fallbackSummary: AnyRow): DashboardView {
  const reportRows = rows.filter((row) => !isC01Row(row));
  const totalSales = sumRows(rows, "salesValue");
  const totalTarget = sumRows(rows, "targetValue");
  const unitsSold = sumRows(rows, "salesUnits");
  const activeProducts = new Set(reportRows.map((row) => valueAsText(row.product)).filter(Boolean)).size;
  const linkedEmployees = new Set(reportRows.map((row) => valueAsText(row.employeeHrId)).filter(Boolean)).size;
  const dsmIds = new Set(reportRows.map((row) => valueAsText(row.managerHrId)).filter(Boolean));
  const prices = rows.map((row) => valueAsNumber(row.factoryPrice)).filter((price) => price > 0);
  const averageFactoryPrice = prices.length ? prices.reduce((total, price) => total + price, 0) / prices.length : 0;

  const trendRows = [...aggregateRows(rows, "period").entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([period, items]) => {
      const sales = sumRows(items, "salesValue");
      const target = sumRows(items, "targetValue");
      return { period, sales, target, achievementRate: achievement(sales, target), linkedEmployees: new Set(items.map((item) => valueAsText(item.employeeHrId)).filter(Boolean)).size };
    });

  const managerRows = [...aggregateRows(reportRows, "managerName").entries()]
    .map(([manager, items]) => {
      const sales = sumRows(items, "salesValue");
      const target = sumRows(items, "targetValue");
      const topProduct = [...aggregateRows(items, "product").entries()]
        .map(([product, productRows]) => ({ product, sales: sumRows(productRows, "salesValue") }))
        .sort((left, right) => right.sales - left.sales)[0]?.product ?? "Unknown";
      return { area: areaLabel(items), manager: cleanPersonName(manager), sales, target, achievementRate: achievement(sales, target), topProduct };
    })
    .sort((left, right) => valueAsNumber(right.sales) - valueAsNumber(left.sales));

  const lineRows = [...aggregateRows(reportRows, "line").entries()]
    .map(([line, items]) => {
      const sales = sumRows(items, "salesValue");
      const target = sumRows(items, "targetValue");
      return { line, sales, target, achievementRate: achievement(sales, target), rows: items.length };
    })
    .sort((left, right) => valueAsNumber(right.sales) - valueAsNumber(left.sales));

  const productRows = [...aggregateRows(reportRows, "product").entries()]
    .map(([product, items]) => {
      const sales = sumRows(items, "salesValue");
      const target = sumRows(items, "targetValue");
      return { product, family: valueAsText(items[0]?.family) || "Unknown", sales, target, achievementRate: achievement(sales, target) };
    })
    .sort((left, right) => valueAsNumber(right.sales) - valueAsNumber(left.sales));

  const repRows = [...aggregateRows(reportRows.filter((row) => valueAsText(row.employeeName)), "employeeName").entries()]
    .map(([rep, items]) => {
      const sales = sumRows(items, "salesValue");
      const target = sumRows(items, "targetValue");
      return { area: areaLabel(items), rep: cleanPersonName(rep), sales, target, achievementRate: achievement(sales, target) };
    })
    .sort((left, right) => valueAsNumber(right.sales) - valueAsNumber(left.sales));

  const territoryRows = [...aggregateRows(reportRows, "territory").entries()]
    .map(([name, items]) => {
      const sales = sumRows(items, "salesValue");
      const target = sumRows(items, "targetValue");
      return { name, sales, target, achievementRate: achievement(sales, target) };
    })
    .sort((left, right) => valueAsNumber(right.sales) - valueAsNumber(left.sales));

  const familyRows = [...aggregateRows(reportRows, "family").entries()]
    .map(([name, items]) => {
      const sales = sumRows(items, "salesValue");
      const target = sumRows(items, "targetValue");
      return { name, units: sumRows(items, "salesUnits"), sales, target, achievementRate: achievement(sales, target) };
    })
    .sort((left, right) => valueAsNumber(right.sales) - valueAsNumber(left.sales));

  const channelMix = [...aggregateRows(reportRows, "salesType").entries()]
    .map(([name, items]) => ({ name, value: sumRows(items, "salesValue") }))
    .sort((left, right) => valueAsNumber(right.value) - valueAsNumber(left.value));

  return {
    channelMix,
    currentPeriod: trendRows[trendRows.length - 1],
    familyRows,
    lineRows,
    managerRows,
    previousPeriod: trendRows[trendRows.length - 2],
    productRows,
    repRows,
    summary: {
      ...fallbackSummary,
      activeProducts,
      approvedRecords: rows.length,
      averageFactoryPrice,
      dataQualityRate: dsmIds.size > 0 ? 1 : Number(fallbackSummary.dataQualityRate ?? 1),
      dsmLinkedRecords: dsmIds.size,
      dsmTotalRecords: dsmIds.size,
      linkedEmployees,
      totalApprovedSales: totalSales,
      totalApprovedTarget: totalTarget,
      unitsSold,
      achievementRate: achievement(totalSales, totalTarget),
      topManager: valueAsText(managerRows[0]?.manager) || "-",
    },
    territoryRows,
    trendRows,
  };
}

function MetricCard({
  icon: Icon,
  label,
  sub,
  tone = "neutral",
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  sub?: string;
  tone?: "neutral" | "success" | "warning" | "danger";
  value: string;
}) {
  const toneClasses = {
    danger: "bg-[#FEF2F2] text-[#DC2626] ring-[#FECACA]",
    neutral: "bg-[#FFF7ED] text-[#EA580C] ring-[#FED7AA]",
    success: "bg-[#F0FDF4] text-[#16A34A] ring-[#BBF7D0]",
    warning: "bg-[#FFFBEB] text-[#D97706] ring-[#FDE68A]",
  };

  return (
    <Card className={`${panelClassName} group min-h-[138px] p-5 transition hover:-translate-y-0.5`}>
      <div className="flex items-center gap-4">
        <div className={cn("flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ring-1", toneClasses[tone])}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#64748B]">{label}</p>
          <p className="mt-1 truncate text-2xl font-black text-[#0F172A]">{value}</p>
          {sub && <p className="mt-2 text-sm leading-6 text-[#64748B]">{sub}</p>}
        </div>
      </div>
    </Card>
  );
}

function AchievementBadge({ rate }: { rate: number }) {
  if (rate >= 1) return <Badge variant="success">{formatPercent(rate)}</Badge>;
  if (rate >= 0.8) return <Badge variant="warning">{formatPercent(rate)}</Badge>;
  return <Badge variant="danger">{formatPercent(rate)}</Badge>;
}

function ProgressBar({ rate }: { rate: number }) {
  const pct = Math.max(0, Math.min(rate * 100, 120));
  const color = rate >= 1 ? "bg-emerald-500" : rate >= 0.8 ? "bg-amber-500" : "bg-red-500";

  return (
    <div className="h-2 overflow-hidden rounded-full bg-[#F8FAFC]">
      <div className={cn("h-full rounded-full", color)} style={{ width: `${Math.min(pct, 100)}%` }} />
    </div>
  );
}

function SectionHeader({ title, subtitle }: { subtitle?: string; title: string }) {
  return (
    <div>
      <h2 className="text-base font-bold text-[#0F172A]">{title}</h2>
      {subtitle && <p className="mt-1 text-sm leading-6 text-[#64748B]">{subtitle}</p>}
    </div>
  );
}

function ChartCard({ children, subtitle, title }: { children: React.ReactNode; subtitle?: string; title: string }) {
  return (
    <Card className={`${panelClassName} p-5`}>
      <div className="flex items-start justify-between gap-3">
        <SectionHeader title={title} subtitle={subtitle} />
        <span className="rounded-full border border-[#FED7AA] bg-[#FFF7ED] px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-[#EA580C]">
          Live
        </span>
      </div>
      <div className="mt-5">{children}</div>
    </Card>
  );
}

function TrendLineChart({ rows }: { rows: AnyRow[] }) {
  const [activePeriod, setActivePeriod] = useState<string | null>(null);
  const width = 720;
  const height = 250;
  const padX = 44;
  const padTop = 26;
  const padBottom = 42;
  const values = rows.flatMap((row) => [valueAsNumber(row.sales), valueAsNumber(row.target)]);
  const maxValue = Math.max(...values, 1);
  const xFor = (index: number) => (rows.length <= 1 ? width / 2 : padX + (index * (width - padX * 2)) / (rows.length - 1));
  const yFor = (value: number) => padTop + (1 - value / maxValue) * (height - padTop - padBottom);
  const salesPoints = rows.map((row, index) => `${xFor(index)},${yFor(valueAsNumber(row.sales))}`).join(" ");
  const targetPoints = rows.map((row, index) => `${xFor(index)},${yFor(valueAsNumber(row.target))}`).join(" ");
  const activeRow = rows.find((row) => valueAsText(row.period) === activePeriod);

  return (
    <div className="relative">
      <svg className="h-[290px] w-full overflow-visible" viewBox={`0 0 ${width} ${height}`} role="img">
        {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
          const y = padTop + tick * (height - padTop - padBottom);
          return <line key={tick} x1={padX} x2={width - padX} y1={y} y2={y} stroke="#e2e8f0" strokeDasharray="4 6" />;
        })}
        <defs>
          <linearGradient id="salesFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#f97316" stopOpacity="0.24" />
            <stop offset="100%" stopColor="#f97316" stopOpacity="0" />
          </linearGradient>
        </defs>
        {rows.length > 1 && (
          <>
            <polyline fill="none" points={targetPoints} stroke="#94a3b8" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" />
            <polyline fill="none" points={salesPoints} stroke="#f97316" strokeLinecap="round" strokeLinejoin="round" strokeWidth="4" />
          </>
        )}
        {rows.map((row, index) => {
          const period = valueAsText(row.period);
          const x = xFor(index);
          const salesY = yFor(valueAsNumber(row.sales));
          const targetY = yFor(valueAsNumber(row.target));
          return (
            <g key={period} onMouseEnter={() => setActivePeriod(period)} onMouseLeave={() => setActivePeriod(null)}>
              <line x1={x} x2={x} y1={padTop} y2={height - padBottom} stroke="transparent" strokeWidth="42" />
              <circle cx={x} cy={targetY} fill="#94a3b8" r="5" />
              <circle cx={x} cy={salesY} fill="#f97316" r="6" stroke="#fff" strokeWidth="3" />
              <text fill="#64748b" fontSize="12" fontWeight="700" textAnchor="middle" x={x} y={height - 12}>
                {compactPeriod(period).replace(" 2026", "")}
              </text>
              <text fill="#0f172a" fontSize="12" fontWeight="800" textAnchor="middle" x={x} y={Math.min(salesY, targetY) - 12}>
                {shortCurrency(valueAsNumber(row.sales)).replace("EGP ", "")}
              </text>
            </g>
          );
        })}
      </svg>
      {activeRow && (
        <div className="absolute right-4 top-4 rounded-xl border border-[#E2E8F0] bg-white p-3 text-xs shadow-xl">
          <p className="font-black text-[#0F172A]">{compactPeriod(valueAsText(activeRow.period))}</p>
          <p className="mt-1 text-[#64748B]">Sales: {formatCurrency(valueAsNumber(activeRow.sales))}</p>
          <p className="text-[#64748B]">Target: {formatCurrency(valueAsNumber(activeRow.target))}</p>
          <p className="text-[#64748B]">Achievement: {formatPercent(valueAsNumber(activeRow.achievementRate))}</p>
        </div>
      )}
      <div className="mt-2 flex gap-5 text-xs font-semibold text-[#64748B]">
        <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-orange-500" /> Sales</span>
        <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-[#CBD5E1]" /> Target</span>
      </div>
    </div>
  );
}

function DonutChart({ rows, total }: { rows: AnyRow[]; total: number }) {
  const first = valueAsNumber(rows[0]?.value);
  const firstPct = total > 0 ? (first / total) * 100 : 0;
  const gradient = rows.length <= 1 ? "#f97316 0 100%" : `#f97316 0 ${firstPct}%, #0f172a ${firstPct}% 100%`;

  return (
    <div className="grid gap-5 sm:grid-cols-[170px_minmax(0,1fr)]">
      <div className="relative mx-auto h-40 w-40 rounded-full" style={{ background: `conic-gradient(${gradient})` }}>
        <div className="absolute inset-6 flex flex-col items-center justify-center rounded-full bg-white">
          <p className="text-2xl font-black text-[#0F172A]">{shortCurrency(total).replace("EGP ", "")}</p>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#64748B]">EGP</p>
        </div>
      </div>
      <div className="space-y-3 self-center">
        {rows.map((row, index) => {
          const value = valueAsNumber(row.value);
          const rate = total > 0 ? value / total : 0;
          return (
            <div className="flex items-center justify-between gap-3 text-sm" key={valueAsText(row.name)}>
              <span className="flex items-center gap-2 font-bold text-[#0F172A]">
                <span className={cn("h-2.5 w-2.5 rounded-full", index === 0 ? "bg-orange-500" : "bg-[#0F172A]")} />
                {valueAsText(row.name)}
              </span>
              <span className="text-right text-xs font-semibold text-[#64748B]">
                {shortCurrency(value).replace("EGP ", "")} / {formatPercent(rate)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TopList({ labelKey, rows, title }: { labelKey: string; rows: AnyRow[]; title: string }) {
  const topRows = rows.slice(0, 5);
  const max = Math.max(...topRows.map((row) => valueAsNumber(row.sales)), 1);
  const total = topRows.reduce((acc, row) => acc + valueAsNumber(row.sales), 0);

  return (
    <Card className="rounded-2xl border-[#E2E8F0] bg-white p-5 shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
      <h3 className="text-sm font-black uppercase tracking-[0.12em] text-[#0F172A]">{title}</h3>
      <div className="mt-4 space-y-3">
        {topRows.map((row, index) => {
          const sales = valueAsNumber(row.sales);
          return (
            <div className="grid grid-cols-[24px_minmax(0,1fr)_70px] items-center gap-3" key={`${valueAsText(row[labelKey])}-${index}`}>
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[#F8FAFC] text-xs font-black text-[#64748B]">{index + 1}</span>
              <div className="min-w-0">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <p className="truncate font-bold text-[#0F172A]">{valueAsText(row[labelKey])}</p>
                  <p className="shrink-0 text-xs font-bold text-[#64748B]">{shortCurrency(sales).replace("EGP ", "")}</p>
                </div>
                {valueAsText(row.area) && <p className="mt-0.5 truncate text-[11px] font-semibold text-[#64748B]">{valueAsText(row.area)}</p>}
                <div className="mt-1.5 h-1.5 rounded-full bg-[#F8FAFC]">
                  <div className="h-full rounded-full bg-orange-500" style={{ width: `${Math.min((sales / max) * 100, 100)}%` }} />
                </div>
              </div>
              <p className="text-right text-xs font-semibold text-[#64748B]">{formatPercent(total > 0 ? sales / total : 0)}</p>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function buildLeadershipRows(rows: AnyRow[], groupKey: "managerName" | "employeeName") {
  return [...aggregateRows(rows.filter((row) => valueAsText(row[groupKey])), groupKey).entries()]
    .map(([name, items]) => {
      const sales = sumRows(items, "salesValue");
      const target = sumRows(items, "targetValue");
      const periods = [...aggregateRows(items, "period").entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([period, periodItems]) => ({ period, sales: sumRows(periodItems, "salesValue") }));
      const first = periods[0]?.sales ?? 0;
      const last = periods[periods.length - 1]?.sales ?? 0;
      return {
        achievementRate: achievement(sales, target),
        area: areaLabel(items),
        firstPeriod: periods[0]?.period ?? "",
        growthRate: deltaPercent(last, first),
        lastPeriod: periods[periods.length - 1]?.period ?? "",
        name: cleanPersonName(name),
        sales,
        target,
      };
    });
}

function normalizeRankingRows(rows: AnyRow[], nameKey: string) {
  return rows.map((row) => ({
    achievementRate: valueAsNumber(row.achievementRate),
    area: valueAsText(row.area) || "-",
    name: cleanPersonName(row[nameKey]),
    sales: valueAsNumber(row.sales),
    target: valueAsNumber(row.target),
  }));
}

function RankingHalfTable({
  label,
  metric,
  tableRows,
  tone,
}: {
  label: string;
  metric: "achievement" | "value";
  tableRows: AnyRow[];
  tone: "top" | "low";
}) {
  const valueLabel = metric === "achievement" ? "Ach. %" : "Sales";
  const renderValue = (row: AnyRow) => (metric === "achievement" ? formatPercent(valueAsNumber(row.achievementRate)) : formatCurrency(valueAsNumber(row.sales)));

  return (
    <div className="overflow-hidden rounded-lg border border-[#E2E8F0]">
      <div className={cn("px-3 py-2 text-xs font-black uppercase tracking-[0.12em]", tone === "top" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700")}>
        {label}
      </div>
      <div className="overflow-x-auto">
      <table className="min-w-[720px] w-full text-left text-sm">
        <thead className="bg-[#F8FAFC] text-[11px] uppercase tracking-[0.1em] text-[#64748B]">
          <tr>
            <th className={adminTableHeaderClassName}>#</th>
            <th className={adminTableHeaderClassName}>Name</th>
            <th className={adminTableHeaderClassName}>Area</th>
            <th className={adminTableHeaderClassName}>{valueLabel}</th>
            <th className={adminTableHeaderClassName}>Sales</th>
            <th className={adminTableHeaderClassName}>Target</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {tableRows.map((row, index) => (
            <tr className="transition hover:bg-[#F8FAFC]/80" key={`${valueAsText(row.name)}-${label}-${index}`}>
              <td className="px-3 py-2 font-black text-[#64748B]">{index + 1}</td>
              <td className="max-w-[260px] truncate px-3 py-2 font-semibold text-[#0F172A]">{valueAsText(row.name)}</td>
              <td className="max-w-[180px] truncate px-3 py-2 text-xs font-semibold text-[#64748B]">{valueAsText(row.area) || "-"}</td>
              <td className={cn("px-3 py-2 font-black", tone === "top" ? "text-emerald-600" : "text-red-600")}>{renderValue(row)}</td>
              <td className="px-3 py-2 text-[#64748B]">{shortCurrency(row.sales)}</td>
              <td className="px-3 py-2 text-[#64748B]">{shortCurrency(row.target)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function LeadershipTable({ rows, title }: { rows: AnyRow[]; title: string }) {
  const topAchievement = [...rows].sort((left, right) => valueAsNumber(right.achievementRate) - valueAsNumber(left.achievementRate))[0];
  const topValue = [...rows].sort((left, right) => valueAsNumber(right.sales) - valueAsNumber(left.sales))[0];
  const topGrowth = [...rows].sort((left, right) => valueAsNumber(right.growthRate) - valueAsNumber(left.growthRate))[0];
  const tableRows = [
    { metric: "Highest Achievement %", row: topAchievement, value: formatPercent(valueAsNumber(topAchievement?.achievementRate)) },
    { metric: "Highest Sales Value", row: topValue, value: formatCurrency(valueAsNumber(topValue?.sales)) },
    { metric: "Highest M/M Growth", row: topGrowth, value: formatPercent(valueAsNumber(topGrowth?.growthRate)) },
  ];

  return (
    <Card className={`${panelClassName} p-5`}>
      <SectionHeader title={title} subtitle="Highest achievement, sales value, and month-over-month growth leaders in the current scope." />
      <div className="mt-4 overflow-hidden rounded-[24px] border border-[#E2E8F0]">
        <div className="overflow-x-auto">
        <table className="min-w-[760px] w-full text-left text-sm">
          <thead className="bg-[#F8FAFC] text-[11px] uppercase tracking-[0.12em] text-[#64748B]">
            <tr>
              <th className={adminTableHeaderClassName}>Metric</th>
              <th className={adminTableHeaderClassName}>Name</th>
              <th className={adminTableHeaderClassName}>Area</th>
              <th className={adminTableHeaderClassName}>Value</th>
              <th className={adminTableHeaderClassName}>Sales</th>
              <th className={adminTableHeaderClassName}>Period</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {tableRows.map(({ metric, row, value }) => (
              <tr className="transition hover:bg-[#F8FAFC]/80" key={metric}>
                <td className="px-3 py-3 font-bold text-[#0F172A]">{metric}</td>
                <td className="max-w-[220px] truncate px-3 py-3 font-semibold text-[#0F172A]">{valueAsText(row?.name) || "-"}</td>
                <td className="max-w-[170px] truncate px-3 py-3 text-xs font-semibold text-[#64748B]">{valueAsText(row?.area) || "-"}</td>
                <td className="px-3 py-3 font-black text-orange-600">{value}</td>
                <td className="px-3 py-3 text-[#64748B]">{formatCurrency(valueAsNumber(row?.sales))}</td>
                <td className="px-3 py-3 text-xs font-semibold text-[#64748B]">
                  {valueAsText(row?.firstPeriod) && valueAsText(row?.lastPeriod)
                    ? `${compactPeriod(valueAsText(row?.firstPeriod))} -> ${compactPeriod(valueAsText(row?.lastPeriod))}`
                    : "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </Card>
  );
}

function RankingSplitTable({
  limit,
  metric,
  rows,
  title,
}: {
  limit: number;
  metric: "achievement" | "value";
  rows: AnyRow[];
  title: string;
}) {
  const eligibleRows =
    metric === "achievement"
      ? rows.filter((row) => valueAsNumber(row.target) > 0)
      : rows;
  const topRows =
    metric === "achievement"
      ? [...eligibleRows].sort((left, right) => valueAsNumber(right.achievementRate) - valueAsNumber(left.achievementRate)).slice(0, limit)
      : [...eligibleRows].sort((left, right) => valueAsNumber(right.sales) - valueAsNumber(left.sales)).slice(0, limit);
  const lowestRows =
    metric === "achievement"
      ? [...eligibleRows].sort((left, right) => valueAsNumber(left.achievementRate) - valueAsNumber(right.achievementRate)).slice(0, limit)
      : [...eligibleRows].sort((left, right) => valueAsNumber(left.sales) - valueAsNumber(right.sales)).slice(0, limit);

  return (
    <Card className={`${panelClassName} p-5`}>
      <SectionHeader title={title} subtitle={`${limit} highest and ${limit} lowest in the current filter selection.`} />
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <RankingHalfTable label={`Top ${limit}`} metric={metric} tableRows={topRows} tone="top" />
        <RankingHalfTable label={`Lowest ${limit}`} metric={metric} tableRows={lowestRows} tone="low" />
      </div>
    </Card>
  );
}

function ComparativeLineSales({ rows }: { rows: AnyRow[] }) {
  const topRows = rows.slice(0, 8);
  const maxSales = Math.max(...topRows.map((row) => valueAsNumber(row.sales)), 1);

  return (
    <Card className={`${panelClassName} p-5`}>
      <SectionHeader title="Comparative Sales by Line" subtitle="Sales, target, achievement, and contribution by selected line." />
      <div className="mt-4 space-y-3">
        {topRows.length === 0 ? (
          <p className="rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-4 text-sm text-[#64748B]">No line sales data for the selected filters.</p>
        ) : (
          topRows.map((row) => {
            const sales = valueAsNumber(row.sales);
            const target = valueAsNumber(row.target);
            const rate = valueAsNumber(row.achievementRate);
            return (
              <div className="rounded-lg border border-[#E2E8F0] p-3" key={valueAsText(row.line)}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-black text-[#0F172A]">{valueAsText(row.line)}</p>
                    <p className="text-xs font-semibold text-[#64748B]">{formatNumber(valueAsNumber(row.rows))} rows</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-black text-[#0F172A]">{shortCurrency(sales)}</p>
                    <p className={cn("text-xs font-bold", rate >= 0.8 ? "text-emerald-600" : "text-red-600")}>{formatPercent(rate)}</p>
                  </div>
                </div>
                <div className="mt-3 grid gap-1.5">
                  <div className="h-2 rounded-full bg-[#F8FAFC]">
                    <div className="h-full rounded-full bg-orange-500" style={{ width: `${Math.min((sales / maxSales) * 100, 100)}%` }} />
                  </div>
                  <div className="flex justify-between text-[11px] font-semibold text-[#64748B]">
                    <span>Target {shortCurrency(target)}</span>
                    <span>Gap {shortCurrency(sales - target)}</span>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </Card>
  );
}

function AchievementBars({ rows }: { rows: AnyRow[] }) {
  const [activePeriod, setActivePeriod] = useState<string | null>(null);

  return (
    <div className="flex h-64 items-end gap-3 border-b border-[#E2E8F0] px-2">
      {rows.map((row) => {
        const achievement = valueAsNumber(row.achievement);
        const period = valueAsText(row.period);
        return (
          <div
            className="relative flex min-w-0 flex-1 flex-col items-center gap-2"
            key={period}
            onMouseEnter={() => setActivePeriod(period)}
            onMouseLeave={() => setActivePeriod(null)}
          >
            <div className="flex h-48 w-full items-end justify-center rounded-t-lg bg-[#F8FAFC] px-2">
              <div
                className={cn("w-full rounded-t-md", achievement >= 100 ? "bg-emerald-500" : achievement >= 80 ? "bg-amber-500" : "bg-red-500")}
                style={{ height: `${Math.min(Math.max(achievement, 4), 120) / 120 * 100}%` }}
              />
            </div>
            <p className="text-xs font-semibold text-text">{achievement.toFixed(0)}%</p>
            <p className="truncate text-[11px] text-text-secondary">{period}</p>
            {activePeriod === period && (
              <div className="absolute bottom-20 z-10 w-44 rounded-lg border border-border bg-white p-3 text-center text-xs shadow-lg">
                <p className="font-bold text-text">{period}</p>
                <p className="mt-1 text-text-secondary">Achievement {achievement.toFixed(1)}%</p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FilterSelect({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: string[];
  value: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.14em] text-text-secondary">{label}</span>
      <div className="relative">
        <select
          className="h-10 w-full appearance-none rounded-lg border border-border bg-white px-3 pr-9 text-sm font-medium text-text outline-none transition focus:border-[#F97316] focus:ring-2 focus:ring-[#F97316]/15"
          onChange={(event) => onChange(event.target.value)}
          value={value}
        >
          <option value="">All</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-3 top-2.5 h-4 w-4 text-text-secondary" />
      </div>
    </label>
  );
}

function PeriodFilter({
  onChange,
  options,
  value,
}: {
  onChange: (periods: string[]) => void;
  options: string[];
  value: string[];
}) {
  const allSelected = value.length === 0;
  const [open, setOpen] = useState(false);
  const label = allSelected ? `All Months (${options.length})` : value.length === 1 ? compactPeriod(value[0]) : `${value.length} months selected`;

  return (
    <div className="relative">
      <p className="mb-1 block text-[11px] font-bold uppercase tracking-[0.14em] text-text-secondary">Month</p>
      <button
        className="flex h-11 w-full items-center justify-between rounded-lg border border-border bg-white px-3 text-sm font-semibold text-[#0F172A] outline-none transition hover:bg-[#F8FAFC]"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {label}
        <ChevronDown className={cn("h-4 w-4 text-[#CBD5E1] transition", open && "rotate-180")} />
      </button>
      {open && (
        <div className="absolute z-30 mt-2 w-full rounded-xl border border-[#E2E8F0] bg-white p-3 shadow-2xl">
          <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm font-semibold text-[#0F172A] hover:bg-[#F8FAFC]">
            <input checked={allSelected} className="h-4 w-4 accent-orange-600" onChange={() => onChange([])} type="checkbox" />
            Select All
          </label>
          <div className="mt-1 max-h-56 space-y-1 overflow-auto">
            {options.map((period) => {
              const selected = allSelected || value.includes(period);
              return (
                <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm font-semibold text-[#0F172A] hover:bg-[#F8FAFC]" key={period}>
                  <input
                    checked={selected}
                    className="h-4 w-4 accent-orange-600"
                    onChange={() => {
                      if (allSelected) onChange(options.filter((item) => item !== period));
                      else if (value.includes(period)) onChange(value.filter((item) => item !== period));
                      else onChange([...value, period].sort());
                    }}
                    type="checkbox"
                  />
                  {compactPeriod(period)}
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button
      className="inline-flex items-center gap-2 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-1.5 text-xs font-bold text-[#0F172A] hover:bg-white"
      onClick={onRemove}
      type="button"
    >
      {label}
      <span className="text-[#CBD5E1]">x</span>
    </button>
  );
}

function MiniStat({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#64748B]">
      <Icon className="h-3.5 w-3.5" />
      {label}: <span className="text-[#0F172A]">{value}</span>
    </span>
  );
}

function FilterField({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div>
      <p className="mb-1 block text-[11px] font-bold uppercase tracking-[0.14em] text-text-secondary">{label}</p>
      {children}
    </div>
  );
}

function ReadOnlyField({ value }: { value: string }) {
  return (
    <div className="flex h-11 items-center rounded-lg border border-border bg-[#F8FAFC] px-3 text-sm font-semibold text-[#0F172A]">
      {value}
    </div>
  );
}

function PerformanceTable({
  columns,
  rows,
}: {
  columns: Array<{ key: string; label: string; render?: (row: AnyRow) => React.ReactNode }>;
  rows: AnyRow[];
}) {
  return (
    <div className="overflow-hidden rounded-[24px] border border-[#E2E8F0]">
      <div className="overflow-x-auto">
      <table className="min-w-[680px] w-full text-left text-sm">
        <thead className="bg-[#F8FAFC] text-[11px] uppercase tracking-[0.14em] text-[#64748B]">
          <tr>
            {columns.map((column) => (
              <th className={adminTableHeaderClassName} key={column.key}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[#E2E8F0] bg-white">
          {rows.length === 0 ? (
            <tr>
              <td className="px-3 py-6 text-center text-text-secondary" colSpan={columns.length}>
                No approved sales data yet.
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr className="transition hover:bg-[#F8FAFC]/80" key={`${row.name ?? row.manager ?? row.product ?? row.period ?? index}-${index}`}>
                {columns.map((column) => (
                  <td className="px-3 py-2 align-middle" key={column.key}>
                    {column.render ? column.render(row) : valueAsText(row[column.key])}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
      </div>
    </div>
  );
}

export function SalesDashboard(props: Props) {
  const data = props.initialData;
  const error = props.initialError;
  const portalMode = props.portalMode === true;

  if (error) {
    return (
      <div className="space-y-6">
        <AdminPageHero
          actions={
            !portalMode ? (
              <Link href="/sales/queue">
                <Button variant="secondary">Review Uploaded Sheets</Button>
              </Link>
            ) : null
          }
          description="We were unable to load the current sales dataset for dashboard visualizations."
          eyebrow="Sales"
          icon={<AlertTriangle className="h-3.5 w-3.5" />}
          title="Sales dashboard unavailable"
        />
        <AdminCallout tone="danger">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          <div>
            <p className="font-semibold">Unable to load sales data</p>
            <p className="text-sm">{error}</p>
          </div>
        </AdminCallout>
      </div>
    );
  }

  if (!data) return null;

  return <SalesDashboardContent data={data} portalMode={portalMode} />;
}

function SalesDashboardContent({
  data,
  portalMode = false,
}: {
  data: SalesDashboardData;
  portalMode?: boolean;
}) {
  const transactions = useMemo(() => ((data.transactions ?? []) as AnyRow[]), [data.transactions]);
  const [filters, setFilters] = useState<Filters>({ area: "", line: "", manager: "", medicalRep: "", periods: [], product: "", salesType: "" });
  const periodScopedRows = useMemo(
    () => transactions.filter((row) => filters.periods.length === 0 || filters.periods.includes(valueAsText(row.period))),
    [filters.periods, transactions]
  );
  const reportPeriodScopedRows = useMemo(() => periodScopedRows.filter((row) => !isC01Row(row)), [periodScopedRows]);
  const lineScopedRows = useMemo(
    () => periodScopedRows.filter((row) => !filters.line || valueAsText(row.line) === filters.line),
    [filters.line, periodScopedRows]
  );
  const reportLineScopedRows = useMemo(() => lineScopedRows.filter((row) => !isC01Row(row)), [lineScopedRows]);
  const areaScopedRows = useMemo(
    () => lineScopedRows.filter((row) => !filters.area || valueAsText(row.territory) === filters.area),
    [filters.area, lineScopedRows]
  );
  const reportAreaScopedRows = useMemo(() => areaScopedRows.filter((row) => !isC01Row(row)), [areaScopedRows]);
  const typeScopedRows = useMemo(
    () => areaScopedRows.filter((row) => !filters.salesType || valueAsText(row.salesType) === filters.salesType),
    [areaScopedRows, filters.salesType]
  );
  const reportTypeScopedRows = useMemo(() => typeScopedRows.filter((row) => !isC01Row(row)), [typeScopedRows]);
  const managerScopedRows = useMemo(
    () => typeScopedRows.filter((row) => !filters.manager || valueAsText(row.managerName) === filters.manager),
    [filters.manager, typeScopedRows]
  );
  const reportManagerScopedRows = useMemo(() => managerScopedRows.filter((row) => !isC01Row(row)), [managerScopedRows]);
  const repScopedRows = useMemo(
    () => managerScopedRows.filter((row) => !filters.medicalRep || valueAsText(row.employeeName) === filters.medicalRep),
    [filters.medicalRep, managerScopedRows]
  );
  const filterOptions = useMemo(
    () => ({
      areas: uniqueSorted(reportLineScopedRows, "territory"),
      lines: uniqueSorted(reportPeriodScopedRows, "line"),
      managers: uniqueSorted(reportTypeScopedRows, "managerName"),
      medicalReps: uniqueSorted(reportManagerScopedRows, "employeeName"),
      periods: uniqueSorted(transactions, "period"),
      products: uniqueSorted(repScopedRows.filter((row) => !isC01Row(row)), "product"),
      salesTypes: uniqueSorted(reportAreaScopedRows, "salesType"),
    }),
    [repScopedRows, reportAreaScopedRows, reportLineScopedRows, reportManagerScopedRows, reportPeriodScopedRows, reportTypeScopedRows, transactions]
  );
  const filteredTransactions = useMemo(() => {
    return repScopedRows.filter((row) => !filters.product || valueAsText(row.product) === filters.product);
  }, [filters.product, repScopedRows]);
  const view = useMemo(() => {
    if (transactions.length === 0) {
      return {
        channelMix: data.channelMix ?? [],
        currentPeriod: (data.trend ?? [])[((data.trend ?? []).length || 1) - 1],
        familyRows: data.familyMatrix ?? [],
        lineRows: data.linePerformance ?? [],
        managerRows: data.managerPerformance ?? [],
        previousPeriod: (data.trend ?? [])[((data.trend ?? []).length || 2) - 2],
        productRows: data.productPerformance ?? [],
        repRows: [],
        summary: data.summary ?? {},
        territoryRows: data.territories ?? [],
        trendRows: data.trend ?? [],
      };
    }
    return calculateView(filteredTransactions, data.summary ?? {});
  }, [data, filteredTransactions, transactions.length]);
  const summary = view.summary;
  const hasData = summary.approvedRecords > 0;
  const productRows = view.productRows.slice(0, 10);
  const trendRows = view.trendRows;
  const currentPeriod = view.currentPeriod as AnyRow | undefined;
  const previousPeriod = view.previousPeriod as AnyRow | undefined;
  const salesDelta = deltaPercent(valueAsNumber(currentPeriod?.sales), valueAsNumber(previousPeriod?.sales));
  const chartTrendRows = trendRows.map((row: AnyRow) => ({
    achievement: valueAsNumber(row.achievementRate) * 100,
    period: valueAsText(row.period),
    sales: valueAsNumber(row.sales),
    target: valueAsNumber(row.target),
  }));
  const resetFilters = () => setFilters({ area: "", line: "", manager: "", medicalRep: "", periods: [], product: "", salesType: "" });
  const activeFilterCount =
    filters.periods.length + [filters.area, filters.line, filters.manager, filters.medicalRep, filters.product, filters.salesType].filter(Boolean).length;
  const selectedPeriods = filters.periods.length > 0 ? filters.periods : filterOptions.periods;
  const channelTotal = view.channelMix.reduce((acc: number, row: AnyRow) => acc + valueAsNumber(row.value), 0);
  const reportTransactions = filteredTransactions.filter((row) => !isC01Row(row));
  const dsmLeadershipRows = buildLeadershipRows(reportTransactions, "managerName");
  const repLeadershipRows = buildLeadershipRows(reportTransactions, "employeeName");
  const dsmRankingRows = normalizeRankingRows(dsmLeadershipRows, "name");
  const repRankingRows = normalizeRankingRows(view.repRows, "rep");

  return (
    <div className="space-y-5">
      <AdminPageHero
        actions={(
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            {!portalMode && (
              <>
                <Link href="/sales/queue">
                  <Button className="gap-2 rounded-xl">
                    <FileSpreadsheet className="h-4 w-4" />
                    Uploaded Sheets
                  </Button>
                </Link>
                <Link href="/sales/upload">
                  <Button className="gap-2 rounded-xl border border-[#E2E8F0] bg-white text-[#0F172A] hover:bg-[#FFF7ED]" variant="secondary">
                    <FileUp className="h-4 w-4" />
                    Upload Monthly Closing Sheet
                  </Button>
                </Link>
              </>
            )}
          </div>
        )}
        badges={(
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 font-semibold text-[#64748B]">Period: {periodRangeLabel(selectedPeriods)}</span>
            <span className="rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 font-semibold text-[#64748B]">{formatNumber(summary.approvedRecords)} approved rows</span>
            <span className="rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 font-semibold text-[#64748B]">Achievement {formatPercent(summary.achievementRate)}</span>
          </div>
        )}
        description={portalMode
          ? "Sales performance across the periods, territories, products, and scope assigned to your employee account."
          : "Track approved sales, target progress, channel mix, line performance, and leadership rankings from one compact command surface."
        }
        eyebrow={portalMode ? "Employee sales" : "Sales intelligence"}
        icon={<BarChart3 className="h-3.5 w-3.5" />}
        title={portalMode ? "My Sales Dashboard" : "Sales dashboard"}
      />

      <AdminTableShell
        action={activeFilterCount > 0 ? (
          <button className="rounded-lg border border-orange-100 bg-orange-50 px-3 py-1.5 text-xs font-bold text-orange-700 hover:bg-orange-100" onClick={resetFilters} type="button">
            Clear {activeFilterCount}
          </button>
        ) : null}
        description="Filters cascade from period and line into area, DSM, rep, product, and channel."
        title="Command Filters"
      >
        <div className="space-y-4 p-4 sm:p-5">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <FilterField label="Period">
            <ReadOnlyField value={periodRangeLabel(selectedPeriods)} />
          </FilterField>
          <PeriodFilter onChange={(periods) => setFilters((current) => ({ ...current, periods }))} options={filterOptions.periods} value={filters.periods} />
          <FilterSelect
            label="Line"
            onChange={(line) => setFilters((current) => ({ ...current, area: "", line, manager: "", medicalRep: "", product: "", salesType: "" }))}
            options={filterOptions.lines}
            value={filters.line}
          />
          <FilterSelect
            label="Area"
            onChange={(area) => setFilters((current) => ({ ...current, area, manager: "", medicalRep: "", product: "", salesType: "" }))}
            options={filterOptions.areas}
            value={filters.area}
          />
        </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <FilterSelect label="Product / SKU" onChange={(product) => setFilters((current) => ({ ...current, product }))} options={filterOptions.products} value={filters.product} />
          <FilterSelect
            label="Medical Rep"
            onChange={(medicalRep) => setFilters((current) => ({ ...current, medicalRep, product: "" }))}
            options={filterOptions.medicalReps}
            value={filters.medicalRep}
          />
          <FilterSelect
            label="Manager / DSM"
            onChange={(manager) => setFilters((current) => ({ ...current, manager, medicalRep: "", product: "" }))}
            options={filterOptions.managers}
            value={filters.manager}
          />
          <FilterSelect
            label="Channel"
            onChange={(salesType) => setFilters((current) => ({ ...current, manager: "", medicalRep: "", product: "", salesType }))}
            options={filterOptions.salesTypes}
            value={filters.salesType}
          />
          <FilterField label="Data Source">
            <ReadOnlyField value="All Uploaded Sheets" />
          </FilterField>
        </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[#E2E8F0] pt-4">
            <div className="flex flex-wrap gap-2">
              <FilterChip label={`Period: ${periodRangeLabel(selectedPeriods)}`} onRemove={() => setFilters((current) => ({ ...current, periods: [] }))} />
              {filters.line && <FilterChip label={`Line: ${filters.line}`} onRemove={() => setFilters((current) => ({ ...current, area: "", line: "" }))} />}
              {filters.area && <FilterChip label={`Area: ${filters.area}`} onRemove={() => setFilters((current) => ({ ...current, area: "" }))} />}
              {filters.manager && <FilterChip label={`DSM: ${filters.manager}`} onRemove={() => setFilters((current) => ({ ...current, manager: "", medicalRep: "" }))} />}
            </div>
            <div className="flex flex-wrap gap-4">
              <MiniStat icon={FileSpreadsheet} label="Rows" value={formatNumber(summary.approvedRecords)} />
              <MiniStat icon={Package} label="Products" value={formatNumber(summary.activeProducts)} />
              <MiniStat icon={Users} label="Reps" value={formatNumber(summary.linkedEmployees)} />
              <MiniStat icon={MapPinned} label="Managers" value={formatNumber(summary.dsmTotalRecords ?? 0)} />
            </div>
          </div>
        </div>
      </AdminTableShell>

      {!hasData && (
        <AdminCallout tone="neutral">
          <AlertTriangle className="mt-0.5 h-5 w-5" />
          <div>
            <p className="font-semibold">
              {portalMode ? "No sales data is available for your scope yet" : "No sales batches yet"}
            </p>
            <p className="text-sm">
              {portalMode
                ? "Sales records will appear here once they are linked to your employee or team scope."
                : "Upload a monthly sales sheet to populate this dashboard."}
            </p>
            {!portalMode ? (
              <Link className="mt-3 inline-flex" href="/sales/queue">
                <Button variant="secondary">
                  Review Uploaded Sheets
                </Button>
              </Link>
            ) : null}
          </div>
        </AdminCallout>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard icon={BarChart3} label="Sales" value={formatCurrency(summary.totalApprovedSales)} sub={`${formatNumber(summary.approvedRecords)} rows read`} />
        <MetricCard icon={Target} label="Target" value={formatCurrency(summary.totalApprovedTarget)} sub={`${formatPercent(summary.achievementRate)} achievement`} tone={summary.achievementRate >= 1 ? "success" : summary.achievementRate >= 0.8 ? "warning" : "danger"} />
        <MetricCard icon={Boxes} label="Units Sold" value={formatNumber(summary.unitsSold)} sub={`${formatNumber(summary.activeProducts)} active products`} />
        <MetricCard icon={TrendingUp} label="Achievement" value={formatPercent(summary.achievementRate)} sub={`${formatPercent(salesDelta)} vs previous`} tone={summary.achievementRate >= 0.8 ? "success" : "danger"} />
        <MetricCard
          icon={Link2}
          label="DSM Linkage"
          value={`${formatNumber(summary.dsmLinkedRecords ?? summary.linkedRecords)} / ${formatNumber(summary.dsmTotalRecords ?? summary.approvedRecords)}`}
          sub={`${formatPercent(summary.dataQualityRate)} manager linkage`}
          tone={summary.dataQualityRate >= 0.9 ? "success" : "warning"}
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.85fr)_minmax(320px,0.7fr)]">
        <ChartCard title="Monthly Trends (Sales vs Target)" subtitle="Sales rows are grouped by the real Month/Year in each uploaded sheet.">
          <TrendLineChart rows={trendRows} />
        </ChartCard>

        <ChartCard title="Achievement Trend (%)" subtitle="Achievement percentage by selected month range.">
          <AchievementBars rows={chartTrendRows} />
        </ChartCard>

        <ChartCard title="Channel Mix (Sales)" subtitle="Retail vs stores contribution.">
          <DonutChart rows={view.channelMix} total={channelTotal} />
        </ChartCard>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <LeadershipTable rows={dsmLeadershipRows} title="DSM Leadership Table" />
        <LeadershipTable rows={repLeadershipRows} title="Medical Rep Leadership Table" />
      </div>

      <div className="grid gap-5">
        <RankingSplitTable limit={15} metric="achievement" rows={repRankingRows} title="Medical Reps Ranking by Achievement %" />
        <RankingSplitTable limit={15} metric="value" rows={repRankingRows} title="Medical Reps Ranking by Sales Value" />
        <RankingSplitTable limit={10} metric="achievement" rows={dsmRankingRows} title="DSM Ranking by Achievement %" />
        <RankingSplitTable limit={10} metric="value" rows={dsmRankingRows} title="DSM Ranking by Sales Value" />
      </div>

      <div className="grid gap-5">
        <ComparativeLineSales rows={view.lineRows} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(260px,0.8fr)]">
        <AdminTableShell
          description="Sales, target, achievement, and linked employees by period."
          title="Monthly Comparison Table"
        >
          <div className="p-4 sm:p-5">
            <PerformanceTable
              columns={[
                { key: "period", label: "Month", render: (row) => compactPeriod(valueAsText(row.period)) },
                { key: "sales", label: "Sales", render: (row) => formatCurrency(valueAsNumber(row.sales)) },
                { key: "target", label: "Target", render: (row) => formatCurrency(valueAsNumber(row.target)) },
                {
                  key: "achievementRate",
                  label: "Achievement",
                  render: (row) => (
                    <div className="min-w-28 space-y-1">
                      <AchievementBadge rate={valueAsNumber(row.achievementRate)} />
                      <ProgressBar rate={valueAsNumber(row.achievementRate)} />
                    </div>
                  ),
                },
                { key: "linkedEmployees", label: "Linked", render: (row) => formatNumber(valueAsNumber(row.linkedEmployees)) },
              ]}
              rows={trendRows}
            />
          </div>
        </AdminTableShell>
        <TopList labelKey="product" rows={productRows} title="Top 5 Products (By Sales)" />
      </div>

      <Card className={`${panelClassName} p-5`}>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="flex items-center gap-3">
            <Users className="h-5 w-5 text-[#F97316]" />
            <div>
              <p className="text-xs text-text-secondary">Linked Employees</p>
              <p className="font-bold text-text">{formatNumber(summary.linkedEmployees)}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <MapPinned className="h-5 w-5 text-[#F97316]" />
            <div>
              <p className="text-xs text-text-secondary">Territories</p>
              <p className="font-bold text-text">{formatNumber(view.territoryRows.length)}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <TrendingUp className="h-5 w-5 text-[#F97316]" />
            <div>
              <p className="text-xs text-text-secondary">Average Factory Price</p>
              <p className="font-bold text-text">{formatCurrency(summary.averageFactoryPrice)}</p>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
