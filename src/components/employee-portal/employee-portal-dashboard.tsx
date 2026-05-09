"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Legend,
} from "recharts";
import {
  Activity,
  BadgeCheck,
  Bell,
  BriefcaseBusiness,
  CalendarDays,
  CalendarClock,
  CircleDollarSign,
  CircleDashed,
  CircleHelp,
  Crown,
  Download,
  FileText,
  HeadphonesIcon,
  HelpCircle,
  IdCard,
  Info,
  LineChart as LineChartIcon,
  LogOut,
  MapPin,
  Menu,
  MinusCircle,
  Paperclip,
  Phone,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Target,
  Trophy,
  TrendingDown,
  TrendingUp,
  Upload,
  Users,
  UserRound,
  Wallet,
  Zap,
  Car,
  ReceiptText,
  Filter,
  Calculator,
} from "lucide-react";

import { PhoenixLogo } from "@/components/brand/phoenix-logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { calculateIncentive2026 } from "@/lib/incentives/scheme-2026";
import { toPeriodLabel } from "@/lib/employee-portal/period";
import type { MedicalRepPortalData } from "@/lib/employee-portal/service";

function egp(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

function prettyDate(value: string | null) {
  if (!value) return "Not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(date);
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

function asStatus(value: string) {
  const normalized = value.toLowerCase();
  if (normalized.includes("active") || normalized.includes("approved") || normalized.includes("locked")) return "success" as const;
  if (normalized.includes("pending") || normalized.includes("review")) return "warning" as const;
  if (normalized.includes("rejected") || normalized.includes("terminated")) return "danger" as const;
  return "neutral" as const;
}

function navItemClass(active: boolean) {
  return active
    ? "border-l-2 border-orange-500 bg-orange-50 text-orange-600"
    : "border-l-2 border-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-900";
}

function chartTooltipStyle() {
  return {
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    borderRadius: 12,
    boxShadow: "0 10px 30px rgba(15,23,42,0.08)",
  };
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
    return { badge: "Warning", classes: "bg-rose-50 text-rose-700", icon: TrendingDown };
  }
  return { badge: "Insight", classes: "bg-slate-100 text-slate-700", icon: Info };
}

function sectionTitle(kicker: string, title: string) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500">{kicker}</p>
      <h2 className="mt-2 text-2xl font-semibold text-slate-900">{title}</h2>
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
    <Card className="rounded-3xl border border-slate-100 bg-white p-10 text-center shadow-[0_12px_34px_rgba(15,23,42,0.05)]">
      <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-50 text-slate-500">
        <CircleDashed className="h-5 w-5" />
      </div>
      <p className="mt-4 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">{title}</p>
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
    <div className="rounded-2xl border border-slate-100 bg-white px-4 py-3 shadow-[0_4px_14px_rgba(15,23,42,0.04)] transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_12px_24px_rgba(15,23,42,0.08)]">
      <div className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-[0.1em] text-slate-500">
        <span>{label}</span>
        {tooltip ? (
          <span title={tooltip}>
            <CircleHelp className="h-3.5 w-3.5 text-slate-400" />
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-base font-semibold text-slate-900">{value}</p>
    </div>
  );
}

export function SmartInsightCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Sparkles;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-[0_4px_16px_rgba(15,23,42,0.04)] transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_12px_24px_rgba(15,23,42,0.08)]">
      <div className="flex items-center gap-2 text-slate-700">
        <Icon className="h-4 w-4 text-slate-500" />
        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-slate-500">{label}</p>
      </div>
      <p className="mt-2 text-sm font-semibold text-slate-900">{value}</p>
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
                <BriefcaseBusiness className="h-6 w-6 text-orange-500" />
                <span className="text-[21px] font-medium">{employee.line ?? "Unassigned Line"} Line</span>
              </div>
              <span className="h-2 w-2 rounded-full bg-orange-500/90" />
              <div className="flex items-center gap-2.5">
                <MapPin className="h-6 w-6 text-orange-500" />
                <span className="text-[21px] font-medium">{employee.territory ?? "Unassigned Territory"} Territory</span>
              </div>
              <span className="h-2 w-2 rounded-full bg-orange-500/90" />
              <div className="flex items-center gap-2.5">
                <Users className="h-6 w-6 text-orange-500" />
                <span className="text-[21px] font-medium">Reports to {employee.manager ?? "Unassigned Manager"}</span>
              </div>
            </div>

            <div className="mt-5 h-px w-full bg-slate-200" />

            <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3 text-slate-900">
              <div className="flex items-center gap-2.5">
                <IdCard className="h-7 w-7 text-slate-500" />
                <span className="text-[22px]">HR ID: {employee.hrId}</span>
              </div>

              <span className="h-7 w-px bg-slate-200" />

              <span className={`inline-flex items-center gap-2.5 rounded-full border px-5 py-1.5 text-[22px] font-medium ${statusPillClass}`}>
                {employee.status}
                <span className={`h-3.5 w-3.5 rounded-full ${statusDotClass}`} />
              </span>

              <span className="h-7 w-px bg-slate-200" />

              <div className="flex items-center gap-2.5">
                <CalendarDays className="h-7 w-7 text-slate-500" />
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
          HR ID: {employee.hrId} <span className="text-slate-400">·</span>{" "}
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
                <Badge variant="neutral">HR ID {employee.hrId}</Badge>
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
          percent={sales.overviewAchievementPercent}
          salesValue={sales.overviewSales}
          targetValue={sales.overviewTarget}
        />

        <div className="space-y-3">
          <SmartInsightCard
            icon={CalendarClock}
            label="Contract Renewal"
            value={data.hrContract.daysUntilRenewal === null ? "No renewal date" : `${data.hrContract.daysUntilRenewal} days remaining`}
          />
          <SmartInsightCard
            icon={FileText}
            label="Next Payroll"
            value={payroll.latestBatchStatus ? payroll.latestBatchStatus.replace(/_/g, " ") : "No payroll run"}
          />
          <SmartInsightCard
            icon={Crown}
            label="Rank in Team"
            value={sales.rankInTeam ? `#${sales.rankInTeam.position} / ${sales.rankInTeam.total}` : "Not available"}
          />
          <SmartInsightCard
            icon={Target}
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

function PayrollSummaryPanel({ data }: { data: MedicalRepPortalData }) {
  if (data.empty.payroll) {
    return (
      <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
        <div className="flex h-full flex-col items-center justify-center text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-50 text-slate-500">
            <MinusCircle className="h-5 w-5" />
          </div>
          <p className="mt-3 text-sm font-semibold text-slate-900">Payroll Unavailable</p>
          <p className="mt-1 text-sm text-slate-600">Payslip data has not been uploaded yet.</p>
          <Button className="mt-4" disabled variant="secondary">View Payslip</Button>
        </div>
      </Card>
    );
  }

  const gross = Math.max(1, data.payroll.grossSalary);
  const additionsRatio = Math.min(100, Math.round((Math.max(0, data.payroll.totalAdditions) / gross) * 100));
  const deductionsRatio = Math.min(100, Math.round((Math.max(0, data.payroll.totalDeductions) / gross) * 100));
  const netRatio = Math.min(100, Math.round((Math.max(0, data.payroll.netSalary) / gross) * 100));

  return (
    <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
      <div className="flex items-center justify-between">
        <p className="text-lg font-semibold text-slate-900">Payroll Summary</p>
        <Link className="text-sm font-medium text-orange-600 hover:text-orange-700" href="/employee-portals/payroll">
          View Payslips
        </Link>
      </div>
      <p className="mt-3 text-xs uppercase tracking-[0.12em] text-slate-500">Latest Payslip</p>
      <p className="mt-1 text-sm text-slate-600">{data.payroll.latestBatchLabel}</p>
      <p className="mt-3 text-3xl font-semibold text-slate-900">{egp(data.payroll.netSalary)}</p>
      <p className="text-sm text-slate-500">Net Pay</p>

      <div className="mt-5 space-y-2 rounded-2xl border border-slate-100 bg-slate-50/70 p-3">
        <div className="flex items-center justify-between text-sm"><span className="text-slate-500">Gross</span><span className="font-semibold text-slate-900">{egp(data.payroll.grossSalary)}</span></div>
        <div className="flex items-center justify-between text-sm"><span className="text-slate-500">Additions</span><span className="font-semibold text-emerald-600">{egp(data.payroll.totalAdditions)}</span></div>
        <div className="flex items-center justify-between text-sm"><span className="text-slate-500">Deductions</span><span className="font-semibold text-rose-600">{egp(data.payroll.totalDeductions)}</span></div>
      </div>

      <div className="mt-4 space-y-2">
        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-slate-500"><span>Net Pay</span><span>{netRatio}%</span></div>
          <div className="h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-orange-500" style={{ width: `${netRatio}%` }} /></div>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-slate-500"><span>Additions</span><span>{additionsRatio}%</span></div>
          <div className="h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-emerald-500" style={{ width: `${additionsRatio}%` }} /></div>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-slate-500"><span>Deductions</span><span>{deductionsRatio}%</span></div>
          <div className="h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-rose-400" style={{ width: `${deductionsRatio}%` }} /></div>
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-slate-100 bg-white px-3 py-2 text-sm text-slate-700">
        Incentive = <span className="font-semibold text-slate-900">{additionsRatio}%</span> of your gross pay
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
          const Icon = meta.icon;
          return (
            <div key={insight} className="rounded-2xl border border-slate-100 bg-white px-4 py-3 shadow-[0_4px_14px_rgba(15,23,42,0.04)] transition hover:-translate-y-0.5 hover:shadow-[0_10px_20px_rgba(15,23,42,0.08)]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-slate-700">
                  <Icon className="h-4 w-4" />
                  <span className="text-xs font-medium">Insight</span>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.classes}`}>{meta.badge}</span>
              </div>
              <p className="mt-2 text-sm text-slate-700">{shortInsight(insight)}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function OverviewStatCard({
  accent,
  icon: Icon,
  label,
  note,
  progress,
  value,
}: {
  accent?: "orange" | "green" | "purple" | "blue";
  icon: typeof Target;
  label: string;
  note?: string;
  progress?: number | null;
  value: string;
}) {
  const tone =
    accent === "green"
      ? "text-emerald-600 bg-emerald-50"
      : accent === "purple"
        ? "text-violet-600 bg-violet-50"
        : accent === "blue"
          ? "text-blue-600 bg-blue-50"
          : "text-orange-600 bg-orange-50";
  return (
    <Card className="group rounded-2xl border border-slate-200 bg-white/95 px-5 py-5 shadow-[0_8px_20px_rgba(15,23,42,0.04)] transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_14px_28px_rgba(15,23,42,0.08)]">
       <div className="mb-4 h-0.5 w-8 rounded-full bg-slate-200 transition group-hover:w-12 group-hover:bg-orange-500" />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
       <p className="text-[clamp(1.4rem,2.4vw,2rem)] leading-tight font-semibold tracking-tight text-slate-900">{value}</p>
          <p className="mt-1.5 text-xs font-medium text-slate-500">{label}</p>
          {note ? <p className="mt-1 text-xs text-slate-500">{note}</p> : null}
          {typeof progress === "number" ? (
            <div className="mt-3 h-1.5 rounded-full bg-slate-100">
              <div
                className="h-1.5 rounded-full bg-emerald-500"
                style={{ width: `${Math.max(0, Math.min(100, Math.round(progress)))}%` }}
              />
            </div>
          ) : null}
        </div>
        <div className={`mt-0.5 flex h-9 w-9 items-center justify-center rounded-xl ${tone}`}>
          <Icon className="h-4.5 w-4.5" />
        </div>
      </div>
    </Card>
  );
}

function IncentiveStatusCard({ data }: { data: MedicalRepPortalData }) {
  const achievementPercent = data.sales.overviewAchievementPercent;
  const shortfallPercent = Math.max(0, 90 - achievementPercent);
  const calculation = calculateIncentive2026({
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
       <p className="text-[clamp(1.5rem,2.4vw,1.85rem)] leading-tight font-semibold tracking-tight text-slate-900">
            {isEligible ? egp(calculation.payoutAmount) : "Below Threshold"}
          </p>
          <p className="mt-1.5 text-xs font-medium text-slate-500">2026 Incentive Scheme</p>
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

function IncentiveCalculatorWidget({ data }: { data: MedicalRepPortalData }) {
  const calculatedNetSalary = Math.max(
    0,
    (data.payroll.grossSalary || 0) - (data.payroll.socialInsurance || 0) - (data.payroll.incomeTax || 0),
  );
  const calculatedBasicSalary = Math.max(0, calculatedNetSalary * 0.7);
  const simNetSalary = calculatedNetSalary;
  const [simAchievement, setSimAchievement] = useState(data.sales.overviewAchievementPercent || 100);

  const calc = calculateIncentive2026({
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
        <div className="flex items-center gap-1 text-[10px] text-slate-400">
          <Info className="h-3 w-3" />
          <span>Simulation only</span>
        </div>
      }
    >
      <div className="space-y-6">
        <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-600">Actual Net Salary (formula)</span>
            <span className="font-medium text-slate-900">{egp(calculatedNetSalary)}</span>
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-600">Basic Salary</span>
            <span className="font-medium text-slate-900">{egp(calculatedBasicSalary)}</span>
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
              <p className="text-2xl font-bold text-emerald-400">{egp(calc.payoutAmount)}</p>
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
  const target = Math.max(0, data.sales.currentMonthTarget);
  const current = Math.max(0, data.sales.currentMonthSales);
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
              <span className="font-semibold text-slate-900">{percent.toFixed(1)}%</span> current achievement
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
        <p className="text-lg font-semibold text-slate-900">Incentive Scheme 2026</p>
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
          <li>Above 120%: add +3% per 1%, achievement capped at 150%</li>
        </ul>
      </div>
    </Card>
  );
}

export function EmployeePortalIncentivePage({ data }: { data: MedicalRepPortalData }) {
  if (data.empty.profile) {
    return <EmptyStateCard message="Your employee profile is not linked yet. Please contact HR." title="Profile Not Linked" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-semibold text-slate-900">Incentive</h1>
          <p className="mt-1 text-sm text-slate-500">Calculate your incentive and review the 2026 scheme rules</p>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.2fr_1fr]">
        <IncentiveSchemeDescriptionCard />
        <IncentiveStatusCard data={data} />
      </div>
      <IncentiveCalculatorWidget data={data} />
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
            className="w-full max-w-xs rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm"
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
            className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm"
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
        {rows.map((row) => (
          <div key={`${row.position}-${row.name}`} className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 w-7 text-sm font-semibold text-slate-700">#{row.position}</span>
              <span className="truncate text-sm text-slate-700">{row.name}</span>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-sm font-semibold text-slate-900">{row.achievementPercent.toFixed(1)}%</p>
              <p className="whitespace-nowrap text-[11px] text-slate-500">{egp(row.sales)} / {egp(row.target)}</p>
            </div>
          </div>
        ))}
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
    <Card className="flex h-full flex-col rounded-3xl border border-slate-100 bg-white p-4 lg:p-6 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
      <div className="mb-4 lg:mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-orange-500/80" />
          <p className="text-base lg:text-lg font-semibold text-slate-900">{title}</p>
        </div>
        {action}
      </div>
      <div className="flex-1 min-w-0">{children}</div>
    </Card>
  );
}

function OverviewInsightsAlerts({ data }: { data: MedicalRepPortalData }) {
  const remainingTargetPercent = Math.max(0, 100 - data.sales.achievementPercent);
  const topProduct = data.sales.productContribution[0];
  const totalTopSales = data.sales.productContribution.reduce((sum, p) => sum + p.value, 0);
  const topProductContribution = topProduct && totalTopSales > 0 ? (topProduct.value / totalTopSales) * 100 : 0;

  const raw = [
    data.sales.achievementPercent < 100
      ? `You are ${Math.max(0, 100 - data.sales.achievementPercent).toFixed(1)}% towards your monthly target.`
      : "You have reached your monthly target.",
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
  const rows = data.sales.productContribution.slice(0, 4);
  const max = Math.max(1, ...rows.map((row) => row.value));
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  
  return (
    <OverviewPagePanel
      title="Top Products"
      action={<Button className="h-8 px-3 text-xs" variant="secondary">View All</Button>}
    >
      <div className="space-y-3">
        {rows.length === 0 ? (
          <p className="text-sm text-slate-500">No product contribution data.</p>
        ) : rows.map((row) => {
          const width = Math.max(8, Math.round((row.value / max) * 100));
          const contributionPercent = total > 0 ? (row.value / total) * 100 : 0;
          return (
            <div key={row.name}>
              <div className="mb-1 flex items-center justify-between text-sm">
                <div className="flex flex-col">
                  <span className="font-medium text-slate-700">{row.name}</span>
                  <span className="text-[10px] text-slate-500">{contributionPercent.toFixed(1)}% of top 4</span>
                </div>
                <span className="font-semibold text-slate-900">{egp(row.value)}</span>
              </div>
              <div className="h-2 rounded-full bg-slate-100">
                <div className="h-2 rounded-full bg-orange-500" style={{ width: `${width}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </OverviewPagePanel>
  );
}

function OverviewAchievementByLine({ data }: { data: MedicalRepPortalData }) {
  const palette = ["#f97316", "#3b82f6", "#22c55e", "#f59e0b", "#8b5cf6", "#06b6d4", "#ef4444", "#14b8a6"];
  const rows = [...data.sales.familyContribution].sort((a, b) => b.value - a.value);
  const source = rows.map((row, index) => ({
    name: row.name,
    value: row.value,
    color: palette[index % palette.length],
  }));
  const total = Math.max(1, source.reduce((sum, row) => sum + row.value, 0));
  const currentMonth = data.sales.currentMonthLabel;
  
  return (
    <Link className="flex h-full flex-col" href={`/employee-portals/sales?source=dashboard&month=${currentMonth}`}>
      <motion.div
        layoutId="sales-performance-family"
        className="flex h-full flex-col"
        whileHover={{ scale: 1.01 }}
        transition={{ duration: 0.2 }}
      >
        <OverviewPagePanel title="Achievement by Product Family">
          <div className="grid gap-3 md:grid-cols-[0.9fr_1.1fr]">
            <div className="relative h-56">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={source} dataKey="value" innerRadius={60} outerRadius={84} paddingAngle={1}>
                    {source.map((item) => (
                      <Cell key={item.name} fill={item.color} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={chartTooltipStyle()} formatter={(v: unknown) => egp(Number(v ?? 0))} />
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <p className="text-[22px] font-semibold tracking-tight text-slate-900">
                  {new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(data.sales.currentMonthSales)}
                </p>
                <p className="text-[11px] text-slate-500">EGP Achievement</p>
              </div>
            </div>
            <div className="space-y-2 pt-2">
              {source.map((row) => {
                const percent = Math.max(0, Math.round((row.value / total) * 100));
                return (
                  <div key={row.name} className="flex items-center justify-between gap-3 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: row.color }} />
                      <span className="text-slate-700">{row.name}</span>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold text-slate-900">{percent}%</p>
                      <p className="text-xs text-slate-500">{egp(row.value)}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </OverviewPagePanel>
      </motion.div>
    </Link>
  );
}

function OverviewPerformanceChart({ data }: { data: MedicalRepPortalData }) {
  const currentMonth = data.sales.currentMonthLabel;
  
  return (
    <Link className="flex h-full flex-col" href={`/employee-portals/sales?source=dashboard&month=${currentMonth}`}>
      <motion.div
        layoutId="sales-performance-chart"
        className="flex h-full flex-col"
        whileHover={{ scale: 1.01 }}
        transition={{ duration: 0.2 }}
      >
        <OverviewPagePanel
          title="Performance Overview"
          action={<div className="rounded-lg border border-slate-200 px-3 py-1 text-xs text-slate-600">This Month</div>}
        >
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.sales.trend}>
                <defs>
                  <linearGradient id="overviewSalesFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f97316" stopOpacity={0.16} />
                    <stop offset="95%" stopColor="#f97316" stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                <XAxis dataKey="period" tickFormatter={periodLabel} stroke="#64748b" />
                <YAxis stroke="#64748b" tickFormatter={(value) => `${Math.round(Number(value) / 1000)}k`} />
                <Tooltip
                  contentStyle={chartTooltipStyle()}
                  cursor={{ stroke: "#cbd5e1", strokeDasharray: "3 3" }}
                  formatter={(value: unknown) => tooltipCurrency(value)}
                  labelFormatter={(value) => `Period: ${periodLabel(String(value))}`}
                />
                <Area dataKey="sales" name="Achievement" stroke="#f97316" strokeWidth={2.5} fill="url(#overviewSalesFill)" activeDot={{ r: 4 }} type="monotone" />
                <Area dataKey="target" name="Target" stroke="#94a3b8" strokeDasharray="4 4" fillOpacity={0} type="monotone" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </OverviewPagePanel>
      </motion.div>
    </Link>
  );
}

export function SalesPerformanceSection({ data }: { data: MedicalRepPortalData }) {
  const chartColors = ["#f97316", "#f59e0b", "#fdba74", "#94a3b8", "#cbd5e1"];
  const trendData = data.sales.trend;
  const salesMissing = data.empty.sales;

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
              <MetricCard label="Rank" value={data.sales.rankInTeam ? `#${data.sales.rankInTeam.position}/${data.sales.rankInTeam.total}` : "N/A"} />
              <MetricCard label="Top Product" value={data.sales.topProduct ?? "N/A"} />
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <Card className="rounded-3xl border border-slate-100 bg-white p-5 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
                <div className="mb-3 flex items-center gap-2">
                  <LineChartIcon className="h-4 w-4 text-slate-500" />
                  <p className="text-sm font-semibold text-slate-900">Sales Trend</p>
                </div>
                <div className="h-64 w-full min-w-0">
                  {trendData && trendData.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={trendData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="salesFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#f97316" stopOpacity={0.16} />
                            <stop offset="95%" stopColor="#f97316" stopOpacity={0.01} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                        <XAxis dataKey="period" tickFormatter={periodLabel} stroke="#64748b" />
                        <YAxis stroke="#64748b" tickFormatter={(value) => `${Math.round(Number(value) / 1000)}k`} />
                        <Tooltip
                          contentStyle={chartTooltipStyle()}
                          formatter={(value: unknown) => tooltipCurrency(value)}
                          labelFormatter={(value) => `Period: ${periodLabel(String(value))}`}
                        />
                        <Area dataKey="target" name="Target" stroke="#94a3b8" fill="#cbd5e1" fillOpacity={0.18} />
                        <Area dataKey="sales" name="Sales" stroke="#f97316" fill="url(#salesFill)" />
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="flex h-full items-center justify-center">
                      <p className="text-sm text-slate-500">No trend data available</p>
                    </div>
                  )}
                </div>
              </Card>

              <Card className="rounded-3xl border border-slate-100 bg-white p-5 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
                <p className="mb-3 text-sm font-semibold text-slate-900">Sales vs Target</p>
                <div className="h-64 w-full min-w-0">
                  {trendData && trendData.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={trendData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                        <XAxis dataKey="period" tickFormatter={periodLabel} stroke="#64748b" />
                        <YAxis stroke="#64748b" tickFormatter={(value) => `${Math.round(Number(value) / 1000)}k`} />
                        <Tooltip contentStyle={chartTooltipStyle()} formatter={(value: unknown) => tooltipCurrency(value)} />
                        <Bar dataKey="sales" name="Sales" fill="#f97316" radius={[6, 6, 0, 0]} />
                        <Bar dataKey="target" name="Target" fill="#94a3b8" radius={[6, 6, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="flex h-full items-center justify-center">
                      <p className="text-sm text-slate-500">No trend data available</p>
                    </div>
                  )}
                </div>
              </Card>
            </div>

            <Card className="rounded-3xl border border-slate-100 bg-white p-5 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
              <p className="mb-3 text-sm font-semibold text-slate-900">Product Mix & Contribution</p>
              <div className="grid gap-4 md:grid-cols-[1fr_1fr]">
                <div className="h-56 w-full min-w-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                      <Pie
                        data={data.sales.productContribution}
                        dataKey="value"
                        innerRadius={54}
                        outerRadius={84}
                        paddingAngle={2}
                        nameKey="name"
                      >
                        {data.sales.productContribution.map((entry, index) => (
                          <Cell key={entry.name} fill={chartColors[index % chartColors.length]} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={chartTooltipStyle()} formatter={(value: unknown) => tooltipCurrency(value)} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="flex flex-col justify-center space-y-2">
                  {data.sales.productContribution.slice(0, 5).map((p, i) => (
                    <div key={p.name} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-2 rounded-full" style={{ backgroundColor: chartColors[i % chartColors.length] }} />
                        <span className="max-w-[120px] truncate text-slate-600" title={p.name}>{p.name}</span>
                      </div>
                      <div className="flex gap-3">
                        <span className="font-semibold text-slate-900">{(p.percentage || 0).toFixed(1)}%</span>
                        <span className="text-slate-400">{egp(p.value)}</span>
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

export function PayrollPayslipsSection({ data }: { data: MedicalRepPortalData }) {
  const payrollMissing = data.empty.payroll;

  return (
    <section id="payroll" className="space-y-4">
      {sectionTitle("Payroll & Payslips", "Compensation and Monthly Payslips")}

      {payrollMissing ? (
        <Card className="rounded-3xl border border-slate-100 bg-white p-10 shadow-[0_14px_30px_rgba(15,23,42,0.05)]">
          <div className="mx-auto flex max-w-lg flex-col items-center text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-50 text-slate-500">
              <MinusCircle className="h-5 w-5" />
            </div>
            <p className="mt-4 text-sm font-semibold text-slate-900">Payroll Unavailable</p>
            <p className="mt-1 text-sm text-slate-600">Payslip data has not been uploaded yet.</p>
            <Button className="mt-5" disabled variant="secondary">View Payslip</Button>
          </div>
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
          <Card className="rounded-3xl border border-slate-100 bg-white p-5 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
            <p className="text-sm font-semibold text-slate-900">Latest Payslip Summary</p>
            <p className="mt-1 text-xs text-slate-500">{data.payroll.latestBatchLabel}</p>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <MetricCard label="Gross Salary" value={egp(data.payroll.grossSalary)} />
              <MetricCard label="Net Salary" value={egp(data.payroll.netSalary)} tooltip="Final net salary" />
              <MetricCard label="Total Additions" value={egp(data.payroll.totalAdditions)} tooltip="Total additions" />
              <MetricCard label="Total Deductions" value={egp(data.payroll.totalDeductions)} tooltip="Total deductions" />
              <MetricCard label="First Part" value={egp(data.payroll.firstPart)} />
              <MetricCard label="Second Part" value={egp(data.payroll.secondPart)} />
              <MetricCard label="Statutory Deductions" value={egp(data.payroll.statutoryDeductions)} />
              <MetricCard label="Internal Deductions" value={egp(data.payroll.internalDeductions)} />
            </div>
          </Card>

          <Card className="rounded-3xl border border-slate-100 bg-white p-5 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-900">Payslip History</p>
              <Badge variant={asStatus(data.payroll.latestBatchStatus ?? "unknown")}>
                {(data.payroll.latestBatchStatus ?? "unknown").replace(/_/g, " ")}
              </Badge>
            </div>
            <div className="max-h-[340px] overflow-auto rounded-2xl border border-slate-100">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-[0.12em] text-slate-500">
                    <th className="px-3 py-2">Month</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {data.payroll.payslipRows.map((row) => (
                    <tr key={row.id} className="border-b border-slate-100">
                      <td className="px-3 py-2 font-semibold text-slate-900">{row.label}</td>
                      <td className="px-3 py-2">
                        <Badge variant={asStatus(row.status)}>{row.status.replace(/_/g, " ")}</Badge>
                      </td>
                      <td className="px-3 py-2">
                        <Link href={`/api/payroll/${row.id}/payslips`} target="_blank">
                          <Button className="h-8 px-3 text-xs" variant="secondary">View payslip</Button>
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </section>
  );
}

export function EarningsPage({ data }: { data: MedicalRepPortalData }) {
  if (data.empty.payroll) {
    return (
      <Card className="rounded-3xl border border-slate-100 bg-white p-10 shadow-[0_14px_30px_rgba(15,23,42,0.05)]">
        <div className="mx-auto flex max-w-lg flex-col items-center text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-50 text-slate-500">
            <CircleDashed className="h-5 w-5" />
          </div>
          <p className="mt-4 text-sm font-semibold text-slate-900">Earnings Unavailable</p>
          <p className="mt-1 text-sm text-slate-600">Payslip data has not been uploaded yet.</p>
        </div>
      </Card>
    );
  }

  const latestRecord = data.payroll;
  const netEarnings = latestRecord.netSalary;
  const basicSalary = latestRecord.basicSalary;
  const currentIncentive = latestRecord.allPeriodsIncentive;
  const incentiveTarget = latestRecord.allPeriodsIncentiveTarget;
  const grossSalary = latestRecord.grossSalary;
  const totalAdditions = latestRecord.totalAdditions;
  const payrollTaxes = latestRecord.incomeTax > 0
    ? latestRecord.incomeTax
    : Math.max(0, grossSalary - latestRecord.socialInsurance - netEarnings);
  const additionsRatio = grossSalary > 0 ? (totalAdditions / grossSalary) * 100 : 0;
  const netToGrossPercent = grossSalary > 0 ? (netEarnings / grossSalary) * 100 : 0;

  const netVsLastMonth = data.payroll.netVsLastMonth;
  const baseVsLastMonth = data.payroll.grossVsLastMonth;

  const achievementPercent = latestRecord.allPeriodsAchievementPercent ?? data.sales.overviewAchievementPercent;
  const salesGap = Math.max(0, (data.sales.overviewTarget ?? 0) - (data.sales.overviewSales ?? 0));

  const trendData = data.payroll.salaryTrend.length > 0
    ? data.payroll.salaryTrend.map(point => ({
        month: String(point.month),
        totalPaid: point.netSalary,
      }))
    : [
      {
        month: data.payroll.latestBatchLabel ?? "No data",
        totalPaid: netEarnings,
      },
    ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold text-slate-900">Earnings</h1>
          <p className="mt-1 text-sm text-slate-500">Overview of your earnings, incentives, and deductions</p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <EarningsKPICard
          label="Net Earnings (This Month)"
          subLabel="Take Home Pay"
          value={egp(netEarnings)}
          delta={netVsLastMonth}
          icon={Wallet}
        />
        <EarningsKPICard
          label="Basic Salary"
          subLabel="Fixed Pay"
          value={egp(basicSalary)}
          delta={baseVsLastMonth}
          icon={BriefcaseBusiness}
        />
        <EarningsKPICard
          label="Earnings Key"
          subLabel="Net-to-Gross"
          value={`${netToGrossPercent.toFixed(1)}%`}
          delta={null}
          icon={CircleDollarSign}
        />
        <EarningsKPICard
          label="Additions Share"
          subLabel="Incentives + Bonuses %"
          value={`${additionsRatio.toFixed(1)}%`}
          delta={null}
          icon={Sparkles}
        />
      </div>

      <div className="grid gap-6">
        <EarningsTrendCard data={trendData} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <IncentiveBlock
          achievementPercent={achievementPercent}
          currentIncentive={currentIncentive}
          incentiveTarget={incentiveTarget}
          salesGap={salesGap}
        />
        <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
          <div className="mb-4">
            <p className="text-sm font-semibold text-slate-900">Latest Payroll Snapshot</p>
            <p className="text-xs text-slate-500">
              {data.payroll.latestBatchLabel ?? "Payroll details"}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <MetricCard label="Gross Salary" value={egp(data.payroll.grossSalary)} />
            <MetricCard label="Insurance" value={egp(data.payroll.socialInsurance)} />
            <MetricCard label="Taxes" value={egp(payrollTaxes)} />
            <MetricCard label="Net Salary" value={egp(data.payroll.netSalary)} />
          </div>
        </Card>
      </div>

      <NotificationsSection />
    </div>
  );
}

function EarningsKPICard({
  delta,
  icon: Icon,
  label,
  subLabel,
  value,
  isDeduction = false,
}: {
  delta: number | null;
  icon: typeof Wallet;
  label: string;
  subLabel: string;
  value: string;
  isDeduction?: boolean;
}) {
  const deltaColor = delta === null ? "text-slate-500" : delta > 0 ? "text-emerald-600" : "text-rose-600";
  const deltaPrefix = delta === null ? "" : delta > 0 ? "+" : "";

  return (
       <Card className="group rounded-2xl border border-slate-200 bg-white/95 px-4 py-4 shadow-[0_8px_20px_rgba(15,23,42,0.04)] transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_14px_28px_rgba(15,23,42,0.08)]">
      <div className="mb-4 h-0.5 w-8 rounded-full bg-slate-200 transition group-hover:w-12 group-hover:bg-orange-500" />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
           <p className="min-w-0 text-[clamp(1.5rem,2.4vw,2rem)] leading-tight font-semibold tracking-tight text-slate-900 break-words">{value}</p>
           <p className="mt-1.5 text-[11px] font-medium text-slate-500">{label}</p>
           <p className="mt-0.5 text-[10px] leading-snug text-slate-400">{subLabel}</p>
          {delta !== null && (
            <p className={`mt-2 text-sm font-medium ${deltaColor}`}>
              {deltaPrefix}{delta.toFixed(1)}% vs last month
            </p>
          )}
        </div>
        <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${isDeduction ? "bg-rose-50 text-rose-600" : "bg-orange-50 text-orange-600"}`}>
          <Icon className="h-4.5 w-4.5" />
        </div>
      </div>
    </Card>
  );
}

function EarningsTrendCard({ data }: { data: Array<{ month: string; totalPaid: number }> }) {
  const hasData = data && data.length > 0;

  return (
    <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
      <div className="mb-4 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-orange-500/80" />
        <p className="text-lg font-semibold text-slate-900">Earnings Trend</p>
      </div>
      {!hasData ? (
        <div className="rounded-2xl border border-slate-100 bg-slate-50/70 px-4 py-6 text-sm text-slate-600">
          Trend data is being prepared. Please check back after this month&rsquo;s payroll is finalized.
        </div>
      ) : (
      <div className="h-[280px] w-full min-w-0 overflow-hidden">
        <ResponsiveContainer height="100%" width="100%">
            <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <defs>
              <linearGradient id="totalPaidGradient" x1="0" x2="0" y1="0" y2="1">
                <stop offset="5%" stopColor="#f97316" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#f97316" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
            <XAxis
              axisLine={false}
              dataKey="month"
              stroke="#94a3b8"
              style={{ fontSize: 12 }}
              tickLine={false}
            />
            <YAxis
              axisLine={false}
              stroke="#94a3b8"
              style={{ fontSize: 12 }}
              tickLine={false}
              tickFormatter={(value) => `EGP ${value / 1000}k`}
            />
            <Tooltip
              contentStyle={chartTooltipStyle()}
              formatter={(value) => egp(Number(value))}
            />
            <Area
              dataKey="totalPaid"
              fill="url(#totalPaidGradient)"
              name="Total Paid"
              stroke="#f97316"
              strokeWidth={2}
              type="monotone"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      )}
    </Card>
  );
}

function IncentiveBlock({
  achievementPercent,
  currentIncentive,
  incentiveTarget,
  salesGap,
}: {
  achievementPercent: number;
  currentIncentive: number;
  incentiveTarget: number;
  salesGap: number;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(achievementPercent)));
  const needsUnlockPercent = Math.max(0, 90 - achievementPercent);
  const circleStyle = {
    background: `conic-gradient(#f97316 ${clamped * 3.6}deg, #edf0f4 0deg)`,
  };
  const isEligible = achievementPercent >= 90;

  return (
    <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
      <div className="mb-4 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-orange-500/80" />
        <p className="text-lg font-semibold text-slate-900">Incentive Achievement</p>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <div className="flex flex-col items-center">
          <div className="relative flex h-[200px] w-[200px] items-center justify-center rounded-full" style={circleStyle}>
            <div className="flex h-[160px] w-[160px] flex-col items-center justify-center rounded-full bg-white shadow-[inset_0_0_0_1px_rgba(15,23,42,0.06)]">
              <p className="text-[48px] font-semibold leading-none text-slate-950">{clamped}%</p>
              <p className="mt-1 text-[11px] font-medium uppercase tracking-[0.1em] text-slate-500">Achievement</p>
            </div>
          </div>
           <p className="mt-4 text-2xl font-semibold text-slate-900">{egp(currentIncentive)}</p>
        </div>
        <div className="flex flex-col justify-center space-y-4">
          <div className="rounded-2xl border border-slate-100 bg-slate-50/70 p-4">
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-slate-500">To increase your incentive</p>
            {!isEligible ? (
              <p className="mt-2 text-sm text-slate-700">
                You are <span className="font-semibold text-orange-600">{needsUnlockPercent.toFixed(1)}%</span> away from the 90% unlock threshold.
              </p>
            ) : salesGap > 0 ? (
              <>
                <p className="mt-2 text-sm text-slate-600">
                  You are <span className="font-semibold text-orange-600">{egp(salesGap)}</span> away from reaching your target.
                </p>
                <p className="mt-2 text-sm text-slate-700">
                  Focus on top performing products to increase incentive
                </p>
              </>
            ) : (
              <p className="mt-2 text-sm text-slate-600">
                Great job! You have reached your target and are now in over-achievement.
              </p>
            )}
          </div>
          <Button className="w-full rounded-xl" variant="secondary">
            View Incentive Plan
          </Button>
        </div>
      </div>
    </Card>
  );
}

function PayslipPreviewCard({
  bankAccount,
  month,
  netEarnings,
  payPeriod,
  paymentDate,
}: {
  bankAccount: string;
  month: string;
  netEarnings: number;
  payPeriod: string;
  paymentDate: string;
}) {
  return (
    <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
      <div className="mb-4 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-orange-500/80" />
        <p className="text-lg font-semibold text-slate-900">Payslip Preview</p>
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50/70 px-4 py-3">
          <span className="text-sm text-slate-500">Month</span>
          <span className="text-sm font-semibold text-slate-900">{month}</span>
        </div>
        <div className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50/70 px-4 py-3">
          <span className="text-sm text-slate-500">Net Earnings</span>
          <span className="text-sm font-semibold text-orange-600">{egp(netEarnings)}</span>
        </div>
        <div className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50/70 px-4 py-3">
          <span className="text-sm text-slate-500">Pay Period</span>
          <span className="text-sm font-semibold text-slate-900">{payPeriod}</span>
        </div>
        <div className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50/70 px-4 py-3">
          <span className="text-sm text-slate-500">Payment Date</span>
          <span className="text-sm font-semibold text-slate-900">{paymentDate}</span>
        </div>
        <div className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50/70 px-4 py-3">
          <span className="text-sm text-slate-500">Bank Account</span>
          <span className="text-sm font-semibold text-slate-900">{bankAccount}</span>
        </div>
      </div>
      <Button className="mt-4 w-full rounded-xl" variant="secondary">
        View Full Payslip
      </Button>
    </Card>
  );
}

function NotificationsSection() {
  const notifications = [
    {
      icon: BadgeCheck,
      title: "Incentive approved",
      description: "Your incentive for this month has been approved",
      date: "2 days ago",
    },
    {
      icon: FileText,
      title: "Payslip available",
      description: "Your payslip for this month is now available",
      date: "3 days ago",
    },
    {
      icon: MinusCircle,
      title: "Loan deduction applied",
      description: "Loan deduction of EGP 500 applied this month",
      date: "5 days ago",
    },
  ];

  return (
    <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
      <div className="mb-4 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-orange-500/80" />
        <p className="text-lg font-semibold text-slate-900">Notifications</p>
      </div>
      <div className="space-y-3">
        {notifications.map((notification) => {
          const Icon = notification.icon;
          return (
            <div key={notification.title} className="flex items-start gap-3 rounded-xl border border-slate-100 bg-slate-50/70 px-4 py-3 transition hover:bg-slate-50">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-orange-50 text-orange-600">
                <Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-900">{notification.title}</p>
                <p className="mt-0.5 text-xs text-slate-600">{notification.description}</p>
                <p className="mt-1 text-[11px] text-slate-400">{notification.date}</p>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function ContactHRSupportPage({ data }: { data: MedicalRepPortalData }) {
  const [category, setCategory] = useState("");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  const hrTeam: { name: string; role: string; email: string; phone?: string; avatar?: string }[] = [
    {
      name: "Omar Anwar Gawish",
      role: "HR Section Head",
      email: "omar.anwar@satopharma.com",
      phone: "01280955558",
      avatar: "/images/hr/omar-anwar-gawish.jpg",
    },
    {
      name: "Youmna Kotb",
      role: "Talent Acquisition",
      email: "youmna.kotb@satopharma.com",
      phone: "01123566677",
      avatar: "/images/hr/youmna-kotb.jpg",
    },
    {
      name: "Nada Ali",
      role: "Office Coordinator",
      email: "head.office@satopharma.com",
      phone: "01144333347",
      avatar: "/images/hr/nada-ali.jpg",
    },
  ];

  const recentRequests: { id: string; subject: string; category: string; status: string; date: string }[] = [];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setTimeout(() => {
      setIsSubmitting(false);
      setShowSuccess(true);
      setCategory("");
      setSubject("");
      setDescription("");
      setTimeout(() => setShowSuccess(false), 3000);
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
        <p className="mt-1 text-sm text-slate-500">Submit a support request or contact HR for assistance</p>
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
                <div key={member.email} className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50/70 px-4 py-3 transition hover:bg-slate-50">
                  <div className="flex items-start gap-3">
                    <div className="shrink-0 overflow-hidden rounded-lg ring-2 ring-orange-100"
                      style={{ width: "2cm", height: "3cm" }}>
                      {member.avatar ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={member.avatar}
                          alt={member.name}
                          className="h-full w-full object-cover object-top"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center bg-orange-100 text-sm font-semibold text-orange-700">
                          {member.name.split(" ").map(n => n[0]).join("")}
                        </div>
                      )}
                    </div>
                    <div>
                    <p className="text-sm font-semibold text-slate-900">{member.name}</p>
                    <p className="text-xs text-slate-500">{member.role}</p>
                    <div className="mt-1 flex flex-col gap-0.5">
                      <p className="text-[10px] text-slate-400">{member.email}</p>
                      {member.phone && <p className="text-[10px] font-medium text-orange-600/80">{member.phone}</p>}
                    </div>
                  </div>
                  </div>
                  <Button
                    className="h-8 rounded-lg text-xs"
                    variant="secondary"
                    onClick={() => window.location.href = `mailto:${member.email}`}
                  >
                    <Send className="mr-1.5 h-3 w-3" />
                    Email
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

          <p className="mt-4 text-xs text-slate-500 italic">For urgent HR matters, please contact one of the HR team members above.</p>
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
        <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
          <div className="mb-4 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-orange-500/80" />
            <p className="text-lg font-semibold text-slate-900">Workload Overview</p>
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
          <div className="mt-6 h-64">
            <ResponsiveContainer height="100%" width="100%">
              <AreaChart data={tripsVsDistanceTrend}>
                <defs>
                  <linearGradient id="tripsGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f97316" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#f97316" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="month" stroke="#94a3b8" style={{ fontSize: 12 }} tickLine={false} />
                <YAxis stroke="#94a3b8" style={{ fontSize: 12 }} tickLine={false} />
                <Tooltip contentStyle={chartTooltipStyle()} />
                <Area dataKey="trips" fill="url(#tripsGradient)" name="Trips" stroke="#f97316" strokeWidth={2} type="monotone" />
                <Area dataKey="distance" fill="none" name="Distance (km)" stroke="#94a3b8" strokeWidth={2} strokeDasharray="5 5" type="monotone" />
                <Legend />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
          <div className="mb-4 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-orange-500/80" />
            <p className="text-lg font-semibold text-slate-900">Workload Distribution</p>
          </div>
          <div className="grid gap-4 md:grid-cols-[1fr_1fr]">
            <div className="h-64">
              <ResponsiveContainer height="100%" width="100%">
                <PieChart>
                  <Pie
                    data={workloadDistribution}
                    dataKey="value"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={2}
                    nameKey="name"
                  >
                    {workloadDistribution.map((entry) => (
                      <Cell key={entry.name} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={chartTooltipStyle()} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="flex flex-col justify-center space-y-3">
              {workloadDistribution.map((item) => (
                <div key={item.name} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="h-3 w-3 rounded-full" style={{ backgroundColor: item.color }} />
                    <span className="text-sm text-slate-600">{item.name}</span>
                  </div>
                  <span className="text-sm font-semibold text-slate-900">{item.value}</span>
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
        <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
          <div className="mb-4 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-orange-500/80" />
            <p className="text-lg font-semibold text-slate-900">Expense Analysis</p>
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
          <div className="mt-6 h-48">
            <ResponsiveContainer height="100%" width="100%">
              <AreaChart data={expenseTrend}>
                <defs>
                  <linearGradient id="expenseTrendGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f97316" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#f97316" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="month" stroke="#94a3b8" style={{ fontSize: 12 }} tickLine={false} />
                <YAxis stroke="#94a3b8" style={{ fontSize: 12 }} tickLine={false} tickFormatter={(value) => `EGP ${(value / 1000).toFixed(0)}k`} />
                <Tooltip contentStyle={chartTooltipStyle()} formatter={(value) => egp(Number(value))} />
                <Area dataKey="expenses" fill="url(#expenseTrendGradient)" name="Expenses" stroke="#f97316" strokeWidth={2} type="monotone" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
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
          <a className="text-xs font-medium text-orange-600 hover:text-orange-700" href="#">View All Trips &gt;</a>
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

export function IdentityCard({ data }: { data: MedicalRepPortalData }) {
  const employee = data.employee;
  const hiredLabel = prettyDate(data.hrContract.hireDate);
  const statusVariant = asStatus(employee.status);

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
    <div className="rounded-[28px] border border-slate-200 bg-white px-5 py-5 shadow-[0_8px_28px_rgba(15,23,42,0.05)] lg:px-8 lg:py-6">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center">

        {/* Avatar circle */}
        <div className="flex h-[80px] w-[80px] lg:h-[112px] lg:w-[112px] shrink-0 items-center justify-center rounded-full border-2 border-orange-100 bg-orange-50/40">
          <div className="flex h-[56px] w-[56px] lg:h-[72px] lg:w-[72px] items-center justify-center rounded-full bg-orange-500/10 text-orange-500">
            <UserRound className="h-6 w-6 lg:h-9 lg:w-9" />
          </div>
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">

          {/* Name + role */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h1 className="text-[22px] lg:text-[28px] font-bold leading-tight tracking-[-0.01em] text-slate-900">
              {employee.fullName}
            </h1>
            <span className="hidden lg:block h-2 w-2 shrink-0 rounded-full bg-orange-500" />
            <p className="text-[14px] lg:text-[17px] font-medium text-slate-400">{employee.roleLabel}</p>
          </div>

          {/* Line · Territory · Manager */}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 lg:mt-3.5 lg:gap-x-5">
            <div className="flex items-center gap-1.5 text-slate-700 lg:gap-2">
              <BriefcaseBusiness className="h-4 w-4 lg:h-[18px] lg:w-[18px] shrink-0 text-orange-500" />
              <span className="text-[12px] lg:text-[14px] font-medium">{employee.line ?? "Unassigned"} Line</span>
            </div>
            <span className="hidden lg:block h-1.5 w-1.5 shrink-0 rounded-full bg-orange-400/60" />
            <div className="flex items-center gap-1.5 text-slate-700 lg:gap-2">
              <MapPin className="h-4 w-4 lg:h-[18px] lg:w-[18px] shrink-0 text-orange-500" />
              <span className="text-[12px] lg:text-[14px] font-medium">{employee.territory ?? "Unassigned"} Territory</span>
            </div>
            <span className="hidden lg:block h-1.5 w-1.5 shrink-0 rounded-full bg-orange-400/60" />
            <div className="flex items-center gap-1.5 text-slate-700 lg:gap-2">
              <Users className="h-4 w-4 lg:h-[18px] lg:w-[18px] shrink-0 text-orange-500" />
              <span className="text-[12px] lg:text-[14px] font-medium">Reports to {employee.manager ?? "Unassigned"}</span>
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 h-px w-full bg-slate-200" />

          {/* HR ID | Active | Hired */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3 lg:gap-x-5 lg:gap-y-2">
            <div className="flex items-center gap-2">
              <IdCard className="h-4 w-4 lg:h-[18px] lg:w-[18px] shrink-0 text-slate-400" />
              <span className="text-[12px] lg:text-[14px] text-slate-600">HR ID: {employee.hrId}</span>
            </div>

            <span className="hidden lg:block h-5 w-px shrink-0 bg-slate-200" />

            <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-0.5 text-[11px] lg:px-3.5 lg:text-[13px] font-semibold ${statusPillClass}`}>
              {employee.status}
              <span className={`h-2 w-2 lg:h-2.5 lg:w-2.5 shrink-0 rounded-full ${statusDotClass}`} />
            </span>

            <span className="hidden lg:block h-5 w-px shrink-0 bg-slate-200" />

            <div className="flex items-center gap-2">
              <CalendarDays className="h-4 w-4 lg:h-[18px] lg:w-[18px] shrink-0 text-slate-400" />
              <span className="text-[12px] lg:text-[14px] text-slate-600">Hired {hiredLabel}</span>
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

  const isNationalSalesManager = data.employee.roleLabel === "National Sales Manager";

  return (
    <div className="space-y-6 lg:space-y-7">
      <div className={`grid gap-4 md:grid-cols-2 lg:gap-5 ${isNationalSalesManager ? "xl:grid-cols-3" : "xl:grid-cols-4"}`}>
        <OverviewStatCard accent="orange" icon={Target} label="Monthly Target" note={data.sales.currentMonthLabel} value={egp(data.sales.currentMonthTarget)} />
        <OverviewStatCard accent="green" icon={TrendingUp} label="Achievement" note={`${data.sales.achievementPercent.toFixed(1)}% of target`} progress={data.sales.achievementPercent} value={egp(data.sales.currentMonthSales)} />
        <OverviewStatCard accent="purple" icon={Wallet} label="Net Salary" note={data.payroll.latestBatchLabel ?? "Latest payroll"} value={egp(data.payroll.netSalary)} />
        {!isNationalSalesManager && (
          <OverviewStatCard accent="blue" icon={Trophy} label="Rank in Team" note={data.sales.rankInTeam ? "Great job!" : "Not available"} value={data.sales.rankInTeam ? `${data.sales.rankInTeam.position} / ${data.sales.rankInTeam.total}` : "N/A"} />
        )}
      </div>
      <div className="grid gap-4 lg:gap-5 xl:grid-cols-1">
        <OverviewPerformanceChart data={data} />
      </div>
      <div className="grid gap-4 lg:gap-5 xl:grid-cols-[1.55fr_0.9fr]">
        <OverviewInsightsAlerts data={data} />
        <OverviewAchievementByLine data={data} />
      </div>
      <div className="grid gap-4 lg:gap-5 xl:grid-cols-[1.55fr_0.9fr]">
        <OverviewTopProducts data={data} />
        <div className="grid gap-4 lg:gap-5">
          <TeamRankComparisonWidget data={data} />
          <ToReachTargetWidget data={data} />
        </div>
      </div>
      <div className="flex justify-center lg:justify-end">
        <Link className="w-full lg:w-auto" href="/employee-portals/sales">
          <Button className="w-full rounded-xl px-5 lg:w-auto" variant="secondary">Open Full Performance</Button>
        </Link>
      </div>
      <section className="sr-only">
        <div className="grid gap-3 md:grid-cols-2">
          <MetricCard label="Employment Status" value={data.hrContract.employmentStatus} />
          <MetricCard label="Payroll Eligibility" value={data.hrContract.payrollEligibility} />
        </div>
      </section>
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
  return (
    <>
      <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
        <div className="flex items-center gap-2">
          <UserRound className="h-5 w-5 text-slate-500" />
          <p className="text-lg font-semibold text-slate-900">{data.employee.fullName}</p>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <MetricCard label="HR ID" value={data.employee.hrId} />
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
