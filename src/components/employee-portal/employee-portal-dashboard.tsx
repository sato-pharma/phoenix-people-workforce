"use client";

import Link from "next/link";
import type { ReactElement, ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";

const AreaChart  = dynamic(() => import("recharts").then((m) => ({ default: m.AreaChart })),  { ssr: false });
const PieChart   = dynamic(() => import("recharts").then((m) => ({ default: m.PieChart })),   { ssr: false });
const Area       = dynamic(() => import("recharts").then((m) => ({ default: m.Area })),       { ssr: false });
const CartesianGrid = dynamic(() => import("recharts").then((m) => ({ default: m.CartesianGrid })), { ssr: false });
const Cell       = dynamic(() => import("recharts").then((m) => ({ default: m.Cell })),       { ssr: false });
const Pie        = dynamic(() => import("recharts").then((m) => ({ default: m.Pie })),        { ssr: false });
const Tooltip    = dynamic(() => import("recharts").then((m) => ({ default: m.Tooltip })),    { ssr: false });
const XAxis      = dynamic(() => import("recharts").then((m) => ({ default: m.XAxis })),      { ssr: false });
const YAxis      = dynamic(() => import("recharts").then((m) => ({ default: m.YAxis })),      { ssr: false });
const Legend     = dynamic(() => import("recharts").then((m) => ({ default: m.Legend })),     { ssr: false });
import { SafeResponsiveContainer } from "@/components/charts/safe-responsive-container";
import {
  Activity,
  ArrowUpRight,
  BriefcaseBusiness,
  Calculator,
  CalendarClock,
  CalendarDays,
  Car,
  ClipboardCheck,
  CircleDollarSign,
  Eye,
  EyeOff,
  HelpCircle,
  Info,
  MapPin,
  Megaphone,
  MinusCircle,
  ReceiptText,
  RefreshCw,
  Send,
  ShieldCheck,
  Target,
  TrendingUp,
  Trophy,
  Upload,
  UserRound,
  Users,
  Wallet,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PremiumTooltip } from "@/components/ui/premium-tooltip";
import {
  PayrollPayslipsSection,
} from "@/components/employee-portal/dashboard/payroll-payslips-section";
import { SalesPerformanceSection } from "@/components/employee-portal/dashboard/sales-performance-section";
import { formatDateOnly } from "@/lib/date-only";
import { calculateIncentive2026 } from "@/lib/incentives/scheme-2026";
import { toPeriodLabel } from "@/lib/employee-portal/period";
import type { EmployeePortalShellData, MedicalRepPortalData } from "@/lib/employee-portal/service";
import { formatHrIdForDisplay } from "@/lib/hr-id";

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
type MetricIcon = typeof Activity;
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

const maskedMoneyValue = "******";

function prettyDate(value: string | null) {
  return formatDateOnly(value, "en-GB", { day: "2-digit", month: "short", year: "numeric" }, "Not available");
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

function periodMonthLabel(value: string) {
  const [yearText, monthText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!year || !month) return value;
  return new Intl.DateTimeFormat("en", { month: "short" }).format(
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
    <div className="inline-flex rounded-xl border border-slate-200 bg-white/80 p-1 shadow-[0_6px_18px_rgba(15,23,42,0.05)] ring-1 ring-white/80">
      {(["sales", "units"] as const).map((option) => {
        const active = metric === option;
        return (
          <button
            className={active
              ? "rounded-lg bg-slate-950 px-3 py-1.5 text-xs font-bold text-white shadow-sm"
              : "rounded-lg px-3 py-1.5 text-xs font-bold text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"}
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
      soft: "bg-amber-100/70 text-amber-800",
      value: "text-amber-700",
    },
    blue: {
      border: "border-sky-200 border-t-sky-500 hover:border-sky-300",
      card: "border-slate-200 from-white to-slate-50",
      icon: "bg-sky-50 text-sky-600 ring-sky-100",
      line: "bg-sky-500",
      soft: "bg-sky-100/70 text-sky-800",
      value: "text-sky-700",
    },
    green: {
      border: "border-emerald-200 border-t-emerald-500 hover:border-emerald-300",
      card: "border-emerald-200 from-emerald-50 to-white ring-1 ring-emerald-200/70",
      icon: "bg-emerald-50 text-emerald-600 ring-emerald-100",
      line: "bg-emerald-500",
      soft: "bg-emerald-100/70 text-emerald-800",
      value: "text-emerald-700",
    },
    orange: {
      border: "border-orange-200 border-t-orange-500 hover:border-orange-300",
      card: "border-orange-200 from-orange-50 to-white ring-1 ring-orange-200/70",
      icon: "bg-orange-50 text-orange-600 ring-orange-100",
      line: "bg-orange-500",
      soft: "bg-orange-100/70 text-orange-800",
      value: "text-orange-700",
    },
    purple: {
      border: "border-violet-200 border-t-violet-500 hover:border-violet-300",
      card: "border-violet-200 from-violet-50 to-white ring-1 ring-violet-200/70",
      icon: "bg-violet-50 text-violet-600 ring-violet-100",
      line: "bg-violet-500",
      soft: "bg-violet-100/70 text-violet-800",
      value: "text-violet-700",
    },
  } satisfies Record<MetricAccent, Record<string, string>>;

  return tones[accent];
}

function chartTooltipStyle() {
  return {
    backdropFilter: "blur(18px)",
    background: "rgba(255,255,255,0.96)",
    border: "1px solid rgba(226,232,240,0.9)",
    borderRadius: 14,
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
    <SafeResponsiveContainer
      className={`${className} min-w-0 overflow-hidden`}
      minHeight={height}
      style={{ height }}
    >
      {children}
    </SafeResponsiveContainer>
  );
}

function computeGapToTarget(sales: number, target: number) {
  return Math.max(0, target - sales);
}

function shortInsight(text: string) {
  const trimmed = text.trim();
  if (trimmed.length <= 82) return trimmed;
  return `${trimmed.slice(0, 79).trimEnd()}...`;
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
      <div className="h-8 w-[3px] rounded-full bg-gradient-to-b from-orange-400 to-orange-600" />
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-orange-500">{kicker}</p>
        <h2 className="mt-0.5 text-[22px] font-semibold leading-tight tracking-tight text-slate-900">{title}</h2>
      </div>
    </div>
  );
}

export function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-[300px] animate-pulse rounded-3xl border border-slate-200 bg-slate-100/80" />
      <div className="h-[420px] animate-pulse rounded-3xl border border-slate-200 bg-slate-100/80" />
      <div className="h-[120px] animate-pulse rounded-3xl border border-slate-200 bg-slate-100/80" />
    </div>
  );
}

export function EmptyStateCard({
  message,
  title,
}: {
  message: string;
  title: string;
}) {
  return (
    <Card className="rounded-3xl border border-slate-200/90 bg-gradient-to-br from-white to-slate-50/50 p-10 text-center shadow-[0_12px_34px_rgba(15,23,42,0.05)]">
      <p className="mt-4 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">{title}</p>
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
      className="group relative overflow-hidden rounded-xl border border-slate-200/90 bg-gradient-to-br from-white to-slate-50/50 px-4 py-3 shadow-[0_4px_14px_rgba(15,23,42,0.04)] transition-all duration-160 ease-out hover:-translate-y-px hover:shadow-md hover:border-slate-300"
      title={tooltip}
    >
      <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">
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
    <div className="group relative overflow-hidden rounded-xl border border-slate-200/90 bg-gradient-to-br from-white to-slate-50/50 p-4 shadow-[0_4px_16px_rgba(15,23,42,0.04)] transition-all duration-160 ease-out hover:-translate-y-px hover:shadow-md hover:border-slate-300">
      <div className="flex items-center gap-2 text-slate-700">
        <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">{label}</p>
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
    <div className="flex h-full flex-col justify-center rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_18px_36px_rgba(15,23,42,0.06)]">
      <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500">Sales Achievement</p>
      <div className="mt-4 flex flex-col items-center">
        <div className="relative flex h-[280px] w-[280px] items-center justify-center rounded-full" style={circleStyle} title="Sales achievement">
          <div className="flex h-[236px] w-[236px] flex-col items-center justify-center rounded-full bg-white shadow-[inset_0_0_0_1px_rgba(15,23,42,0.06)]">
            <p className="text-[68px] font-semibold leading-none text-slate-950">{clamped}%</p>
            <p className="mt-1 text-[12px] font-medium uppercase tracking-[0.1em] text-slate-500">of target</p>
          </div>
        </div>
        <p className="mt-5 text-3xl font-semibold text-slate-900">{egp(salesValue)}</p>
        <p className="mt-1 text-sm text-slate-500">of {egp(targetValue)} target</p>
        <p className={`mt-2 text-sm font-medium ${growthNegative ? "text-rose-600" : "text-emerald-600"}`}>
          {growthText}
        </p>
        <div className="mt-3 rounded-full border border-slate-200 bg-slate-50 px-4 py-1.5 text-sm text-slate-700">
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
    <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_22px_48px_rgba(15,23,42,0.06)] lg:p-8">
      <div className="mb-6 rounded-[32px] border border-slate-200 bg-white px-6 py-6 shadow-[0_8px_26px_rgba(15,23,42,0.05)] lg:px-8 lg:py-7">
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

              <span className={`inline-flex items-center gap-2.5 rounded-full border px-5 py-1.5 text-[22px] font-medium ${statusPillClass}`}>
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
      <div className="hidden mb-5 rounded-2xl border border-slate-200 bg-slate-50/60 px-4 py-3">
        <p className="text-base font-semibold text-slate-900">
          {employee.fullName} <span className="text-slate-500">·</span> {employee.roleLabel}
        </p>
        <p className="mt-1 text-sm text-slate-600">
          {employee.line ?? "Unassigned Line"} Line <span className="text-slate-400">·</span>{" "}
          {employee.territory ?? "Unassigned Territory"} Territory <span className="text-slate-400">·</span>{" "}
          Reports to {employee.manager ?? "Unassigned Manager"}
        </p>
        <p className="mt-1 text-sm text-slate-600">
          HR ID: {displayHrId} <span className="text-slate-400">·</span>{" "}
          <span className="inline-flex items-center gap-1">
            {employee.status}
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
          </span>{" "}
          <span className="text-slate-400">·</span> Hired {hiredLabel}
        </p>
      </div>
      <div className="grid gap-6 xl:grid-cols-[0.82fr_1.38fr_0.85fr]">
        <div className="space-y-4 xl:pr-2">
          <div className="flex items-start gap-3">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100 text-xl font-semibold text-slate-700">
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

          <div className="space-y-2 rounded-2xl border border-slate-100 bg-slate-50/70 p-4">
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
            value={payroll.latestBatchStatus ? payroll.latestBatchStatus.replace(/_/g, " ") : "No payroll run"}
          />
          <SmartInsightCard
            label="Rank in Team"
            value={sales.rankInTeam ? `#${sales.rankInTeam.position} / ${sales.rankInTeam.total}` : "Not available"}
          />
          <SmartInsightCard
            label="Top Product"
            value={sales.topProduct ?? "No product data"}
          />
          <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-[0_4px_16px_rgba(15,23,42,0.04)]">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-slate-500">Trend</p>
              <p className={`text-sm font-medium ${growthNegative ? "text-rose-600" : "text-emerald-600"}`}>
                {sales.growthVsLastMonthPercent === null ? "N/A" : `${sales.growthVsLastMonthPercent.toFixed(1)}%`}
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
            <div key={insight} className="group relative overflow-hidden rounded-xl border border-slate-200/90 bg-gradient-to-br from-white to-slate-50/50 px-4 py-3 shadow-[0_4px_14px_rgba(15,23,42,0.04)] transition-all duration-160 ease-out hover:-translate-y-px hover:shadow-md hover:border-slate-300">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-slate-700">
                  <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">Insight</span>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] ${meta.classes}`}>{meta.badge}</span>
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

function resolveExpenseActionHref(data: MedicalRepPortalData) {
  return isRole(data, "medical rep", "medical representative")
    ? "/employee-portals/expenses"
    : "/employee-portals/submit-expense";
}

function resolveTripsOverviewHref(data: MedicalRepPortalData) {
  return isRole(data, "medical rep", "medical representative")
    ? "/employee-portals/expenses"
    : "/employee-portals/expense-dashboard";
}

function canUsePendingApprovals(data: MedicalRepPortalData) {
  if (data.workforce.pendingApprovals > 0) return true;

  const role = normalizedRoleLabel(data);
  return [
    "district manager",
    "district sales manager",
    "dsm",
    "regional manager",
    "regional sales manager",
    "rsm",
    "national sales manager",
    "nsm",
    "finance manager",
    "ceo",
    "super admin",
  ].some((token) => role.includes(token)) || role === "manager";
}

function ExecutiveCommandStrip({ data }: { data: MedicalRepPortalData }) {
  const achievement = Number.isFinite(data.sales.overviewAchievementPercent)
    ? data.sales.overviewAchievementPercent
    : 0;
  const gap = Math.max(0, data.sales.overviewTarget - data.sales.overviewSales);
  const performanceState = achievement >= 100
    ? "Ahead of plan"
    : achievement >= 90
      ? "Within control band"
      : "Needs attention";
  const signals = [
    {
      accent: "green" as const,
      icon: CircleDollarSign,
      label: "Sales",
      note: `Target ${egp(data.sales.overviewTarget)}`,
      progress: achievement,
      value: egp(data.sales.overviewSales),
    },
    {
      accent: "orange" as const,
      icon: Target,
      label: "Target",
      progress: achievement,
      note: "Approved sales target",
      value: egp(data.sales.overviewTarget),
    },
    {
      accent: "blue" as const,
      icon: Trophy,
      label: "Achievement Rate",
      note: "All-time sales versus target",
      progress: achievement,
      value: `${achievement.toFixed(1)}%`,
    },
    {
      accent: "amber" as const,
      icon: MinusCircle,
      label: "Gap to Target",
      note: performanceState,
      progress: achievement,
      value: egp(gap),
    },
  ] satisfies Array<{
    accent: MetricAccent;
    icon: MetricIcon;
    label: string;
    note: string;
    progress: number;
    value: string;
  }>;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3 px-1">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-orange-700">Command Metrics</p>
          <h2 className="mt-1 text-lg font-black tracking-[-0.02em] text-slate-950">Key operating signals</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="rounded-full border border-slate-200 bg-white/80 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-700 shadow-sm backdrop-blur-sm">{data.workforce.scopeLabel}</span>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {signals.map((signal) => {
          const tone = metricTone(signal.accent);
          const Icon = signal.icon;
          return (
            <Card
              className={`group relative flex min-h-[124px] min-w-0 flex-col overflow-hidden rounded-lg border bg-gradient-to-br px-4 py-4 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md ${tone.card}`}
              key={signal.label}
            >
              <div className={`absolute inset-x-0 top-0 h-1 ${tone.line} opacity-90 transition-all duration-300 group-hover:h-1.5`} />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.92),transparent_42%)] opacity-80" />
              <div className="relative flex flex-1 flex-col justify-between gap-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="whitespace-nowrap text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">{signal.label}</p>
                    </div>
                    <p className={`mt-2 max-w-full whitespace-nowrap text-2xl font-black leading-none tracking-[-0.03em] tabular-nums ${tone.value}`}>
                      {signal.value}
                    </p>
                    <p className="mt-1.5 line-clamp-2 text-[11px] font-medium leading-snug text-slate-500">{signal.note}</p>
                  </div>
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ring-1 ${tone.icon}`}>
                    <Icon className="h-5 w-5" />
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <div className={`${tone.line} h-full rounded-full transition-[width] duration-500`} style={{ width: `${Math.max(8, Math.min(100, achievement))}%` }} />
                  </div>
                  <div className="flex items-center justify-between text-[10px] font-medium text-slate-400">
                    <span>Live signal</span>
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

function IncentiveStatusCard({
  data,
  isSalaryVisible,
}: {
  data: MedicalRepPortalData;
  isSalaryVisible: boolean;
}) {
  const achievementPercent = data.sales.overviewAchievementPercent;
  const shortfallPercent = Math.max(0, 90 - achievementPercent);
  const calculation = calculateIncentive2026({
    basicSalary: data.payroll.basicSalary,
    baseSalary: data.payroll.baseSalary,
    extraCostOfLiving: data.payroll.extraCostOfLiving,
    fuelAllowance: data.payroll.fuelAllowance,
    netSalary: data.payroll.netSalary,
    grossSalary: data.payroll.grossSalary,
    socialInsurance: data.payroll.socialInsurance,
    taxes: data.payroll.incomeTax,
    achievementPercent,
  });

  const isEligible = achievementPercent >= 90;

  return (
    <Card className="group rounded-2xl border border-slate-200 bg-white/95 px-5 py-5 shadow-[0_8px_20px_rgba(15,23,42,0.04)] transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_14px_28px_rgba(15,23,42,0.08)]">
      <div className="mb-4 h-0.5 w-8 rounded-full bg-amber-200 transition group-hover:w-12 group-hover:bg-amber-500" />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-2xl leading-tight font-semibold tracking-tight text-slate-900">
            {isEligible ? (isSalaryVisible ? egp(calculation.payoutAmount) : maskedMoneyValue) : "Below Threshold"}
          </p>
          <p className="mt-1.5 text-xs font-medium text-slate-500">Incentive Policy</p>
          <p className="mt-1 text-xs text-slate-500">
            {isEligible 
              ? `Estimated payout (${calculation.payoutPercentage.toFixed(1)}%)`
              : `Missing ${shortfallPercent.toFixed(1)}% to unlock 90% threshold`}
          </p>
          <p className="mt-2 text-[11px] text-slate-400">
            Based on Basic Salary x 2 months per semester.
          </p>
        </div>
        <div className={`mt-0.5 flex h-9 w-9 items-center justify-center rounded-xl transition-colors ${isEligible ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
          <Wallet className="h-4 w-4" />
        </div>
      </div>
      <div className="mt-4 flex items-center gap-2">
        <span className={`rounded-full px-2 py-1 text-[11px] font-medium ${isEligible ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
          {isEligible ? 'In the Money' : 'Threshold Pending'}
        </span>
        {isEligible && (
          <span className="text-[10px] text-slate-400">Semester Payout</span>
        )}
      </div>
    </Card>
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
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-600 focus-visible:outline-2 focus-visible:outline-orange-500 focus-visible:outline-offset-1"
      onClick={onToggleSalaryVisibility}
      title={label}
      type="button"
    >
      {isSalaryVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
    </button>
  );
}

function IncentiveCalculatorWidget({
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
  const calculatedBaseSalary = data.payroll.baseSalary;
  const calculatedNetSalary = salaryReference.netSalary;
  const calculatedBasicSalary = salaryReference.basicSalary;
  const simNetSalary = calculatedNetSalary;
  const [simAchievement, setSimAchievement] = useState(data.sales.overviewAchievementPercent || 100);

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

  return (
    <OverviewPagePanel 
      title="Incentive Calculator (2026 Scheme)" 
      action={
        <IncentiveSalaryVisibilityToggle
          isSalaryVisible={isSalaryVisible}
          onToggleSalaryVisibility={onToggleSalaryVisibility}
        />
      }
    >
      <div className="space-y-6">
        <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-600">Base Salary</span>
            <span className="font-medium text-slate-900">{isSalaryVisible ? egp(calculatedBaseSalary) : maskedMoneyValue}</span>
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-600">Basic Salary</span>
            <span className="font-medium text-slate-900">{isSalaryVisible ? egp(calculatedBasicSalary) : maskedMoneyValue}</span>
          </div>
        </div>

            <div className="grid gap-4 md:grid-cols-1">
              <div className="space-y-3">
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Achievement %</span>
                  <span className="font-medium text-slate-900">{simAchievement.toFixed(1)}%</span>
                </div>
            <input
              type="range"
              value={simAchievement} 
              onChange={(e) => setSimAchievement(Math.min(150, Number(e.target.value)))} 
              max={150} 
              step={1}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-100 accent-orange-500"
            />
          </div>
        </div>

        <div className="rounded-2xl bg-slate-900 p-4 text-white shadow-lg">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <p className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">Estimated Semester Payout</p>
              <p className="text-2xl font-bold text-emerald-400">{isSalaryVisible ? egp(calc.payoutAmount) : maskedMoneyValue}</p>
            </div>
            <div className="text-right space-y-1">
              <p className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">Payout %</p>
              <p className="text-xl font-bold text-white">{calc.payoutPercentage.toFixed(1)}%</p>
            </div>
          </div>
          
        </div>
      </div>
    </OverviewPagePanel>
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
            <div className="rounded-xl border border-emerald-100 bg-emerald-50/60 px-3 py-2">
              <p className="text-sm font-semibold text-emerald-700">Target Achieved</p>
              <p className="mt-1 text-sm text-emerald-700">Great job! You have reached your target and are now in over-achievement.</p>
            </div>
          </>
        ) : (
          <>
            <div className="rounded-xl border border-orange-100 bg-orange-50/50 px-3 py-2">
              <p className="text-xs text-slate-500">Remaining Gap</p>
              <p className="text-xl font-semibold text-slate-900">{egp(gap)}</p>
            </div>
            <div className="text-sm text-slate-600">
              <span className="font-semibold text-slate-900">{percent.toFixed(1)}%</span> all-period achievement
            </div>
            <div className="h-2 rounded-full bg-slate-100">
              <div className="h-2 rounded-full bg-orange-500" style={{ width: `${percent}%` }} />
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
  return (
    <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
      <div className="mb-4 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-emerald-500/80" />
        <p className="text-lg font-semibold text-slate-900">Incentive Policy</p>
      </div>
      <div className="space-y-3 text-sm text-slate-600">
        <p>The 2026 incentive plan is paid per semester (2 payouts per year).</p>
        <p>Semester target incentive = <span className="font-semibold text-slate-800">Basic Salary × 2 months</span>.</p>
        <p>Performance curve:</p>
        <ul className="ml-5 list-disc space-y-1 text-sm text-slate-600">
          <li>&lt; 90% achievement: 0%</li>
          <li>90% achievement: 50%</li>
          <li>91% to 100%: add +5% per 1%</li>
          <li>101% to 120%: add +1.5% per 1%</li>
          <li>Above 120%: add +3% per 1%, achievement capped at 150% and payout tops at 220%</li>
        </ul>
      </div>
    </Card>
  );
}

export function EmployeePortalIncentivePage({ data }: { data: MedicalRepPortalData }) {
  const [isIncentiveSalaryVisible, setIsIncentiveSalaryVisible] = useState(false);

  if (data.empty.profile) {
    return <EmptyStateCard message="Your employee profile is not linked yet. Please contact HR." title="Profile Not Linked" />;
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-5 xl:grid-cols-[1.2fr_1fr]">
        <IncentiveSchemeDescriptionCard />
        <IncentiveStatusCard data={data} isSalaryVisible={isIncentiveSalaryVisible} />
      </div>
      <IncentiveCalculatorWidget
        data={data}
        isSalaryVisible={isIncentiveSalaryVisible}
        onToggleSalaryVisibility={() => setIsIncentiveSalaryVisible((current) => !current)}
      />
    </div>
  );
}

function TeamRankComparisonWidget({ data }: { data: MedicalRepPortalData }) {
  const rows = data.sales.teamComparison ?? [];
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const comparisonPeriods = Array.from(new Set(data.sales.trend.map((item) => String(item.period).trim()).filter(Boolean))).sort().reverse();
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

  if (rows.length === 0) {
    return (
      <OverviewPagePanel title="Rank in Team Comparison">
        <div className="mb-3">
          <label className="mb-1 inline-block text-xs text-slate-500" htmlFor="team-period-filter">Comparison period</label>
          <select
            id="team-period-filter"
            className="w-full max-w-xs rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-orange-300 focus:outline-none focus:ring-2 focus:ring-orange-100"
            onChange={(event) => handlePeriodChange(event.target.value)}
            value={selectedPeriod}
          >
            <option value="all">All periods</option>
            {comparisonPeriods.map((period) => (
              <option key={period} value={period}>{toPeriodLabel(period)}</option>
            ))}
          </select>
        </div>
        <p className="text-sm text-slate-500">Team comparison is not available for this period.</p>
      </OverviewPagePanel>
    );
  }

  return (
    <OverviewPagePanel
      title="Rank in Team Comparison"
      action={(
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-500" htmlFor="team-period-filter">
            Period
          </label>
          <select
            id="team-period-filter"
            className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 shadow-sm focus:border-orange-300 focus:outline-none focus:ring-2 focus:ring-orange-100"
            onChange={(event) => handlePeriodChange(event.target.value)}
            value={selectedPeriod}
          >
            <option value="all">All periods</option>
            {comparisonPeriods.map((period) => (
              <option key={period} value={period}>{toPeriodLabel(period)}</option>
            ))}
          </select>
        </div>
      )}
    >
      <div className="space-y-2">
        {rows.map((row) => {
          const pct = row.achievementPercent;
          const fillWidth = Math.max(6, Math.min(100, pct));
          const pctClass = pct >= 100 ? "text-emerald-600" : pct >= 80 ? "text-orange-600" : "text-rose-500";
          return (
            <div key={`${row.position}-${row.name}`} className="rounded-2xl border border-slate-100 bg-white px-3 py-3 shadow-[0_8px_20px_rgba(15,23,42,0.035)] transition hover:-translate-y-0.5 hover:border-orange-100 hover:shadow-[0_12px_26px_rgba(15,23,42,0.07)]">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className={`shrink-0 flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-black ${row.position === 1 ? "bg-slate-950 text-white shadow-sm" : "bg-slate-100 text-slate-600 ring-1 ring-slate-200"}`}>
                    {row.position}
                  </span>
                  <span className="truncate text-sm font-bold text-slate-700">{row.name}</span>
                </div>
                <div className="shrink-0 text-right">
                  <p className={`font-mono text-sm font-black tabular-nums ${pctClass}`}>{pct.toFixed(1)}%</p>
                  <p className="whitespace-nowrap font-mono text-[11px] text-slate-400 tabular-nums">{egp(row.sales)}</p>
                </div>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-orange-500 via-amber-400 to-emerald-400"
                  style={{ width: `${fillWidth}%` }}
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
    <Card className="group relative flex h-full flex-col overflow-hidden rounded-[22px] border border-white/80 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] p-4 shadow-[0_14px_34px_rgba(15,23,42,0.06)] ring-1 ring-slate-200/70 transition-all duration-200 hover:-translate-y-0.5 hover:ring-slate-300 hover:shadow-[0_20px_44px_rgba(15,23,42,0.09)] lg:p-5">
      <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-orange-400/80 via-sky-400/70 to-emerald-400/70 opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
      <div className="relative mb-3 flex flex-wrap items-center justify-between gap-3 lg:mb-4">
        <div className="flex items-center gap-2.5">
          <span className="h-2 w-2 rounded-full bg-orange-500 ep-pulse-orange" />
          <p className="text-[17px] font-semibold tracking-normal text-slate-900 lg:text-[18px]">{title}</p>
        </div>
        {action}
      </div>
      <div className="relative min-w-0 flex-1">{children}</div>
    </Card>
  );
}

function OverviewInsightsAlerts({ data }: { data: MedicalRepPortalData }) {
  const topProduct = data.sales.productContribution[0];
  const totalTopSales = data.sales.productContribution.reduce((sum, p) => sum + p.sales, 0);
  const topProductContribution = topProduct && totalTopSales > 0 ? (topProduct.sales / totalTopSales) * 100 : 0;

  const raw = [
    data.sales.overviewAchievementPercent < 100
      ? `You are ${data.sales.overviewAchievementPercent.toFixed(1)}% towards your all-period target.`
      : "You have reached your all-period target.",
    data.sales.growthVsLastMonthPercent !== null
      ? `Sales ${data.sales.growthVsLastMonthPercent < 0 ? "decreased" : "increased"} by ${Math.abs(data.sales.growthVsLastMonthPercent).toFixed(1)}% vs last month.`
      : "Last month comparison is not available yet.",
    data.sales.rankInTeam?.position === 1
      ? "Top performer in your team. Keep it up."
      : "You can close the gap with focused daily activity.",
    topProduct 
      ? `${topProduct.name} contributes ${topProductContribution.toFixed(1)}% to your top 5 products.`
      : "No product contribution data available.",
  ];
  const cards = raw.slice(0, 4);
  return (
    <OverviewPagePanel title="Insights & Alerts">
      <div className="grid gap-3 md:grid-cols-2">
        {cards.map((text) => {
          const meta = insightMeta(text);
          const Icon = meta.icon;
          const borderTone = meta.badge === "Positive"
            ? "border-l-emerald-500"
            : meta.badge === "Warning"
              ? "border-l-amber-500"
              : meta.badge === "Insight"
                ? "border-l-blue-500"
                : "border-l-rose-500";
          return (
            <div key={text} className={`rounded-xl border border-slate-100 border-l-2 ${borderTone} bg-white p-3 shadow-[0_4px_14px_rgba(15,23,42,0.03)]`}>
              <div className="flex items-center gap-2">
                <Icon className="h-4 w-4 text-slate-500" />
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.classes}`}>{meta.badge}</span>
              </div>
              <p className="mt-2 text-sm text-slate-700">{shortInsight(text)}</p>
            </div>
          );
        })}
      </div>
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
        ) : rows.map((row) => {
          const value = getContributionValue(row, metric);
          const width = Math.max(8, Math.round((value / max) * 100));
          const contributionPercent = total > 0 ? (value / total) * 100 : 0;
          return (
            <div key={row.name} className="rounded-2xl border border-slate-100 bg-white p-3 shadow-[0_8px_18px_rgba(15,23,42,0.035)]">
              <div className="mb-1 flex items-center justify-between text-sm">
                <div className="flex flex-col">
                  <span className="font-bold text-slate-800">{row.name}</span>
                  <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">{contributionPercent.toFixed(1)}% of top 4</span>
                </div>
                <span className="font-mono text-xs font-black text-slate-900 tabular-nums">{formatContributionValue(metric, value)}</span>
              </div>
              <div className="h-2.5 overflow-hidden rounded-full bg-slate-100 shadow-inner">
                <div className="h-full rounded-full bg-gradient-to-r from-orange-600 via-amber-400 to-sky-400 shadow-[0_0_18px_rgba(249,115,22,0.24)]" style={{ width: `${width}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </OverviewPagePanel>
  );
}

function OverviewPerformanceChart({ data }: { data: MedicalRepPortalData }) {
  const [activeTrendIndex, setActiveTrendIndex] = useState<number | null>(null);
  const trendData = Array.isArray(data.sales.trend) ? data.sales.trend : [];
  const chartWidth = 720;
  const chartHeight = 232;
  const padding = { bottom: 34, left: 58, right: 22, top: 20 };
  const innerWidth = chartWidth - padding.left - padding.right;
  const innerHeight = chartHeight - padding.top - padding.bottom;
  const values = trendData.flatMap((point) => [point.sales, point.target]).filter(Number.isFinite);
  const maxValue = Math.max(1, ...values);
  const roundedMax = Math.ceil(maxValue / 100000) * 100000;
  const xFor = (index: number) => padding.left + (trendData.length <= 1 ? innerWidth / 2 : (index / (trendData.length - 1)) * innerWidth);
  const yFor = (value: number) => padding.top + (1 - Math.max(0, Math.min(1, value / roundedMax))) * innerHeight;
  const salesPoints = trendData.map((point, index) => `${xFor(index)},${yFor(point.sales)}`).join(" ");
  const targetPoints = trendData.map((point, index) => `${xFor(index)},${yFor(point.target)}`).join(" ");
  const activeTrendPoint = activeTrendIndex === null ? null : trendData[activeTrendIndex] ?? null;
  const activeTrendX = activeTrendIndex === null ? 0 : xFor(activeTrendIndex);
  const activeTrendY = activeTrendPoint ? yFor(activeTrendPoint.sales) : 0;
  const tooltipLeft = `${Math.max(18, Math.min(82, (activeTrendX / chartWidth) * 100))}%`;
  const tooltipTop = `${Math.max(14, Math.min(72, (activeTrendY / chartHeight) * 100))}%`;

  return (
    <div
      className="flex h-full flex-col"
    >
      <OverviewPagePanel
        title="Performance Overview"
      >
        <div className="relative h-64 rounded-[22px] border border-slate-100 bg-white/70 p-3 shadow-inner">
          {trendData.length === 0 ? (
            <div className="flex h-full items-center justify-center rounded-2xl bg-slate-50 text-sm font-semibold text-slate-500">
              No trend data available
            </div>
          ) : (
            <div className="h-full min-w-0" onPointerLeave={() => setActiveTrendIndex(null)}>
              <svg
                aria-label="Sales and target performance trend"
                className="h-full w-full overflow-visible"
                preserveAspectRatio="none"
                role="img"
                viewBox={`0 0 ${chartWidth} ${chartHeight}`}
              >
                <defs>
                  <linearGradient id="overviewSalesStaticFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f97316" stopOpacity={0.26} />
                    <stop offset="95%" stopColor="#f97316" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
                  const y = padding.top + ratio * innerHeight;
                  const labelValue = Math.round((roundedMax * (1 - ratio)) / 1000);
                  return (
                    <g key={ratio}>
                      <line
                        stroke="#e8edf4"
                        strokeDasharray="3 3"
                        strokeWidth="1"
                        vectorEffect="non-scaling-stroke"
                        x1={padding.left}
                        x2={chartWidth - padding.right}
                        y1={y}
                        y2={y}
                      />
                      <text fill="#64748b" fontSize="11" fontWeight="700" textAnchor="end" x={padding.left - 10} y={y + 4}>
                        {labelValue}k
                      </text>
                    </g>
                  );
                })}
                {trendData.length > 1 ? (
                  <polygon
                    fill="url(#overviewSalesStaticFill)"
                    points={`${padding.left},${chartHeight - padding.bottom} ${salesPoints} ${chartWidth - padding.right},${chartHeight - padding.bottom}`}
                  />
                ) : null}
                {targetPoints ? (
                  <polyline
                    fill="none"
                    points={targetPoints}
                    stroke="#64748b"
                    strokeDasharray="5 5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2.25"
                    vectorEffect="non-scaling-stroke"
                  />
                ) : null}
                {salesPoints ? (
                  <polyline
                    fill="none"
                    points={salesPoints}
                    stroke="#f97316"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="3"
                    vectorEffect="non-scaling-stroke"
                  />
                ) : null}
                {trendData.map((point, index) => (
                  <g
                    aria-label={`${periodLabel(point.period)} sales ${egp(point.sales)} target ${egp(point.target)}`}
                    key={point.period}
                    onClick={() => setActiveTrendIndex(index)}
                    onFocus={() => setActiveTrendIndex(index)}
                    onPointerEnter={() => setActiveTrendIndex(index)}
                    role="button"
                    tabIndex={0}
                  >
                    <circle
                      cx={xFor(index)}
                      cy={yFor(point.sales)}
                      fill="transparent"
                      r="16"
                    />
                    <circle
                      cx={xFor(index)}
                      cy={yFor(point.sales)}
                      fill="#f97316"
                      r={activeTrendIndex === index ? 5.5 : index === trendData.length - 1 ? 4.5 : 3}
                      stroke="#ffffff"
                      strokeWidth="2"
                      vectorEffect="non-scaling-stroke"
                    />
                    {activeTrendIndex === index ? (
                      <line
                        stroke="#f97316"
                        strokeDasharray="4 4"
                        strokeOpacity="0.45"
                        strokeWidth="1.5"
                        vectorEffect="non-scaling-stroke"
                        x1={xFor(index)}
                        x2={xFor(index)}
                        y1={padding.top}
                        y2={chartHeight - padding.bottom}
                      />
                    ) : null}
                  </g>
                ))}
                {trendData.map((point, index) => (
                  <text
                    fill="#64748b"
                    fontSize="11"
                    fontWeight="700"
                    key={`label-${point.period}`}
                    textAnchor="middle"
                    x={xFor(index)}
                    y={chartHeight - 9}
                  >
                    {periodMonthLabel(point.period)}
                  </text>
                ))}
              </svg>
              {activeTrendPoint ? (
                <div
                  className="pointer-events-none absolute z-10 min-w-[160px] -translate-x-1/2 -translate-y-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs shadow-[0_16px_35px_rgba(15,23,42,0.16)]"
                  style={{ left: tooltipLeft, top: tooltipTop }}
                >
                  <p className="font-black text-slate-900">{periodLabel(activeTrendPoint.period)}</p>
                  <div className="mt-1.5 space-y-1">
                    <p className="flex items-center justify-between gap-4 text-slate-600">
                      <span>Sales</span>
                      <span className="font-black text-orange-600">{egp(activeTrendPoint.sales)}</span>
                    </p>
                    <p className="flex items-center justify-between gap-4 text-slate-600">
                      <span>Target</span>
                      <span className="font-black text-slate-700">{egp(activeTrendPoint.target)}</span>
                    </p>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </OverviewPagePanel>
    </div>
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

function MyActionsPanel({ data }: { data: MedicalRepPortalData }) {
  const actions = data.overview.myActions;

  return (
    <OverviewPagePanel title="My Actions">
      {actions.length === 0 ? (
        <div className="flex h-full min-h-[200px] items-center justify-center rounded-[18px] border border-dashed border-slate-200 bg-slate-50/70 px-6 text-center">
                <p className="text-sm font-medium text-slate-500">No pending actions right now.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {actions.map((item) => (
            <PremiumTooltip
              content={(
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-slate-900">{item.label}</p>
                  <p className="text-[11px] text-slate-500">Pending items in your visible queue.</p>
                  <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-2 text-[11px]">
                    <span className="text-slate-500">Visible count</span>
                    <span className="font-semibold text-slate-900">{item.count}</span>
                  </div>
                </div>
              )}
              key={item.id}
              triggerClassName="block"
            >
              <Link
                className="group flex items-center gap-3 rounded-[18px] border border-slate-200 bg-white/80 px-4 py-3 shadow-[0_8px_20px_rgba(15,23,42,0.05)] transition hover:-translate-y-0.5 hover:border-orange-200 hover:bg-orange-50/60"
                href={item.href}
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-orange-50 text-orange-600 ring-1 ring-orange-100 transition-transform duration-200 group-hover:scale-105">
                  {item.id === "pending-approvals" ? (
                    <ClipboardCheck className="h-5 w-5" />
                  ) : item.id === "vacation-approvals" ? (
                    <CalendarClock className="h-5 w-5" />
                  ) : item.id === "my-vacation-requests" ? (
                    <CalendarDays className="h-5 w-5" />
                  ) : item.id === "marketing-drafts" ? (
                    <Megaphone className="h-5 w-5" />
                  ) : (
                    <ReceiptText className="h-5 w-5" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-medium text-slate-800">{item.label}</p>
                </div>
                <span className="shrink-0 text-sm font-semibold text-orange-600">({item.count})</span>
                <ArrowUpRight className="h-4 w-4 shrink-0 text-slate-300 transition-colors duration-200 group-hover:text-slate-500" />
              </Link>
            </PremiumTooltip>
          ))}
        </div>
      )}
    </OverviewPagePanel>
  );
}

function QuickActionsPanel({ data }: { data: MedicalRepPortalData }) {
  const actions = [
    ...(canUsePendingApprovals(data) ? [{ href: "/pending-approvals", icon: ClipboardCheck, label: "Pending Approvals" }] : []),
    { href: resolveExpenseActionHref(data), icon: ReceiptText, label: "Submit Expense" },
    { href: "/leave-management/vacation-request", icon: CalendarDays, label: "Submit Vacation Request" },
    { href: "/employee-portals/marketing-requests", icon: Megaphone, label: "Submit Marketing Request" },
  ].filter((item) => {
    if (item.href === "/employee-portals/marketing-requests") {
      return !isRole(data, "training manager");
    }
    return true;
  });

  return (
    <OverviewPagePanel title="Quick Actions">
      <div className="grid grid-cols-1 auto-rows-fr gap-3 sm:grid-cols-3">
        {actions.map((item) => (
          <PremiumTooltip
            content={(
              <div className="space-y-2">
                <p className="text-xs font-semibold text-slate-900">{item.label}</p>
                <p className="text-[11px] text-slate-500">Open the relevant workflow directly from your dashboard.</p>
              </div>
            )}
            key={item.href}
            triggerClassName="block"
          >
            <Link
              className="group flex h-full min-h-[116px] flex-col items-center justify-between rounded-[18px] border border-slate-200 bg-white/80 px-3 py-3 text-center shadow-[0_8px_20px_rgba(15,23,42,0.05)] transition hover:-translate-y-0.5 hover:border-orange-200 hover:bg-orange-50/60"
              href={item.href}
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-700 ring-1 ring-slate-200 transition-all duration-200 group-hover:scale-105 group-hover:bg-white">
                <item.icon className="h-5 w-5" />
              </span>
              <span className="flex min-h-[40px] items-center text-[14px] font-medium leading-5 text-slate-800">
                {item.label}
              </span>
              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-slate-400 transition-colors duration-200 group-hover:text-slate-500">
                Open
                <ArrowUpRight className="h-3 w-3" />
              </span>
            </Link>
          </PremiumTooltip>
        ))}
      </div>
    </OverviewPagePanel>
  );
}

function EmployeesOnLeaveTodayPanel({ data }: { data: MedicalRepPortalData }) {
  const rows = data.overview.employeesOnLeaveToday;

  return (
    <OverviewPagePanel title="Employees on Leave Today">
      {rows.length === 0 ? (
        <div className="flex h-full min-h-[200px] items-center justify-center rounded-[18px] border border-dashed border-slate-200 bg-slate-50/70 px-6 text-center">
          <p className="text-sm font-medium text-slate-500">No employees are on leave today.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.slice(0, 6).map((row) => (
            <div
              className="flex items-start justify-between gap-3 rounded-[18px] border border-slate-200 bg-white/80 px-4 py-3 shadow-[0_8px_20px_rgba(15,23,42,0.05)]"
              key={row.id}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-900">{row.employeeName}</p>
                <p className="mt-1 text-xs font-normal text-slate-500">
                  {row.lineName ?? row.departmentName ?? "Phoenix"} • Until {prettyDate(row.endDate)}
                </p>
              </div>
              <span className="shrink-0 rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-sky-700">
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
  const visibleAreas = Array.from(
    new Set(
      (vacancyDetails?.vacancies ?? [])
        .map((row) => row.areaName ?? row.regionName ?? row.positionTitle ?? row.jobTitle ?? row.vacancyCode)
        .filter(Boolean),
    ),
  ).slice(0, 4);

  return (
    <OverviewPagePanel title="Team Structure">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-[18px] border border-slate-200 bg-white/80 p-3.5 shadow-[0_8px_20px_rgba(15,23,42,0.05)]">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Total Structure</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{formatUnits(totalStructure)}</p>
        </div>
        <div className="rounded-[18px] border border-slate-200 bg-white/80 p-3.5 shadow-[0_8px_20px_rgba(15,23,42,0.05)]">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Actual</p>
          <p className="mt-2 text-2xl font-semibold text-emerald-600">{formatUnits(actualNow)}</p>
        </div>
        <div className="rounded-[18px] border border-slate-200 bg-white/80 p-3.5 shadow-[0_8px_20px_rgba(15,23,42,0.05)]">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Vacant</p>
          <p className="mt-2 text-2xl font-semibold text-orange-600">{formatUnits(vacancies)}</p>
        </div>
      </div>
      <div className="mt-3 rounded-[18px] border border-slate-200 bg-slate-50/70 p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-slate-900">
            {data.orgStructure?.scopeLabel ?? data.workforce.scopeLabel}
          </p>
          <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600">
            {formatUnits(vacancies)} vacant
          </span>
        </div>
        {visibleAreas.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {visibleAreas.map((area) => (
              <span
                className="rounded-full border border-orange-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700"
                key={area}
              >
                {area}
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-sm font-medium text-slate-500">No active vacancy areas are visible in your current scope.</p>
        )}
      </div>
    </OverviewPagePanel>
  );
}

export function ContactHRSupportPage({ data }: { data: EmployeePortalShellData }) {
  const employeeName = data.employee.fullName || data.employee.hrId || "your profile";
  const [category, setCategory] = useState("");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const submitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hrTeam: { id: string; name: string; role: string; summary: string }[] = [
    {
      id: "hr-support",
      name: "HR Support Desk",
      role: "General HR support",
      summary: "Use the request form for policy questions, profile issues, and HR process support.",
    },
    {
      id: "talent-support",
      name: "Talent Support Desk",
      role: "Recruitment and onboarding support",
      summary: "Use this channel for onboarding status, hiring requests, and talent coordination.",
    },
    {
      id: "ops-support",
      name: "Operations Support Desk",
      role: "Workplace and office support",
      summary: "Use this channel for office coordination, workplace requests, and operational help.",
    },
  ];

  const recentRequests: { id: string; subject: string; category: string; status: string; date: string }[] = [];

  useEffect(() => {
    return () => {
      if (submitTimeoutRef.current) clearTimeout(submitTimeoutRef.current);
      if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current);
    };
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    submitTimeoutRef.current = setTimeout(() => {
      setIsSubmitting(false);
      setShowSuccess(true);
      setCategory("");
      setSubject("");
      setDescription("");
      successTimeoutRef.current = setTimeout(() => setShowSuccess(false), 3000);
    }, 1000);
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "In Progress": return "bg-amber-100 text-amber-700";
      case "Resolved": return "bg-emerald-100 text-emerald-700";
      case "Pending": return "bg-slate-100 text-slate-700";
      default: return "bg-slate-100 text-slate-700";
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold text-slate-900">Request Support</h1>
        <p className="mt-1 text-sm text-slate-500">Submit a support request for {employeeName} or contact HR for assistance</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
          <div className="mb-4 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-orange-500/80" />
            <p className="text-lg font-semibold text-slate-900">Contact HR</p>
          </div>
          <p className="mb-6 text-sm text-slate-600">Get in touch with the HR team for any inquiries</p>

          <div className="space-y-4">
            {hrTeam.length > 0 ? (
              hrTeam.map((member) => (
                <div key={member.id} className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50/70 px-4 py-3 transition hover:bg-slate-50">
                  <div className="flex items-start gap-3">
                    <div className="shrink-0 overflow-hidden rounded-lg ring-2 ring-orange-100"
                      style={{ width: "2cm", height: "3cm" }}>
                      <div className="flex h-full w-full items-center justify-center bg-orange-100 text-sm font-semibold text-orange-700">
                        {member.name.split(" ").map((n) => n[0]).join("")}
                      </div>
                    </div>
                    <div>
                    <p className="text-sm font-semibold text-slate-900">{member.name}</p>
                    <p className="text-xs text-slate-500">{member.role}</p>
                    <div className="mt-1 flex flex-col gap-0.5">
                      <p className="text-[10px] text-slate-400">{member.summary}</p>
                    </div>
                  </div>
                  </div>
                  <Button
                    className="h-8 rounded-lg text-xs"
                    variant="secondary"
                    onClick={() => {
                      setCategory("HR Request");
                      setSubject(`${member.name} request`);
                    }}
                  >
                    <Send className="mr-1.5 h-3 w-3" />
                    Use Form
                  </Button>
                </div>
              ))
            ) : (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50/50 py-8 text-center">
                <Users className="mb-2 h-8 w-8 text-slate-300" />
                <p className="text-sm font-medium text-slate-500">No HR contacts available</p>
                <p className="text-xs text-slate-400">Please use the support form for inquiries</p>
              </div>
            )}
          </div>

          <div className="mt-6 space-y-3 rounded-2xl border border-slate-100 bg-slate-50/70 p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-50 text-orange-600">
                <CalendarClock className="h-4 w-4" />
              </div>
              <div>
                <p className="text-xs font-medium text-slate-500">Office Hours</p>
                <p className="text-sm font-semibold text-slate-900">Sun - Thu (9:00 AM - 5:00 PM)</p>
              </div>
            </div>
          </div>

          <p className="mt-4 text-xs text-slate-500 italic">For urgent HR matters, use the support form below so the request is tracked inside Phoenix Workforce.</p>
        </Card>

        <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
          <div className="mb-4 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-orange-500/80" />
            <p className="text-lg font-semibold text-slate-900">Request Support</p>
          </div>
          <p className="mb-6 text-sm text-slate-600">Submit a request and our team will get back to you as soon as possible</p>

          {showSuccess && (
            <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
              <p className="text-sm font-medium text-emerald-800">Request submitted successfully!</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-700">Category</label>
              <select
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-orange-300 focus:shadow-[0_0_0_3px_rgba(249,115,22,0.08)]"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                required
              >
                <option value="">Select a category</option>
                <option value="Payslip & Earnings">Payslip & Earnings</option>
                <option value="System Issue">System Issue</option>
                <option value="HR Request">HR Request</option>
                <option value="Other">Other</option>
              </select>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-700">Subject</label>
              <input
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-orange-300 focus:shadow-[0_0_0_3px_rgba(249,115,22,0.08)]"
                placeholder="Enter a short subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                required
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-700">Description</label>
              <textarea
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-orange-300 focus:shadow-[0_0_0_3px_rgba(249,115,22,0.08)] resize-none"
                placeholder="Describe your issue or request in detail..."
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                required
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-700">Attachments (Optional)</label>
              <div className="flex h-24 w-full cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-200 bg-slate-50/50 transition hover:border-orange-300 hover:bg-slate-50">
                <Upload className="mb-2 h-5 w-5 text-slate-400" />
                <p className="text-xs text-slate-500">Drag and drop files here or click to upload</p>
                <p className="text-[10px] text-slate-400">Max file size 10MB (PDF, PNG, JPG)</p>
              </div>
            </div>

            <Button className="w-full rounded-xl" disabled={isSubmitting} type="submit">
              {isSubmitting ? (
                "Submitting..."
              ) : (
                <>
                  <Send className="mr-2 h-4 w-4" />
                  Submit Request
                </>
              )}
            </Button>
          </form>
        </Card>
      </div>

      <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-orange-500/80" />
            <p className="text-lg font-semibold text-slate-900">Your Recent Requests</p>
          </div>
          <a className="text-xs font-medium text-orange-600 hover:text-orange-700" href="#">View All Requests &gt;</a>
        </div>
        <div className="overflow-x-auto rounded-2xl border border-slate-100">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-[0.12em] text-slate-500">
                <th className="px-4 py-3">Request ID</th>
                <th className="px-4 py-3">Subject</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Action</th>
              </tr>
            </thead>
            <tbody>
              {recentRequests.length > 0 ? (
                recentRequests.map((request) => (
                  <tr key={request.id} className="border-b border-slate-100">
                    <td className="px-4 py-3 font-mono text-xs text-slate-600">{request.id}</td>
                    <td className="px-4 py-3 font-medium text-slate-900">{request.subject}</td>
                    <td className="px-4 py-3 text-slate-600">{request.category}</td>
                    <td className="px-4 py-3">
                      <Badge className={getStatusColor(request.status)}>{request.status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{request.date}</td>
                    <td className="px-4 py-3">
                      <Button className="h-7 rounded-lg px-2 text-xs" variant="secondary">View</Button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="px-4 py-12 text-center text-slate-400" colSpan={6}>
                    <div className="flex flex-col items-center justify-center">
                      <HelpCircle className="mb-2 h-8 w-8 text-slate-200" />
                      <p className="text-sm font-medium">No recent requests found</p>
                      <p className="text-xs">Your support history will appear here</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

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
    { label: "Highest Single Trip", value: egp(Math.max(0, ...(workload?.recentTrips.map(t => t.cost) ?? []))), delta: "N/A" },
  ];

  const expenseTrend = workload?.expenseTrend ?? [];
  const territoryAnalysis = workload?.territoryAnalysis ?? [];
  const recentTrips = workload?.recentTrips ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold text-slate-900">Workload & Expense Dashboard</h1>
          <p className="mt-1 text-sm text-slate-500">Track workload, trips, and expense efficiency across AMs & PMs</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
            <CalendarDays className="h-4 w-4 text-slate-400" />
            <input className="w-32 text-sm text-slate-700 outline-none" placeholder="From" type="date" />
            <span className="text-slate-400">-</span>
            <input className="w-32 text-sm text-slate-700 outline-none" placeholder="To" type="date" />
          </div>
          <Button className="rounded-xl" disabled={isRefreshing} onClick={handleRefresh} variant="secondary">
            <RefreshCw className={`mr-2 h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      <Card className="rounded-2xl border border-slate-100 bg-white p-4 shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
        <div className="flex flex-wrap items-center gap-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">View By</label>
            <select
              className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none transition focus:border-orange-300"
              value={viewBy}
              onChange={(e) => setViewBy(e.target.value)}
            >
              <option value="Employee">Employee</option>
              <option value="Role">Role</option>
              <option value="Territory">Territory</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Employee</label>
            <select
              className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none transition focus:border-orange-300"
              value={selectedEmployee}
              onChange={(e) => setSelectedEmployee(e.target.value)}
            >
              <option value="All">All Employees</option>
              {workload?.availableEmployees.map((emp) => (
                <option key={emp.id} value={emp.id}>{emp.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Role</label>
            <select
              className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none transition focus:border-orange-300"
              value={selectedRole}
              onChange={(e) => setSelectedRole(e.target.value)}
            >
              <option value="All">All Roles</option>
              <option value="AM">AM</option>
              <option value="PM">PM</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Territory</label>
            <select
              className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none transition focus:border-orange-300"
              value={selectedTerritory}
              onChange={(e) => setSelectedTerritory(e.target.value)}
            >
              <option value="All">All Territories</option>
              {workload?.availableTerritories.map((loc) => (
                <option key={loc} value={loc}>{loc}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Trip Type</label>
            <select
              className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none transition focus:border-orange-300"
              value={tripType}
              onChange={(e) => setTripType(e.target.value)}
            >
              <option value="All">All</option>
              <option value="Travel">Travel</option>
              <option value="Return">Return</option>
              <option value="Meeting">Meeting</option>
            </select>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
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
        <Card className="rounded-3xl border border-white/80 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] p-6 shadow-[0_14px_34px_rgba(15,23,42,0.07)] ring-1 ring-slate-200/70">
          <div className="mb-4 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-orange-500/80" />
            <p className="text-lg font-black tracking-tight text-slate-900">Workload Overview</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {workloadOverview.map((item) => (
              <div key={item.label} className="rounded-xl border border-slate-100 bg-slate-50/50 p-4">
                <p className="text-xs font-medium text-slate-500">{item.label}</p>
                <p className="mt-1 text-xl font-semibold text-slate-900">{item.value}</p>
                <p className="mt-1 text-xs text-emerald-600">{item.delta}</p>
              </div>
            ))}
          </div>
          <StableChartFrame
            className="mt-6 h-64 rounded-[22px] border border-slate-100 bg-white/70 p-3 shadow-inner"
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

        <Card className="rounded-3xl border border-white/80 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] p-6 shadow-[0_14px_34px_rgba(15,23,42,0.07)] ring-1 ring-slate-200/70">
          <div className="mb-4 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-orange-500/80" />
            <p className="text-lg font-black tracking-tight text-slate-900">Workload Distribution</p>
          </div>
          <div className="grid gap-4 md:grid-cols-[1fr_1fr]">
            <StableChartFrame
              className="h-64 rounded-[22px] border border-slate-100 bg-white/70 p-3 shadow-inner"
              height={232}
            >
                <PieChart>
                  <Pie
                    cornerRadius={7}
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
                <div key={item.name} className="flex items-center justify-between rounded-xl border border-slate-100 bg-white px-3 py-2 shadow-[0_5px_14px_rgba(15,23,42,0.03)]">
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

      <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
        <div className="mb-4 flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-orange-500/80" />
          <p className="text-lg font-semibold text-slate-900">Workload by Day (Heatmap)</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-[0.12em] text-slate-500">
                <th className="px-4 py-3">Metric</th>
                <th className="px-4 py-3">Mon</th>
                <th className="px-4 py-3">Tue</th>
                <th className="px-4 py-3">Wed</th>
                <th className="px-4 py-3">Thu</th>
                <th className="px-4 py-3">Fri</th>
                <th className="px-4 py-3">Sat</th>
                <th className="px-4 py-3">Sun</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-slate-100">
                <td className="px-4 py-3 font-medium text-slate-900">Trips</td>
                {heatmapData.trips.map((value, index) => (
                  <td key={index} className="px-4 py-3">
                    <div
                      className="flex h-8 items-center justify-center rounded-lg text-sm font-semibold text-white"
                      style={{ backgroundColor: `rgba(249, 115, 22, ${0.2 + (value / 6) * 0.8})` }}
                    >
                      {value}
                    </div>
                  </td>
                ))}
              </tr>
              <tr className="border-b border-slate-100">
                <td className="px-4 py-3 font-medium text-slate-900">Distance (km)</td>
                {heatmapData.distance.map((value, index) => (
                  <td key={index} className="px-4 py-3">
                    <div
                      className="flex h-8 items-center justify-center rounded-lg text-sm font-semibold text-white"
                      style={{ backgroundColor: `rgba(249, 115, 22, ${0.2 + (value / 520) * 0.8})` }}
                    >
                      {value}
                    </div>
                  </td>
                ))}
              </tr>
              <tr>
                <td className="px-4 py-3 font-medium text-slate-900">Expenses (EGP)</td>
                {heatmapData.expenses.map((value, index) => (
                  <td key={index} className="px-4 py-3">
                    <div
                      className="flex h-8 items-center justify-center rounded-lg text-sm font-semibold text-white"
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

      <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
        <div className="mb-4 flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-orange-500/80" />
          <p className="text-lg font-semibold text-slate-900">Employee Performance (AM & PM)</p>
        </div>
        <div className="overflow-x-auto rounded-2xl border border-slate-100">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-[0.12em] text-slate-500">
                <th className="px-4 py-3">Employee Name</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Trips</th>
                <th className="px-4 py-3">Distance</th>
                <th className="px-4 py-3">Active Days</th>
              </tr>
            </thead>
            <tbody>
              {employeePerformance.map((emp, index) => (
                <tr key={emp.name} className="border-b border-slate-100 transition hover:bg-slate-50">
                  <td className="px-4 py-3 text-slate-900">
                    <div className="flex items-center gap-2">
                      {index < 2 && <Trophy className="h-4 w-4 text-orange-500" />}
                      {emp.name}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="neutral">{emp.role}</Badge>
                  </td>
                  <td className="px-4 py-3 font-semibold text-slate-900">{emp.trips}</td>
                  <td className="px-4 py-3 text-slate-600">{emp.distance} km</td>
                  <td className="px-4 py-3 text-slate-600">{emp.activeDays}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="rounded-3xl border border-white/80 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] p-6 shadow-[0_14px_34px_rgba(15,23,42,0.07)] ring-1 ring-slate-200/70">
          <div className="mb-4 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-orange-500/80" />
            <p className="text-lg font-black tracking-tight text-slate-900">Expense Analysis</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {expenseAnalysis.map((item) => (
              <div key={item.label} className="rounded-xl border border-slate-100 bg-slate-50/50 p-4">
                <p className="text-xs font-medium text-slate-500">{item.label}</p>
                <p className="mt-1 text-xl font-semibold text-slate-900">{item.value}</p>
                <p className="mt-1 text-xs text-slate-400">{item.delta}</p>
              </div>
            ))}
          </div>
          <StableChartFrame
            className="mt-6 h-48 rounded-[22px] border border-slate-100 bg-white/70 p-3 shadow-inner"
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

        <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
          <div className="mb-4 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-orange-500/80" />
            <p className="text-lg font-semibold text-slate-900">Territory Analysis</p>
          </div>
          <div className="overflow-x-auto rounded-2xl border border-slate-100">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-[0.12em] text-slate-500">
                  <th className="px-4 py-3">Territory</th>
                  <th className="px-4 py-3">Trips</th>
                  <th className="px-4 py-3">Distance</th>
                  <th className="px-4 py-3">Expenses</th>
                </tr>
              </thead>
              <tbody>
                {territoryAnalysis.map((territory) => (
                  <tr key={territory.territory} className="border-b border-slate-100 transition hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium text-slate-900">{territory.territory}</td>
                    <td className="px-4 py-3 text-slate-600">{territory.trips}</td>
                    <td className="px-4 py-3 text-slate-600">{territory.distance} km</td>
                    <td className="px-4 py-3 font-semibold text-slate-900">{egp(territory.expenses)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-orange-500/80" />
            <p className="text-lg font-semibold text-slate-900">Recent Trips</p>
          </div>
          <Link className="text-xs font-medium text-orange-600 hover:text-orange-700" href={resolveTripsOverviewHref(data)}>
            View All Trips &gt;
          </Link>
        </div>
        <div className="overflow-x-auto rounded-2xl border border-slate-100">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-[0.12em] text-slate-500">
                <th className="px-4 py-3">Trip ID</th>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Employee</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">From</th>
                <th className="px-4 py-3">To</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Distance</th>
                <th className="px-4 py-3">Cost</th>
              </tr>
            </thead>
            <tbody>
              {recentTrips.map((trip) => (
                <tr key={trip.id} className="border-b border-slate-100 transition hover:bg-slate-50">
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">{trip.id}</td>
                  <td className="px-4 py-3 text-slate-900">{trip.date}</td>
                  <td className="px-4 py-3 text-slate-600">{trip.employee}</td>
                  <td className="px-4 py-3">
                    <Badge variant="neutral">{trip.role}</Badge>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{trip.from}</td>
                  <td className="px-4 py-3 text-slate-600">{trip.to}</td>
                  <td className="px-4 py-3">
                    <Badge variant="neutral">{trip.type}</Badge>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{trip.distance} km</td>
                  <td className="px-4 py-3 font-semibold text-slate-900">{egp(trip.cost)}</td>
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
    <Card className="group rounded-2xl border border-slate-200 bg-white/95 px-4 py-4 shadow-[0_8px_20px_rgba(15,23,42,0.04)] transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_14px_28px_rgba(15,23,42,0.08)]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-2xl font-semibold tracking-tight text-slate-900">{value}</p>
          <p className="mt-1 text-xs font-medium text-slate-500">{label}</p>
          <p className="mt-0.5 text-[10px] text-slate-400">{subLabel}</p>
          <p className={`mt-1 text-xs font-medium ${isPositive ? "text-emerald-600" : "text-red-600"}`}>{delta}</p>
        </div>
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-orange-50 text-orange-600">
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
      <Card className="rounded-3xl border border-slate-100 bg-white p-5 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
        <div className="mb-4 rounded-2xl border border-slate-100 bg-slate-50/70 px-4 py-3">
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
          <MetricCard label="Days Remaining" value={daysRemaining === null ? "N/A" : `${daysRemaining} days`} />
        </div>
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Identity Card — replaces the old "Personal Overview / Good Morning" header
// Matches the exact design from the ChatGPT image reference
// ---------------------------------------------------------------------------

export function IdentityCard({ data }: { data: EmployeePortalShellData }) {
  const employee = data.employee;
  const hiredLabel = prettyDate(data.hrContract.hireDate);
  const statusVariant = asStatus(employee.status);
  const displayHrId = formatHrIdForDisplay(employee.hrId) ?? employee.hrId;

  const statusPillClass =
    statusVariant === "success"
      ? "border-emerald-200/50 bg-emerald-50/50 text-emerald-600 shadow-sm"
      : statusVariant === "warning"
        ? "border-amber-200/50 bg-amber-50/50 text-amber-700 shadow-sm"
        : statusVariant === "danger"
          ? "border-rose-200/50 bg-rose-50/50 text-rose-700 shadow-sm"
          : "border-slate-200/50 bg-slate-50/50 text-slate-600 shadow-sm";

  const statusDotClass =
    statusVariant === "success"
      ? "bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.1)]"
      : statusVariant === "warning"
        ? "bg-amber-500 shadow-[0_0_0_4px_rgba(245,158,11,0.1)]"
        : statusVariant === "danger"
          ? "bg-rose-500 shadow-[0_0_0_4px_rgba(244,63,94,0.1)]"
          : "bg-slate-500 shadow-[0_0_0_4px_rgba(100,116,139,0.1)]";

  const initials = employee.fullName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join("")
    .toUpperCase();

  return (
    <div className="relative overflow-hidden rounded-[30px] border border-white/80 bg-[linear-gradient(135deg,#ffffff_0%,#ffffff_48%,#f8fafc_100%)] px-5 py-5 shadow-[0_18px_48px_rgba(15,23,42,0.08)] ring-1 ring-slate-200/70 lg:px-10 lg:py-8">
      <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-sky-500 via-orange-500 to-emerald-500" />
      <div className="absolute inset-0 bg-[linear-gradient(rgba(15,23,42,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(15,23,42,0.025)_1px,transparent_1px)] bg-[size:34px_34px] opacity-70 [mask-image:linear-gradient(110deg,rgba(0,0,0,0.85),transparent_76%)]" />
      
      <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center">

        {/* Avatar circle */}
        <div className="group relative flex h-[90px] w-[90px] shrink-0 items-center justify-center rounded-full border border-orange-100 bg-gradient-to-tr from-orange-50/80 to-white p-1.5 shadow-[0_14px_34px_rgba(249,115,22,0.12)] lg:h-[124px] lg:w-[124px]">
          <div className="flex h-full w-full items-center justify-center rounded-full bg-white shadow-inner">
            <div className="flex h-full w-full items-center justify-center rounded-full bg-orange-500/10 text-orange-500 transition-transform duration-500 group-hover:scale-105">
              <span className="text-[28px] lg:text-[40px] font-black tracking-tight">{initials || "EM"}</span>
            </div>
          </div>
          {/* Active status ring on avatar */}
          <div className="absolute bottom-1 right-1 h-4 w-4 rounded-full border-4 border-white bg-emerald-500 shadow-sm lg:h-6 lg:w-6" />
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">

          {/* Name + role */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <h1 className="text-[24px] font-black leading-tight tracking-tight text-slate-950 lg:text-[32px]">
              {employee.fullName}
            </h1>
            <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-wider lg:px-4 lg:text-[13px] ${statusPillClass}`}>
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full lg:h-2 lg:w-2 ${statusDotClass} ${statusVariant === "success" ? "animate-pulse" : ""}`} />
              {employee.status}
            </span>
          </div>

          {/* Role + Metadata Subline */}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-slate-400">
            <p className="text-[14px] font-semibold tracking-tight lg:text-[16px]">{employee.roleLabel}</p>
            <span className="h-1 w-1 rounded-full bg-slate-200" />
            <p className="text-[13px] font-medium tabular-nums lg:text-[14px]">HR ID: {displayHrId}</p>
          </div>

          {/* Line · Territory · Manager - Enhanced Grid */}
          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3 lg:mt-6">
            <div className="flex items-center gap-2.5 group/item">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white text-orange-500 shadow-sm ring-1 ring-slate-200 transition-colors group-hover/item:bg-orange-50">
                <BriefcaseBusiness className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Business Line</p>
                <p className="truncate text-sm font-bold text-slate-700">{employee.line ?? "Unassigned"}</p>
              </div>
            </div>
            
            <div className="flex items-center gap-2.5 group/item">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white text-orange-500 shadow-sm ring-1 ring-slate-200 transition-colors group-hover/item:bg-orange-50">
                <MapPin className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Territory</p>
                <p className="truncate text-sm font-bold text-slate-700">{employee.territory ?? "Unassigned"}</p>
              </div>
            </div>

            <div className="flex items-center gap-2.5 group/item">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white text-orange-500 shadow-sm ring-1 ring-slate-200 transition-colors group-hover/item:bg-orange-50">
                <Users className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Direct Manager</p>
                <p className="truncate text-sm font-bold text-slate-700">{employee.manager ?? "Unassigned"}</p>
              </div>
            </div>
          </div>

          {/* Footer Info */}
          <div className="mt-6 flex flex-wrap items-center gap-4 border-t border-slate-100 pt-5">
            <div className="flex items-center gap-2 text-slate-500">
              <CalendarDays className="h-4 w-4 text-slate-300" />
              <span className="text-[13px] font-medium">Hired <span className="text-slate-900 font-bold">{hiredLabel}</span></span>
            </div>
            <div className="hidden h-4 w-px bg-slate-200 sm:block" />
            <div className="flex items-center gap-2 text-slate-500">
              <ShieldCheck className="h-4 w-4 text-emerald-400" />
              <span className="text-[13px] font-medium">Verified Profile</span>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

export function MedicalRepOverviewPage({ data }: { data: MedicalRepPortalData }) {
  if (data.empty.profile) {
    return <EmptyStateCard message="Your employee profile is not linked yet. Please contact HR." title="Profile Not Linked" />;
  }
  const showTeamLeaveAndStructurePanels = canSeeTeamLeaveAndStructurePanels(data);

  return (
    <div className="space-y-6 lg:space-y-7">
      <ExecutiveCommandStrip data={data} />
      <div className="grid gap-4 lg:gap-5 xl:grid-cols-2">
        <MyActionsPanel data={data} />
        <QuickActionsPanel data={data} />
        {showTeamLeaveAndStructurePanels ? <EmployeesOnLeaveTodayPanel data={data} /> : null}
        {showTeamLeaveAndStructurePanels ? <TeamStructurePanel data={data} /> : null}
      </div>
      <div className="grid gap-4 lg:gap-5 xl:grid-cols-1">
        <OverviewPerformanceChart data={data} />
      </div>
      <div className="grid gap-4 lg:gap-5 xl:grid-cols-1">
        <OverviewInsightsAlerts data={data} />
      </div>
      <div className="grid gap-4 lg:gap-5 xl:grid-cols-[1.55fr_0.9fr]">
        <div className="grid gap-4 lg:gap-5">
          <OverviewTopProducts data={data} />
          <ToReachTargetWidget data={data} />
        </div>
        <TeamRankComparisonWidget data={data} />
      </div>
      <div className="flex justify-center lg:justify-end">
        <Link className="w-full lg:w-auto" href="/employee-portals/sales">
          <Button className="w-full rounded-xl px-5 lg:w-auto" variant="secondary">Open Full Performance</Button>
        </Link>
      </div>
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

export function MedicalRepPayrollPage({ data }: { data: MedicalRepPortalData }) {
  if (data.empty.profile) {
    return <EmptyStateCard message="Your employee profile is not linked yet. Please contact HR." title="Profile Not Linked" />;
  }

  return (
    <>
      <PayrollPayslipsSection data={data} />
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
      <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
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
