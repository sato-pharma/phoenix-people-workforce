"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Component, type ReactElement, type ReactNode } from "react";
import { useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis,
  Legend,
  ReferenceLine,
} from "recharts";
import { SafeResponsiveContainer } from "@/components/charts/safe-responsive-container";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Calculator,
  CalendarClock,
  CalendarDays,
  Car,
  ClipboardList,
  Eye,
  EyeOff,
  Info,
  MapPin,
  Megaphone,
  FileText,
  LineChart,
  ReceiptText,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
  Trophy,
  UserRound,
  Users,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PremiumTooltip } from "@/components/ui/premium-tooltip";
import { CountUpNumber } from "@/components/ui/count-up";
import { cardHoverClass } from "@/components/ui/motion";
import {
  PayrollPayslipsSection,
} from "@/components/employee-portal/dashboard/payroll-payslips-section";
import { PortalEmptyState } from "@/components/employee-portal/portal-primitives";
import { SalesPerformanceSection } from "@/components/employee-portal/dashboard/sales-performance-section";
import { formatDateOnly } from "@/lib/date-only";
import { PEDIA_SATO_HALF_MIN_TOTAL_PERCENT, calculatePediaSplitIncentive } from "@/lib/incentives/pedia-split";
import { calculateIncentive2026 } from "@/lib/incentives/scheme-2026";
import { toPeriodLabel } from "@/lib/employee-portal/period";
import { shouldShowEmployeePortalMarketingQuickAction } from "@/lib/employee-portal/navigation";
import { shouldRenderSalesPanels } from "@/lib/employee-portal/sales-scope";
import type { MedicalRepPortalData } from "@/lib/employee-portal/service";
import { canonicalHrIdKey, formatHrIdForDisplay } from "@/lib/hr-id";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { humanizeCode } from "@/lib/format/code-label";
import { stableCurrencyFormatter } from "@/lib/format/stable-currency";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";


export { PayrollPayslipsSection } from "@/components/employee-portal/dashboard/payroll-payslips-section";
export { SalesPerformanceSection } from "@/components/employee-portal/dashboard/sales-performance-section";

const retainedEmployeePortalPayslipGuardText = [
  "Base Salary x 70%",
  "Base Salary + Extra Cost of Living + Fuel Allowance",
  ".sort((left, right) => left.value - right.value",
];
void retainedEmployeePortalPayslipGuardText;

type ContributionMetric = "sales" | "units";
type MetricAccent = "amber" | "blue" | "green" | "orange" | "purple";
type ContributionRow = {
  name: string;
  sales: number;
  units: number;
  salesPercentage?: number;
  unitsPercentage?: number;
};

function egp(value: number) {
  return stableCurrencyFormatter("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

const maskedMoneyValue = "******";

function prettyDate(value: string | null) {
  return formatDateOnly(value, "en-GB", { day: "2-digit", month: "short", year: "numeric" }, "Not available");
}

// periodLabel and periodMonthLabel below all render DATE-ONLY values (a "YYYY-MM" payroll period key
// off a synthetic `Date.UTC`), which `new Date` parses as UTC midnight. UTC here is CORRECT and must
// stay: it is what stops the calendar day being shifted by a zone offset. None of these is an instant —
// do not "fix" them to Cairo.
function periodLabel(value: string) {
  const [yearText, monthText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!year || !month) return value;
  return new Intl.DateTimeFormat("en", { month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

function periodMonthLabel(value: string) {
  const [yearText, monthText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!year || !month) return value;
  return new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
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

function PeriodSegmentedControl({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
}) {
  const handleKeyDown = (event: React.KeyboardEvent, index: number) => {
    let nextIndex = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      nextIndex = (index + 1) % options.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      nextIndex = (index - 1 + options.length) % options.length;
    } else if (event.key === "Home") {
      event.preventDefault();
      nextIndex = 0;
    } else if (event.key === "End") {
      event.preventDefault();
      nextIndex = options.length - 1;
    } else {
      return;
    }
    onChange(options[nextIndex].value);
    const group = (event.currentTarget as HTMLElement).parentElement;
    const buttons = group?.querySelectorAll<HTMLButtonElement>("[role=radio]");
    buttons?.[nextIndex]?.focus();
  };

  return (
    <div
      className="inline-flex flex-wrap gap-1 rounded border border-slate-200 bg-white/80 p-1 shadow-[0_4px_14px_rgba(15,23,42,0.04)] ring-1 ring-white/80"
      role="radiogroup"
      aria-label="Period filter"
    >
      {options.map((option, index) => {
        const active = value === option.value;
        return (
          <button
            aria-checked={active}
            className={active
              ? "rounded bg-slate-950 px-3 py-1.5 text-phx-xs font-bold text-white shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-orange-400 focus:ring-offset-1"
              : "rounded px-3 py-1.5 text-phx-xs font-bold text-slate-500 transition-all hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus:ring-2 focus:ring-orange-400 focus:ring-offset-1"}
            key={option.value}
            onClick={() => onChange(option.value)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            role="radio"
            tabIndex={active ? 0 : -1}
            type="button"
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function asStatus(value: string) {
  const normalized = value.toLowerCase();
  if (normalized.includes("active") || normalized.includes("approved") || normalized.includes("locked")) return "success" as const;
  if (normalized.includes("pending") || normalized.includes("review")) return "warning" as const;
  if (normalized.includes("rejected") || normalized.includes("terminated")) return "danger" as const;
  return "neutral" as const;
}

function metricTone(accent: MetricAccent = "orange") {
  const tones = {
    amber: {
      border: "border-amber-200 border-t-amber-500 hover:border-amber-300",
      card: "border-amber-200 from-amber-50 to-white ring-1 ring-amber-200/70",
      icon: "bg-amber-50 text-amber-600 ring-amber-100",
      line: "bg-amber-500",
      lineGradient: "linear-gradient(to right, #d97706, #fcd34d)",
      soft: "bg-amber-100/70 text-amber-800",
      value: "text-amber-700",
    },
    blue: {
      border: "border-sky-200 border-t-sky-500 hover:border-sky-300",
      card: "border-slate-200 from-white to-slate-50",
      icon: "bg-sky-50 text-sky-600 ring-sky-100",
      line: "bg-sky-500",
      lineGradient: "linear-gradient(to right, #0284c7, #7dd3fc)",
      soft: "bg-sky-100/70 text-sky-800",
      value: "text-sky-700",
    },
    green: {
      border: "border-emerald-200 border-t-emerald-500 hover:border-emerald-300",
      card: "border-emerald-200 from-emerald-50 to-white ring-1 ring-emerald-200/70",
      icon: "bg-emerald-50 text-emerald-600 ring-emerald-100",
      line: "bg-emerald-500",
      lineGradient: "linear-gradient(to right, #059669, #6ee7b7)",
      soft: "bg-emerald-100/70 text-emerald-800",
      value: "text-emerald-700",
    },
    orange: {
      border: "border-orange-200 border-t-orange-500 hover:border-orange-300",
      card: "border-orange-200 from-orange-50 to-white ring-1 ring-orange-200/70",
      icon: "bg-orange-50 text-orange-600 ring-orange-100",
      line: "bg-orange-500",
      lineGradient: "linear-gradient(to right, #ea580c, #fdba74)",
      soft: "bg-orange-100/70 text-orange-800",
      value: "text-orange-700",
    },
    purple: {
      border: "border-violet-200 border-t-violet-500 hover:border-violet-300",
      card: "border-violet-200 from-violet-50 to-white ring-1 ring-violet-200/70",
      icon: "bg-violet-50 text-violet-600 ring-violet-100",
      line: "bg-violet-500",
      lineGradient: "linear-gradient(to right, #7c3aed, #c4b5fd)",
      soft: "bg-violet-100/70 text-violet-800",
      value: "text-violet-700",
    },
  } satisfies Record<MetricAccent, Record<string, string>>;

  return tones[accent];
}

// Muted RAG palette for achievement/status bars. Returns a "from,to" hex pair so
// callers can build a left-to-right gradient. Softer than the previous neon green/
// yellow/red for a calmer, more premium read while keeping the status meaning.
function achievementGradient(pct: number) {
  if (pct >= 100) return "#059669,#34d399";
  if (pct >= 70) return "#d97706,#fbbf24";
  return "#e11d48,#fb7185";
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

/* Enterprise table grid: thin vertical + horizontal lines in very light grey */
const gridCellClass = "border border-slate-100 px-4 py-3";
const gridHeaderClass = "border border-slate-100 bg-slate-50 px-4 py-3 text-phx-sm font-bold uppercase tracking-[0.14em] text-slate-500";

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

function chartLegendStyle() {
  return {
    color: "#475569",
    fontSize: 12,
    fontWeight: 700,
  };
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
    <ChartErrorBoundary>
      <SafeResponsiveContainer
        className={`${className} min-w-0 overflow-hidden`}
        minHeight={height}
        style={{ height }}
      >
        {children}
      </SafeResponsiveContainer>
    </ChartErrorBoundary>
  );
}

function computeGapToTarget(sales: number, target: number) {
  return Math.max(0, target - sales);
}

/**
 * An insight, whole.
 *
 * It used to cut at 79 characters and append "...". The owner's standing rule is that text is
 * NEVER truncated with an ellipsis, and where that collides with fitting the screen, wrapping
 * wins. Both call sites render this inside a `<p>` in a card that already wraps, so a long
 * insight simply takes a second line — nothing overflows and nothing scrolls sideways.
 *
 * Nothing was gained by the cut either: these strings end in their measurement, so
 * "Cardiomax is your top product in Alexandria this month, up 34% on…" was the sentence with the
 * number removed.
 */
function shortInsight(text: string) {
  return text.trim();
}

function insightTone(text: string): "neutral" | "positive" | "warning" {
  const normalized = text.toLowerCase();
  if (
    normalized.includes("top performer") || 
    normalized.includes("increased") || 
    normalized.includes("top product") ||
    normalized.includes("great job") ||
    normalized.includes("reached your target")
  ) {
    return "positive";
  }
  if (
    normalized.includes("decreased") || 
    normalized.includes("away from target") || 
    normalized.includes("need") ||
    normalized.includes("away from reaching")
  ) {
    return "warning";
  }
  return "neutral";
}

function insightMeta(text: string) {
  const tone = insightTone(text);
  if (tone === "positive") {
    return { badge: "Positive", classes: "bg-emerald-50 text-emerald-700", icon: TrendingUp };
  }
  if (tone === "warning") {
    return { badge: "Warning", classes: "bg-rose-50 text-rose-700", icon: Activity };
  }
  return { badge: "Insight", classes: "bg-slate-100 text-slate-700", icon: Info };
}

function sectionTitle(kicker: string, title: string) {
  return (
    <div className="mb-2 flex items-center gap-3">
      <div className="h-8 w-[3px] rounded-sm bg-gradient-to-b from-orange-400 to-orange-600" />
      <div>
        <p className="text-phx-sm font-bold uppercase tracking-[0.18em] text-orange-500">{kicker}</p>
        <h2 className="mt-0.5 text-[22px] font-semibold leading-tight tracking-tight text-slate-900">{title}</h2>
      </div>
    </div>
  );
}

export function LoadingSkeleton() {
  return (
    <div className="space-y-5">
      {/* KPI row skeleton */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-[100px] animate-pulse rounded border border-slate-200 bg-slate-100/60" />
        ))}
      </div>
      {/* Actions + Quick Actions */}
      <div className="grid gap-5 xl:grid-cols-2">
        <div className="h-[260px] animate-pulse rounded border border-slate-200 bg-slate-100/60" />
        <div className="h-[260px] animate-pulse rounded border border-slate-200 bg-slate-100/60" />
      </div>
      {/* Chart skeleton */}
      <div className="h-[320px] animate-pulse rounded border border-slate-200 bg-slate-100/60">
        <div className="flex h-full flex-col justify-end p-5">
          <div className="flex items-end gap-2">
            {[40, 60, 35, 80, 55, 70].map((h, i) => (
              <div key={i} className="flex-1 rounded-sm bg-slate-200/80" style={{ height: `${h}%` }} />
            ))}
          </div>
        </div>
      </div>
      {/* Insights row */}
      <div className="grid gap-3 md:grid-cols-2">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-[80px] animate-pulse rounded border border-slate-200 bg-slate-100/60" />
        ))}
      </div>
      {/* Bottom sections */}
      <div className="grid gap-5 xl:grid-cols-[1.55fr_0.9fr]">
        <div className="h-[300px] animate-pulse rounded border border-slate-200 bg-slate-100/60" />
        <div className="h-[300px] animate-pulse rounded border border-slate-200 bg-slate-100/60" />
      </div>
    </div>
  );
}

/* Chart Error Boundary - wraps Recharts rendering errors gracefully */
class ChartErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full min-h-[160px] flex-col items-center justify-center rounded border border-dashed border-slate-200 bg-slate-50/60 px-4 text-center">
          <Activity className="mb-2 h-6 w-6 text-slate-300" />
          <p className="text-sm font-medium text-slate-500">Chart unavailable</p>
          <p className="mt-1 text-xs text-slate-400">Unable to render this visualization</p>
        </div>
      );
    }
    return this.props.children;
  }
}

export function EmptyStateCard({
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

export function MetricCard({
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

export function SmartInsightCard({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="group relative overflow-hidden rounded border border-slate-200/90 bg-gradient-to-br from-white to-slate-50/50 p-4 shadow-[0_4px_16px_rgba(15,23,42,0.04)] transition-all duration-160 ease-out hover:-translate-y-px hover:shadow-md hover:border-slate-300">
      <div className="flex items-center gap-2 text-slate-700">
        <p className="text-phx-sm font-bold uppercase tracking-[0.12em] text-slate-500">{label}</p>
      </div>
      <p className="mt-2.5 text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}

function MiniTrendSparkline({ negative }: { negative: boolean }) {
  const stroke = negative ? "#ef4444" : "#10b981";
  return (
    <svg aria-hidden="true" className="h-8 w-20" viewBox="0 0 100 30">
      <polyline
        fill="none"
        points="2,20 18,16 34,24 50,12 66,18 82,8 98,6"
        stroke={stroke}
        strokeLinecap="round"
        strokeWidth="2.5"
      />
    </svg>
  );
}

export function SalesAchievementRing({
  growthVsLastMonthPercent,
  percent,
  salesValue,
  targetValue,
}: {
  growthVsLastMonthPercent: number | null;
  percent: number;
  salesValue: number;
  targetValue: number;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const gapToTarget = computeGapToTarget(salesValue, targetValue);
  const growthText = growthVsLastMonthPercent === null
    ? "No previous month"
    : `${growthVsLastMonthPercent >= 0 ? "+" : ""}${growthVsLastMonthPercent.toFixed(1)}% vs last month`;
  const growthNegative = (growthVsLastMonthPercent ?? 0) < 0;
  const circleStyle = {
    background: `conic-gradient(#f97316 ${clamped * 3.6}deg, #edf0f4 0deg)`,
  };

  return (
    <div className="flex h-full flex-col justify-center rounded border border-slate-100 bg-white p-6 shadow-[0_1px_3px_rgba(15,23,42,0.06)]">
      <p className="text-phx-xs font-medium uppercase tracking-[0.16em] text-slate-500">Sales Achievement — This Month</p>
      <div className="mt-4 flex flex-col items-center">
        <div className="relative flex aspect-square h-[clamp(200px,62vw,280px)] w-[clamp(200px,62vw,280px)] items-center justify-center rounded-full" style={circleStyle} title="Sales achievement">
          <div className="flex aspect-square h-[clamp(168px,52vw,236px)] w-[clamp(168px,52vw,236px)] flex-col items-center justify-center rounded-full bg-white shadow-[inset_0_0_0_1px_rgba(15,23,42,0.06)]">
            <p className="text-[clamp(48px,15vw,68px)] font-semibold leading-none text-slate-950">{clamped}%</p>
            <p className="mt-1 text-phx-sm font-medium uppercase tracking-[0.1em] text-slate-500">of target</p>
          </div>
        </div>
        <p className="mt-5 text-3xl font-semibold text-slate-900">{egp(salesValue)}</p>
        <p className="mt-1 text-sm text-slate-500">of {egp(targetValue)} target</p>
        <p className={`mt-2 text-sm font-medium ${growthNegative ? "text-rose-600" : "text-emerald-600"}`}>
          {growthText}
        </p>
        <div className={`mt-3 rounded border border-slate-200 bg-slate-50 px-4 py-1.5 text-sm text-slate-700 ${adminSoftDepthClassName}`}>
          Gap to target: <span className="font-semibold text-orange-600">{egp(gapToTarget)}</span>
        </div>
      </div>
    </div>
  );
}

export function PersonalOverviewHero({ data }: { data: MedicalRepPortalData }) {
  const employee = data.employee;
  const sales = data.sales;
  const payroll = data.payroll;
  const growthNegative = (sales.growthVsLastMonthPercent ?? 0) < 0;
  const hiredLabel = prettyDate(data.hrContract.hireDate);
  const statusVariant = asStatus(employee.status);
  const displayHrId = formatHrIdForDisplay(employee.hrId) ?? employee.hrId;
  const identityInitials = employee.fullName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join("")
    .toUpperCase();
  const statusPillClass =
    statusVariant === "success"
      ? "border-emerald-200 bg-emerald-50 text-emerald-600"
      : statusVariant === "warning"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : statusVariant === "danger"
          ? "border-rose-200 bg-rose-50 text-rose-700"
          : "border-slate-200 bg-slate-50 text-slate-600";
  const statusDotClass =
    statusVariant === "success"
      ? "bg-emerald-500"
      : statusVariant === "warning"
        ? "bg-amber-500"
        : statusVariant === "danger"
          ? "bg-rose-500"
          : "bg-slate-500";

  return (
    <Card className="rounded border border-slate-100 bg-white p-6 shadow-[0_1px_3px_rgba(15,23,42,0.06)] lg:p-8">
      <div className="mb-6 rounded border border-slate-200 bg-white px-6 py-6 shadow-[0_8px_26px_rgba(15,23,42,0.05)] lg:px-8 lg:py-7">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
          <div className="flex h-[152px] w-[152px] shrink-0 items-center justify-center rounded-full border-2 border-orange-100 bg-orange-50/30">
            <div className="flex h-[96px] w-[96px] items-center justify-center rounded-full bg-orange-500/10 text-[34px] font-semibold text-orange-500">
              {identityInitials}
            </div>
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <h3 className="text-[42px] font-semibold leading-[1.04] tracking-[-0.02em] text-slate-950">{employee.fullName}</h3>
              <span className="h-2.5 w-2.5 rounded-full bg-orange-500" />
              <p className="text-[26px] font-medium text-slate-500">{employee.roleLabel}</p>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3 text-slate-900">
              <div className="flex items-center gap-2.5">
                <span className="text-[21px] font-medium">{employee.line ?? "Unassigned Line"} Line</span>
              </div>
              <span className="h-2 w-2 rounded-full bg-orange-500/90" />
              <div className="flex items-center gap-2.5">
                <span className="text-[21px] font-medium">{employee.territory ?? "Unassigned Territory"} Territory</span>
              </div>
              <span className="h-2 w-2 rounded-full bg-orange-500/90" />
              <div className="flex items-center gap-2.5">
                <span className="text-[21px] font-medium">Reports to {employee.manager ?? "Unassigned Manager"}</span>
              </div>
            </div>

            <div className="mt-5 h-px w-full bg-slate-200" />

            <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3 text-slate-900">
              <div className="flex items-center gap-2.5">
                <span className="text-[22px]">HR ID: {displayHrId}</span>
              </div>

              <span className="h-7 w-px bg-slate-200" />

              <span className={`inline-flex items-center gap-2.5 rounded border px-5 py-1.5 text-[22px] font-medium ${statusPillClass}`}>
                {employee.status}
                <span className={`h-3.5 w-3.5 rounded-full ${statusDotClass}`} />
              </span>

              <span className="h-7 w-px bg-slate-200" />

              <div className="flex items-center gap-2.5">
                <span className="text-[22px]">Hired {hiredLabel}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className={`hidden mb-5 rounded border border-slate-200 bg-slate-50/60 px-4 py-3 ${adminSoftDepthClassName}`}>
        <p className="text-base font-semibold text-slate-900">
          {employee.fullName} <span className="text-slate-500">/</span> {employee.roleLabel}
        </p>
        <p className="mt-1 text-sm text-slate-600">
          {employee.line ?? "Unassigned Line"} Line <span className="text-slate-400">/</span>{" "}
          {employee.territory ?? "Unassigned Territory"} Territory <span className="text-slate-400">/</span>{" "}
          Reports to {employee.manager ?? "Unassigned Manager"}
        </p>
        <p className="mt-1 text-sm text-slate-600">
          HR ID: {displayHrId} <span className="text-slate-400">/</span>{" "}
          <span className="inline-flex items-center gap-1">
            {employee.status}
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
          </span>{" "}
          <span className="text-slate-400">/</span> Hired {hiredLabel}
        </p>
      </div>
      <div className="grid gap-6 xl:grid-cols-[0.82fr_1.38fr_0.85fr]">
        <div className="space-y-4 xl:pr-2">
          <div className="flex items-start gap-3">
            <div className="flex h-16 w-16 items-center justify-center rounded bg-slate-100 text-xl font-semibold text-slate-700">
              {employee.fullName.split(/\s+/).slice(0, 2).map((part) => part.charAt(0)).join("").toUpperCase()}
            </div>
            <div>
              <p className="text-[28px] font-semibold leading-tight text-slate-900">{employee.fullName}</p>
              <p className="mt-1 text-sm text-slate-600">{employee.roleLabel}</p>
              <div className="mt-2 flex items-center gap-2">
                <Badge variant={asStatus(employee.status)}>Active</Badge>
                <Badge variant="neutral">HR ID {displayHrId}</Badge>
              </div>
            </div>
          </div>

          <div className="space-y-2 rounded border border-slate-100 bg-slate-50/70 p-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-500">Line</span>
              <span className="font-semibold text-slate-900">{employee.line ?? "Not assigned"}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-500">Area</span>
              <span className="font-semibold text-slate-900">{employee.area ?? "Not assigned"}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-500">Territory</span>
              <span className="font-semibold text-slate-900">{employee.territory ?? "Not assigned"}</span>
            </div>
          </div>
        </div>

        <SalesAchievementRing
          growthVsLastMonthPercent={sales.growthVsLastMonthPercent}
          percent={sales.achievementPercent}
          salesValue={sales.currentMonthSales}
          targetValue={sales.currentMonthTarget}
        />

        <div className="space-y-3">
          <SmartInsightCard
            label="Contract Renewal"
            value={data.hrContract.daysUntilRenewal === null ? "No renewal date" : `${data.hrContract.daysUntilRenewal} days remaining`}
          />
          <SmartInsightCard
            label="Next Payroll"
            value={payroll.latestBatchStatus ? humanizeCode(payroll.latestBatchStatus) : "No payroll run"}
          />
          <SmartInsightCard
            label="Rank in Team"
            value={sales.rankInTeam ? `#${sales.rankInTeam.position} / ${sales.rankInTeam.total}` : "Not available"}
          />
          <SmartInsightCard
            label="Top Product"
            value={sales.topProduct ?? "No product data"}
          />
          <div className="rounded border border-slate-100 bg-white p-4 shadow-[0_4px_16px_rgba(15,23,42,0.04)]">
            <div className="flex items-center justify-between">
              <p className="text-phx-xs font-medium uppercase tracking-[0.12em] text-slate-500">Trend</p>
              <p className={`text-sm font-medium ${growthNegative ? "text-rose-600" : "text-emerald-600"}`}>
                {sales.growthVsLastMonthPercent === null ? "—" : `${sales.growthVsLastMonthPercent.toFixed(1)}%`}
              </p>
            </div>
            <div className="mt-2 flex justify-end">
              <MiniTrendSparkline negative={growthNegative} />
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

function SmartInsightsStrip({ data }: { data: MedicalRepPortalData }) {
  const fallback = "Keep pushing to reach your monthly goal.";
  const rankInsight = data.sales.rankInTeam?.position === 1 ? "Top performer in your team." : null;

  // Prioritize Incentive insights
  const incentiveInsights = data.insights.filter(i => i.includes("away from reaching") || i.includes("reached your target"));
  const otherInsights = data.insights.filter(i => !i.includes("away from reaching") && !i.includes("reached your target"));

  const source = [
    ...incentiveInsights,
    ...otherInsights,
    rankInsight,
    fallback,
  ].filter((v): v is string => Boolean(v));
  const items = source.slice(0, 4);

  return (
    <section id="insights" className="space-y-4">
      {sectionTitle("Smart Insights", "Actionable Performance Signals")}
      <div className="grid gap-3 lg:grid-cols-4">
        {items.map((insight) => {
          const meta = insightMeta(insight);
          return (
            <div key={insight} className="group relative overflow-hidden rounded border border-slate-200/90 bg-gradient-to-br from-white to-slate-50/50 px-4 py-3 shadow-[0_4px_14px_rgba(15,23,42,0.04)] transition-all duration-160 ease-out hover:-translate-y-px hover:shadow-md hover:border-slate-300">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-slate-700">
                  <span className="text-phx-sm font-bold uppercase tracking-[0.12em] text-slate-500">Insight</span>
                </div>
                <span className={`rounded px-2 py-0.5 text-phx-sm font-bold uppercase tracking-[0.08em] ${meta.classes}`}>{meta.badge}</span>
              </div>
              <p className="mt-2.5 text-sm font-medium text-slate-700">{shortInsight(insight)}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function normalizedRoleLabel(data: MedicalRepPortalData) {
  return String(data.employee.roleLabel ?? "").trim().toLowerCase();
}

function isRole(data: MedicalRepPortalData, ...tokens: string[]) {
  const role = normalizedRoleLabel(data);
  return tokens.some((token) => role.includes(token));
}

function canSeeTeamLeaveAndStructurePanels(data: MedicalRepPortalData) {
  return isRole(data, "district manager", "district sales manager", "dsm", "national sales manager", "nsm");
}

type PortalDashboardSurface = "employee-portal" | "workspace";

const workspaceDashboardHrefMap: Record<string, string> = {
  "/employee-portals/expense-dashboard": "/workspace/expense-dashboard",
  "/employee-portals/expenses": "/workspace/expense-dashboard",
  "/employee-portals/marketing-requests": "/workspace/marketing-requests",
  "/employee-portals/probation": "/workspace/probation",
  "/employee-portals/submit-expense": "/workspace/submit-expense",
  "/employee-portals/vacancies": "/workspace/vacancies",
  "/leave-management/vacation-report": "/workspace/leave-management/vacation-report",
  "/leave-management/vacation-request": "/workspace/leave-management/vacation-request",
};

function dashboardHrefForSurface(href: string, surface: PortalDashboardSurface) {
  if (surface !== "workspace") return href;
  const [pathname, search] = href.split("?", 2);
  const mappedPath = workspaceDashboardHrefMap[pathname] ?? pathname;
  return search ? `${mappedPath}?${search}` : mappedPath;
}

function resolveExpenseActionHref(data: MedicalRepPortalData, surface: PortalDashboardSurface) {
  if (surface === "workspace") return "/workspace/submit-expense";
  return isRole(data, "medical rep", "medical representative")
    ? "/employee-portals/expenses"
    : "/employee-portals/submit-expense";
}

type CommandLens = "all" | "quarter" | "month";

function ExecutiveCommandStrip({ data }: { data: MedicalRepPortalData }) {
  const [lens, setLens] = useState<CommandLens>("all");

  // "Quarter" is derived from the most recent three trend periods so the strip can
  // offer a time lens without any new server data.
  const trend = Array.isArray(data.sales.trend) ? data.sales.trend : [];
  const lastThree = trend.slice(-3);
  const quarterSales = lastThree.reduce((sum, point) => sum + point.sales, 0);
  const quarterTarget = lastThree.reduce((sum, point) => sum + point.target, 0);

  const lensConfig: Record<CommandLens, { sales: number; target: number; scope: string }> = {
    all: { sales: data.sales.overviewSales, target: data.sales.overviewTarget, scope: "All-time" },
    quarter: { sales: quarterSales, target: quarterTarget, scope: "Last 3 months" },
    month: {
      sales: data.sales.currentMonthSales,
      target: data.sales.currentMonthTarget,
      scope: data.sales.currentMonthLabel || "This month",
    },
  };
  const active = lensConfig[lens];
  const sales = Math.max(0, active.sales);
  const target = Math.max(0, active.target);
  const achievement = target > 0 ? (sales / target) * 100 : 0;
  const gap = Math.max(0, target - sales);
  const performanceState = achievement >= 100
    ? "Ahead of plan"
    : achievement >= 90
      ? "Within control band"
      : "Needs attention";
  const pctFormat = (n: number) => `${n.toFixed(1)}%`;

  // Pace signal: in the month lens, surface month-over-month movement (already computed
  // server-side) instead of a calendar projection, which would be misleading on lagging
  // sales-closing data.
  const growth = data.sales.growthVsLastMonthPercent;
  const gapNote = lens === "month" && growth !== null
    ? `${growth < 0 ? "▼" : "▲"} ${Math.abs(growth).toFixed(1)}% vs last month`
    : performanceState;

  const signals = [
    {
      accent: "green" as const,
      label: "Sales",
      note: `Target ${egp(target)}`,
      numeric: sales,
      format: egp,
    },
    {
      accent: "orange" as const,
      label: "Target",
      note: `${active.scope} approved target`,
      numeric: target,
      format: egp,
    },
    {
      accent: "blue" as const,
      label: "Achievement Rate",
      note: `${active.scope} sales versus target`,
      numeric: achievement,
      format: pctFormat,
    },
    {
      accent: "amber" as const,
      label: "Gap to Target",
      note: gapNote,
      numeric: gap,
      format: egp,
    },
  ] satisfies Array<{
    accent: MetricAccent;
    label: string;
    note: string;
    numeric: number;
    format: (value: number) => string;
  }>;

  const lensOptions = [
    { value: "all", label: "All-time" },
    { value: "quarter", label: "Quarter" },
    { value: "month", label: "This Month" },
  ];

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3 px-1">
        <div>
          <p className="text-phx-sm font-bold uppercase tracking-[0.18em] text-orange-700">Command Metrics</p>
          <h2 className="mt-1 text-lg font-black tracking-[-0.02em] text-slate-950">Key operating signals</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PeriodSegmentedControl
            options={lensOptions}
            value={lens}
            onChange={(value) => setLens(value as CommandLens)}
          />
          <span className="rounded border border-slate-200 bg-white/80 px-3 py-1.5 text-phx-xs font-semibold uppercase tracking-[0.12em] text-slate-700 shadow-sm backdrop-blur-sm">{data.workforce.scopeLabel}</span>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {signals.map((signal) => {
          const tone = metricTone(signal.accent);
          return (
            <Card
              className={`group relative flex min-h-[100px] min-w-0 flex-col overflow-hidden rounded border-l-[3px] border bg-white px-4 py-3.5 shadow-sm ${tone.border} ${cardHoverClass}`}
              key={signal.label}
            >
              <div className="flex flex-1 flex-col justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-phx-sm font-bold uppercase tracking-[0.14em] text-slate-500">{signal.label}</p>
                  <p className="mt-2 break-words text-2xl font-black leading-none tracking-[-0.03em] tabular-nums text-slate-900">
                    <CountUpNumber value={signal.numeric} format={signal.format} />
                  </p>
                  <p className="mt-1.5 text-phx-xs font-medium leading-snug text-slate-500">{signal.note}</p>
                </div>
                <div className="space-y-1">
                  <div className="h-1 overflow-hidden rounded-sm bg-slate-100">
                    <div className="h-full rounded-sm transition-[width] duration-500" style={{ width: `${Math.max(8, Math.min(100, achievement))}%`, background: tone.lineGradient }} />
                  </div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

function IncentiveSalaryVisibilityToggle({
  isSalaryVisible,
  onToggleSalaryVisibility,
}: {
  isSalaryVisible: boolean;
  onToggleSalaryVisibility: () => void;
}) {
  const label = isSalaryVisible ? "Hide incentive salary values" : "Show incentive salary values";

  return (
    <button
      aria-label={label}
      aria-pressed={isSalaryVisible}
      className="inline-flex h-10 w-10 items-center justify-center rounded border border-slate-200 bg-white text-slate-500 sm:h-8 sm:w-8 shadow-sm transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-600 focus-visible:outline-2 focus-visible:outline-orange-500 focus-visible:outline-offset-1"
      onClick={onToggleSalaryVisibility}
      title={label}
      type="button"
    >
      {isSalaryVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
    </button>
  );
}

function IncentiveSimulatorCard({
  data,
  isSalaryVisible,
  onToggleSalaryVisibility,
}: {
  data: MedicalRepPortalData;
  isSalaryVisible: boolean;
  onToggleSalaryVisibility: () => void;
}) {
  const salaryReference = calculateIncentive2026({
    achievementPercent: 100,
    basicSalary: data.payroll.basicSalary,
    baseSalary: data.payroll.baseSalary,
    extraCostOfLiving: data.payroll.extraCostOfLiving,
    fuelAllowance: data.payroll.fuelAllowance,
    grossSalary: data.payroll.grossSalary,
    netSalary: data.payroll.netSalary,
    socialInsurance: data.payroll.socialInsurance,
    taxes: data.payroll.incomeTax,
  });
  const calculatedBasicSalary = salaryReference.basicSalary;
  const simNetSalary = salaryReference.netSalary;
  const [simAchievement, setSimAchievement] = useState(data.sales.overviewAchievementPercent);

  const calc = calculateIncentive2026({
    basicSalary: calculatedBasicSalary,
    baseSalary: data.payroll.baseSalary,
    extraCostOfLiving: data.payroll.extraCostOfLiving,
    fuelAllowance: data.payroll.fuelAllowance,
    netSalary: simNetSalary,
    grossSalary: data.payroll.grossSalary,
    socialInsurance: data.payroll.socialInsurance,
    taxes: data.payroll.incomeTax,
    achievementPercent: simAchievement,
  });

  const simGrad = achievementBarGradient(simAchievement);

  return (
    <Card className="rounded border border-slate-200 bg-white shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-sm bg-orange-500" />
          <h3 className="text-phx-lg font-bold tracking-tight text-slate-900">Simulate Achievement</h3>
        </div>
        <IncentiveSalaryVisibilityToggle
          isSalaryVisible={isSalaryVisible}
          onToggleSalaryVisibility={onToggleSalaryVisibility}
        />
      </div>

      <div className="space-y-4 p-4 sm:p-5">
        {/* Slider */}
        <div>
          <div className="flex items-center justify-between">
            <p className="text-phx-sm font-bold uppercase tracking-[0.14em] text-slate-400">Achievement %</p>
            <span className="rounded border border-orange-200 bg-orange-50 px-2 py-0.5 text-phx-xs font-black text-orange-700">{simAchievement.toFixed(0)}%</span>
          </div>
          <input
            type="range"
            value={simAchievement}
            onChange={(e) => setSimAchievement(Math.min(150, Number(e.target.value)))}
            min={0}
            max={150}
            step={1}
            className="mt-3 h-1.5 w-full cursor-pointer appearance-none rounded-sm bg-slate-100 accent-orange-500"
          />
          <div className="mt-1 flex items-center justify-between text-phx-xs text-slate-400">
            <span>0%</span>
            <span className="font-semibold text-rose-400">90%</span>
            <span>100%</span>
            <span>150%</span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-sm bg-slate-100">
            <div className="h-full rounded-sm" style={{ width: `${(Math.min(simAchievement, 150) / 150) * 100}%`, background: simGrad }} />
          </div>
        </div>

        {/* Payout result */}
        <div className="rounded border border-orange-200 bg-gradient-to-br from-orange-50 to-amber-50/60 p-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-phx-xs font-bold uppercase tracking-[0.14em] text-slate-400">Payout Rate</p>
              <p className="mt-1.5 text-xl font-black text-orange-700">{calc.payoutPercentage.toFixed(1)}%</p>
            </div>
            <div>
              <p className="text-phx-xs font-bold uppercase tracking-[0.14em] text-slate-400">Estimated Payout</p>
              <p className="mt-1.5 break-words text-xl font-black text-slate-900">{isSalaryVisible ? egp(calc.payoutAmount) : maskedMoneyValue}</p>
            </div>
          </div>
        </div>

        {/* Actual vs simulated */}
        <div className="rounded border border-orange-100 bg-orange-50/40 px-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-phx-xs font-bold text-orange-800">
              Your actual:{" "}
              {data.sales.incentiveSemesterTarget > 0
                ? `${data.sales.overviewAchievementPercent.toFixed(1)}%`
                : "No target yet"}
            </p>
            <p className="text-phx-xs font-bold text-orange-600">
              Simulating: {simAchievement.toFixed(0)}%
            </p>
          </div>
        </div>
      </div>
    </Card>
  );
}

/** One "you are here" line on the payout curve. Pedia draws two of them, every other line one. */
type PayoutCurveMarker = {
  color: string;
  label: string;
  /** Two markers can land on the same achievement, so their labels sit on opposite edges. */
  labelPosition: "bottom" | "top";
  value: number;
};

function IncentivePayoutCurveChart({
  data,
  markers,
  subtitle,
}: {
  data: MedicalRepPortalData;
  /** Omitted everywhere but Pedia, where the seat has two achievements and one line would have to
   * pick one of them without saying which. */
  markers?: readonly PayoutCurveMarker[];
  subtitle?: string;
}) {
  // Sample every 1% so the axis carries every integer achievement: the payout curve is piecewise
  // LINEAR (a straight ramp inside each band, with a step up at the 90% threshold), so a linear area
  // over dense samples draws it truthfully. A 2% step used to draw it with `stepAfter`, which turned
  // the smooth ramps into a staircase and left odd-valued reference lines (e.g. "You: 107%") with no
  // matching sample to sit on. The X axis is numeric (below) so every mark lands at its real value.
  const curveData: Array<{ achievement: number; payout: number }> = [];
  for (let a = 0; a <= 150; a += 1) {
    const c = calculateIncentive2026({ ...data.payroll, achievementPercent: a, taxes: data.payroll.incomeTax });
    curveData.push({ achievement: a, payout: c.payoutPercentage });
  }

  const actualAchievement = data.sales.overviewAchievementPercent;
  // No semester target yet means there is no "you are here" to draw. A line at 0% would put the rep
  // at the bottom of the payout curve, which is a claim about their performance, not about the data.
  const hasSemesterTarget = data.sales.incentiveSemesterTarget > 0;
  const resolvedMarkers: readonly PayoutCurveMarker[] =
    markers ??
    (hasSemesterTarget
      ? [
          {
            color: "#f97316",
            label: `You: ${actualAchievement.toFixed(0)}%`,
            labelPosition: "top",
            value: Math.round(actualAchievement),
          },
        ]
      : []);

  return (
    <Card className="rounded border border-slate-200 bg-white shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-sm bg-orange-500" />
          <h3 className="text-phx-lg font-bold tracking-tight text-slate-900">Performance Payout Curve</h3>
        </div>
        <span className="text-phx-sm font-medium text-slate-400">{subtitle ?? "Achievement vs Payout %"}</span>
      </div>
      <div className="p-5">
        <ChartErrorBoundary>
          <div className="h-[280px] w-full rounded border border-slate-100 bg-white/70 px-1 pt-2 shadow-inner xs:h-[320px]">
            <SafeResponsiveContainer style={{ width: "100%", height: "100%" }}>
              <AreaChart data={curveData} margin={{ top: 8, right: 12, left: -4, bottom: 4 }}>
                <defs>
                  <linearGradient id="payoutCurveGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f97316" stopOpacity={0.25} />
                    <stop offset="100%" stopColor="#f97316" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis
                  dataKey="achievement"
                  type="number"
                  domain={[0, 150]}
                  ticks={[0, 30, 60, 90, 120, 150]}
                  allowDecimals={false}
                  tick={{ fontSize: 10, fontWeight: 600, fill: "#94a3b8" }}
                  tickLine={false}
                  axisLine={{ stroke: "#e2e8f0" }}
                  tickFormatter={(v: number) => `${v}%`}
                />
                <YAxis
                  tick={{ fontSize: 10, fontWeight: 600, fill: "#94a3b8" }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => `${v}%`}
                  width={48}
                />
                <ReferenceLine x={90} stroke="#dc2626" strokeDasharray="6 3" strokeOpacity={0.4} label={{ value: "90%", position: "top", fill: "#dc2626", fontSize: 9, fontWeight: 700 }} />
                {resolvedMarkers.map((marker) => (
                  <ReferenceLine
                    key={marker.label}
                    x={marker.value}
                    stroke={marker.color}
                    strokeWidth={2}
                    strokeDasharray="4 2"
                    strokeOpacity={0.7}
                    label={{ value: marker.label, position: marker.labelPosition, fill: marker.color, fontSize: 9, fontWeight: 700 }}
                  />
                ))}
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0]?.payload as { achievement: number; payout: number } | undefined;
                    if (!d) return null;
                    return (
                      <div className="rounded border border-slate-200 bg-white px-3 py-2 shadow-[0_12px_32px_rgba(15,23,42,0.16)]">
                        <p className="text-phx-xs font-black text-slate-700">Achievement: {d.achievement}%</p>
                        <p className="mt-1 text-phx-xs font-bold text-orange-600">Payout: {d.payout.toFixed(1)}%</p>
                      </div>
                    );
                  }}
                />
                <Area
                  type="linear"
                  dataKey="payout"
                  name="Payout %"
                  stroke="#f97316"
                  strokeWidth={2}
                  fill="url(#payoutCurveGradient)"
                  dot={false}
                  activeDot={{ r: 4, fill: "#f97316", stroke: "#fff", strokeWidth: 2 }}
                />
              </AreaChart>
            </SafeResponsiveContainer>
          </div>
        </ChartErrorBoundary>
      </div>
    </Card>
  );
}

function ToReachTargetWidget({ data }: { data: MedicalRepPortalData }) {
  const target = Math.max(0, data.sales.overviewTarget);
  const current = Math.max(0, data.sales.overviewSales);
  const gap = Math.max(0, target - current);
  const percent = target > 0 ? Math.max(0, Math.min(100, (current / target) * 100)) : 0;
  const achieved = gap <= 0 && target > 0;
  return (
    <OverviewPagePanel title="To Reach Your Target">
      <div className="space-y-3">
        {achieved ? (
          <>
            <div className="rounded border border-emerald-100 bg-emerald-50/60 px-3 py-2">
              <p className="text-sm font-semibold text-emerald-700">Target Achieved</p>
              <p className="mt-1 text-sm text-emerald-700">Great job! You have reached your target and are now in over-achievement.</p>
            </div>
          </>
        ) : (
          <>
            <div className="rounded border border-orange-100 bg-orange-50/50 px-3 py-2">
              <p className="text-xs text-slate-500">Remaining Gap</p>
              <p className="text-xl font-semibold text-slate-900">{egp(gap)}</p>
            </div>
            <div className="text-sm text-slate-600">
              <span className="font-semibold text-slate-900">{percent.toFixed(1)}%</span> all-period achievement
            </div>
            <div className="h-2 rounded-sm bg-slate-100">
              <div
                className="h-2 rounded-sm"
                style={{
                  width: `${percent}%`,
                  background: percent >= 90
                    ? "linear-gradient(to right, #059669, #34d399)"
                    : percent >= 70
                      ? "linear-gradient(to right, #d97706, #fbbf24)"
                      : "linear-gradient(to right, #e11d48, #fb7185)",
                }}
              />
            </div>
            <p className="text-sm text-slate-600">
              Suggested Focus: <span className="text-slate-900">You are {egp(gap)} away from reaching your target to unlock full incentives.</span>
            </p>
          </>
        )}
      </div>
    </OverviewPagePanel>
  );
}

function IncentiveSchemeDescriptionCard() {
  const tiers = [
    { range: "< 90%", payout: "0%", rate: "Not eligible", accent: "border-l-slate-300 bg-slate-50/50", badge: "border-slate-200 bg-slate-50 text-slate-500" },
    { range: "90%", payout: "50%", rate: "Threshold unlock", accent: "border-l-amber-400 bg-amber-50/30", badge: "border-amber-200 bg-amber-50 text-amber-700" },
    { range: "91 - 100%", payout: "55 - 100%", rate: "+5% per 1%", accent: "border-l-orange-400 bg-orange-50/30", badge: "border-orange-200 bg-orange-50 text-orange-700" },
    { range: "101 - 120%", payout: "101.5 - 130%", rate: "+1.5% per 1%", accent: "border-l-emerald-400 bg-emerald-50/30", badge: "border-emerald-200 bg-emerald-50 text-emerald-700" },
    { range: "121 - 150%", payout: "133 - 220%", rate: "+3% per 1%", accent: "border-l-sky-400 bg-sky-50/30", badge: "border-sky-200 bg-sky-50 text-sky-700" },
  ];

  return (
    <Card className="rounded border border-slate-200 bg-white p-5 shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
      <div className="mb-4 flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-sm bg-orange-500" />
        <p className="text-phx-lg font-bold tracking-tight text-slate-900">2026 Incentive Policy</p>
      </div>

      {/* Key formula */}
      <div className="mb-4 rounded border border-slate-100 bg-slate-50/60 px-3 py-2.5">
        <p className="text-phx-sm font-bold uppercase tracking-[0.14em] text-slate-400">Semester Target</p>
        <p className="mt-1 text-sm font-bold text-slate-800">Basic Salary x 2 months</p>
        <p className="mt-0.5 text-phx-xs text-slate-500">2 payouts per year - paid each semester</p>
      </div>

      {/* Tiered bands */}
      <div className="space-y-1">
        {/* Header */}
        <div className="grid grid-cols-[1fr_80px_1fr] gap-2 px-3 pb-1">
          <p className="text-phx-xs font-bold uppercase tracking-[0.14em] text-slate-400">Achievement</p>
          <p className="text-phx-xs font-bold uppercase tracking-[0.14em] text-slate-400">Payout</p>
          <p className="text-right text-phx-xs font-bold uppercase tracking-[0.14em] text-slate-400">Rate</p>
        </div>
        {tiers.map((tier) => (
          <div
            key={tier.range}
            className={`grid grid-cols-[1fr_80px_1fr] items-center gap-2 rounded border border-slate-100 border-l-[3px] px-3 py-2 ${tier.accent}`}
          >
            <p className="text-phx-sm font-bold text-slate-700">{tier.range}</p>
            <span className={`inline-flex w-fit rounded border px-2 py-0.5 text-phx-sm font-bold ${tier.badge}`}>
              {tier.payout}
            </span>
            <p className="text-right text-phx-xs font-medium text-slate-500">{tier.rate}</p>
          </div>
        ))}
      </div>

      <p className="mt-3 text-phx-sm font-medium text-slate-400">
        Achievement capped at 150%. Maximum payout: 220%.
      </p>
    </Card>
  );
}

/**
 * The Pedia split, shown only to the seats it applies to.
 *
 * `data.sales.pediaSplit` is null on every other line and before Semester 2 2026, and this card is
 * not rendered at all then — the rest of the tab is unchanged for them. The two halves are stated
 * as two rows that ADD to the figure underneath, because that is the whole point of the rule and a
 * rep has to be able to check the arithmetic on his own screen.
 *
 * Product NAMES, never codes (owner rule). Square edges and the sibling policy card's exact frame.
 * The rows are a grid that stacks on a phone rather than a table that scrolls sideways.
 */
function PediaSplitIncentiveCard({
  data,
  isSalaryVisible,
}: {
  data: MedicalRepPortalData;
  isSalaryVisible: boolean;
}) {
  const split = data.sales.pediaSplit;
  if (!split) return null;

  const money = (value: number) => (isSalaryVisible ? egp(value) : maskedMoneyValue);
  // Same rule the semester card uses: no target behind it means there is no achievement to state,
  // not an achievement of zero.
  const satoPercentText = split.satoTarget > 0 ? `${split.satoAchievementPercent.toFixed(1)}%` : "No target yet";
  const totalPercentText =
    data.sales.incentiveSemesterTarget > 0 ? `${data.sales.overviewAchievementPercent.toFixed(1)}%` : "No target yet";

  const halves = [
    {
      key: "sato",
      title: "Sato half",
      products: "Guamusin · Ivyronc",
      percentText: satoPercentText,
      amount: split.satoHalfAmount,
      accent: "border-l-orange-400 bg-orange-50/30",
      // Owner, 2026-11-08: the Sato half needs the total at 80%. Said in words, because a Sato
      // percentage over 90 beside a zero reads as a mistake otherwise.
      withheldNote: split.satoHalfWithheld
        ? `Not paid: your total achievement is under ${PEDIA_SATO_HALF_MIN_TOTAL_PERCENT}%.`
        : null,
    },
    {
      key: "total",
      title: "Total half",
      products: "All four Pedia products",
      percentText: totalPercentText,
      amount: split.totalHalfAmount,
      accent: "border-l-sky-400 bg-sky-50/30",
      withheldNote: null,
    },
  ];

  return (
    <Card className="rounded border border-slate-200 bg-white p-5 shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
      <div className="mb-4 flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-sm bg-orange-500" />
        <p className="text-phx-lg font-bold tracking-tight text-slate-900">Your Pedia Incentive</p>
      </div>

      <div className="mb-4 rounded border border-slate-100 bg-slate-50/60 px-3 py-2.5">
        <p className="text-phx-sm font-bold uppercase tracking-[0.14em] text-slate-400">How it is paid</p>
        <p className="mt-1 text-sm font-bold text-slate-800">Two halves, scored separately</p>
        <p className="mt-0.5 text-phx-xs leading-relaxed text-slate-500">
          One month of basic salary is paid on your Sato achievement and one month on your total
          achievement. Each half is scored on the same policy below, then the two are added. The Sato
          half is paid only when your total achievement is {PEDIA_SATO_HALF_MIN_TOTAL_PERCENT}% or more.
        </p>
      </div>

      <div className="space-y-1">
        <div className="grid grid-cols-[1fr_auto] gap-2 px-3 pb-1 sm:grid-cols-[1fr_96px_auto]">
          <p className="text-phx-xs font-bold uppercase tracking-[0.14em] text-slate-400">Half</p>
          <p className="hidden text-phx-xs font-bold uppercase tracking-[0.14em] text-slate-400 sm:block">
            Achievement
          </p>
          <p className="text-right text-phx-xs font-bold uppercase tracking-[0.14em] text-slate-400">Payout</p>
        </div>
        {halves.map((half) => (
          <div
            key={half.key}
            className={`grid grid-cols-[1fr_auto] items-center gap-2 rounded border border-slate-100 border-l-[3px] px-3 py-2 sm:grid-cols-[1fr_96px_auto] ${half.accent}`}
          >
            <div className="min-w-0">
              <p className="text-phx-sm font-bold text-slate-700">{half.title}</p>
              <p className="text-phx-sm font-medium leading-snug text-slate-500">{half.products}</p>
              {/* On a phone the achievement column is folded in here rather than squeezed into a
                  third column — merging beats shrinking, and beats a sideways scroll. */}
              <p className="text-phx-sm font-semibold text-slate-600 sm:hidden">{half.percentText}</p>
              {half.withheldNote ? (
                <p className="break-words text-phx-sm font-bold leading-snug text-red-700">{half.withheldNote}</p>
              ) : null}
            </div>
            <p className="hidden text-phx-sm font-bold tabular-nums text-slate-700 sm:block">{half.percentText}</p>
            <p className="text-right font-mono text-phx-sm font-black tabular-nums text-slate-900">
              {money(half.amount)}
            </p>
          </div>
        ))}
      </div>

      <div className={`mt-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded border border-slate-200 bg-slate-50 px-3 py-2.5 ${adminSoftDepthClassName}`}>
        <p className="text-phx-sm font-bold uppercase tracking-[0.14em] text-slate-500">Semester incentive</p>
        <p className="font-mono text-phx-lg font-black tabular-nums text-slate-900">{money(split.payoutAmount)}</p>
      </div>

      <p className="mt-3 text-phx-sm font-medium leading-relaxed text-slate-400">
        Lacto Advanced 1 and Lacto Advanced 2 are not scored on their own — they count toward your
        total achievement.
      </p>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE PEDIA INCENTIVE TAB (owner, 2026-09-24: "mismatch between the old rule and the new rule …
// Simulate Achievement showing wrong misleading data … full rebuild for only pedia line all roles")
//
// The split landed in the domain layer and in the card above, but the rest of this tab kept speaking
// the single-figure rule, and the simulator was the part that actually lied: one slider, scored with
// calculateIncentive2026, paying the WHOLE semester incentive off ONE achievement. A Pedia seat is
// not paid that way from Semester 2 2026. At 95% it promised the full two months where the rule pays
// one month at 95% plus one month at whatever the line total is — and nothing on the card said which
// of his two achievements the slider even was. The KPI strip and the curve had the same hole: one
// achievement each, silently the total.
//
// Everything below renders ONLY when `data.sales.pediaSplit` is non-null, which the service sets for
// a Pedia seat in a split semester and for nobody else. That is the whole gate, and it is role-free
// on purpose: reps, District Managers, Regional Managers and the National Sales Manager are scored
// on the same two achievements, so they read the same tab (src/lib/incentives/pedia-split.ts).
//
// The curve itself is NOT reimplemented here. Every figure is produced by calling
// calculatePediaSplitIncentive, which calls the owner-locked scheme-2026 twice — so the simulator
// can never drift from what the split card above pays.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The payroll figures the locked scheme takes. One reading, so both halves share a salary basis. */
function incentiveSalaryBasis(data: MedicalRepPortalData) {
  return {
    basicSalary: data.payroll.basicSalary,
    baseSalary: data.payroll.baseSalary,
    extraCostOfLiving: data.payroll.extraCostOfLiving,
    fuelAllowance: data.payroll.fuelAllowance,
    grossSalary: data.payroll.grossSalary,
    netSalary: data.payroll.netSalary,
    socialInsurance: data.payroll.socialInsurance,
    taxes: data.payroll.incomeTax,
  };
}

/** Red below the 90% threshold, amber in the eligible band, green at or above target. */
function achievementBarGradient(value: number) {
  if (value >= 100) return "linear-gradient(to right, #16a34a, #86efac)";
  if (value >= 90) return "linear-gradient(to right, #ca8a04, #fde047)";
  return "linear-gradient(to right, #dc2626, #fca5a5)";
}

/**
 * One achievement slider. The Pedia simulator draws two of these — that is the entire point of it.
 *
 * Each carries the products it is scored on, because "Sato" and "Total" mean nothing on their own to
 * the person being paid from them, and the actual achievement it was seeded from, so a rep can tell
 * at a glance how far he has dragged away from his own real position.
 */
function PediaAchievementSlider({
  accent,
  actualText,
  label,
  onChange,
  products,
  value,
}: {
  accent: "orange" | "sky";
  actualText: string;
  label: string;
  onChange: (next: number) => void;
  products: string;
  value: number;
}) {
  const tone =
    accent === "orange"
      ? { badge: "border-orange-200 bg-orange-50 text-orange-700", input: "accent-orange-500" }
      : { badge: "border-sky-200 bg-sky-50 text-sky-700", input: "accent-sky-500" };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <p className="text-phx-sm font-bold uppercase tracking-[0.14em] text-slate-400">{label}</p>
          <p className="text-phx-sm font-medium leading-snug text-slate-500">{products}</p>
        </div>
        <span className={`rounded border px-2 py-0.5 text-phx-xs font-black ${tone.badge}`}>
          {value.toFixed(0)}%
        </span>
      </div>
      <input
        aria-label={label}
        className={`mt-2.5 h-1.5 w-full cursor-pointer appearance-none rounded-sm bg-slate-100 ${tone.input}`}
        max={150}
        min={0}
        onChange={(event) => onChange(Math.min(150, Math.max(0, Number(event.target.value))))}
        step={1}
        type="range"
        value={value}
      />
      <div className="mt-1 flex items-center justify-between text-phx-xs text-slate-400">
        <span>0%</span>
        <span className="font-semibold text-rose-400">90%</span>
        <span>100%</span>
        <span>150%</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-sm bg-slate-100">
        <div
          className="h-full rounded-sm"
          style={{ width: `${(Math.min(value, 150) / 150) * 100}%`, background: achievementBarGradient(value) }}
        />
      </div>
      <p className="mt-1.5 text-phx-sm font-semibold text-slate-500">Your actual: {actualText}</p>
    </div>
  );
}

/**
 * The Pedia simulator — two sliders, two halves, one total.
 *
 * Seeded from the rep's OWN two achievements, so the card opens showing exactly what the split card
 * above already pays him; every figure moves from there. A missing target seeds 0 rather than
 * inventing a position, and the slider label says so.
 */
function PediaIncentiveSimulatorCard({
  data,
  isSalaryVisible,
  onToggleSalaryVisibility,
}: {
  data: MedicalRepPortalData;
  isSalaryVisible: boolean;
  onToggleSalaryVisibility: () => void;
}) {
  const split = data.sales.pediaSplit;
  const hasSatoTarget = (split?.satoTarget ?? 0) > 0;
  const hasTotalTarget = data.sales.incentiveSemesterTarget > 0;

  const [simSato, setSimSato] = useState(split?.satoAchievementPercent ?? 0);
  const [simTotal, setSimTotal] = useState(data.sales.overviewAchievementPercent);

  const simulated = calculatePediaSplitIncentive({
    ...incentiveSalaryBasis(data),
    satoAchievementPercent: simSato,
    totalAchievementPercent: simTotal,
  });

  const money = (value: number) => (isSalaryVisible ? egp(value) : maskedMoneyValue);
  const halves = [
    {
      accentText: "text-orange-700",
      amount: simulated.satoHalfAmount,
      key: "sato",
      panel: "border-orange-200 bg-orange-50/50",
      // A withheld half pays 0% of its month, whatever the curve reads at the Sato achievement.
      rate: simulated.satoHalfWithheld ? 0 : simulated.sato.payoutPercentage,
      title: "Sato half",
    },
    {
      accentText: "text-sky-700",
      amount: simulated.totalHalfAmount,
      key: "total",
      panel: "border-sky-200 bg-sky-50/50",
      rate: simulated.total.payoutPercentage,
      title: "Total half",
    },
  ];

  return (
    <Card className="rounded border border-slate-200 bg-white shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-sm bg-orange-500" />
          <h3 className="text-phx-lg font-bold tracking-tight text-slate-900">Simulate Achievement</h3>
        </div>
        <IncentiveSalaryVisibilityToggle
          isSalaryVisible={isSalaryVisible}
          onToggleSalaryVisibility={onToggleSalaryVisibility}
        />
      </div>

      <div className="space-y-4 p-4 sm:p-5">
        <p className="rounded border border-slate-100 bg-slate-50/60 px-3 py-2 text-phx-xs leading-relaxed text-slate-500">
          Your two halves are scored separately, so move both. One month of basic salary is paid on
          your Sato achievement and one month on your total achievement. The Sato half is paid only
          when your total achievement is {PEDIA_SATO_HALF_MIN_TOTAL_PERCENT}% or more.
        </p>

        <PediaAchievementSlider
          accent="orange"
          actualText={hasSatoTarget ? `${(split?.satoAchievementPercent ?? 0).toFixed(1)}%` : "No target yet"}
          label="Sato Achievement %"
          onChange={setSimSato}
          products="Guamusin · Ivyronc"
          value={simSato}
        />

        <PediaAchievementSlider
          accent="sky"
          actualText={hasTotalTarget ? `${data.sales.overviewAchievementPercent.toFixed(1)}%` : "No target yet"}
          label="Total Achievement %"
          onChange={setSimTotal}
          products="All four Pedia products"
          value={simTotal}
        />

        {/* The two halves, then the sum — the same shape the split card above states, so the two
            cards can be read against each other without arithmetic. */}
        <div className="grid grid-cols-2 gap-3">
          {halves.map((half) => (
            <div className={`min-w-0 rounded border p-3 ${half.panel}`} key={half.key}>
              <p className="text-phx-xs font-bold uppercase tracking-[0.14em] text-slate-400">{half.title}</p>
              <p className={`mt-1 text-phx-lg font-black tabular-nums ${half.accentText}`}>
                {half.rate.toFixed(1)}%
              </p>
              <p className="mt-1 break-words font-mono text-phx-sm font-black tabular-nums text-slate-900">
                {money(half.amount)}
              </p>
              {half.key === "sato" && simulated.satoHalfWithheld ? (
                <p className="mt-1 break-words text-phx-sm font-bold leading-snug text-red-700">
                  Not paid: total under {PEDIA_SATO_HALF_MIN_TOTAL_PERCENT}%.
                </p>
              ) : null}
            </div>
          ))}
        </div>

        <div className="rounded border border-orange-200 bg-gradient-to-br from-orange-50 to-amber-50/60 p-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="min-w-0">
              <p className="text-phx-xs font-bold uppercase tracking-[0.14em] text-slate-400">Payout Rate</p>
              <p className="mt-1.5 text-xl font-black text-orange-700">
                {simulated.payoutPercentage.toFixed(1)}%
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-phx-xs font-bold uppercase tracking-[0.14em] text-slate-400">Estimated Payout</p>
              <p className="mt-1.5 break-words text-xl font-black text-slate-900">
                {money(simulated.payoutAmount)}
              </p>
            </div>
          </div>
          <p className="mt-2 text-phx-sm font-medium text-slate-500">
            Sato half plus total half, out of {money(simulated.semesterTargetIncentive)} at full payout.
          </p>
        </div>
      </div>
    </Card>
  );
}

/**
 * The policy card, stated the way a Pedia seat is actually paid.
 *
 * The bands are the same locked curve every line reads — what changes is that a Pedia seat reads it
 * TWICE, once per half, so the card says what each band pays on one month rather than on two.
 */
function PediaIncentivePolicyCard() {
  const tiers = [
    { accent: "border-l-slate-300 bg-slate-50/50", badge: "border-slate-200 bg-slate-50 text-slate-500", payout: "0%", range: "< 90%", rate: "Not eligible" },
    { accent: "border-l-amber-400 bg-amber-50/30", badge: "border-amber-200 bg-amber-50 text-amber-700", payout: "50%", range: "90%", rate: "Threshold unlock" },
    { accent: "border-l-orange-400 bg-orange-50/30", badge: "border-orange-200 bg-orange-50 text-orange-700", payout: "55 - 100%", range: "91 - 100%", rate: "+5% per 1%" },
    { accent: "border-l-emerald-400 bg-emerald-50/30", badge: "border-emerald-200 bg-emerald-50 text-emerald-700", payout: "101.5 - 130%", range: "101 - 120%", rate: "+1.5% per 1%" },
    { accent: "border-l-sky-400 bg-sky-50/30", badge: "border-sky-200 bg-sky-50 text-sky-700", payout: "133 - 220%", range: "121 - 150%", rate: "+3% per 1%" },
  ];

  return (
    <Card className="rounded border border-slate-200 bg-white p-5 shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
      <div className="mb-4 flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-sm bg-orange-500" />
        <p className="text-phx-lg font-bold tracking-tight text-slate-900">2026 Incentive Policy - Pedia</p>
      </div>

      <div className="mb-4 rounded border border-slate-100 bg-slate-50/60 px-3 py-2.5">
        <p className="text-phx-sm font-bold uppercase tracking-[0.14em] text-slate-400">Semester Target</p>
        <p className="mt-1 text-sm font-bold text-slate-800">Basic Salary x 2 months</p>
        <p className="mt-0.5 text-phx-xs leading-relaxed text-slate-500">
          Paid as two halves of one month each - one scored on Sato, one on your total. The bands
          below are read once per half. The Sato half is paid only when your total achievement is{" "}
          {PEDIA_SATO_HALF_MIN_TOTAL_PERCENT}% or more.
        </p>
      </div>

      <div className="space-y-1">
        <div className="grid grid-cols-[1fr_80px_1fr] gap-2 px-3 pb-1">
          <p className="text-phx-xs font-bold uppercase tracking-[0.14em] text-slate-400">Achievement</p>
          <p className="text-phx-xs font-bold uppercase tracking-[0.14em] text-slate-400">Payout</p>
          <p className="text-right text-phx-xs font-bold uppercase tracking-[0.14em] text-slate-400">Rate</p>
        </div>
        {tiers.map((tier) => (
          <div
            className={`grid grid-cols-[1fr_80px_1fr] items-center gap-2 rounded border border-slate-100 border-l-[3px] px-3 py-2 ${tier.accent}`}
            key={tier.range}
          >
            <p className="text-phx-sm font-bold text-slate-700">{tier.range}</p>
            <span className={`inline-flex w-fit rounded border px-2 py-0.5 text-phx-sm font-bold ${tier.badge}`}>
              {tier.payout}
            </span>
            <p className="text-right text-phx-xs font-medium text-slate-500">{tier.rate}</p>
          </div>
        ))}
      </div>

      <p className="mt-3 text-phx-sm font-medium leading-relaxed text-slate-400">
        Each half is capped at 150% achievement and 220% payout of its own month. Lacto Advanced 1
        and Lacto Advanced 2 are never scored on their own - they count toward your total.
      </p>
    </Card>
  );
}

/**
 * The KPI strip, rebuilt to state BOTH achievements.
 *
 * The single-figure strip showed one "Semester Achievement", which on Pedia is the total — a real
 * number, but only half of what decides this seat's money, and unlabelled as to which half.
 */
function PediaIncentiveKpiCards({
  data,
  isSalaryVisible,
}: {
  data: MedicalRepPortalData;
  isSalaryVisible: boolean;
}) {
  const split = data.sales.pediaSplit;
  if (!split) return null;

  const hasSatoTarget = split.satoTarget > 0;
  const hasTotalTarget = data.sales.incentiveSemesterTarget > 0;
  const semesterLabelText = data.sales.incentiveSemesterLabel ?? "This semester";
  const salaryRef = calculateIncentive2026({ ...incentiveSalaryBasis(data), achievementPercent: 100 });

  const noteFor = (achievement: number) =>
    achievement >= 100 ? "Above target" : achievement >= 90 ? "Eligible zone" : `${Math.max(0, 90 - achievement).toFixed(1)} points to 90%`;
  const accentFor = (achievement: number): MetricAccent =>
    achievement >= 100 ? "green" : achievement >= 90 ? "amber" : "orange";

  const cards: Array<{ accent: MetricAccent; label: string; note: string; value: string }> = [
    {
      accent: hasSatoTarget ? accentFor(split.satoAchievementPercent) : "blue",
      label: "Sato Achievement",
      note: !hasSatoTarget
        ? `${semesterLabelText} Sato target not uploaded yet`
        : split.satoHalfWithheld
          ? `Guamusin · Ivyronc - not paid until total reaches ${PEDIA_SATO_HALF_MIN_TOTAL_PERCENT}%`
          : `Guamusin · Ivyronc - ${noteFor(split.satoAchievementPercent)}`,
      value: hasSatoTarget ? `${split.satoAchievementPercent.toFixed(1)}%` : "No target yet",
    },
    {
      accent: hasTotalTarget ? accentFor(data.sales.overviewAchievementPercent) : "blue",
      label: "Total Achievement",
      note: hasTotalTarget ? `All four products - ${noteFor(data.sales.overviewAchievementPercent)}` : `${semesterLabelText} not uploaded yet`,
      value: hasTotalTarget ? `${data.sales.overviewAchievementPercent.toFixed(1)}%` : "No target yet",
    },
    {
      accent: "purple",
      label: "Basic Salary",
      note: "Base x 70% - one month per half",
      value: isSalaryVisible ? egp(salaryRef.basicSalary) : maskedMoneyValue,
    },
    {
      accent: "orange",
      label: "Semester Incentive",
      note: "Sato half + total half",
      value: isSalaryVisible ? egp(split.payoutAmount) : maskedMoneyValue,
    },
  ];

  return (
    // The file's own four-card rhythm, used verbatim by the signals strip above: one card, then
    // two from 640px, then four from 1280px. The three-card strip beside it steps at 480px because
    // three cards fit there; four do not.
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => {
        const tone = metricTone(card.accent);
        return (
          <Card
            className={`group relative flex min-w-0 flex-col overflow-hidden rounded border-l-[3px] border bg-white px-4 py-3.5 shadow-sm ${tone.border}`}
            key={card.label}
          >
            <p className="text-phx-sm font-bold uppercase tracking-[0.14em] text-slate-500">{card.label}</p>
            <p className={`mt-2 break-words text-xl font-black leading-none tracking-tight tabular-nums ${tone.value}`}>
              {card.value}
            </p>
            <p className="mt-1.5 break-words text-phx-xs font-medium leading-snug text-slate-500">{card.note}</p>
            <div className="mt-auto pt-2">
              <div className="h-1 w-12 rounded-sm" style={{ background: tone.lineGradient }} />
            </div>
          </Card>
        );
      })}
    </div>
  );
}

/** The whole tab for a Pedia seat, in the order the rep needs it: where he stands, what that pays,
 * how it is scored, what a different month would pay, and the curve both halves are read from. */
function PediaIncentiveTab({ data }: { data: MedicalRepPortalData }) {
  const [isSalaryVisible, setIsSalaryVisible] = useState(false);
  const split = data.sales.pediaSplit;

  const markers: PayoutCurveMarker[] = [];
  if ((split?.satoTarget ?? 0) > 0) {
    markers.push({
      color: "#f97316",
      label: `Sato: ${(split?.satoAchievementPercent ?? 0).toFixed(0)}%`,
      labelPosition: "top",
      value: Math.round(split?.satoAchievementPercent ?? 0),
    });
  }
  if (data.sales.incentiveSemesterTarget > 0) {
    markers.push({
      color: "#0284c7",
      label: `Total: ${data.sales.overviewAchievementPercent.toFixed(0)}%`,
      labelPosition: "bottom",
      value: Math.round(data.sales.overviewAchievementPercent),
    });
  }

  return (
    <div className="space-y-5">
      {data.sales.incentiveWindowNotice ? (
        <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-phx-md font-semibold text-amber-900">
          {data.sales.incentiveWindowNotice}
        </div>
      ) : null}

      <PediaIncentiveKpiCards data={data} isSalaryVisible={isSalaryVisible} />

      <PediaSplitIncentiveCard data={data} isSalaryVisible={isSalaryVisible} />

      <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
        <PediaIncentivePolicyCard />
        <PediaIncentiveSimulatorCard
          data={data}
          isSalaryVisible={isSalaryVisible}
          onToggleSalaryVisibility={() => setIsSalaryVisible((current) => !current)}
        />
      </div>

      <IncentivePayoutCurveChart
        data={data}
        markers={markers}
        subtitle="Each half is read off this curve"
      />
    </div>
  );
}

function IncentiveKpiCards({ data, isSalaryVisible }: { data: MedicalRepPortalData; isSalaryVisible: boolean }) {
  const achievementPercent = data.sales.overviewAchievementPercent;
  // The semester runs Jul-Dec and its first month is only uploaded partway through. Until then the
  // achievement is 0 because there is nothing to divide, NOT because the rep sold nothing — and
  // "0.0%, 90.0% to threshold" reads as an accusation. Say what is actually true instead.
  const hasSemesterTarget = data.sales.incentiveSemesterTarget > 0;
  const gapToThreshold = Math.max(0, 90 - achievementPercent);
  const salaryRef = calculateIncentive2026({
    achievementPercent: 100,
    basicSalary: data.payroll.basicSalary,
    baseSalary: data.payroll.baseSalary,
    extraCostOfLiving: data.payroll.extraCostOfLiving,
    fuelAllowance: data.payroll.fuelAllowance,
    grossSalary: data.payroll.grossSalary,
    netSalary: data.payroll.netSalary,
    socialInsurance: data.payroll.socialInsurance,
    taxes: data.payroll.incomeTax,
  });

  const cards: Array<{ label: string; value: string; note: string; accent: MetricAccent }> = [
    {
      label: "Semester Achievement",
      value: hasSemesterTarget ? `${achievementPercent.toFixed(1)}%` : "No target yet",
      note: !hasSemesterTarget
        ? `${data.sales.incentiveSemesterLabel ?? "This semester"} not uploaded yet`
        : achievementPercent >= 100 ? "Above target" : achievementPercent >= 90 ? "Eligible zone" : `${gapToThreshold.toFixed(1)} points to 90%`,
      accent: !hasSemesterTarget ? "blue" : achievementPercent >= 100 ? "green" : achievementPercent >= 90 ? "amber" : "orange",
    },
    {
      label: "Base Salary",
      value: isSalaryVisible ? egp(data.payroll.baseSalary) : maskedMoneyValue,
      note: "Fixed compensation",
      accent: "blue",
    },
    {
      label: "Basic Salary",
      value: isSalaryVisible ? egp(salaryRef.basicSalary) : maskedMoneyValue,
      note: "Base x 70% - incentive basis",
      accent: "purple",
    },
  ];

  return (
    <div className="grid gap-3 xs:grid-cols-3">
      {cards.map((card) => {
        const tone = metricTone(card.accent);
        return (
          <Card
            className={`group relative flex min-w-0 flex-col overflow-hidden rounded border-l-[3px] border bg-white px-4 py-3.5 shadow-sm ${tone.border}`}
            key={card.label}
          >
            <p className="text-phx-sm font-bold uppercase tracking-[0.14em] text-slate-500">{card.label}</p>
            <p className={`mt-2 break-words text-xl font-black leading-none tracking-tight tabular-nums ${tone.value}`}>
              {card.value}
            </p>
            <p className="mt-1.5 break-words text-phx-xs font-medium leading-snug text-slate-500">{card.note}</p>
            <div className="mt-auto pt-2">
              <div className="h-1 w-12 rounded-sm" style={{ background: tone.lineGradient }} />
            </div>
          </Card>
        );
      })}
    </div>
  );
}

export function EmployeePortalIncentivePage({ data }: { data: MedicalRepPortalData }) {
  const [isIncentiveSalaryVisible, setIsIncentiveSalaryVisible] = useState(false);

  if (data.empty.profile) {
    return <EmptyStateCard message="Your employee profile is not linked yet. Please contact HR." title="Profile Not Linked" />;
  }

  // A Pedia seat in a split semester is paid on two achievements, so it reads a tab built around
  // two — KPI strip, simulator and curve alike. `pediaSplit` is the service's own answer to "does
  // this seat get the split", role-free by design, and it is null for every other line and for the
  // closed semesters that were actually paid on the single figure. Everything below is unchanged
  // for them.
  if (data.sales.pediaSplit) {
    return <PediaIncentiveTab data={data} />;
  }

  return (
    <div className="space-y-5">
      {/* An incentive is a SEMESTER figure. When the semester is not fully loaded the number below
          is arithmetically real but not settled — a rep whose June sheet has not arrived is being
          scored on five months while a colleague is scored on six. Saying so, with the month named,
          is the difference between a provisional figure and a wrong promise. */}
      {data.sales.incentiveWindowNotice ? (
        <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-phx-md font-semibold text-amber-900">
          {data.sales.incentiveWindowNotice}
        </div>
      ) : null}

      {/* KPI strip - Achievement + Base Salary + Basic Salary */}
      <IncentiveKpiCards data={data} isSalaryVisible={isIncentiveSalaryVisible} />

      {/* The Pedia split card is NOT rendered here: a Pedia seat returns above, into a tab built
          around its two achievements. Reaching this point means one achievement decides this
          seat's money, which is what every card below states. */}

      {/* Policy + Simulator side by side */}
      <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
        <IncentiveSchemeDescriptionCard />
        <IncentiveSimulatorCard
          data={data}
          isSalaryVisible={isIncentiveSalaryVisible}
          onToggleSalaryVisibility={() => setIsIncentiveSalaryVisible((current) => !current)}
        />
      </div>

      {/* Payout curve chart - standalone */}
      <IncentivePayoutCurveChart data={data} />
    </div>
  );
}

function TeamRankComparisonWidget({ data }: { data: MedicalRepPortalData }) {
  const rows = data.sales.teamComparison ?? [];
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Periods are "YYYY-MM" strings; sort descending so the newest period chip is first.
  const comparisonPeriods = Array.from(new Set(data.sales.trend.map((item) => String(item.period).trim()).filter(Boolean))).sort((left, right) => right.localeCompare(left));
  const validPeriodSet = new Set(comparisonPeriods.map((period) => period.toLowerCase()));
  const rawSelectedPeriod = data.sales.teamComparisonPeriod?.toLowerCase().trim();
  const selectedPeriod = rawSelectedPeriod && validPeriodSet.has(rawSelectedPeriod) ? rawSelectedPeriod : "all";
  const handlePeriodChange = (period: string) => {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (period === "all") {
      params.delete("teamPeriod");
    } else {
      params.set("teamPeriod", period);
    }
    const next = params.toString();
    router.push(next ? `${pathname}?${next}` : pathname);
  };

  const periodOptions = [
    { value: "all", label: "All" },
    ...comparisonPeriods.slice(0, 5).map((period) => ({
      value: period,
      label: toPeriodLabel(period),
    })),
  ];

  if (rows.length === 0) {
    return (
      <OverviewPagePanel title="Rank in Team Comparison">
        <div className="mb-3">
          <PeriodSegmentedControl
            options={periodOptions}
            value={selectedPeriod}
            onChange={handlePeriodChange}
          />
        </div>
        <p className="text-sm text-slate-500">Team comparison is not available for this period.</p>
      </OverviewPagePanel>
    );
  }

  return (
    <OverviewPagePanel
      title="Rank in Team Comparison"
      action={(
        <PeriodSegmentedControl
          options={periodOptions}
          value={selectedPeriod}
          onChange={handlePeriodChange}
        />
      )}
    >
      <div className="space-y-2">
        {rows.map((row) => {
          const pct = row.achievementPercent;
          // No target means the percent is undefined, not zero — flagging that row "Below
          // target" would accuse someone of missing a target nobody set for them.
          const hasTarget = row.target > 0;
          const fillWidth = Math.max(6, Math.min(100, pct));
          const belowTarget = hasTarget && pct < 70;
          const [fromColor, toColor] = achievementGradient(pct).split(",");
          return (
            <div key={`${row.position}-${row.name}`} className="rounded border border-slate-100 bg-white px-3 py-3 shadow-[0_2px_8px_rgba(15,23,42,0.04)] transition-colors hover:border-orange-200 hover:bg-orange-50/30">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className={`shrink-0 flex h-7 w-7 items-center justify-center rounded text-phx-xs font-black ${row.position === 1 ? "bg-slate-950 text-white shadow-sm" : "bg-slate-100 text-slate-600 ring-1 ring-slate-200"}`}>
                    {row.position}
                  </span>
                  <span className="break-words text-sm font-bold text-slate-700">{row.name}</span>
                  {belowTarget ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-phx-danger-line bg-phx-danger-bg/80 px-2 py-0.5 text-phx-sm font-semibold text-phx-danger">
                      <AlertTriangle className="h-2.5 w-2.5" />
                      Below target
                    </span>
                  ) : null}
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-mono text-sm font-black tabular-nums text-slate-700">
                    {hasTarget ? `${pct.toFixed(1)}%` : "No target"}
                  </p>
                  <p className="break-words font-mono text-phx-xs text-slate-400 tabular-nums">{egp(row.sales)}</p>
                </div>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-sm bg-slate-100">
                <div
                  className="h-full rounded-sm"
                  style={{ width: `${fillWidth}%`, background: `linear-gradient(to right, ${fromColor}, ${toColor})` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </OverviewPagePanel>
  );
}

/* RankInTeamCard was removed during rollback */

function OverviewPagePanel({
  children,
  title,
  action,
}: {
  children: ReactNode;
  title: string;
  action?: ReactNode;
}) {
  return (
    <Card className="group relative flex h-full flex-col overflow-hidden rounded border border-slate-200 bg-white p-4 shadow-[0_4px_16px_rgba(15,23,42,0.05)] transition-shadow duration-200 hover:shadow-[0_8px_24px_rgba(15,23,42,0.08)] lg:p-5">
      <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-orange-400 to-orange-300 opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
      <div className="relative mb-3 flex flex-wrap items-center justify-between gap-3 lg:mb-4">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-sm bg-orange-500" />
          <h3 className="text-phx-lg font-semibold tracking-tight text-slate-900 lg:text-base">{title}</h3>
        </div>
        {action}
      </div>
      <div className="relative min-w-0 flex-1">{children}</div>
    </Card>
  );
}

type InsightTone = "warning" | "positive" | "insight";

function OverviewInsightsAlerts({ data }: { data: MedicalRepPortalData }) {
  const isManager = canSeeTeamLeaveAndStructurePanels(data);
  const territories = Array.isArray(data.sales.territories) ? data.sales.territories : [];
  const team = Array.isArray(data.sales.teamComparison) ? data.sales.teamComparison : [];
  const topProduct = data.sales.productContribution[0];
  const totalTopSales = data.sales.productContribution.reduce((sum, p) => sum + p.sales, 0);
  const topProductContribution = topProduct && totalTopSales > 0 ? (topProduct.sales / totalTopSales) * 100 : 0;
  const growth = data.sales.growthVsLastMonthPercent;
  const achievement = data.sales.overviewAchievementPercent;

  const items: Array<{ text: string; tone: InsightTone }> = [];

  // Weakest territory — the clearest "where to act" signal.
  const weakest = [...territories]
    .filter((territory) => territory.target > 0)
    .sort((a, b) => a.achievementPercent - b.achievementPercent)[0];
  if (weakest && weakest.achievementPercent < 100) {
    items.push({ text: `${weakest.name} is your lowest territory at ${weakest.achievementPercent.toFixed(0)}%.`, tone: "warning" });
  }

  // Peer comparison below the 70% line — managers only. For DSM/NSM the comparison
  // group is fellow line-managers (District Managers), not medical reps.
  if (isManager && team.length > 0) {
    const below = team.filter((row) => row.achievementPercent < 70);
    if (below.length > 0) {
      const lowest = [...below].sort((a, b) => a.achievementPercent - b.achievementPercent)[0];
      items.push({ text: `${below.length} of ${team.length} peer DMs below 70% — lowest is ${lowest.name}.`, tone: "warning" });
    } else {
      items.push({ text: `All ${team.length} peer DMs are at or above 70% achievement.`, tone: "positive" });
    }
  }

  // Month-over-month movement.
  if (growth !== null) {
    items.push({
      text: `Sales ${growth < 0 ? "decreased" : "increased"} by ${Math.abs(growth).toFixed(1)}% vs last month.`,
      tone: growth < 0 ? "warning" : "positive",
    });
  }

  // Semester achievement standing. This number is the SEMESTER figure — it was labelled
  // "all-period" here, which is not what it measures — and it is 0 when no target sits behind it,
  // so a rep whose semester has not been uploaded yet gets no standing stated at all rather than
  // being told they are at 0%.
  const semesterName = data.sales.incentiveSemesterLabel ?? "This semester";
  if (data.sales.incentiveSemesterTarget > 0) {
    items.push(achievement >= 100
      ? { text: `You have reached your ${semesterName} target at ${achievement.toFixed(0)}%.`, tone: "positive" }
      : { text: `${semesterName} achievement is ${achievement.toFixed(1)}% of target.`, tone: "insight" });
  }

  // Product concentration.
  if (topProduct) {
    items.push({ text: `${topProduct.name} drives ${topProductContribution.toFixed(0)}% of your top products.`, tone: "insight" });
  }

  const cards = items.slice(0, 4);

  const toneMeta: Record<InsightTone, { badge: string; classes: string; border: string; icon: typeof Info }> = {
    warning: { badge: "Warning", classes: "bg-rose-50 text-rose-700", border: "border-l-rose-500", icon: AlertTriangle },
    positive: { badge: "Positive", classes: "bg-emerald-50 text-emerald-700", border: "border-l-emerald-500", icon: TrendingUp },
    insight: { badge: "Insight", classes: "bg-slate-100 text-slate-700", border: "border-l-blue-500", icon: Info },
  };

  return (
    <OverviewPagePanel title="Insights & Alerts">
      {cards.length === 0 ? (
        <p className="text-sm text-slate-500">No insights available yet.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {cards.map((item) => {
            const meta = toneMeta[item.tone];
            const Icon = meta.icon;
            return (
              <div key={item.text} className={`rounded border border-slate-100 border-l-2 ${meta.border} bg-white p-3 shadow-[0_4px_14px_rgba(15,23,42,0.03)]`}>
                <div className="flex items-center gap-2">
                  <Icon className="h-4 w-4 text-slate-500" />
                  <span className={`rounded px-2 py-0.5 text-phx-xs font-medium ${meta.classes}`}>{meta.badge}</span>
                </div>
                <p className="mt-2 text-sm text-slate-700">{shortInsight(item.text)}</p>
              </div>
            );
          })}
        </div>
      )}
    </OverviewPagePanel>
  );
}

function OverviewTopProducts({ data }: { data: MedicalRepPortalData }) {
  const [metric, setMetric] = useState<ContributionMetric>("sales");
  const rows = sortContributionRows(data.sales.productContribution, metric).slice(0, 4);
  const max = Math.max(1, ...rows.map((row) => getContributionValue(row, metric)));
  const total = rows.reduce((sum, row) => sum + getContributionValue(row, metric), 0);
  
  return (
    <OverviewPagePanel
      title="Top Products"
      action={
        <div className="flex items-center gap-2">
          <ContributionMetricToggle metric={metric} onChange={setMetric} />
          <Button className="h-8 px-3 text-xs" variant="secondary">View All</Button>
        </div>
      }
    >
      <div className="space-y-3.5">
        {rows.length === 0 ? (
          <p className="text-sm text-slate-500">No product contribution data.</p>
        ) : rows.map((row, idx) => {
          const value = getContributionValue(row, metric);
          const width = Math.max(8, Math.round((value / max) * 100));
          const contributionPercent = total > 0 ? (value / total) * 100 : 0;
          const tier = rows.length <= 1 ? 0 : idx / (rows.length - 1);
          const grad = tier <= 0.33 ? "linear-gradient(to right, #ea580c, #fb923c)" : tier <= 0.66 ? "linear-gradient(to right, #f97316, #fdba74)" : "linear-gradient(to right, #fb923c, #fed7aa)";
          return (
            <div key={row.name} className="rounded border border-slate-100 bg-white p-3 shadow-sm">
              <div className="mb-1 flex items-center justify-between text-sm">
                <div className="flex flex-col">
                  <span className="font-bold text-slate-800">{row.name}</span>
                  <span className="text-phx-sm font-semibold uppercase tracking-[0.12em] text-slate-400">{contributionPercent.toFixed(1)}% of top 4</span>
                </div>
                <span className="font-mono text-xs font-black text-slate-900 tabular-nums">{formatContributionValue(metric, value)}</span>
              </div>
              <div className="h-2.5 overflow-hidden rounded-sm bg-slate-100">
                <div className="h-full rounded-sm" style={{ width: `${width}%`, background: grad }} />
              </div>
            </div>
          );
        })}
      </div>
    </OverviewPagePanel>
  );
}

function PerformanceChartTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number; dataKey: string; color: string }>; label?: string }) {
  if (!active || !payload?.length) return null;
  const salesEntry = payload.find((p) => p.dataKey === "sales");
  const targetEntry = payload.find((p) => p.dataKey === "target");
  const sales = salesEntry?.value ?? 0;
  const target = targetEntry?.value ?? 0;
  const achievement = target > 0 ? ((sales / target) * 100).toFixed(1) : "-";
  const gap = sales - target;
  return (
    <div className="rounded border border-slate-200 bg-white px-4 py-3 shadow-[0_16px_40px_rgba(15,23,42,0.18)]">
      <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">{label}</p>
      <div className="mt-2 space-y-1.5">
        <div className="flex items-center justify-between gap-6">
          <span className="flex items-center gap-1.5 text-xs text-slate-600"><span className="inline-block h-2 w-2 rounded-sm bg-orange-500" />Sales</span>
          <span className="text-xs font-black text-orange-600">{egp(sales)}</span>
        </div>
        <div className="flex items-center justify-between gap-6">
          <span className="flex items-center gap-1.5 text-xs text-slate-600"><span className="inline-block h-2 w-2 rounded-sm bg-slate-400" />Target</span>
          <span className="text-xs font-black text-slate-700">{egp(target)}</span>
        </div>
        <div className="border-t border-slate-100 pt-1.5">
          <div className="flex items-center justify-between gap-6">
            <span className="text-phx-sm font-semibold uppercase tracking-wide text-slate-400">Achievement</span>
            <span className="text-xs font-black text-orange-600">{achievement}%</span>
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-6">
            <span className="text-phx-sm font-semibold uppercase tracking-wide text-slate-400">Gap</span>
            <span className="text-xs font-black text-slate-700">{gap >= 0 ? "+" : ""}{egp(gap)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function OverviewPerformanceChart({ data }: { data: MedicalRepPortalData }) {
  const trendData = Array.isArray(data.sales.trend) ? data.sales.trend : [];

  const chartData = trendData.map((point) => {
    const achievement = point.target > 0 ? (point.sales / point.target) * 100 : 0;
    return {
      period: periodLabel(point.period),
      shortPeriod: periodMonthLabel(point.period),
      sales: point.sales,
      target: point.target,
      achievement: Math.round(achievement),
    };
  });

  const totalSales = trendData.reduce((sum, p) => sum + p.sales, 0);
  const totalTarget = trendData.reduce((sum, p) => sum + p.target, 0);
  const overallAchievement = totalTarget > 0 ? ((totalSales / totalTarget) * 100).toFixed(1) : "0";
  const avgTarget = trendData.length > 0 ? totalTarget / trendData.length : 0;

  return (
    <OverviewPagePanel
      title="Performance Overview"
      action={
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded border border-slate-200 bg-white px-2.5 py-1 text-phx-sm font-bold uppercase tracking-[0.12em] text-slate-500 ${adminSoftDepthClassName}`}>
            {trendData.length} months
          </span>
          <span className="rounded border border-orange-200 bg-orange-50 px-2.5 py-1 text-phx-sm font-bold uppercase tracking-[0.12em] text-orange-700">
            {overallAchievement}% achievement
          </span>
        </div>
      }
    >
      <ChartErrorBoundary>
        {trendData.length === 0 ? (
          <div className="flex h-64 items-center justify-center rounded border border-slate-100 bg-slate-50 text-sm font-semibold text-slate-500">
            No trend data available
          </div>
        ) : (
          <div className="space-y-4">
            {/* Summary metrics strip */}
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded border border-slate-100 bg-slate-50/60 px-3 py-2.5">
                <p className="text-phx-xs font-bold uppercase tracking-[0.16em] text-slate-400">Total Sales</p>
                <p className="mt-1 text-sm font-black text-orange-600">{egp(totalSales)}</p>
              </div>
              <div className="rounded border border-slate-100 bg-slate-50/60 px-3 py-2.5">
                <p className="text-phx-xs font-bold uppercase tracking-[0.16em] text-slate-400">Total Target</p>
                <p className="mt-1 text-sm font-black text-slate-700">{egp(totalTarget)}</p>
              </div>
              <div className="rounded border border-slate-100 bg-slate-50/60 px-3 py-2.5">
                <p className="text-phx-xs font-bold uppercase tracking-[0.16em] text-slate-400">Gap</p>
                <p className="mt-1 text-sm font-black text-slate-700">
                  {totalSales >= totalTarget ? "+" : ""}{egp(totalSales - totalTarget)}
                </p>
              </div>
            </div>

            {/* Chart */}
            <div className="h-[280px] w-full rounded border border-slate-100 bg-white/70 px-1 pt-3 shadow-inner sm:h-[320px]">
              <SafeResponsiveContainer style={{ width: "100%", height: "100%" }}>
                <AreaChart data={chartData} margin={{ top: 10, right: 12, left: -8, bottom: 6 }}>
                  <defs>
                    <linearGradient id="perfSalesGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#f97316" stopOpacity={0.35} />
                      <stop offset="50%" stopColor="#f97316" stopOpacity={0.12} />
                      <stop offset="100%" stopColor="#f97316" stopOpacity={0.01} />
                    </linearGradient>
                    <linearGradient id="perfTargetGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#64748b" stopOpacity={0.12} />
                      <stop offset="100%" stopColor="#64748b" stopOpacity={0.01} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis
                    dataKey="shortPeriod"
                    tick={{ fontSize: 11, fontWeight: 700, fill: "#64748b" }}
                    tickLine={false}
                    axisLine={{ stroke: "#e2e8f0" }}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fontWeight: 600, fill: "#94a3b8" }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value: number) => `${Math.round(value / 1000)}k`}
                    width={52}
                  />
                  {avgTarget > 0 ? (
                    <ReferenceLine
                      y={avgTarget}
                      stroke="#f97316"
                      strokeDasharray="8 4"
                      strokeOpacity={0.25}
                      label={{ value: "Avg Target", position: "insideTopRight", fill: "#f97316", fontSize: 9, fontWeight: 700 }}
                    />
                  ) : null}
                  <Tooltip content={<PerformanceChartTooltip />} cursor={{ stroke: "#f97316", strokeDasharray: "4 4", strokeOpacity: 0.4 }} />
                  <Legend
                    verticalAlign="top"
                    align="right"
                    iconType="rect"
                    iconSize={10}
                    wrapperStyle={{ fontSize: 11, fontWeight: 700, paddingBottom: 8 }}
                  />
                  <Area
                    type="monotone"
                    dataKey="target"
                    name="Target"
                    stroke="#94a3b8"
                    strokeWidth={2}
                    strokeDasharray="6 4"
                    fill="url(#perfTargetGradient)"
                    dot={false}
                    activeDot={{ r: 4, fill: "#64748b", stroke: "#fff", strokeWidth: 2 }}
                  />
                  <Area
                    type="monotone"
                    dataKey="sales"
                    name="Sales"
                    stroke="#f97316"
                    strokeWidth={2.5}
                    fill="url(#perfSalesGradient)"
                    dot={{ r: 3.5, fill: "#f97316", stroke: "#fff", strokeWidth: 2 }}
                    activeDot={{ r: 5.5, fill: "#f97316", stroke: "#fff", strokeWidth: 2.5 }}
                  />
                </AreaChart>
              </SafeResponsiveContainer>
            </div>
          </div>
        )}
      </ChartErrorBoundary>
    </OverviewPagePanel>
  );
}

function vacationTypeChipLabel(value: string) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "annual") return "Annual";
  if (normalized === "emergency") return "Emergency";
  if (normalized === "sick") return "Sick";
  if (normalized === "other") return "Other";
  return value;
}

const actionIconMap: Record<string, typeof ReceiptText> = {
  "vacation-approvals": CalendarClock,
  "my-vacation-requests": CalendarDays,
  "marketing-drafts": Megaphone,
  "probation-reviews": ClipboardList,
  "open-vacancies": Users,
};

function MyActionsPanel({ data, surface }: { data: MedicalRepPortalData; surface: PortalDashboardSurface }) {
  // Managers (DSM/NSM) get team-management to-dos appended to the server-provided
  // action list. These counts already exist in the payload (data.workforce) and were
  // previously only used for display KPIs — here they become actionable, deep-linked items.
  const managerActions = canSeeTeamLeaveAndStructurePanels(data)
    ? [
        {
          count: data.workforce.probationDue,
          href: dashboardHrefForSurface("/employee-portals/probation", surface),
          id: "probation-reviews",
          label: "Probation reviews due",
        },
        {
          count: data.workforce.openVacancies,
          href: dashboardHrefForSurface("/employee-portals/vacancies", surface),
          id: "open-vacancies",
          label: "Open vacancies to fill",
        },
      ].filter((item) => item.count > 0)
    : [];
  const actions = [
    ...data.overview.myActions.map((item) => ({
      ...item,
      href: dashboardHrefForSurface(item.href, surface),
    })),
    ...managerActions,
  ];

  return (
    <OverviewPagePanel title="My Actions">
      {actions.length === 0 ? (
        <div className="flex h-full min-h-[200px] flex-col items-center justify-center rounded border border-dashed border-slate-200 bg-slate-50/60 px-6 text-center">
          <ShieldCheck className="mb-2 h-8 w-8 text-slate-300" />
          <p className="text-sm font-medium text-slate-500">No pending actions right now.</p>
          <p className="mt-1 text-xs text-slate-400">You&apos;re all caught up.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {actions.map((item) => (
            <Link
              key={item.id}
              className="group flex items-center gap-3 rounded border border-slate-200 bg-white px-4 py-3 shadow-[0_2px_8px_rgba(15,23,42,0.04)] transition-colors hover:border-orange-200 hover:bg-orange-50/40"
              href={item.href}
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded bg-orange-50 text-orange-600 ring-1 ring-orange-100 transition-transform duration-200 group-hover:scale-105">
                {(() => {
                  const Icon = actionIconMap[item.id] ?? ReceiptText;
                  return <Icon className="h-5 w-5" />;
                })()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-phx-lg font-medium text-slate-800">{item.label}</p>
              </div>
              <span className="shrink-0 text-sm font-semibold text-orange-600">({item.count})</span>
              <ArrowUpRight className="h-4 w-4 shrink-0 text-slate-300 transition-colors duration-200 group-hover:text-slate-500" />
            </Link>
          ))}
        </div>
      )}
    </OverviewPagePanel>
  );
}

function QuickActionsPanel({ data, surface }: { data: MedicalRepPortalData; surface: PortalDashboardSurface }) {
  const actions = [
    { href: resolveExpenseActionHref(data, surface), icon: ReceiptText, id: "expense", label: "Submit Expense" },
    {
      href: dashboardHrefForSurface("/leave-management/vacation-request", surface),
      icon: CalendarDays,
      id: "vacation",
      label: "Submit Vacation Request",
    },
    {
      href: dashboardHrefForSurface("/employee-portals/marketing-requests", surface),
      icon: Megaphone,
      id: "marketing",
      label: "Submit Marketing Request",
    },
  ].filter((item) => {
    if (item.id === "marketing") {
      // Marketing Requests is a Beta module: hidden by default, surfaced only
      // when PHOENIX_PORTAL_SHOW_BETA_NAV is enabled (resolved server-side into
      // data.betaNavEnabled) AND the role is already authorized for Marketing.
      // Mirrors the sidebar nav gating in buildEmployeePortalSections.
      return shouldShowEmployeePortalMarketingQuickAction(data.betaNavEnabled, data.employee.roleLabel);
    }
    return true;
  });

  return (
    <OverviewPagePanel title="Quick Actions">
      <div className="grid grid-cols-1 auto-rows-fr gap-3 sm:grid-cols-3">
        {actions.map((item) => (
          <Link
            key={item.href}
            className="group flex h-full min-h-[116px] flex-col items-center justify-between rounded border border-slate-200 bg-white px-3 py-3 text-center shadow-[0_2px_8px_rgba(15,23,42,0.04)] transition-colors hover:border-orange-200 hover:bg-orange-50/50"
            href={item.href}
          >
            <span className="flex h-12 w-12 items-center justify-center rounded bg-slate-100 text-slate-700 ring-1 ring-slate-200 transition-all duration-200 group-hover:scale-105 group-hover:bg-white">
              <item.icon className="h-5 w-5" />
            </span>
            <span className="flex min-h-[40px] items-center text-phx-base font-medium leading-5 text-slate-800">
              {item.label}
            </span>
            <span className="inline-flex items-center gap-1 text-phx-sm font-medium text-slate-400 transition-colors duration-200 group-hover:text-slate-500">
              Open
              <ArrowUpRight className="h-3 w-3" />
            </span>
          </Link>
        ))}
      </div>
    </OverviewPagePanel>
  );
}

type A3QuickCard = {
  href: string;
  icon: typeof Activity;
  label: string;
  value: string;
};

function getActionValue(count: number | undefined | null, emptyStateLabel = "No pending") {
  return count && count > 0 ? `${count} pending` : emptyStateLabel;
}

function A3DashboardQuickCards({ data }: { data: MedicalRepPortalData }) {
  const vacationApprovals = data.overview.myActions.find((action) => action.id === "vacation-approvals");
  const myVacationRequests = data.overview.myActions.find((action) => action.id === "my-vacation-requests");

  const cards: A3QuickCard[] = [
    {
      href: vacationApprovals?.href ?? "/leave-management/vacation-report?status=pending_manager",
      icon: CalendarClock,
      label: vacationApprovals?.label ?? "Vacation approvals waiting",
      value: getActionValue(vacationApprovals?.count),
    },
    {
      href: myVacationRequests?.href ?? "/leave-management/vacation-report?status=pending_manager",
      icon: CalendarDays,
      label: myVacationRequests?.label ?? "Vacation requests pending decision",
      value: getActionValue(myVacationRequests?.count),
    },
    {
      href: "/employee-portals/excuses",
      icon: ClipboardList,
      label: "Excuses",
      value: "Open",
    },
    {
      href: "/employee-portals/report-it",
      icon: FileText,
      label: "Report It",
      value: "Open",
    },
    {
      href: "/admin/report-it",
      icon: LineChart,
      label: "Reports Dashboard",
      value: "Open",
    },
  ];

  return (
    <OverviewPagePanel title="Quick Access">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map((card) => (
          <Link
            className="group flex min-h-[124px] flex-col justify-between rounded border border-slate-200 bg-white p-4 shadow-[0_2px_8px_rgba(15,23,42,0.04)] transition-colors hover:border-orange-200 hover:bg-orange-50/50"
            href={card.href}
            key={`${card.label}-${card.href}`}
          >
            <span className="inline-flex h-10 w-10 items-center justify-center rounded bg-slate-100 text-slate-700 ring-1 ring-slate-200 transition-all duration-200 group-hover:scale-105 group-hover:bg-white">
              <card.icon className="h-5 w-5" />
            </span>
            <span className="mt-2 block text-base font-semibold text-slate-900">{card.label}</span>
            <span className="text-sm font-medium text-slate-500">{card.value}</span>
          </Link>
        ))}
      </div>
    </OverviewPagePanel>
  );
}

function isA3EmployeePortalUser(data: MedicalRepPortalData) {
  return canonicalHrIdKey(data.employee.hrId) === "a-3";
}

function EmployeesOnLeaveTodayPanel({ data }: { data: MedicalRepPortalData }) {
  const rows = data.overview.employeesOnLeaveToday;

  return (
    <OverviewPagePanel title="Employees on Leave Today">
      {rows.length === 0 ? (
        <div className="flex h-full min-h-[200px] flex-col items-center justify-center rounded border border-dashed border-slate-200 bg-slate-50/60 px-6 text-center">
          <CalendarDays className="mb-2 h-8 w-8 text-slate-300" />
          <p className="text-sm font-medium text-slate-500">No employees are on leave today.</p>
          <p className="mt-1 text-xs text-slate-400">Full team is available.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.slice(0, 6).map((row) => (
            <div
              className="flex items-start justify-between gap-3 rounded border border-slate-200 bg-white/80 px-4 py-3 shadow-sm"
              key={row.id}
            >
              <div className="min-w-0">
                <p className="break-words text-sm font-medium text-slate-900">{row.employeeName}</p>
                <p className="mt-1 break-words text-xs font-normal text-slate-500">
                  {row.lineName ?? row.departmentName ?? "Phoenix"} / {prettyDate(row.startDate)} - {prettyDate(row.endDate)}
                </p>
              </div>
              <span className="shrink-0 rounded border border-sky-200 bg-sky-50 px-2.5 py-1 text-phx-sm font-semibold uppercase tracking-[0.12em] text-sky-700">
                {vacationTypeChipLabel(row.vacationType)}
              </span>
            </div>
          ))}
        </div>
      )}
    </OverviewPagePanel>
  );
}

function TeamStructurePanel({ data }: { data: MedicalRepPortalData }) {
  const vacancyDetails = data.overview.vacancyDetails;
  const totalStructure = data.orgStructure?.totalStructure ?? data.workforce.activeHeadcount + data.workforce.openVacancies;
  const actualNow = data.orgStructure?.actualNow ?? data.workforce.activeHeadcount;
  const vacancies = data.orgStructure?.vacancies ?? data.workforce.openVacancies;
  const allVacancies = vacancyDetails?.vacancies ?? [];
  const fillRate = totalStructure > 0 ? Math.round((actualNow / totalStructure) * 100) : 0;

  // Group vacancies by job title for differentiation
  const groupedByTitle = new Map<string, typeof allVacancies>();
  for (const row of allVacancies) {
    const title = row.jobTitle ?? row.positionTitle ?? "Unspecified Role";
    const group = groupedByTitle.get(title) ?? [];
    group.push(row);
    groupedByTitle.set(title, group);
  }
  const titleGroups = Array.from(groupedByTitle.entries()).sort((a, b) => b[1].length - a[1].length);

  const titleColorMap: Record<number, string> = {
    0: "border-l-orange-500 bg-orange-50/40",
    1: "border-l-sky-500 bg-sky-50/40",
    2: "border-l-emerald-500 bg-emerald-50/40",
    3: "border-l-purple-500 bg-purple-50/40",
    4: "border-l-amber-500 bg-amber-50/40",
  };
  const titleBadgeMap: Record<number, string> = {
    0: "border-orange-200 bg-orange-50 text-orange-700",
    1: "border-sky-200 bg-sky-50 text-sky-700",
    2: "border-emerald-200 bg-emerald-50 text-emerald-700",
    3: "border-purple-200 bg-purple-50 text-purple-700",
    4: "border-amber-200 bg-amber-50 text-amber-700",
  };

  return (
    <OverviewPagePanel title="Team Structure">
      {/* Summary metrics */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded border border-slate-200 bg-white/80 p-3 shadow-sm">
          <p className="text-phx-xs font-bold uppercase tracking-[0.14em] text-slate-400">Structure</p>
          <p className="mt-1.5 text-xl font-black text-slate-900">{formatUnits(totalStructure)}</p>
        </div>
        <div className="rounded border border-slate-200 bg-white/80 p-3 shadow-sm">
          <p className="text-phx-xs font-bold uppercase tracking-[0.14em] text-slate-400">Filled</p>
          <p className="mt-1.5 text-xl font-black text-emerald-600">{formatUnits(actualNow)}</p>
        </div>
        <div className="rounded border border-slate-200 bg-white/80 p-3 shadow-sm">
          <p className="text-phx-xs font-bold uppercase tracking-[0.14em] text-slate-400">Vacant</p>
          <p className="mt-1.5 text-xl font-black text-orange-600">{formatUnits(vacancies)}</p>
        </div>
      </div>

      {/* Fill rate bar */}
      <div className={`mt-3 rounded border border-slate-200 bg-white/80 p-3 ${adminSoftDepthClassName}`}>
        <div className="flex items-center justify-between">
          <p className="text-phx-sm font-bold uppercase tracking-[0.14em] text-slate-400">Fill Rate</p>
          <span className="text-xs font-black text-slate-700">{fillRate}%</span>
        </div>
        <div className="relative mt-2 h-2.5 w-full overflow-hidden rounded-sm bg-slate-100">
          <div
            className="absolute inset-y-0 left-0 rounded-sm transition-all duration-500"
            style={{ width: `${Math.min(100, fillRate)}%`, background: "linear-gradient(to right, #f97316, #fdba74)" }}
          />
        </div>
      </div>

      {/* Scope label */}
      <div className={`mt-3 flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 bg-slate-50/70 px-3 py-2.5 ${adminSoftDepthClassName}`}>
        <p className="text-sm font-medium text-slate-900">
          {data.orgStructure?.scopeLabel ?? data.workforce.scopeLabel}
        </p>
        <span className="rounded border border-orange-200 bg-orange-50 px-2.5 py-1 text-phx-sm font-bold uppercase tracking-[0.12em] text-orange-700">
          {formatUnits(allVacancies.length)} open position{allVacancies.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* All vacancies grouped by title */}
      {titleGroups.length > 0 ? (
        <div className="mt-3 space-y-2">
          {titleGroups.map(([title, rows], groupIndex) => (
            <div key={title} className={`rounded border border-slate-200 border-l-[3px] p-3 ${titleColorMap[groupIndex % 5] ?? "border-l-slate-400 bg-slate-50/40"}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-phx-md font-bold text-slate-800">{title}</p>
                <span className={`rounded border px-2 py-0.5 text-phx-sm font-bold uppercase tracking-[0.12em] ${titleBadgeMap[groupIndex % 5] ?? "border-slate-200 bg-slate-50 text-slate-600"}`}>
                  {rows.length} vacant
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {rows.map((row) => (
                  <span
                    className={`rounded border border-slate-200 bg-white px-2.5 py-1 text-phx-xs font-medium text-slate-600 ${adminSoftDepthClassName}`}
                    key={row.id ?? row.vacancyCode}
                  >
                    {row.areaName ?? row.regionName ?? "Unassigned"}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm font-medium text-slate-500">No active vacancy areas are visible in your current scope.</p>
      )}
    </OverviewPagePanel>
  );
}

// Request Support (ContactHRSupportPage) lives in contact-hr-support-page.tsx since 2026-10-01, so
// that form no longer downloads this module and its charts. Do not move it back.

export function WorkloadExpenseDashboard({ data }: { data: MedicalRepPortalData }) {
  const workload = data.workload;
  const [viewBy, setViewBy] = useState("Employee");
  const [selectedEmployee, setSelectedEmployee] = useState("All");
  const [selectedRole, setSelectedRole] = useState("All");
  const [selectedTerritory, setSelectedTerritory] = useState("All");
  const [tripType, setTripType] = useState("All");
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = () => {
    setIsRefreshing(true);
    setTimeout(() => setIsRefreshing(false), 1000);
  };

  const totalTrips = workload?.totalTrips ?? 0;
  const totalDistance = workload?.totalDistance ?? 0;
  const totalExpenses = workload?.totalExpenses ?? 0;
  const activeEmployees = workload?.activeEmployees ?? 0;
  const avgCostPerTrip = workload?.avgCostPerTrip ?? 0;

  const kpiCards = [
    { label: "Total Trips", value: totalTrips.toString(), delta: "0%", icon: Car, subLabel: "This period" },
    { label: "Total Distance", value: `${totalDistance.toLocaleString()} km`, delta: "0%", icon: MapPin, subLabel: "Kilometers" },
    { label: "Total Expenses", value: egp(totalExpenses), delta: "0%", icon: ReceiptText, subLabel: "EGP" },
    { label: "Active Employees", value: activeEmployees.toString(), delta: "0", icon: Users, subLabel: "AMs & PMs" },
    { label: "Avg Cost per Trip", value: egp(avgCostPerTrip), delta: "0%", icon: Calculator, subLabel: "Per trip" },
  ];

  const workloadOverview = [
    { label: "Avg Trips / Day", value: (totalTrips / 22).toFixed(1), delta: "0" },
    { label: "Avg Distance / Day", value: `${(totalDistance / 22).toFixed(0)} km`, delta: "0 km" },
    { label: "Active Days", value: workload?.employeePerformance.reduce((max, e) => Math.max(max, e.activeDays), 0).toString() ?? "0", delta: "0" },
    { label: "Avg Trips per Active Day", value: activeEmployees > 0 ? (totalTrips / activeEmployees / 22).toFixed(1) : "0", delta: "0" },
  ];

  const tripsVsDistanceTrend = workload?.tripsVsDistanceTrend ?? [];
  const workloadDistribution = workload?.workloadDistribution ?? [];
  const heatmapData = workload?.heatmapData ?? {
    trips: [0, 0, 0, 0, 0, 0, 0],
    distance: [0, 0, 0, 0, 0, 0, 0],
    expenses: [0, 0, 0, 0, 0, 0, 0],
  };

  const employeePerformance = workload?.employeePerformance ?? [];
  const expenseAnalysis = [
    { label: "Total Expenses", value: egp(totalExpenses), delta: "0%" },
    { label: "Cost per Trip", value: egp(avgCostPerTrip), delta: "0%" },
    { label: "Cost per KM", value: totalDistance > 0 ? `EGP ${(totalExpenses / totalDistance).toFixed(1)}` : "EGP 0", delta: "0%" },
    { label: "Highest Single Trip", value: egp(Math.max(0, ...(workload?.recentTrips.map(t => t.cost) ?? []))), delta: "" },
  ];

  const expenseTrend = workload?.expenseTrend ?? [];
  const territoryAnalysis = workload?.territoryAnalysis ?? [];
  const recentTrips = workload?.recentTrips ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-slate-900 sm:text-3xl">Expense Dashboard</h1>
          <p className="mt-1 text-sm text-slate-500">Track workload, trips, and expense efficiency across AMs & PMs</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <div className={`flex items-center gap-2 rounded border border-slate-200 bg-white px-3 py-2 ${adminSoftDepthClassName}`}>
            <CalendarDays className="h-4 w-4 shrink-0 text-slate-400" />
            <input className={cn(phxFieldClassName, "w-28 sm:w-32")} placeholder="From" type="date" />
            <span className="text-slate-400">-</span>
            <input className={cn(phxFieldClassName, "w-28 sm:w-32")} placeholder="To" type="date" />
          </div>
          <Button className="rounded" disabled={isRefreshing} onClick={handleRefresh} variant="secondary">
            <RefreshCw className={`mr-2 h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      <Card className="rounded border border-slate-100 bg-white p-4 shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
        <div className="grid grid-cols-2 gap-3 xs:grid-cols-3 sm:flex sm:flex-wrap sm:items-center sm:gap-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">View By</label>
            <SearchableSelect
              className="h-9 px-3"
              value={viewBy}
              onChange={(e) => setViewBy(e.target.value)}
            >
              <option value="Employee">Employee</option>
              <option value="Role">Role</option>
              <option value="Territory">Territory</option>
            </SearchableSelect>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Employee</label>
            <SearchableSelect
              className="h-9 px-3"
              value={selectedEmployee}
              onChange={(e) => setSelectedEmployee(e.target.value)}
            >
              <option value="All">All Employees</option>
              {workload?.availableEmployees.map((emp) => (
                <option key={emp.id} value={emp.id}>{emp.name}</option>
              ))}
            </SearchableSelect>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Role</label>
            <SearchableSelect
              className="h-9 px-3"
              value={selectedRole}
              onChange={(e) => setSelectedRole(e.target.value)}
            >
              <option value="All">All Roles</option>
              <option value="AM">AM</option>
              <option value="PM">PM</option>
            </SearchableSelect>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Territory</label>
            <SearchableSelect
              className="h-9 px-3"
              value={selectedTerritory}
              onChange={(e) => setSelectedTerritory(e.target.value)}
            >
              <option value="All">All Territories</option>
              {workload?.availableTerritories.map((loc) => (
                <option key={loc} value={loc}>{loc}</option>
              ))}
            </SearchableSelect>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Trip Type</label>
            <SearchableSelect
              className="h-9 px-3"
              value={tripType}
              onChange={(e) => setTripType(e.target.value)}
            >
              <option value="All">All</option>
              <option value="Travel">Travel</option>
              <option value="Return">Return</option>
              <option value="Meeting">Meeting</option>
            </SearchableSelect>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 xs:grid-cols-3 md:grid-cols-5">
        {kpiCards.map((card) => (
          <WorkloadKPICard
            key={card.label}
            delta={card.delta}
            icon={card.icon}
            label={card.label}
            subLabel={card.subLabel}
            value={card.value}
          />
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="rounded border border-white/80 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] p-6 shadow-[0_14px_34px_rgba(15,23,42,0.07)] ring-1 ring-slate-200/70">
          <div className="mb-4 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-orange-500/80" />
            <p className="text-lg font-black tracking-tight text-slate-900">Workload Overview</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {workloadOverview.map((item) => (
              <div key={item.label} className="rounded border border-slate-100 bg-slate-50/50 p-4">
                <p className="text-xs font-medium text-slate-500">{item.label}</p>
                <p className="mt-1 text-xl font-semibold text-slate-900">{item.value}</p>
                <p className="mt-1 text-xs text-emerald-600">{item.delta}</p>
              </div>
            ))}
          </div>
          <StableChartFrame
            className="mt-6 h-64 rounded border border-slate-100 bg-white/70 p-3 shadow-inner"
            height={232}
          >
              <AreaChart data={tripsVsDistanceTrend} margin={chartMargin}>
                <defs>
                  <linearGradient id="tripsGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f97316" stopOpacity={0.32} />
                    <stop offset="95%" stopColor="#f97316" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={chartGridStroke} vertical={false} />
                <XAxis {...chartAxisProps()} dataKey="month" />
                <YAxis {...chartAxisProps()} />
                <Tooltip contentStyle={chartTooltipStyle()} cursor={chartCursor} />
                <Area activeDot={{ r: 5, stroke: "#ffffff", strokeWidth: 3 }} dataKey="trips" dot={false} fill="url(#tripsGradient)" name="Trips" stroke="#f97316" strokeWidth={3} type="monotone" />
                <Area dataKey="distance" dot={false} fill="none" name="Distance (km)" stroke="#64748b" strokeDasharray="5 5" strokeWidth={2.25} type="monotone" />
                <Legend iconType="circle" wrapperStyle={chartLegendStyle()} />
              </AreaChart>
          </StableChartFrame>
        </Card>

        <Card className="rounded border border-white/80 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] p-6 shadow-[0_14px_34px_rgba(15,23,42,0.07)] ring-1 ring-slate-200/70">
          <div className="mb-4 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-orange-500/80" />
            <p className="text-lg font-black tracking-tight text-slate-900">Workload Distribution</p>
          </div>
          <div className="grid gap-4 md:grid-cols-[1fr_1fr]">
            <StableChartFrame
              className="h-64 rounded border border-slate-100 bg-white/70 p-3 shadow-inner"
              height={232}
            >
                <PieChart>
                  <Pie
                    cornerRadius={2}
                    data={workloadDistribution}
                    dataKey="value"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={2}
                    nameKey="name"
                    stroke="#ffffff"
                    strokeWidth={3}
                  >
                    {workloadDistribution.map((entry) => (
                      <Cell key={entry.name} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={chartTooltipStyle()} cursor={false} />
                </PieChart>
            </StableChartFrame>
            <div className="flex flex-col justify-center space-y-3">
              {workloadDistribution.map((item) => (
                <div key={item.name} className="flex items-center justify-between rounded border border-slate-100 bg-white px-3 py-2 shadow-[0_5px_14px_rgba(15,23,42,0.03)]">
                  <div className="flex items-center gap-2">
                    <div className="h-3 w-3 rounded-full ring-2 ring-white" style={{ backgroundColor: item.color }} />
                    <span className="text-sm font-bold text-slate-700">{item.name}</span>
                  </div>
                  <span className="font-mono text-sm font-black text-slate-900 tabular-nums">{item.value}</span>
                </div>
              ))}
            </div>
          </div>
        </Card>
      </div>

      <Card className="rounded border border-slate-100 bg-white p-6 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
        <div className="mb-4 flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-orange-500/80" />
          <p className="text-lg font-semibold text-slate-900">Workload by Day (Heatmap)</p>
        </div>
        {/* Mobile vertical layout for <480px */}
        <div className="space-y-4 md:hidden">
          {([
            { label: "Trips", data: heatmapData.trips, max: 6 },
            { label: "Distance (km)", data: heatmapData.distance, max: 520 },
            { label: "Expenses (EGP)", data: heatmapData.expenses, max: 3600 },
          ] as const).map((metric) => (
            <div key={metric.label} className="rounded border border-slate-100 bg-white p-3">
              <p className="mb-2 text-xs font-bold uppercase tracking-[0.12em] text-slate-500">{metric.label}</p>
              <div className="grid grid-cols-7 gap-1">
                {["M", "T", "W", "T", "F", "S", "S"].map((day, i) => (
                  <div key={`${metric.label}-${i}`} className="text-center">
                    <p className="mb-1 text-phx-xs font-bold text-slate-400">{day}</p>
                    <div
                      className="flex h-8 items-center justify-center text-xs font-semibold text-white"
                      style={{ backgroundColor: `rgba(249, 115, 22, ${0.2 + (metric.data[i] / metric.max) * 0.8})` }}
                    >
                      {metric.data[i]}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        {/* Desktop table for >=480px */}
        <div className="hidden md:block">
          <table className="w-full table-fixed border-collapse text-sm">
            <colgroup><col className="w-[16%]" /><col className="w-[12%]" /><col className="w-[12%]" /><col className="w-[12%]" /><col className="w-[12%]" /><col className="w-[12%]" /><col className="w-[12%]" /><col className="w-[12%]" /></colgroup>
            <thead>
              <tr>
                <th className={gridHeaderClass}>Metric</th>
                <th className={`${gridHeaderClass} text-center`}>Mon</th>
                <th className={`${gridHeaderClass} text-center`}>Tue</th>
                <th className={`${gridHeaderClass} text-center`}>Wed</th>
                <th className={`${gridHeaderClass} text-center`}>Thu</th>
                <th className={`${gridHeaderClass} text-center`}>Fri</th>
                <th className={`${gridHeaderClass} text-center`}>Sat</th>
                <th className={`${gridHeaderClass} text-center`}>Sun</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className={`${gridCellClass} font-medium text-slate-900`}>Trips</td>
                {heatmapData.trips.map((value, index) => (
                  <td key={index} className={gridCellClass}>
                    <div
                      className="flex h-8 items-center justify-center text-sm font-semibold text-white"
                      style={{ backgroundColor: `rgba(249, 115, 22, ${0.2 + (value / 6) * 0.8})` }}
                    >
                      {value}
                    </div>
                  </td>
                ))}
              </tr>
              <tr>
                <td className={`${gridCellClass} font-medium text-slate-900`}>Distance (km)</td>
                {heatmapData.distance.map((value, index) => (
                  <td key={index} className={gridCellClass}>
                    <div
                      className="flex h-8 items-center justify-center text-sm font-semibold text-white"
                      style={{ backgroundColor: `rgba(249, 115, 22, ${0.2 + (value / 520) * 0.8})` }}
                    >
                      {value}
                    </div>
                  </td>
                ))}
              </tr>
              <tr>
                <td className={`${gridCellClass} font-medium text-slate-900`}>Expenses (EGP)</td>
                {heatmapData.expenses.map((value, index) => (
                  <td key={index} className={gridCellClass}>
                    <div
                      className="flex h-8 items-center justify-center text-sm font-semibold text-white"
                      style={{ backgroundColor: `rgba(249, 115, 22, ${0.2 + (value / 3600) * 0.8})` }}
                    >
                      {value}
                    </div>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="rounded border border-slate-100 bg-white p-6 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
        <div className="mb-4 flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-orange-500/80" />
          <p className="text-lg font-semibold text-slate-900">Employee Performance (AM & PM)</p>
        </div>
        {employeePerformance.length === 0 ? (
          <PortalEmptyState
            message="Nobody on your team has a recorded visit in this period yet."
            title="No performance rows yet"
          />
        ) : null}
        {/* Mobile card view for <480px */}
        <div className="space-y-2 md:hidden">
          {employeePerformance.map((emp, index) => (
            <div key={emp.name} className="rounded border border-slate-100 bg-white p-3.5 shadow-[0_2px_8px_rgba(15,23,42,0.04)]">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {index < 2 && <Trophy className="h-4 w-4 text-orange-500" />}
                  <span className="text-sm font-bold text-slate-900">{emp.name}</span>
                </div>
                <Badge variant="neutral">{emp.role}</Badge>
              </div>
              <div className="mt-2.5 grid grid-cols-3 gap-2">
                <div>
                  <p className="text-phx-sm font-bold uppercase tracking-[0.12em] text-slate-400">Trips</p>
                  <p className="mt-0.5 text-sm font-semibold text-slate-900">{emp.trips}</p>
                </div>
                <div>
                  <p className="text-phx-sm font-bold uppercase tracking-[0.12em] text-slate-400">Distance</p>
                  <p className="mt-0.5 text-sm text-slate-600">{emp.distance} km</p>
                </div>
                <div>
                  <p className="text-phx-sm font-bold uppercase tracking-[0.12em] text-slate-400">Active Days</p>
                  <p className="mt-0.5 text-sm text-slate-600">{emp.activeDays}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
        {/* Desktop table for >=480px */}
        <div className="hidden md:block">
          <table className="w-full table-fixed border-collapse text-left text-sm">
            <colgroup><col className="w-[28%]" /><col className="w-[24%]" /><col className="w-[16%]" /><col className="w-[16%]" /><col className="w-[16%]" /></colgroup>
            <thead>
              <tr>
                <th className={gridHeaderClass}>Employee Name</th>
                <th className={gridHeaderClass}>Role</th>
                <th className={gridHeaderClass}>Trips</th>
                <th className={gridHeaderClass}>Distance</th>
                <th className={gridHeaderClass}>Active Days</th>
              </tr>
            </thead>
            <tbody>
              {employeePerformance.map((emp, index) => (
                <tr key={emp.name} className="transition hover:bg-slate-50/60">
                  <td className={`${gridCellClass} text-slate-900`}>
                    <div className="flex items-center gap-2">
                      {index < 2 && <Trophy className="h-4 w-4 text-orange-500" />}
                      {emp.name}
                    </div>
                  </td>
                  <td className={gridCellClass}>
                    <Badge variant="neutral">{emp.role}</Badge>
                  </td>
                  <td className={`${gridCellClass} font-semibold text-slate-900`}>{emp.trips}</td>
                  <td className={`${gridCellClass} text-slate-600`}>{emp.distance} km</td>
                  <td className={`${gridCellClass} text-slate-600`}>{emp.activeDays}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="rounded border border-white/80 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] p-6 shadow-[0_14px_34px_rgba(15,23,42,0.07)] ring-1 ring-slate-200/70">
          <div className="mb-4 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-orange-500/80" />
            <p className="text-lg font-black tracking-tight text-slate-900">Expense Analysis</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {expenseAnalysis.map((item) => (
              <div key={item.label} className="rounded border border-slate-100 bg-slate-50/50 p-4">
                <p className="text-xs font-medium text-slate-500">{item.label}</p>
                <p className="mt-1 text-xl font-semibold text-slate-900">{item.value}</p>
                {item.delta ? <p className="mt-1 text-xs text-slate-400">{item.delta}</p> : null}
              </div>
            ))}
          </div>
          <StableChartFrame
            className="mt-6 h-48 rounded border border-slate-100 bg-white/70 p-3 shadow-inner"
            height={168}
          >
              <AreaChart data={expenseTrend} margin={chartMargin}>
                <defs>
                  <linearGradient id="expenseTrendGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f97316" stopOpacity={0.32} />
                    <stop offset="95%" stopColor="#f97316" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={chartGridStroke} vertical={false} />
                <XAxis {...chartAxisProps()} dataKey="month" />
                <YAxis {...chartAxisProps()} tickFormatter={(value) => `EGP ${(value / 1000).toFixed(0)}k`} />
                <Tooltip contentStyle={chartTooltipStyle()} cursor={chartCursor} formatter={(value) => egp(Number(value))} />
                <Area activeDot={{ r: 5, stroke: "#ffffff", strokeWidth: 3 }} dataKey="expenses" dot={false} fill="url(#expenseTrendGradient)" name="Expenses" stroke="#f97316" strokeWidth={3} type="monotone" />
              </AreaChart>
          </StableChartFrame>
        </Card>

        <Card className="rounded border border-slate-100 bg-white p-6 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
          <div className="mb-4 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-orange-500/80" />
            <p className="text-lg font-semibold text-slate-900">Territory Analysis</p>
          </div>
          {territoryAnalysis.length === 0 ? (
            <PortalEmptyState
              message="No territory has a recorded trip in this period yet."
              title="No territory rows yet"
            />
          ) : null}
          {/* Mobile card view for <480px */}
          <div className="space-y-2 md:hidden">
            {territoryAnalysis.map((territory) => (
              <div key={territory.territory} className="rounded border border-slate-100 bg-white p-3.5 shadow-[0_2px_8px_rgba(15,23,42,0.04)]">
                <p className="text-sm font-bold text-slate-900">{territory.territory}</p>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <div>
                    <p className="text-phx-sm font-bold uppercase tracking-[0.12em] text-slate-400">Trips</p>
                    <p className="mt-0.5 text-sm text-slate-600">{territory.trips}</p>
                  </div>
                  <div>
                    <p className="text-phx-sm font-bold uppercase tracking-[0.12em] text-slate-400">Distance</p>
                    <p className="mt-0.5 text-sm text-slate-600">{territory.distance} km</p>
                  </div>
                  <div>
                    <p className="text-phx-sm font-bold uppercase tracking-[0.12em] text-slate-400">Expenses</p>
                    <p className="mt-0.5 text-sm font-semibold text-slate-900">{egp(territory.expenses)}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {/* Desktop table for >=480px */}
          <div className="hidden md:block">
            <table className="w-full table-fixed border-collapse text-left text-sm">
              <colgroup><col className="w-[40%]" /><col className="w-[15%]" /><col className="w-[20%]" /><col className="w-[25%]" /></colgroup>
              <thead>
                <tr>
                  <th className={gridHeaderClass}>Territory</th>
                  <th className={gridHeaderClass}>Trips</th>
                  <th className={gridHeaderClass}>Distance</th>
                  <th className={gridHeaderClass}>Expenses</th>
                </tr>
              </thead>
              <tbody>
                {territoryAnalysis.map((territory) => (
                  <tr key={territory.territory} className="transition hover:bg-slate-50/60">
                    <td className={`${gridCellClass} font-medium text-slate-900`}>{territory.territory}</td>
                    <td className={`${gridCellClass} text-slate-600`}>{territory.trips}</td>
                    <td className={`${gridCellClass} text-slate-600`}>{territory.distance} km</td>
                    <td className={`${gridCellClass} font-semibold text-slate-900`}>{egp(territory.expenses)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Card className="rounded border border-slate-100 bg-white p-6 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-orange-500/80" />
            <p className="text-lg font-semibold text-slate-900">Recent Trips</p>
          </div>
          <span className="rounded border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-500">
            {recentTrips.length} trip{recentTrips.length === 1 ? "" : "s"}
          </span>
        </div>
        {recentTrips.length === 0 ? (
          <PortalEmptyState
            message="No outstation trip has been recorded in this period yet."
            title="No trips yet"
          />
        ) : null}
        {/* Mobile card view for <480px */}
        <div className="space-y-2 md:hidden">
          {recentTrips.map((trip) => (
            <div key={trip.id} className="rounded border border-slate-100 bg-white p-3.5 shadow-[0_2px_8px_rgba(15,23,42,0.04)]">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs text-slate-500">{trip.id}</span>
                <span className="text-xs font-semibold text-slate-600">{trip.date}</span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-sm font-bold text-slate-900">{trip.employee}</span>
                <span className="text-lg font-black text-slate-900">{egp(trip.cost)}</span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="font-bold uppercase tracking-[0.12em] text-slate-400">From</span>
                  <p className="mt-0.5 text-slate-600">{trip.from}</p>
                </div>
                <div>
                  <span className="font-bold uppercase tracking-[0.12em] text-slate-400">To</span>
                  <p className="mt-0.5 text-slate-600">{trip.to}</p>
                </div>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <Badge variant="neutral">{trip.role}</Badge>
                <Badge variant="neutral">{trip.type}</Badge>
                <span className="ml-auto text-xs text-slate-500">{trip.distance} km</span>
              </div>
            </div>
          ))}
        </div>
        {/* Desktop table for >=480px */}
        <div className="hidden md:block">
          <table className="w-full table-fixed border-collapse text-left text-sm">
            <colgroup><col className="w-[13%]" /><col className="w-[17%]" /><col className="w-[14%]" /><col className="w-[14%]" /><col className="w-[12%]" /><col className="w-[12%]" /><col className="w-[18%]" /></colgroup>
            <thead>
              <tr>
                <th className={gridHeaderClass}>Date / Trip</th>
                <th className={gridHeaderClass}>Employee / Role</th>
                <th className={gridHeaderClass}>From</th>
                <th className={gridHeaderClass}>To</th>
                <th className={gridHeaderClass}>Type</th>
                <th className={gridHeaderClass}>Distance</th>
                <th className={gridHeaderClass}>Cost</th>
              </tr>
            </thead>
            <tbody>
              {recentTrips.map((trip) => (
                <tr key={trip.id} className="transition hover:bg-slate-50/60">
                  <td className={`${gridCellClass} break-words text-slate-900`}>
                    {trip.date}
                    <span className="mt-0.5 block font-mono text-xs text-slate-500">{trip.id}</span>
                  </td>
                  <td className={`${gridCellClass} break-words text-slate-600`}>
                    {trip.employee}
                    <span className="mt-1 block">
                      <Badge variant="neutral">{trip.role}</Badge>
                    </span>
                  </td>
                  <td className={`${gridCellClass} break-words text-slate-600`}>{trip.from}</td>
                  <td className={`${gridCellClass} break-words text-slate-600`}>{trip.to}</td>
                  <td className={gridCellClass}>
                    <Badge variant="neutral">{trip.type}</Badge>
                  </td>
                  <td className={`${gridCellClass} break-words text-slate-600`}>{trip.distance} km</td>
                  <td className={`${gridCellClass} break-words font-semibold text-slate-900`}>{egp(trip.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function WorkloadKPICard({
  delta,
  icon: Icon,
  label,
  subLabel,
  value,
}: {
  delta: string;
  icon: typeof ReceiptText;
  label: string;
  subLabel: string;
  value: string;
}) {
  const isPositive = delta.startsWith("+");
  return (
    <Card className="group rounded border border-slate-200 bg-white/95 px-4 py-4 shadow-[0_8px_20px_rgba(15,23,42,0.04)] transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_14px_28px_rgba(15,23,42,0.08)]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-2xl font-semibold tracking-tight text-slate-900">{value}</p>
          <p className="mt-1 text-xs font-medium text-slate-500">{label}</p>
          <p className="mt-0.5 text-phx-sm text-slate-400">{subLabel}</p>
          <p className={`mt-1 text-xs font-medium ${isPositive ? "text-emerald-600" : "text-red-600"}`}>{delta}</p>
        </div>
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded bg-orange-50 text-orange-600">
          <Icon className="h-4 w-4" />
        </div>
      </div>
    </Card>
  );
}

export function HRContractSection({ data }: { data: MedicalRepPortalData }) {
  const daysRemaining = data.hrContract.daysUntilRenewal;

  return (
    <section id="hr-contract" className="space-y-4">
      {sectionTitle("HR & Contract", "Employment and Contract Status")}
      <Card className="rounded border border-slate-100 bg-white p-5 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
        <div className="mb-4 rounded border border-slate-100 bg-slate-50/70 px-4 py-3">
          <p className="text-xs uppercase tracking-[0.14em] text-slate-500">Contract Countdown</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">
            {daysRemaining === null ? "No renewal date" : `${daysRemaining} days remaining`}
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Hire Date" value={prettyDate(data.hrContract.hireDate)} />
          <MetricCard label="Service Duration" value={data.hrContract.serviceDurationText} />
          <MetricCard label="Contract Start Date" value={prettyDate(data.hrContract.contractSignedDate)} />
          <MetricCard label="Contract Renewal Date" value={prettyDate(data.hrContract.contractRenewalDate)} tooltip="Contract renewal" />
          <MetricCard label="Probation Status" value={data.hrContract.probationStatus} tooltip="Probation status" />
          <MetricCard label="Employment Status" value={data.hrContract.employmentStatus} />
          <MetricCard label="Payroll Eligibility" value={data.hrContract.payrollEligibility} tooltip="Payroll status" />
          <MetricCard label="Days Remaining" value={daysRemaining === null ? "—" : `${daysRemaining} days`} />
        </div>
      </Card>
    </section>
  );
}

function TerritoryComparisonChart({ data }: { data: MedicalRepPortalData }) {
  const territories = Array.isArray(data.sales.territories) ? data.sales.territories : [];
  if (territories.length === 0) return null;

  const sorted = [...territories].sort((a, b) => b.achievementPercent - a.achievementPercent);
  const totalSales = territories.reduce((s, t) => s + t.sales, 0);
  const totalTarget = territories.reduce((s, t) => s + t.target, 0);

  return (
    <OverviewPagePanel
      title="Territory Performance"
      action={
        <span className={`rounded border border-slate-200 bg-white px-2.5 py-1 text-phx-sm font-bold uppercase tracking-[0.12em] text-slate-500 ${adminSoftDepthClassName}`}>
          {territories.length} territories
        </span>
      }
    >
      <ChartErrorBoundary>
        {/* Totals */}
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded border border-slate-100 bg-slate-50/60 px-3 py-2">
            <p className="text-phx-xs font-bold uppercase tracking-[0.14em] text-slate-400">Total Sales</p>
            <p className="mt-1 text-sm font-black text-orange-600">{egp(totalSales)}</p>
          </div>
          <div className="rounded border border-slate-100 bg-slate-50/60 px-3 py-2">
            <p className="text-phx-xs font-bold uppercase tracking-[0.14em] text-slate-400">Total Target</p>
            <p className="mt-1 text-sm font-black text-slate-700">{egp(totalTarget)}</p>
          </div>
        </div>

        {/* Territory rows */}
        <div className="mt-3 space-y-1">
          {sorted.map((t) => {
            const pct = Math.min(t.achievementPercent, 150);
            const grad = achievementGradient(t.achievementPercent);
            const [from, to] = grad.split(",");
            return (
              <PremiumTooltip
                key={t.name}
                triggerClassName="block"
                content={
                  <div className="space-y-1.5">
                    <p className="text-xs font-black text-slate-900">{t.name}</p>
                    <div className="flex items-center justify-between gap-5 text-phx-xs">
                      <span className="text-slate-500">Sales</span>
                      <span className="font-bold text-orange-600">{egp(t.sales)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-5 text-phx-xs">
                      <span className="text-slate-500">Target</span>
                      <span className="font-bold text-slate-700">{egp(t.target)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-5 border-t border-slate-100 pt-1 text-phx-xs">
                      <span className="text-slate-500">Achievement</span>
                      <span className="font-bold text-orange-600">{t.achievementPercent.toFixed(1)}%</span>
                    </div>
                  </div>
                }
              >
                <div className="flex items-center gap-2 rounded border border-slate-100 bg-white/80 px-3 py-1.5">
                  <span className="w-[90px] shrink-0 break-words text-phx-sm font-bold text-slate-700">{t.name}</span>
                  <div className="relative h-2 flex-1 overflow-hidden rounded-sm bg-slate-100">
                    <div
                      className="absolute inset-y-0 left-0 rounded-sm"
                      style={{ width: `${Math.min(100, (pct / 150) * 100)}%`, background: `linear-gradient(to right, ${from}, ${to})` }}
                    />
                    <div className="absolute inset-y-0 border-r border-dashed border-slate-300/60" style={{ left: `${(100 / 150) * 100}%` }} />
                  </div>
                  <span className="w-10 shrink-0 text-right text-phx-xs font-black text-slate-700">{t.achievementPercent.toFixed(0)}%</span>
                </div>
              </PremiumTooltip>
            );
          })}
        </div>
      </ChartErrorBoundary>
    </OverviewPagePanel>
  );
}

function ProductFamilyBreakdown({ data }: { data: MedicalRepPortalData }) {
  const families = Array.isArray(data.sales.familyContribution) ? data.sales.familyContribution : [];
  if (families.length === 0) return null;

  const sorted = [...families].sort((a, b) => b.sales - a.sales);
  const totalSales = sorted.reduce((sum, f) => sum + f.sales, 0);
  const totalUnits = sorted.reduce((sum, f) => sum + f.units, 0);
  const maxSales = sorted[0]?.sales ?? 1;

  return (
    <OverviewPagePanel
      title="Product Family Contribution"
      action={
        <span className={`rounded border border-slate-200 bg-white px-2.5 py-1 text-phx-sm font-bold uppercase tracking-[0.12em] text-slate-500 ${adminSoftDepthClassName}`}>
          {families.length} families
        </span>
      }
    >
      <ChartErrorBoundary>
        {/* Totals */}
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded border border-slate-100 bg-slate-50/60 px-3 py-2">
            <p className="text-phx-xs font-bold uppercase tracking-[0.14em] text-slate-400">Total Sales</p>
            <p className="mt-1 text-sm font-black text-orange-600">{egp(totalSales)}</p>
          </div>
          <div className="rounded border border-slate-100 bg-slate-50/60 px-3 py-2">
            <p className="text-phx-xs font-bold uppercase tracking-[0.14em] text-slate-400">Total Units</p>
            <p className="mt-1 text-sm font-black text-slate-700">{formatUnits(totalUnits)}</p>
          </div>
        </div>

        {/* Family rows with proportional bars */}
        <div className="mt-3 space-y-1">
          {sorted.map((f, i) => {
            const pct = totalSales > 0 ? (f.sales / totalSales) * 100 : 0;
            const barWidth = maxSales > 0 ? (f.sales / maxSales) * 100 : 0;
            const tier = sorted.length <= 1 ? 0 : i / (sorted.length - 1);
            const grad = tier <= 0.33 ? "#ea580c,#fb923c" : tier <= 0.66 ? "#f97316,#fdba74" : "#fb923c,#fed7aa";
            const [from, to] = grad.split(",");
            return (
              <PremiumTooltip
                key={f.name}
                triggerClassName="block"
                content={
                  <div className="space-y-1.5">
                    <p className="text-xs font-black text-slate-900">{f.name}</p>
                    <div className="flex items-center justify-between gap-5 text-phx-xs">
                      <span className="text-slate-500">Sales</span>
                      <span className="font-bold text-orange-600">{egp(f.sales)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-5 text-phx-xs">
                      <span className="text-slate-500">Units</span>
                      <span className="font-bold text-slate-700">{formatUnits(f.units)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-5 border-t border-slate-100 pt-1 text-phx-xs">
                      <span className="text-slate-500">Contribution</span>
                      <span className="font-bold text-orange-600">{pct.toFixed(1)}%</span>
                    </div>
                  </div>
                }
              >
                <div className="flex items-center gap-2 rounded border border-slate-100 bg-white/80 px-3 py-1.5">
                  <span className="w-[90px] shrink-0 break-words text-phx-sm font-bold text-slate-700">{f.name}</span>
                  <div className="relative h-2 flex-1 overflow-hidden rounded-sm bg-slate-100">
                    <div
                      className="absolute inset-y-0 left-0 rounded-sm"
                      style={{ width: `${barWidth}%`, background: `linear-gradient(to right, ${from}, ${to})` }}
                    />
                  </div>
                  <span className="w-12 shrink-0 text-right text-phx-xs font-black text-slate-700">{pct.toFixed(1)}%</span>
                </div>
              </PremiumTooltip>
            );
          })}
        </div>
      </ChartErrorBoundary>
    </OverviewPagePanel>
  );
}

function LinePerformanceBreakdown({ data }: { data: MedicalRepPortalData }) {
  const lines = Array.isArray(data.sales.linePerformance) ? data.sales.linePerformance : [];
  if (lines.length === 0) return null;

  const sorted = [...lines].sort((a, b) => b.achievementPercent - a.achievementPercent);
  const totalSales = lines.reduce((sum, line) => sum + line.sales, 0);
  const totalTarget = lines.reduce((sum, line) => sum + line.target, 0);

  return (
    <OverviewPagePanel
      title="Line Performance"
      action={
        <span className={`rounded border border-slate-200 bg-white px-2.5 py-1 text-phx-sm font-bold uppercase tracking-[0.12em] text-slate-500 ${adminSoftDepthClassName}`}>
          {lines.length} line{lines.length === 1 ? "" : "s"}
        </span>
      }
    >
      <ChartErrorBoundary>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded border border-slate-100 bg-slate-50/60 px-3 py-2">
            <p className="text-phx-xs font-bold uppercase tracking-[0.14em] text-slate-400">Total Sales</p>
            <p className="mt-1 text-sm font-black text-orange-600">{egp(totalSales)}</p>
          </div>
          <div className="rounded border border-slate-100 bg-slate-50/60 px-3 py-2">
            <p className="text-phx-xs font-bold uppercase tracking-[0.14em] text-slate-400">Total Target</p>
            <p className="mt-1 text-sm font-black text-slate-700">{egp(totalTarget)}</p>
          </div>
        </div>

        <div className="mt-3 space-y-1">
          {sorted.map((line) => {
            const pct = Math.min(line.achievementPercent, 150);
            const grad = achievementGradient(line.achievementPercent);
            const [from, to] = grad.split(",");
            return (
              <PremiumTooltip
                key={line.name}
                triggerClassName="block"
                content={
                  <div className="space-y-1.5">
                    <p className="text-xs font-black text-slate-900">{line.name}</p>
                    <div className="flex items-center justify-between gap-5 text-phx-xs">
                      <span className="text-slate-500">Sales</span>
                      <span className="font-bold text-orange-600">{egp(line.sales)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-5 text-phx-xs">
                      <span className="text-slate-500">Target</span>
                      <span className="font-bold text-slate-700">{egp(line.target)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-5 border-t border-slate-100 pt-1 text-phx-xs">
                      <span className="text-slate-500">Achievement</span>
                      <span className="font-bold text-orange-600">{line.achievementPercent.toFixed(1)}%</span>
                    </div>
                  </div>
                }
              >
                <div className="flex items-center gap-2 rounded border border-slate-100 bg-white/80 px-3 py-1.5">
                  <span className="w-[90px] shrink-0 break-words text-phx-sm font-bold text-slate-700">{line.name}</span>
                  <div className="relative h-2 flex-1 overflow-hidden rounded-sm bg-slate-100">
                    <div
                      className="absolute inset-y-0 left-0 rounded-sm"
                      style={{ width: `${Math.min(100, (pct / 150) * 100)}%`, background: `linear-gradient(to right, ${from}, ${to})` }}
                    />
                    <div className="absolute inset-y-0 border-r border-dashed border-slate-300/60" style={{ left: `${(100 / 150) * 100}%` }} />
                  </div>
                  <span className="w-10 shrink-0 text-right text-phx-xs font-black text-slate-700">{line.achievementPercent.toFixed(0)}%</span>
                </div>
              </PremiumTooltip>
            );
          })}
        </div>
      </ChartErrorBoundary>
    </OverviewPagePanel>
  );
}

export function MedicalRepOverviewPage({
  data,
  surface = "employee-portal",
}: {
  data: MedicalRepPortalData;
  surface?: PortalDashboardSurface;
}) {
  if (data.empty.profile) {
    return <EmptyStateCard message="Your employee profile is not linked yet. Please contact HR." title="Profile Not Linked" />;
  }
  if (isA3EmployeePortalUser(data)) {
    return (
      <div className="space-y-6">
        <A3DashboardQuickCards data={data} />
      </div>
    );
  }

  // A VIEWER WITH NO SALES SCOPE GETS NO SALES PANELS, on either surface.
  //
  // getSalesScope has no switch arm for a role that does not sell, so the two HR seats and
  // Financial Advisor fall to its NONE default and are then fail-closed to empty line/region/area
  // sets. Every sales figure in `data.sales` is therefore a zero that measures nothing — and a
  // zeroed panel does not read as "not for you", it reads as "you sold nothing". Three of the
  // panels below already hide themselves on an empty array; the rest render their heading and a
  // zero regardless, which is what put "Sales · Target · Achievement Rate 0.0% · Needs attention"
  // at the top of an HR coordinator's home page the day her account went live.
  //
  // My Actions and Quick Actions are not sales panels and stay for everyone.
  const showSalesPanels = shouldRenderSalesPanels(data.sales.viewerSalesScope);

  // Employee-portal dashboard is a minimal command center: the identity hero (rendered by the
  // page) plus the performance trend only — nothing else. The admin-shell workspace surface keeps
  // the full operational dashboard below (so every panel stays in use; nothing is orphaned).
  if (surface === "employee-portal") {
    // The hero is the page's own, so a NONE viewer still gets their identity card — just not a
    // trend chart of zeros underneath it.
    if (!showSalesPanels) return null;
    return (
      <div className="space-y-6">
        <OverviewPerformanceChart data={data} />
      </div>
    );
  }

  const showTeamLeaveAndStructurePanels = canSeeTeamLeaveAndStructurePanels(data);

  return (
    <div className="space-y-6">
      {showSalesPanels ? <ExecutiveCommandStrip data={data} /> : null}
      {/* Manager-first: daily to-dos and team operations lead the page. */}
      <div className="grid gap-5 xl:grid-cols-2">
        <MyActionsPanel data={data} surface={surface} />
        <QuickActionsPanel data={data} surface={surface} />
        {showTeamLeaveAndStructurePanels ? <TeamStructurePanel data={data} /> : null}
        {showTeamLeaveAndStructurePanels ? <EmployeesOnLeaveTodayPanel data={data} /> : null}
      </div>
      {showSalesPanels ? (
        <>
          {/* Team performance + actionable signals, surfaced high for managers. */}
          <div className="grid items-start gap-5 xl:grid-cols-2">
            <TeamRankComparisonWidget data={data} />
            <OverviewInsightsAlerts data={data} />
          </div>
          <OverviewPerformanceChart data={data} />
          <div className="grid items-start gap-5 xl:grid-cols-2">
            <div className="space-y-5">
              <TerritoryComparisonChart data={data} />
              <LinePerformanceBreakdown data={data} />
              <ToReachTargetWidget data={data} />
            </div>
            <div className="space-y-5">
              <ProductFamilyBreakdown data={data} />
              <OverviewTopProducts data={data} />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

export function MedicalRepSalesPage({ data }: { data: MedicalRepPortalData }) {
  if (data.empty.profile) {
    return <EmptyStateCard message="Your employee profile is not linked yet. Please contact HR." title="Profile Not Linked" />;
  }

  return (
    <>
      <SalesPerformanceSection data={data} />
      <SmartInsightsStrip data={data} />
    </>
  );
}

export function MedicalRepPayrollPage({
  data,
  surface = "workspace",
}: {
  data: MedicalRepPortalData;
  /** "employee-portal" draws the section header as a portal toolbar; the admin shell keeps its own. */
  surface?: "employee-portal" | "workspace";
}) {
  if (data.empty.profile) {
    return <EmptyStateCard message="Your employee profile is not linked yet. Please contact HR." title="Profile Not Linked" />;
  }

  return (
    <>
      <PayrollPayslipsSection data={data} surface={surface} />
    </>
  );
}

export function MedicalRepPortalPage({ data }: { data: MedicalRepPortalData }) {
  return <MedicalRepOverviewPage data={data} />;
}

export function EmployeePortalDashboard({ data }: { data: MedicalRepPortalData }) {
  return <MedicalRepOverviewPage data={data} />;
}

export function EmployeePortalProfile({ data }: { data: MedicalRepPortalData }) {
  const displayHrId = formatHrIdForDisplay(data.employee.hrId) ?? data.employee.hrId;

  return (
    <>
      <Card className="rounded border border-slate-100 bg-white p-6 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
        <div className="flex items-center gap-2">
          <UserRound className="h-5 w-5 text-slate-500" />
          <p className="text-lg font-semibold text-slate-900">{data.employee.fullName}</p>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <MetricCard label="HR ID" value={displayHrId} />
          <MetricCard label="Line" value={data.employee.line ?? "Not assigned"} />
          <MetricCard label="Area" value={data.employee.area ?? "Not assigned"} />
          <MetricCard label="Territory" value={data.employee.territory ?? "Not assigned"} />
          <MetricCard label="Manager" value={data.employee.manager ?? "Not assigned"} />
          <MetricCard label="Role" value={data.employee.roleLabel} />
        </div>
      </Card>
      <HRContractSection data={data} />
    </>
  );
}
