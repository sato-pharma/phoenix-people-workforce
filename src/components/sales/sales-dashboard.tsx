"use client";

import {
  AlertTriangle,
  BarChart3,
  Boxes,
  Brain,
  ChevronDown,
  FileSpreadsheet,
  Link2,
  MapPinned,
  Package,
  Target,
  TrendingUp,
  UploadCloud,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import {
  AdminCallout,
  AdminPageHero,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { CrmCard, CrmCardsOnPhone, CrmFacts, CrmTable } from "@/components/phoenix-crm/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/sales/format";
import { buildSalesDashboardView } from "@/lib/sales/metrics";
import type { SalesDashboardData } from "@/lib/sales/types";
import { cn } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { SortableTh, TableSearchInput, useSortableTable, type SortState } from "@/components/ui/sortable-table";


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

const panelClassName =
  "rounded-3xl border border-phx-line bg-white/95 shadow-[0_18px_42px_rgba(15,23,42,0.07)]";

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

// Fractional change vs the previous value, or null when there is no prior baseline (previous === 0).
// Returning null lets callers render "—" instead of a misleading "+100%" for a brand-new period.
function deltaPercent(current: number, previous: number): number | null {
  if (!previous) return null;
  return (current - previous) / previous;
}

function formatDeltaPercent(delta: number | null): string {
  return delta === null ? "—" : formatPercent(delta);
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

function MetricCard({
  icon: Icon,
  label,
  sub,
  tone = "neutral",
  value,
  trend,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  sub?: string;
  tone?: "neutral" | "success" | "warning" | "danger";
  value: string;
  trend?: "up" | "down" | "neutral";
}) {
  const toneClasses = {
    danger: "bg-gradient-to-r from-rose-50 to-rose-100/50 text-rose-700 ring-rose-200/60",
    neutral: "bg-gradient-to-r from-orange-50 to-orange-100/50 text-orange-700 ring-orange-200/60",
    success: "bg-gradient-to-r from-emerald-50 to-emerald-100/50 text-emerald-700 ring-emerald-200/60",
    warning: "bg-gradient-to-r from-amber-50 to-amber-100/50 text-amber-700 ring-amber-200/60",
  };

  return (
    <Card className={`${panelClassName} group relative min-h-[138px] overflow-hidden px-5 py-4 transition-all duration-160 ease-out hover:-translate-y-px hover:border-phx-accent-line hover:bg-white hover:shadow-md`}>
      <div className="pointer-events-none absolute -right-8 -top-10 h-24 w-24 rounded-full bg-orange-200/20 blur-2xl" />
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500">{label}</p>
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" style={{ animationDuration: '1.5s' }} />
            {trend === "up" && <span className="text-emerald-500 text-xs font-semibold">↑</span>}
            {trend === "down" && <span className="text-rose-500 text-xs font-semibold">↓</span>}
          </div>
          <p className="mt-2 truncate text-2xl font-semibold text-slate-900">{value}</p>
          {sub && <p className="mt-1.5 text-xs text-slate-500">{sub}</p>}
        </div>
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1 shadow-sm transition-all duration-160 ease-out hover:scale-105 ${toneClasses[tone]}`}>
          <Icon className="h-4 w-4" />
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
    <div className="h-2 overflow-hidden rounded-full bg-phx-paper">
      <div className={cn("h-full rounded-full", color)} style={{ width: `${Math.min(pct, 100)}%` }} />
    </div>
  );
}

function SectionHeader({ title, subtitle }: { subtitle?: string; title: string }) {
  return (
    <div>
      <h2 className="text-base font-bold text-phx-ink">{title}</h2>
      {subtitle && <p className="mt-1 text-sm leading-6 text-phx-ink-soft">{subtitle}</p>}
    </div>
  );
}

function ChartCard({ children, subtitle, title }: { children: React.ReactNode; subtitle?: string; title: string }) {
  return (
    <Card className={`${panelClassName} relative overflow-hidden px-5 py-4 transition-all duration-160 ease-out hover:shadow-md`}>
      <div className="pointer-events-none absolute -right-12 -top-14 h-40 w-40 rounded-full bg-orange-200/20 blur-3xl" />
      <div className="flex items-start justify-between gap-3">
        <SectionHeader title={title} subtitle={subtitle} />
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-[#FED7AA] bg-phx-accent-soft px-2.5 py-1 text-phx-2xs font-black uppercase tracking-[0.16em] text-phx-accent-hover">
            Live
          </span>
        </div>
      </div>
      <div className="relative mt-4 rounded-[24px] border border-phx-line bg-[linear-gradient(180deg,#FFFFFF_0%,#F8FAFC_100%)] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">{children}</div>
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
      <svg className="h-[300px] w-full overflow-visible" viewBox={`0 0 ${width} ${height}`} role="img">
        {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
          const y = padTop + tick * (height - padTop - padBottom);
          return <line key={tick} x1={padX} x2={width - padX} y1={y} y2={y} stroke="#dbe3ee" strokeDasharray="4 8" strokeWidth="1" />;
        })}
        <defs>
          <linearGradient id="salesLineGradient" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#F59E0B" />
            <stop offset="52%" stopColor="#F97316" />
            <stop offset="100%" stopColor="#EA580C" />
          </linearGradient>
          <filter id="salesLineGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="8" stdDeviation="7" floodColor="#F97316" floodOpacity="0.28" />
          </filter>
          <linearGradient id="targetLineGradient" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#94A3B8" />
            <stop offset="100%" stopColor="#0F172A" />
          </linearGradient>
          <linearGradient id="salesAreaGradient" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#F97316" stopOpacity="0.15" />
            <stop offset="100%" stopColor="#F97316" stopOpacity="0" />
          </linearGradient>
        </defs>
        {rows.length > 1 && (
          <>
            <polyline fill="none" points={targetPoints} stroke="url(#targetLineGradient)" strokeLinecap="round" strokeLinejoin="round" strokeOpacity={0.55} strokeWidth={3} />
            <polygon fill="url(#salesAreaGradient)" points={`${salesPoints} ${xFor(rows.length - 1)},${height - padBottom} ${xFor(0)},${height - padBottom}`} opacity={0.5} />
            <polyline fill="none" filter="url(#salesLineGlow)" points={salesPoints} stroke="url(#salesLineGradient)" strokeLinecap="round" strokeLinejoin="round" strokeWidth={5} />
          </>
        )}
        {rows.map((row, index) => {
          const period = valueAsText(row.period);
          const x = xFor(index);
          const salesY = yFor(valueAsNumber(row.sales));
          const targetY = yFor(valueAsNumber(row.target));
          const isActive = activePeriod === period;
          return (
            <g key={period} onMouseEnter={() => setActivePeriod(period)} onMouseLeave={() => setActivePeriod(null)}>
              <line x1={x} x2={x} y1={padTop} y2={height - padBottom} stroke="transparent" strokeWidth={42} />
              <circle cx={x} cy={targetY} fill="#0F172A" opacity={0.55} r={isActive ? 6 : 5} />
              <circle cx={x} cy={salesY} fill="#f97316" r={isActive ? 9 : 7} stroke="#fff" strokeWidth={isActive ? 5 : 4} />
              <text fill="#64748b" fontSize={12} fontWeight="700" textAnchor="middle" x={x} y={height - 12}>
                {compactPeriod(period).replace(" 2026", "")}
              </text>
              <text fill="#0f172a" fontSize={12} fontWeight="800" textAnchor="middle" x={x} y={Math.min(salesY, targetY) - 12}>
                {shortCurrency(valueAsNumber(row.sales)).replace("EGP ", "")}
              </text>
            </g>
          );
        })}
      </svg>
      {activeRow && (
        <div className="absolute right-4 top-4 rounded-2xl border border-phx-line bg-white/95 p-3 text-xs shadow-[0_18px_40px_rgba(15,23,42,0.18)] backdrop-blur">
          <p className="font-black text-phx-ink">{compactPeriod(valueAsText(activeRow.period))}</p>
          <p className="mt-1 text-phx-ink-soft">Sales: {formatCurrency(valueAsNumber(activeRow.sales))}</p>
          <p className="text-phx-ink-soft">Target: {formatCurrency(valueAsNumber(activeRow.target))}</p>
          <p className="text-phx-ink-soft">Achievement: {formatPercent(valueAsNumber(activeRow.achievementRate))}</p>
        </div>
      )}
      <div className="mt-3 flex gap-5 rounded-2xl border border-phx-line bg-white/80 px-3 py-2 text-xs font-semibold text-phx-ink-soft">
        <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-orange-500 shadow-[0_0_12px_rgba(249,115,22,0.7)]" /> Sales</span>
        <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-phx-ink/70" /> Target</span>
      </div>
    </div>
  );
}

function DonutChart({ rows, total }: { rows: AnyRow[]; total: number }) {
  const first = valueAsNumber(rows[0]?.value);
  const firstPct = total > 0 ? (first / total) * 100 : 0;
  const gradient = rows.length <= 1 ? "#f97316 0 100%" : `#f97316 0 ${firstPct}%, #0f172a ${firstPct}% 100%`;

  return (
    <div className="grid gap-5 sm:grid-cols-[190px_minmax(0,1fr)]">
      <div className="relative mx-auto h-44 w-44 rounded-full p-2 shadow-[0_20px_45px_rgba(15,23,42,0.12)] transition-all duration-160 ease-out hover:shadow-lg" style={{ background: `conic-gradient(${gradient})` }}>
        <div className="absolute inset-7 flex flex-col items-center justify-center rounded-full border border-phx-line bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
          <p className="text-2xl font-black text-slate-900">{shortCurrency(total).replace("EGP ", "")}</p>
          <p className="text-phx-2xs font-bold uppercase tracking-[0.14em] text-slate-500">EGP Total</p>
        </div>
      </div>
      <div className="space-y-3 self-center">
        {rows.map((row, index) => {
          const value = valueAsNumber(row.value);
          const rate = total > 0 ? value / total : 0;
          return (
            <div className="rounded-2xl border border-phx-line bg-white/80 px-3 py-2 text-sm shadow-sm transition-all duration-160 ease-out hover:shadow-md hover:border-orange-200/60" key={valueAsText(row.name)}>
              <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 font-bold text-slate-900">
                <span className={cn("h-2.5 w-2.5 rounded-full", index === 0 ? "bg-orange-500 shadow-[0_0_10px_rgba(249,115,22,0.7)]" : "bg-phx-ink")} />
                {valueAsText(row.name)}
              </span>
              <span className="text-right text-xs font-semibold text-slate-600">
                {shortCurrency(value).replace("EGP ", "")} / {formatPercent(rate)}
              </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-phx-paper-2">
                <div className={cn("h-full rounded-full transition-all duration-160 ease-out", index === 0 ? "bg-gradient-to-r from-orange-400 to-orange-600" : "bg-phx-ink")} style={{ width: `${Math.min(rate * 100, 100)}%` }} />
              </div>
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
    <Card className="rounded-3xl border-phx-line bg-white/95 p-4 shadow-[0_16px_36px_rgba(15,23,42,0.07)]">
      <h3 className="text-xs font-black uppercase tracking-[0.1em] text-phx-ink">{title}</h3>
      <div className="mt-3 space-y-2.5">
        {topRows.map((row, index) => {
          const sales = valueAsNumber(row.sales);
          return (
            <div className="grid grid-cols-[20px_minmax(0,1fr)_60px] items-center gap-2" key={`${valueAsText(row[labelKey])}-${index}`}>
              <span className="flex h-5 w-5 items-center justify-center rounded-md bg-phx-paper text-phx-2xs font-black text-phx-ink-soft">{index + 1}</span>
              <div className="min-w-0">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <p className="truncate font-bold text-phx-ink">{valueAsText(row[labelKey])}</p>
                  <p className="shrink-0 text-phx-2xs font-bold text-phx-ink-soft">{shortCurrency(sales).replace("EGP ", "")}</p>
                </div>
                {valueAsText(row.area) && <p className="mt-0.5 truncate text-phx-2xs font-semibold text-phx-ink-soft">{valueAsText(row.area)}</p>}
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-phx-paper-2">
                  <div className="h-full rounded-full bg-[linear-gradient(90deg,#F59E0B_0%,#F97316_100%)]" style={{ width: `${Math.min((sales / max) * 100, 100)}%` }} />
                </div>
              </div>
              <p className="text-right text-phx-2xs font-semibold text-phx-ink-soft">{formatPercent(total > 0 ? sales / total : 0)}</p>
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
    <div className="overflow-hidden rounded-xl border border-phx-line transition-all duration-160 ease-out hover:shadow-md hover:border-phx-accent-line/50">
      <div className={cn("px-3 py-1.5 text-phx-2xs font-black uppercase tracking-[0.12em]", tone === "top" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700")}>
        {label}
      </div>
      <CrmTable className="text-xs" columns={metric === "achievement" ? ["8%", "34%", "18%", "20%", "20%"] : ["8%", "46%", "24%", "22%"]}>
        <thead className="bg-phx-paper text-phx-3xs uppercase tracking-[0.08em] text-phx-ink-soft">
          <tr>
            <th className="px-2 py-1.5 font-semibold">#</th>
            <th className="px-2 py-1.5 font-semibold">Name</th>
            <th className="px-2 py-1.5 font-semibold">{valueLabel}</th>
            {metric === "achievement" ? <th className="px-2 py-1.5 font-semibold">Sales</th> : null}
            <th className="px-2 py-1.5 font-semibold">Target</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {tableRows.map((row, index) => {
            const isTopPerformer = index === 0 && tone === "top";
            const area = valueAsText(row.area).trim();
            return (
              <tr className={cn("transition-all duration-160 ease-out hover:bg-phx-paper/80", isTopPerformer && "bg-emerald-50/30")} key={`${valueAsText(row.name)}-${label}-${index}`}>
                <td className={cn("px-2 py-1.5 align-top font-black text-phx-2xs", isTopPerformer ? "text-emerald-600" : "text-phx-ink-soft")}>{index + 1}</td>
                <td className="break-words px-2 py-1.5 align-top">
                  <p className={cn("break-words text-xs font-semibold", isTopPerformer ? "text-slate-900 font-bold" : "text-phx-ink")}>{valueAsText(row.name)}</p>
                  {area && area !== "-" ? <p className="mt-0.5 break-words text-phx-2xs font-semibold text-phx-ink-soft">{area}</p> : null}
                </td>
                <td className={cn("break-words px-2 py-1.5 align-top text-xs font-black", tone === "top" ? "text-emerald-600" : "text-rose-600")}>{renderValue(row)}</td>
                {metric === "achievement" ? <td className="break-words px-2 py-1.5 align-top text-xs text-phx-ink-soft">{shortCurrency(row.sales)}</td> : null}
                <td className="break-words px-2 py-1.5 align-top text-xs text-phx-ink-soft">{shortCurrency(row.target)}</td>
              </tr>
            );
          })}
        </tbody>
      </CrmTable>
      <CrmCardsOnPhone>
        {tableRows.map((row, index) => {
          const area = valueAsText(row.area).trim();
          return (
            <CrmCard
              key={`${valueAsText(row.name)}-${label}-${index}-card`}
              meta={area && area !== "-" ? area : undefined}
              title={`${index + 1}. ${valueAsText(row.name)}`}
            >
              <CrmFacts
                facts={[
                  { label: valueLabel, value: renderValue(row) },
                  ...(metric === "achievement" ? [{ label: "Sales", value: shortCurrency(row.sales) }] : []),
                  { label: "Target", value: shortCurrency(row.target) },
                ]}
              />
            </CrmCard>
          );
        })}
      </CrmCardsOnPhone>
    </div>
  );
}

function LeadershipTable({ rows, title }: { rows: AnyRow[]; title: string }) {
  const topAchievement = [...rows].sort((left, right) => valueAsNumber(right.achievementRate) - valueAsNumber(left.achievementRate))[0];
  const topValue = [...rows].sort((left, right) => valueAsNumber(right.sales) - valueAsNumber(left.sales))[0];

  const table = useSortableTable(rows, {
    columns: [
      { key: "name", accessor: (row) => valueAsText(row.name), type: "string" },
      { key: "sales", accessor: (row) => valueAsNumber(row.sales), type: "number" },
      { key: "target", accessor: (row) => valueAsNumber(row.target), type: "number" },
      { key: "achievementRate", accessor: (row) => valueAsNumber(row.achievementRate), type: "number" },
    ],
    searchAccessors: [(row) => valueAsText(row.name)],
    initialSort: null,
  });

  return (
    <Card className={`${panelClassName} p-4 transition-all duration-160 ease-out hover:shadow-md`}>
      <div className="flex items-center justify-between gap-3">
        <SectionHeader title={title} />
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-[#FED7AA] bg-phx-accent-soft px-2 py-0.5 text-phx-3xs font-black uppercase tracking-[0.14em] text-phx-accent-hover">
            Live
          </span>
        </div>
      </div>
      <div className="mt-3 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-emerald-200/60 bg-emerald-50/30 px-2.5 py-2">
            <p className="text-phx-3xs font-bold uppercase tracking-[0.08em] text-emerald-600">Highest Achievement</p>
            <p className="mt-0.5 text-xs font-black text-slate-900">{topAchievement ? valueAsText(topAchievement.name) : "—"}</p>
            <p className="text-phx-2xs font-semibold text-emerald-600">{topAchievement ? formatPercent(valueAsNumber(topAchievement.achievementRate)) : "—"}</p>
          </div>
          <div className="rounded-xl border border-orange-200/60 bg-orange-50/30 px-2.5 py-2">
            <p className="text-phx-3xs font-bold uppercase tracking-[0.08em] text-orange-600">Highest Sales</p>
            <p className="mt-0.5 text-xs font-black text-slate-900">{topValue ? valueAsText(topValue.name) : "—"}</p>
            <p className="text-phx-2xs font-semibold text-orange-600">{topValue ? shortCurrency(valueAsNumber(topValue.sales)) : "—"}</p>
          </div>
        </div>
        <div className="flex items-center justify-end">
          <div className="w-44">
            <TableSearchInput value={table.query} onChange={table.setQuery} onClear={table.clearQuery} placeholder="Search name…" />
          </div>
        </div>
        <div className="max-h-48 overflow-y-auto rounded-xl border border-phx-line bg-white">
          <CrmTable className="text-xs" columns={["40%", "20%", "20%", "20%"]}>
            <thead className="bg-phx-paper text-phx-3xs uppercase tracking-[0.08em] text-phx-ink-soft sticky top-0">
              <tr>
                <SortableTh label="Name" sortKey="name" {...leaderThProps(table)} />
                <SortableTh label="Sales" sortKey="sales" {...leaderThProps(table)} />
                <SortableTh label="Target" sortKey="target" {...leaderThProps(table)} />
                <SortableTh label="Ach. %" sortKey="achievementRate" {...leaderThProps(table)} />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {table.rows.length === 0 ? (
                <tr>
                  <td className="px-2 py-4 text-center text-xs text-phx-ink-faint" colSpan={4}>
                    {table.isFiltered ? "No names match your search." : "No rows."}
                  </td>
                </tr>
              ) : table.rows.map((row, index) => (
                <tr className="transition-all duration-160 ease-out hover:bg-phx-paper/80" key={`${valueAsText(row.name)}-${index}`}>
                  <td className="break-words px-2 py-1.5 align-top text-xs font-semibold text-phx-ink">{valueAsText(row.name)}</td>
                  <td className="break-words px-2 py-1.5 align-top text-xs font-black text-phx-accent">{shortCurrency(row.sales)}</td>
                  <td className="break-words px-2 py-1.5 align-top text-xs text-phx-ink-soft">{shortCurrency(row.target)}</td>
                  <td className="break-words px-2 py-1.5 align-top text-xs font-black">{formatPercent(valueAsNumber(row.achievementRate))}</td>
                </tr>
              ))}
            </tbody>
          </CrmTable>
          <CrmCardsOnPhone>
            {table.rows.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-phx-ink-faint">
                {table.isFiltered ? "No names match your search." : "No rows."}
              </p>
            ) : table.rows.map((row, index) => (
              <CrmCard key={`${valueAsText(row.name)}-${index}-card`} title={valueAsText(row.name)}>
                <CrmFacts
                  facts={[
                    { label: "Sales", value: shortCurrency(row.sales) },
                    { label: "Target", value: shortCurrency(row.target) },
                    { label: "Ach. %", value: formatPercent(valueAsNumber(row.achievementRate)) },
                  ]}
                />
              </CrmCard>
            ))}
          </CrmCardsOnPhone>
        </div>
      </div>
    </Card>
  );
}

// Compact sortable-header props shared by the leadership table columns.
function leaderThProps(table: { sort: SortState | null; toggleSort: (key: string) => void }) {
  return {
    sort: table.sort,
    onSort: table.toggleSort,
    variant: "light" as const,
    className: "px-2 py-1.5 text-phx-3xs tracking-[0.08em] font-semibold",
  };
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
    <Card className={`${panelClassName} p-4 transition-all duration-160 ease-out hover:shadow-md`}>
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
    <Card className={`${panelClassName} p-4 transition-all duration-160 ease-out hover:shadow-md`}>
      <SectionHeader title="Comparative Sales by Line" subtitle="Sales, target, achievement, and contribution by selected line." />
      <div className="mt-3 space-y-2.5">
        {topRows.length === 0 ? (
          <p className="rounded-lg border border-phx-line bg-phx-paper p-3 text-xs text-phx-ink-soft">No line sales data for the selected filters.</p>
        ) : (
          topRows.map((row, index) => {
            const sales = valueAsNumber(row.sales);
            const target = valueAsNumber(row.target);
            const rate = valueAsNumber(row.achievementRate);
            const isTopPerformer = index === 0;
            return (
              <div className={cn("rounded-xl border bg-white/80 px-3 py-2.5 shadow-sm transition-all duration-160 ease-out hover:border-phx-accent-line hover:bg-white hover:shadow-md", isTopPerformer ? "border-orange-200/60 bg-gradient-to-r from-orange-50/30 to-white" : "border-phx-line")} key={valueAsText(row.line)}>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className={cn("truncate text-xs font-black", isTopPerformer ? "text-orange-700" : "text-slate-900")}>{valueAsText(row.line)}</p>
                      {isTopPerformer && <span className="h-1 w-1 rounded-full bg-orange-500 animate-pulse" style={{ animationDuration: '1.5s' }} />}
                    </div>
                    <p className="text-phx-2xs font-semibold text-slate-500">{formatNumber(valueAsNumber(row.rows))} rows</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs font-black text-slate-900">{shortCurrency(sales)}</p>
                    <p className={cn("text-phx-2xs font-bold", rate >= 0.8 ? "text-emerald-600" : "text-rose-600")}>{formatPercent(rate)}</p>
                  </div>
                </div>
                <div className="mt-2 grid gap-1">
                  <div className="h-2 overflow-hidden rounded-full bg-phx-paper-2 shadow-[inset_0 1px 2px_rgba(15,23,42,0.06)]">
                    <div className={cn("h-full rounded-full shadow-[0_0_14px_rgba(249,115,22,0.35)] transition-all duration-160 ease-out", isTopPerformer ? "bg-gradient-to-r from-orange-400 to-orange-600" : "bg-gradient-to-r from-amber-400 to-orange-600")} style={{ width: `${Math.min((sales / maxSales) * 100, 100)}%` }} />
                  </div>
                  <div className="flex justify-between text-phx-2xs font-semibold text-slate-500">
                    <span>Tgt {shortCurrency(target)}</span>
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
    <div className="flex h-72 items-end gap-3 rounded-[22px] border border-phx-line bg-white/70 px-3 pb-3 pt-6">
      {rows.map((row) => {
        const achievement = valueAsNumber(row.achievement);
        const period = valueAsText(row.period);
        const isActive = activePeriod === period;
        return (
          <div
            className="relative flex min-w-0 flex-1 flex-col items-center gap-2"
            key={period}
            onMouseEnter={() => setActivePeriod(period)}
            onMouseLeave={() => setActivePeriod(null)}
          >
            <div className="flex h-52 w-full items-end justify-center rounded-t-2xl bg-[linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] px-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
              <div
                className={cn(
                  "w-full rounded-t-xl shadow-[0_10px_20px_rgba(15,23,42,0.12)] transition-all duration-160 ease-out hover:shadow-lg",
                  achievement >= 100
                    ? "bg-gradient-to-b from-emerald-400 to-emerald-600"
                    : achievement >= 80
                      ? "bg-gradient-to-b from-amber-400 to-orange-600"
                      : "bg-gradient-to-b from-rose-400 to-rose-600",
                )}
                style={{ height: `${Math.min(Math.max(achievement, 4), 120) / 120 * 100}%` }}
              />
            </div>
            <p className={cn("text-xs font-black text-slate-900 transition-all duration-160 ease-out", isActive ? "scale-110" : "")}>{achievement.toFixed(0)}%</p>
            <p className="truncate text-phx-xs font-semibold text-slate-500">{compactPeriod(period).replace(" 2026", "")}</p>
            {isActive && (
              <div className="absolute bottom-24 z-10 w-44 rounded-2xl border border-phx-line bg-white/95 p-3 text-center text-xs shadow-[0_18px_40px_rgba(15,23,42,0.18)] backdrop-blur">
                <p className="font-bold text-phx-ink">{compactPeriod(period)}</p>
                <p className="mt-1 text-phx-ink-soft">Achievement {achievement.toFixed(1)}%</p>
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
      <span className="mb-1 block text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500">{label}</span>
      <div className="relative">
        <SearchableSelect
          className="h-9 w-full appearance-none px-3 pr-9"
          onChange={(event) => onChange(event.target.value)}
          value={value}
        >
          <option value="">All</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </SearchableSelect>
        <ChevronDown className="pointer-events-none absolute right-3 top-2.5 h-4 w-4 text-slate-400 transition-transform duration-160 ease-out" />
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
      <p className="mb-1 block text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500">Month</p>
      <button
        className="flex h-9 w-full items-center justify-between rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none transition-all duration-160 ease-out hover:border-slate-300 hover:bg-slate-50 hover:shadow-sm"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {label}
        <ChevronDown className={cn("h-4 w-4 text-slate-400 transition-transform duration-160 ease-out", open && "rotate-180")} />
      </button>
      {open && (
        <div className="absolute z-30 mt-2 w-full rounded-xl border border-phx-line bg-white p-3 shadow-2xl">
          <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50">
            <input checked={allSelected} className="h-4 w-4 accent-orange-600" onChange={() => onChange([])} type="checkbox" />
            Select All
          </label>
          <div className="mt-1 max-h-56 space-y-1 overflow-auto">
            {options.map((period) => {
              const selected = allSelected || value.includes(period);
              return (
                <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50" key={period}>
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
      className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-700 transition-all duration-160 ease-out hover:bg-white hover:shadow-sm active:scale-95"
      onClick={onRemove}
      type="button"
    >
      {label}
      <span className="text-slate-400">×</span>
    </button>
  );
}

function MiniStat({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-phx-ink-soft">
      <Icon className="h-3.5 w-3.5" />
      {label}: <span className="text-phx-ink">{value}</span>
    </span>
  );
}

function FilterField({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div>
      <p className="mb-1 block text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500">{label}</p>
      {children}
    </div>
  );
}

function ReadOnlyField({ value }: { value: string }) {
  return (
    <div className="flex h-9 items-center rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-700">
      {value}
    </div>
  );
}

function PerformanceTable({
  columns,
  rows,
}: {
  columns: Array<{ key: string; label: string; render?: (row: AnyRow) => React.ReactNode; width: string }>;
  rows: AnyRow[];
}) {
  const [first, ...rest] = columns;
  return (
    <div className="overflow-hidden rounded-[24px] border border-phx-line">
      <CrmTable className="text-xs" columns={columns.map((column) => column.width)}>
        <thead className="bg-phx-paper text-phx-3xs uppercase tracking-[0.08em] text-phx-ink-soft">
          <tr>
            {columns.map((column) => (
              <th className="break-words px-2 py-1.5 font-semibold" key={column.key}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-phx-line bg-white">
          {rows.length === 0 ? (
            <tr>
              <td className="px-2 py-4 text-center text-xs text-phx-ink-soft" colSpan={columns.length}>
                No approved sales data yet.
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr className="transition hover:bg-phx-paper/80" key={`${row.name ?? row.manager ?? row.product ?? row.period ?? index}-${index}`}>
                {columns.map((column) => (
                  <td className="break-words px-2 py-1.5 align-top" key={column.key}>
                    {column.render ? column.render(row) : valueAsText(row[column.key])}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </CrmTable>
      <CrmCardsOnPhone>
        {rows.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-phx-ink-soft">No approved sales data yet.</p>
        ) : (
          rows.map((row, index) => (
            <CrmCard
              key={`${row.name ?? row.manager ?? row.product ?? row.period ?? index}-${index}-card`}
              title={first.render ? first.render(row) : valueAsText(row[first.key])}
            >
              <CrmFacts
                facts={rest.map((column) => ({
                  label: column.label,
                  value: column.render ? column.render(row) : valueAsText(row[column.key]),
                }))}
              />
            </CrmCard>
          ))
        )}
      </CrmCardsOnPhone>
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
              <>
                <Link href="/sales/upload">
                  <Button variant="secondary">Sales Upload</Button>
                </Link>
                <Link href="/sales/monthly-closing">
                  <Button variant="secondary">Monthly Closing</Button>
                </Link>
              </>
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
    return buildSalesDashboardView(filteredTransactions, data.summary ?? {});
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

  // Intelligence calculations
  const topTerritory = view.territoryRows.length > 0 ? view.territoryRows.reduce((max: AnyRow, row: AnyRow) => valueAsNumber(row.sales) > valueAsNumber(max.sales) ? row : max) : null;
  const topLine = view.lineRows.length > 0 ? view.lineRows.reduce((max: AnyRow, row: AnyRow) => valueAsNumber(row.sales) > valueAsNumber(max.sales) ? row : max) : null;
  const underperformingTerritories = view.territoryRows.filter((row: AnyRow) => valueAsNumber(row.achievementRate) < 0.8).length;
  const topRep = repRankingRows.length > 0 ? repRankingRows[0] : null;
  const growthTrend = salesDelta === null ? "flat" : salesDelta >= 0 ? "positive" : "negative";
  const ownershipSummary = (summary.salesOwnership ?? {}) as Record<string, { records?: number; salesValue?: number }>;
  const nonAssignableSales = ownershipSummary.non_assignable_territory_sales ?? { records: 0, salesValue: 0 };
  const vacantTerritorySales = ownershipSummary.vacant_territory_sales ?? { records: 0, salesValue: 0 };
  const lineLevelSales = ownershipSummary.line_level_sales ?? { records: 0, salesValue: 0 };
  const ownershipBadges = [
    nonAssignableSales.records ? `Non-Assignable Territory: ${formatNumber(nonAssignableSales.records)} / ${shortCurrency(nonAssignableSales.salesValue)}` : "",
    vacantTerritorySales.records ? `Vacant Territory: ${formatNumber(vacantTerritorySales.records)} / ${shortCurrency(vacantTerritorySales.salesValue)}` : "",
    lineLevelSales.records ? `Line-Level: ${formatNumber(lineLevelSales.records)} / ${shortCurrency(lineLevelSales.salesValue)}` : "",
  ].filter(Boolean);

  return (
    <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-phx-line bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.12),transparent_30%),linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] sm:p-6 xl:p-8">
      <div className="space-y-7">
      <div className="relative overflow-hidden rounded-3xl border border-phx-line bg-white/95 p-7 shadow-[0_20px_54px_rgba(15,23,42,0.09)]">
        <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-orange-200/35 blur-3xl" />
        <div className="pointer-events-none absolute bottom-0 left-12 h-28 w-28 rounded-full bg-slate-200/45 blur-2xl" />
        <div className="relative flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="flex-1">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-orange-500/20 bg-orange-500/5 px-3 py-1 backdrop-blur-sm">
              <span className="h-1.5 w-1.5 rounded-full bg-orange-400 shadow-[0_0_6px_rgba(249,115,22,0.5)]" />
              <span className="text-phx-2xs font-bold uppercase tracking-[0.2em] text-orange-600">
                {portalMode ? "Employee Sales" : "Sales Intelligence"}
              </span>
            </div>
            <h1 className="text-4xl font-black tracking-tight text-slate-950 sm:text-5xl">
              {portalMode ? "My Sales Dashboard" : "Sales Dashboard"}
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-500">
              {portalMode
                ? "Sales performance across the periods, territories, products, and scope assigned to your employee account."
                : "Track approved sales, target progress, channel mix, line performance, and leadership rankings from one compact command surface."}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <div className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-emerald-700 border border-emerald-200/60">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" style={{ animationDuration: '1.5s' }} />
                <span className="font-medium">Analytics Live</span>
              </div>
              <div className="flex items-center gap-1.5 rounded-full bg-sky-500/10 px-2.5 py-1 text-sky-700 border border-sky-200/60">
                <BarChart3 className="h-3 w-3" />
                <span className="font-medium">Forecast Updated</span>
              </div>
              <div className="flex items-center gap-1.5 rounded-full bg-violet-500/10 px-2.5 py-1 text-violet-700 border border-violet-200/60">
                <MapPinned className="h-3 w-3" />
                <span className="font-medium">Territory Monitoring</span>
              </div>
            </div>
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              {!portalMode && (
                <>
                  <Link href="/sales/upload">
                    <Button className="gap-2 rounded-xl bg-[#0B0B0B] font-black text-white shadow-[0_12px_26px_rgba(15,23,42,0.18)] transition-all duration-160 ease-out hover:bg-phx-accent hover:shadow-md hover:-translate-y-px active:scale-95">
                      <FileSpreadsheet className="h-4 w-4" />
                      Sales Upload
                    </Button>
                  </Link>
                  <Link href="/sales/monthly-closing">
                    <Button className="gap-2 rounded-xl" variant="secondary">
                      <UploadCloud className="h-4 w-4" />
                      Monthly Closing
                    </Button>
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="relative mt-5 flex flex-wrap gap-2 border-t border-phx-line pt-4 text-xs">
            <span className="rounded-full border border-phx-line bg-phx-paper px-3 py-2 font-semibold text-phx-ink-soft">Period: {periodRangeLabel(selectedPeriods)}</span>
            <span className="rounded-full border border-phx-line bg-phx-paper px-3 py-2 font-semibold text-phx-ink-soft">{formatNumber(summary.approvedRecords)} approved rows</span>
            <span className="rounded-full border border-phx-line bg-phx-paper px-3 py-2 font-semibold text-phx-ink-soft">Achievement {formatPercent(summary.achievementRate)}</span>
        </div>
      </div>

      {/* Executive Summary Intelligence */}
      {hasData && (
        <div className="relative overflow-hidden rounded-2xl border border-phx-line bg-gradient-to-r from-slate-50 to-white p-5 shadow-sm">
          <div className="pointer-events-none absolute -right-20 -top-20 h-48 w-48 rounded-full bg-orange-200/25 blur-3xl" />
          <div className="relative flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-orange-500 to-orange-600 text-white shadow-lg">
              <Brain className="h-5 w-5" />
            </div>
            <div className="flex-1">
              <h3 className="text-sm font-black uppercase tracking-[0.1em] text-slate-900">Executive Intelligence</h3>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <div className="flex items-center gap-2 rounded-lg border border-emerald-200/60 bg-emerald-50/50 px-3 py-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  <span className="text-xs font-semibold text-emerald-700">
                    {growthTrend === "positive" ? "Sales trending upward" : growthTrend === "negative" ? "Sales trending downward" : "No prior period to compare"}
                  </span>
                </div>
                {topLine && (
                  <div className="flex items-center gap-2 rounded-lg border border-orange-200/60 bg-orange-50/50 px-3 py-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-orange-500" />
                    <span className="text-xs font-semibold text-orange-700">
                      {valueAsText(topLine.line)} outperforming target
                    </span>
                  </div>
                )}
                {topTerritory && (
                  <div className="flex items-center gap-2 rounded-lg border border-sky-200/60 bg-sky-50/50 px-3 py-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />
                    <span className="text-xs font-semibold text-sky-700">
                      {valueAsText(topTerritory.name)} driving growth
                    </span>
                  </div>
                )}
                {underperformingTerritories > 0 && (
                  <div className="flex items-center gap-2 rounded-lg border border-amber-200/60 bg-amber-50/50 px-3 py-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                    <span className="text-xs font-semibold text-amber-700">
                      {underperformingTerritories} territory{underperformingTerritories > 1 ? "ies" : ""} below target
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Focal Intelligence Blocks */}
      {hasData && (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="relative overflow-hidden rounded-2xl border border-phx-line bg-gradient-to-br from-emerald-50 to-white p-5 shadow-sm transition-all duration-160 ease-out hover:shadow-md">
            <div className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-emerald-200/30 blur-3xl" />
            <div className="relative flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-emerald-600 text-white shadow-md">
                <TrendingUp className="h-4.5 w-4.5" />
              </div>
              <div className="flex-1">
                <p className="text-phx-2xs font-bold uppercase tracking-[0.1em] text-emerald-600">Top Territory</p>
                <p className="mt-1 text-lg font-black text-slate-900">{topTerritory ? valueAsText(topTerritory.name) : "—"}</p>
                <p className="mt-0.5 text-xs font-semibold text-slate-500">{topTerritory ? shortCurrency(valueAsNumber(topTerritory.sales)) : "—"}</p>
              </div>
            </div>
          </div>
          <div className="relative overflow-hidden rounded-2xl border border-phx-line bg-gradient-to-br from-orange-50 to-white p-5 shadow-sm transition-all duration-160 ease-out hover:shadow-md">
            <div className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-orange-200/30 blur-3xl" />
            <div className="relative flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-orange-500 to-orange-600 text-white shadow-md">
                <BarChart3 className="h-4.5 w-4.5" />
              </div>
              <div className="flex-1">
                <p className="text-phx-2xs font-bold uppercase tracking-[0.1em] text-orange-600">Top Line</p>
                <p className="mt-1 text-lg font-black text-slate-900">{topLine ? valueAsText(topLine.line) : "—"}</p>
                <p className="mt-0.5 text-xs font-semibold text-slate-500">{topLine ? formatPercent(valueAsNumber(topLine.achievementRate)) : "—"} achievement</p>
              </div>
            </div>
          </div>
          <div className="relative overflow-hidden rounded-2xl border border-phx-line bg-gradient-to-br from-sky-50 to-white p-5 shadow-sm transition-all duration-160 ease-out hover:shadow-md">
            <div className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-sky-200/30 blur-3xl" />
            <div className="relative flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-sky-600 text-white shadow-md">
                <Users className="h-4.5 w-4.5" />
              </div>
              <div className="flex-1">
                <p className="text-phx-2xs font-bold uppercase tracking-[0.1em] text-sky-600">Top Performer</p>
                <p className="mt-1 text-lg font-black text-slate-900">{topRep ? valueAsText(topRep.name) : "—"}</p>
                <p className="mt-0.5 text-xs font-semibold text-slate-500">{topRep ? formatPercent(valueAsNumber(topRep.achievementRate)) : "—"} achievement</p>
              </div>
            </div>
          </div>
        </div>
      )}

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
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-phx-line pt-4">
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
              <div className="mt-3 flex flex-wrap gap-2">
                <Link className="inline-flex" href="/sales/upload">
                  <Button variant="secondary">
                    Sales Upload
                  </Button>
                </Link>
                <Link className="inline-flex" href="/sales/monthly-closing">
                  <Button variant="secondary">
                    Monthly Closing
                  </Button>
                </Link>
              </div>
            ) : null}
          </div>
        </AdminCallout>
      )}

      {/* KPI Cards - Featured */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard icon={BarChart3} label="Sales" value={hasData ? formatCurrency(summary.totalApprovedSales) : "—"} sub={`${formatNumber(summary.approvedRecords)} rows read`} trend={salesDelta === null ? "neutral" : salesDelta >= 0 ? "up" : "down"} />
        <MetricCard icon={Target} label="Target" value={hasData ? formatCurrency(summary.totalApprovedTarget) : "—"} sub={hasData ? `${formatPercent(summary.achievementRate)} achievement` : "No data yet"} tone={!hasData ? "neutral" : summary.achievementRate >= 1 ? "success" : summary.achievementRate >= 0.8 ? "warning" : "danger"} trend={!hasData ? "neutral" : summary.achievementRate >= 0.8 ? "up" : "down"} />
        <MetricCard icon={Boxes} label="Units Sold" value={hasData ? formatNumber(summary.unitsSold) : "—"} sub={`${formatNumber(summary.activeProducts)} active products`} trend="neutral" />
        <MetricCard icon={TrendingUp} label="Achievement" value={hasData ? formatPercent(summary.achievementRate) : "—"} sub={`${formatDeltaPercent(salesDelta)} sales vs previous`} tone={!hasData ? "neutral" : summary.achievementRate >= 0.8 ? "success" : "danger"} trend={salesDelta === null ? "neutral" : salesDelta >= 0 ? "up" : "down"} />
        <MetricCard
          icon={Link2}
          label="DSM Linkage"
          value={`${formatNumber(summary.dsmLinkedRecords ?? summary.linkedRecords)} / ${formatNumber(summary.dsmTotalRecords ?? summary.approvedRecords)}`}
          sub={`${formatPercent(summary.dataQualityRate)} manager linkage`}
          tone={summary.dataQualityRate >= 0.9 ? "success" : "warning"}
          trend={summary.dataQualityRate >= 0.9 ? "up" : "neutral"}
        />
      </div>

      {ownershipBadges.length > 0 && (
        <div className="flex flex-wrap gap-2 rounded-2xl border border-phx-line bg-white/90 px-4 py-3 shadow-sm">
          {ownershipBadges.map((label) => (
            <Badge key={label} variant="neutral">{label}</Badge>
          ))}
        </div>
      )}

      {/* Charts - Featured Section */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.85fr)_minmax(320px,0.7fr)]">
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

      {/* Leadership Tables - Compressed */}
      <div className="grid gap-4 xl:grid-cols-2">
        <LeadershipTable rows={dsmLeadershipRows} title="DSM Leadership" />
        <LeadershipTable rows={repLeadershipRows} title="Medical Rep Leadership" />
      </div>

      {/* Rankings - Compressed */}
      <div className="grid gap-4">
        <RankingSplitTable limit={15} metric="achievement" rows={repRankingRows} title="Medical Reps by Achievement" />
        <RankingSplitTable limit={15} metric="value" rows={repRankingRows} title="Medical Reps by Sales" />
        <RankingSplitTable limit={10} metric="achievement" rows={dsmRankingRows} title="DSM by Achievement" />
        <RankingSplitTable limit={10} metric="value" rows={dsmRankingRows} title="DSM by Sales" />
      </div>

      {/* Comparative Sales - Featured */}
      <div className="grid gap-4">
        <ComparativeLineSales rows={view.lineRows} />
      </div>

      {/* Monthly Comparison - Compressed */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(260px,0.8fr)]">
        <AdminTableShell
          description="Sales, target, achievement, and linked employees by period."
          title="Monthly Comparison"
        >
          <div className="p-4 sm:p-5">
            <PerformanceTable
              columns={[
                { key: "period", label: "Month", width: "18%", render: (row) => compactPeriod(valueAsText(row.period)) },
                { key: "sales", label: "Sales", width: "22%", render: (row) => formatCurrency(valueAsNumber(row.sales)) },
                { key: "target", label: "Target", width: "22%", render: (row) => formatCurrency(valueAsNumber(row.target)) },
                {
                  key: "achievementRate",
                  label: "Achievement",
                  width: "26%",
                  render: (row) => (
                    <div className="space-y-1">
                      <AchievementBadge rate={valueAsNumber(row.achievementRate)} />
                      <ProgressBar rate={valueAsNumber(row.achievementRate)} />
                    </div>
                  ),
                },
                { key: "linkedEmployees", label: "Linked", width: "12%", render: (row) => formatNumber(valueAsNumber(row.linkedEmployees)) },
              ]}
              rows={trendRows}
            />
          </div>
        </AdminTableShell>
        <TopList labelKey="product" rows={productRows} title="Top 5 Products" />
      </div>

      {/* Footer Stats - Compressed */}
      <Card className={`${panelClassName} p-4`}>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="flex items-center gap-3">
            <Users className="h-4.5 w-4.5 text-phx-accent" />
            <div>
              <p className="text-phx-2xs font-bold uppercase tracking-[0.1em] text-slate-500">Linked Employees</p>
              <p className="text-sm font-bold text-slate-900">{formatNumber(summary.linkedEmployees)}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <MapPinned className="h-4.5 w-4.5 text-phx-accent" />
            <div>
              <p className="text-phx-2xs font-bold uppercase tracking-[0.1em] text-slate-500">Territories</p>
              <p className="text-sm font-bold text-slate-900">{formatNumber(view.territoryRows.length)}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <TrendingUp className="h-4.5 w-4.5 text-phx-accent" />
            <div>
              <p className="text-phx-2xs font-bold uppercase tracking-[0.1em] text-slate-500">Avg Factory Price</p>
              <p className="text-sm font-bold text-slate-900">{formatCurrency(summary.averageFactoryPrice)}</p>
            </div>
          </div>
        </div>
      </Card>
      </div>
    </div>
  );
}
