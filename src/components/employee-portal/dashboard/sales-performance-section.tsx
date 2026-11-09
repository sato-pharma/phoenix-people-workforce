import { useMemo, useState, type ReactElement } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartLine as LineChartIcon } from "lucide-react";

import { SafeResponsiveContainer } from "@/components/charts/safe-responsive-container";
import { Card } from "@/components/ui/card";
import type { MedicalRepPortalData } from "@/lib/employee-portal/service";

import { PayrollSummaryPanel } from "./payroll-payslips-section";

type ContributionMetric = "sales" | "units";
type ContributionRow = {
  name: string;
  sales: number;
  units: number;
  salesPercentage?: number;
  unitsPercentage?: number;
};

function egp(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

function periodLabel(value: string) {
  const [yearText, monthText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!year || !month) return value;
  return new Intl.DateTimeFormat("en", { month: "short", year: "numeric" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

function tooltipCurrency(value: unknown) {
  if (Array.isArray(value)) return egp(Number(value[0] ?? 0));
  return egp(Number(value ?? 0));
}

function formatUnits(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Number.isFinite(value) ? value : 0);
}

function formatContributionValue(metric: ContributionMetric, value: number) {
  return metric === "sales" ? egp(value) : formatUnits(value);
}

function getContributionValue(row: ContributionRow, metric: ContributionMetric) {
  return metric === "sales" ? row.sales : row.units;
}

function getContributionPercentage(row: ContributionRow, metric: ContributionMetric) {
  return metric === "sales"
    ? Number(row.salesPercentage ?? 0)
    : Number(row.unitsPercentage ?? 0);
}

function sortContributionRows(rows: ContributionRow[], metric: ContributionMetric) {
  return [...rows].sort((left, right) => getContributionValue(right, metric) - getContributionValue(left, metric));
}

function ContributionMetricToggle({
  metric,
  onChange,
}: {
  metric: ContributionMetric;
  onChange: (metric: ContributionMetric) => void;
}) {
  return (
    <div className="inline-flex rounded border border-slate-200 bg-white/80 p-1 shadow-[0_6px_18px_rgba(15,23,42,0.05)] ring-1 ring-white/80">
      {(["sales", "units"] as const).map((option) => {
        const active = metric === option;
        return (
          <button
            className={active
              ? "rounded bg-slate-950 px-3 py-1.5 text-xs font-bold text-white shadow-sm"
              : "rounded px-3 py-1.5 text-xs font-bold text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"}
            key={option}
            onClick={() => onChange(option)}
            type="button"
          >
            {option === "sales" ? "Sales" : "Units"}
          </button>
        );
      })}
    </div>
  );
}

function chartTooltipStyle() {
  return {
    backdropFilter: "blur(18px)",
    background: "rgba(255,255,255,0.96)",
    border: "1px solid rgba(226,232,240,0.9)",
    borderRadius: 0,
    boxShadow: "0 18px 44px rgba(15,23,42,0.14)",
    color: "#0f172a",
    fontSize: 12,
    fontWeight: 700,
  };
}

const chartAxisStyle = {
  fill: "#64748b",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0,
};

const chartMargin = { bottom: 6, left: 2, right: 16, top: 16 };
const chartGridStroke = "#e8edf4";
const chartCursor = { stroke: "#cbd5e1", strokeDasharray: "4 4", strokeWidth: 1.5 };

function chartAxisProps() {
  return {
    axisLine: false,
    stroke: "#94a3b8",
    style: chartAxisStyle,
    tickLine: false,
  };
}

function sectionTitle(kicker: string, title: string) {
  return (
    <div className="mb-2 flex items-center gap-3">
      <div className="h-8 w-[3px] rounded-full bg-gradient-to-b from-orange-400 to-orange-600" />
      <div>
        <p className="text-phx-sm font-bold uppercase tracking-[0.18em] text-orange-500">{kicker}</p>
        <h2 className="mt-0.5 text-[22px] font-semibold leading-tight tracking-tight text-slate-900">{title}</h2>
      </div>
    </div>
  );
}

function EmptyStateCard({
  message,
  title,
}: {
  message: string;
  title: string;
}) {
  return (
    <Card className="rounded border border-slate-200/90 bg-gradient-to-br from-white to-slate-50/50 p-10 text-center shadow-[0_12px_34px_rgba(15,23,42,0.05)]">
      <p className="mt-4 text-phx-sm font-bold uppercase tracking-[0.16em] text-slate-500">{title}</p>
      <p className="mt-2 text-sm text-slate-600">{message}</p>
    </Card>
  );
}

function MetricCard({
  label,
  tooltip,
  value,
}: {
  label: string;
  tooltip?: string;
  value: string;
}) {
  return (
    <div
      className="group relative overflow-hidden rounded border border-slate-200/90 bg-gradient-to-br from-white to-slate-50/50 px-4 py-3 shadow-[0_4px_14px_rgba(15,23,42,0.04)] transition-all duration-160 ease-out hover:-translate-y-px hover:shadow-md hover:border-slate-300"
      title={tooltip}
    >
      <div className="flex items-center gap-1.5 text-phx-sm font-bold uppercase tracking-[0.12em] text-slate-500">
        <span>{label}</span>
      </div>
      <p className="mt-2 text-base font-semibold text-slate-900">{value}</p>
    </div>
  );
}

function StableChartFrame({
  children,
  className,
  height,
}: {
  children: ReactElement;
  className: string;
  height: number;
}) {
  return (
    <SafeResponsiveContainer
      className={`${className} min-w-0 overflow-hidden`}
      minHeight={height}
      style={{ height }}
    >
      {children}
    </SafeResponsiveContainer>
  );
}

export function SalesPerformanceSection({ data }: { data: MedicalRepPortalData }) {
  const [productMetric, setProductMetric] = useState<ContributionMetric>("sales");
  const chartColors = ["#f97316", "#f59e0b", "#fdba74", "#94a3b8", "#cbd5e1"];
  const trendData = Array.isArray(data.sales.trend) ? data.sales.trend : [];
  const salesMissing = data.empty.sales;
  const productRows = useMemo(
    () => sortContributionRows(
      Array.isArray(data.sales.productContribution) ? data.sales.productContribution : [],
      productMetric,
    ),
    [data.sales.productContribution, productMetric],
  );
  const productChartRows = useMemo(
    () => productRows.map((row) => ({
      ...row,
      value: getContributionValue(row, productMetric),
    })),
    [productRows, productMetric],
  );

  return (
    <section id="sales" className="space-y-4">
      {sectionTitle("Sales Performance", "Sales Engine")}

      {salesMissing ? (
        <EmptyStateCard title="Sales Unavailable" message="Sales data has not been uploaded yet." />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[1.55fr_0.85fr]">
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
              <MetricCard label="Sales Value" value={egp(data.sales.currentMonthSales)} tooltip="Current month sales value" />
              <MetricCard label="Target Value" value={egp(data.sales.currentMonthTarget)} tooltip="Current month target" />
              <MetricCard label="Achievement %" value={`${data.sales.achievementPercent.toFixed(1)}%`} tooltip="Current month achievement" />
              <MetricCard label="Units" value={formatUnits(data.sales.units)} />
              <MetricCard label="Rank" value={data.sales.rankInTeam ? `#${data.sales.rankInTeam.position}/${data.sales.rankInTeam.total}` : "—"} />
              <MetricCard label="Top Product" value={data.sales.topProduct ?? "—"} />
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <Card className="rounded border border-white/80 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] p-5 shadow-[0_14px_34px_rgba(15,23,42,0.07)] ring-1 ring-slate-200/70">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="flex h-8 w-8 items-center justify-center rounded bg-orange-50 text-orange-600 ring-1 ring-orange-100">
                      <LineChartIcon className="h-4 w-4" />
                    </span>
                    <p className="text-sm font-black tracking-tight text-slate-900">Sales Trend</p>
                  </div>
                  <span className="rounded bg-slate-100 px-2.5 py-1 text-phx-sm font-bold uppercase tracking-[0.14em] text-slate-500">Monthly</span>
                </div>
                {trendData.length > 0 ? (
                  <StableChartFrame
                    className="h-64 w-full rounded border border-slate-100 bg-white/70 p-3 shadow-inner"
                    height={232}
                  >
                    <AreaChart data={trendData} margin={chartMargin}>
                      <defs>
                        <linearGradient id="salesFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#f97316" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#f97316" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke={chartGridStroke} vertical={false} />
                      <XAxis {...chartAxisProps()} dataKey="period" tickFormatter={periodLabel} />
                      <YAxis {...chartAxisProps()} tickFormatter={(value) => `${Math.round(Number(value) / 1000)}k`} />
                      <Tooltip
                        contentStyle={chartTooltipStyle()}
                        cursor={chartCursor}
                        formatter={(value: unknown) => tooltipCurrency(value)}
                        labelFormatter={(value) => `Period: ${periodLabel(String(value))}`}
                      />
                      <Area dataKey="target" dot={false} fill="none" name="Target" stroke="#64748b" strokeDasharray="5 5" strokeWidth={2.25} type="monotone" />
                      <Area activeDot={{ r: 5, stroke: "#ffffff", strokeWidth: 3 }} dataKey="sales" dot={false} fill="url(#salesFill)" name="Sales" stroke="#f97316" strokeWidth={3} type="monotone" />
                    </AreaChart>
                  </StableChartFrame>
                ) : (
                  <div className="h-64 w-full min-w-0 rounded border border-slate-100 bg-white/70 p-3 shadow-inner">
                    <div className="flex h-full items-center justify-center">
                      <p className="text-sm text-slate-500">No trend data available</p>
                    </div>
                  </div>
                )}
              </Card>

              <Card className="rounded border border-white/80 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] p-5 shadow-[0_14px_34px_rgba(15,23,42,0.07)] ring-1 ring-slate-200/70">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <p className="text-sm font-black tracking-tight text-slate-900">Sales vs Target</p>
                  <span className="rounded bg-slate-100 px-2.5 py-1 text-phx-sm font-bold uppercase tracking-[0.14em] text-slate-500">Variance</span>
                </div>
                {trendData.length > 0 ? (
                  <StableChartFrame
                    className="h-64 w-full rounded border border-slate-100 bg-white/70 p-3 shadow-inner"
                    height={232}
                  >
                    <BarChart data={trendData} margin={chartMargin}>
                      <defs>
                        <linearGradient id="salesBarFill" x1="0" x2="0" y1="0" y2="1">
                          <stop offset="0%" stopColor="#fb923c" />
                          <stop offset="100%" stopColor="#ea580c" />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke={chartGridStroke} vertical={false} />
                      <XAxis {...chartAxisProps()} dataKey="period" tickFormatter={periodLabel} />
                      <YAxis {...chartAxisProps()} tickFormatter={(value) => `${Math.round(Number(value) / 1000)}k`} />
                      <Tooltip contentStyle={chartTooltipStyle()} cursor={chartCursor} formatter={(value: unknown) => tooltipCurrency(value)} />
                      <Bar dataKey="sales" fill="url(#salesBarFill)" name="Sales" radius={[0, 0, 0, 0]} />
                      <Bar dataKey="target" fill="#cbd5e1" name="Target" radius={[0, 0, 0, 0]} />
                    </BarChart>
                  </StableChartFrame>
                ) : (
                  <div className="h-64 w-full min-w-0 rounded border border-slate-100 bg-white/70 p-3 shadow-inner">
                    <div className="flex h-full items-center justify-center">
                      <p className="text-sm text-slate-500">No trend data available</p>
                    </div>
                  </div>
                )}
              </Card>
            </div>

            <Card className="rounded border border-white/80 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] p-5 shadow-[0_14px_34px_rgba(15,23,42,0.07)] ring-1 ring-slate-200/70">
              <div className="mb-3 flex items-center justify-between gap-3">
                <p className="text-sm font-black tracking-tight text-slate-900">Product Mix & Contribution</p>
                <ContributionMetricToggle metric={productMetric} onChange={setProductMetric} />
              </div>
              <div className="grid gap-4 md:grid-cols-[1fr_1fr]">
                {productChartRows.length > 0 ? (
                  <StableChartFrame
                    className="h-56 w-full rounded border border-slate-100 bg-white/70 p-3 shadow-inner"
                    height={200}
                  >
                    <PieChart margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                      <Pie
                        cornerRadius={7}
                        data={productChartRows}
                        dataKey="value"
                        innerRadius={54}
                        outerRadius={84}
                        paddingAngle={2}
                        nameKey="name"
                        stroke="#ffffff"
                        strokeWidth={3}
                      >
                        {productChartRows.map((entry, index) => (
                          <Cell key={entry.name} fill={chartColors[index % chartColors.length]} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={chartTooltipStyle()} cursor={false} formatter={(value: unknown) => formatContributionValue(productMetric, Number(value ?? 0))} />
                    </PieChart>
                  </StableChartFrame>
                ) : (
                  <div className="h-56 w-full min-w-0 rounded border border-slate-100 bg-white/70 p-3 shadow-inner">
                    <div className="flex h-full items-center justify-center">
                      <p className="text-sm text-slate-500">No product mix data available</p>
                    </div>
                  </div>
                )}
                <div className="flex flex-col justify-center space-y-2">
                  {productRows.slice(0, 5).map((p, i) => (
                    <div key={p.name} className="flex items-center justify-between rounded border border-slate-100 bg-white px-3 py-2 text-xs shadow-[0_5px_14px_rgba(15,23,42,0.03)]">
                      <div className="flex items-center gap-2">
                        <div className="h-2.5 w-2.5 rounded-full ring-2 ring-white" style={{ backgroundColor: chartColors[i % chartColors.length] }} />
                        <span className="max-w-[120px] whitespace-nowrap font-bold text-slate-700" title={p.name}>{p.name}</span>
                      </div>
                      <div className="flex gap-3">
                        <span className="font-mono font-black text-slate-900 tabular-nums">{getContributionPercentage(p, productMetric).toFixed(1)}%</span>
                        <span className="font-mono text-slate-400 tabular-nums">{formatContributionValue(productMetric, getContributionValue(p, productMetric))}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          </div>

          <PayrollSummaryPanel data={data} />
        </div>
      )}
    </section>
  );
}
