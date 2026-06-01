/**
 * CEO Command Center — Phase 1 + 1.1 (read-only executive surface).
 *
 * GOVERNANCE NOTE: intentionally relies on the CEO's EXISTING permission matrix and
 * does NOT change CEO powers. Renders aggregate KPIs only (no row-level payroll, no
 * individual salaries, no write/approve/export actions). Phase 1.1 adds the Command
 * Brief + Strategic Risk Register above the dashboards. The governance lockdown
 * (narrowing approve/admin grants) remains DEFERRED to Phase 2. Failed sources render
 * an explicit "Unavailable" state — never a decision-looking zero.
 */
import {
  AlertCircle,
  ArrowUpRight,
  BriefcaseBusiness,
  CalendarClock,
  CalendarDays,
  ChartColumnBig,
  ChartNoAxesColumnIncreasing,
  ClipboardCheck,
  Database,
  FileCheck2,
  FileSpreadsheet,
  FileUp,
  Fingerprint,
  Flag,
  Hourglass,
  IdCard,
  LayoutGrid,
  MapPinned,
  Megaphone,
  Network,
  Radar,
  ReceiptText,
  ScrollText,
  Settings2,
  ShieldCheck,
  TrendingDown,
  UserMinus,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { adminPanelClassName, adminSoftPanelClassName } from "@/components/admin/admin-design-tokens";
import { CeoRiskRegister } from "@/components/admin/ceo-risk-register";
import { CeoWeeklyBrief } from "@/components/admin/ceo-weekly-brief";
import type { AdminCommandCenterData } from "@/lib/admin/command-center";
import type { CeoBriefData } from "@/lib/ceo/brief";
import type { CompanyHealth } from "@/lib/ceo/health-score";
import type { RiskRegister } from "@/lib/ceo/risk";

type ExecutiveProfile = {
  fullName: string;
  roleLabel: string;
  hrId: string;
};

type CeoCommandCenterProps = {
  data: AdminCommandCenterData | null;
  loadError: string | null;
  viewer: ExecutiveProfile;
  generatedAtIso: string;
  brief: CeoBriefData | null;
  risk: RiskRegister;
  health: CompanyHealth;
};

const UNAVAILABLE_LABEL = "Unavailable";

// Premium signature: a hairline gradient accent across the top of each panel.
const PANEL_ACCENT_LINE =
  "pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-orange-400/0 via-orange-400/40 to-orange-400/0";

function formatEgp(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  if (Math.abs(safe) >= 1_000_000) return `EGP ${(safe / 1_000_000).toFixed(1)}M`;
  if (Math.abs(safe) >= 1_000) return `EGP ${(safe / 1_000).toFixed(0)}K`;
  return new Intl.NumberFormat("en-US", { currency: "EGP", maximumFractionDigits: 0, style: "currency" }).format(safe);
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString("en-US") : "0";
}

function formatPercent(value: number, decimals = 0): string {
  return `${(Number.isFinite(value) ? value : 0).toFixed(decimals)}%`;
}

function ratioPercent(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function formatAsOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" }).format(date);
}

function hasUnavailable(list: string[], ...keywords: string[]): boolean {
  return list.some((msg) => {
    const lower = msg.toLowerCase();
    return keywords.some((keyword) => lower.includes(keyword));
  });
}

function HeroStat({ label, value, unavailable }: { label: string; value: string; unavailable?: boolean }) {
  return (
    <div className="min-w-0 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 backdrop-blur-sm">
      <p className="truncate text-[11px] font-medium uppercase tracking-wider text-slate-300">{label}</p>
      {unavailable ? (
        <p className="mt-1 truncate text-sm font-medium text-slate-400">{UNAVAILABLE_LABEL}</p>
      ) : (
        <p className="mt-1 truncate text-lg font-semibold text-white sm:text-xl">{value}</p>
      )}
    </div>
  );
}

function KpiTile({
  icon: Icon,
  label,
  value,
  sublabel,
  accentClassName,
  iconClassName,
  unavailable,
  href,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sublabel: string;
  accentClassName: string;
  iconClassName: string;
  unavailable?: boolean;
  href?: string;
}) {
  const inner = (
    <>
      <div className={`absolute inset-x-0 top-0 h-1 ${unavailable ? "bg-slate-200" : accentClassName}`} />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
          {unavailable ? (
            <>
              <p className="mt-2 flex items-center gap-1.5 text-base font-semibold text-slate-400">
                <AlertCircle className="h-4 w-4" />
                {UNAVAILABLE_LABEL}
              </p>
              <p className="mt-1 truncate text-xs text-slate-400">Source temporarily unavailable</p>
            </>
          ) : (
            <>
              <p className="mt-2 truncate text-2xl font-bold text-slate-900 sm:text-[28px]">{value}</p>
              <p className="mt-1 truncate text-xs text-slate-500">{sublabel}</p>
            </>
          )}
        </div>
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors ${
            unavailable ? "bg-slate-50 text-slate-300" : iconClassName
          }`}
        >
          <Icon className="h-5 w-5" />
        </span>
      </div>
      {href ? (
        <ArrowUpRight className="pointer-events-none absolute bottom-4 right-4 h-4 w-4 text-slate-300 opacity-0 transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-orange-500 group-hover:opacity-100" />
      ) : null}
    </>
  );

  const base = `group relative block min-w-0 overflow-hidden ${adminPanelClassName} bg-gradient-to-br from-white to-slate-50/60 p-5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_16px_38px_rgba(15,23,42,0.10)]`;

  if (!href) {
    return <div className={base}>{inner}</div>;
  }
  return (
    <Link
      aria-label={`${label} — open report`}
      className={`${base} hover:border-orange-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2`}
      href={href}
    >
      {inner}
    </Link>
  );
}

function GaugeRing({
  label,
  value,
  sublabel,
  accent,
  unavailable,
}: {
  label: string;
  value: number;
  sublabel: string;
  accent: string;
  unavailable?: boolean;
}) {
  const arc = clampPercent(value);
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const dash = (arc / 100) * circumference;
  return (
    <div className={`flex min-w-0 flex-col items-center gap-3 ${adminSoftPanelClassName} bg-gradient-to-b from-white to-slate-50/50 p-4 transition-shadow hover:shadow-[0_10px_26px_rgba(15,23,42,0.07)]`}>
      <div className="relative h-24 w-24 sm:h-28 sm:w-28">
        <svg className="h-full w-full -rotate-90" viewBox="0 0 120 120">
          <circle cx="60" cy="60" fill="none" r={radius} stroke="#E2E8F0" strokeWidth="11" />
          {unavailable ? null : (
            <circle
              cx="60"
              cy="60"
              fill="none"
              r={radius}
              stroke={accent}
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeLinecap="round"
              strokeWidth="11"
            />
          )}
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className={`text-xl font-bold sm:text-2xl ${unavailable ? "text-slate-300" : "text-slate-900"}`}>
            {unavailable ? "—" : formatPercent(value)}
          </span>
        </div>
      </div>
      <div className="min-w-0 text-center">
        <p className="truncate text-sm font-semibold text-slate-700">{label}</p>
        <p className="truncate text-xs text-slate-400">{unavailable ? UNAVAILABLE_LABEL : sublabel}</p>
      </div>
    </div>
  );
}

function Panel({
  icon: Icon,
  title,
  children,
  href,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  href?: string;
}) {
  return (
    <section
      className={`group relative min-w-0 overflow-hidden ${adminPanelClassName} bg-gradient-to-br from-white to-slate-50/40 p-5 transition-shadow hover:shadow-[0_14px_32px_rgba(15,23,42,0.08)]`}
    >
      <div className={PANEL_ACCENT_LINE} />
      <header className="mb-4 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-orange-50 text-orange-600 ring-1 ring-orange-100/70">
            <Icon className="h-4 w-4" />
          </span>
          <h2 className="truncate text-sm font-semibold uppercase tracking-wide text-slate-600">{title}</h2>
        </div>
        {href ? (
          <Link
            aria-label={`Open ${title} report`}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-orange-600 opacity-0 transition hover:text-orange-700 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 group-hover:opacity-100"
            href={href}
          >
            View
            <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        ) : null}
      </header>
      {children}
    </section>
  );
}

function PanelUnavailable() {
  return (
    <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-400">
      <AlertCircle className="h-4 w-4" />
      Data temporarily unavailable
    </div>
  );
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-100 py-2 last:border-0">
      <span className="min-w-0 truncate text-sm text-slate-500">{label}</span>
      <span className="shrink-0 text-sm font-semibold text-slate-900">{value}</span>
    </div>
  );
}

function ProgressBar({ value, accent }: { value: number; accent: string }) {
  const pct = clampPercent(value);
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
      <div className={`h-full rounded-full ${accent}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function CommandCenterUnavailable({ message }: { message: string | null }) {
  return (
    <div className="rounded-[20px] border border-rose-100 bg-rose-50 p-8">
      <div className="mb-3 flex items-center gap-3 text-rose-600">
        <AlertCircle className="h-6 w-6" />
        <h2 className="text-lg font-bold">Executive data unavailable</h2>
      </div>
      <p className="max-w-2xl text-sm leading-6 text-rose-700">
        The command center could not load company intelligence from the platform services. This is shown instead of an
        estimated figure to protect decision integrity. Retry from the navigation, and if it persists, ask your Phoenix
        administrator to verify the database views.
      </p>
      {message ? (
        <div className="mt-4 rounded-lg border border-rose-200 bg-white/60 p-3">
          <p className="break-all font-mono text-xs text-rose-800">{message}</p>
        </div>
      ) : null}
    </div>
  );
}

type ReportTile = { label: string; href: string; icon: LucideIcon; hint: string };
type ReportGroup = { label: string; tiles: readonly ReportTile[] };

// Tier-3 "jump to any report" grid — every executive-relevant report reachable in one click.
// Icons mirror src/config/system-navigation.ts so the surfaces feel consistent with the sidebar.
const REPORT_GROUPS: readonly ReportGroup[] = [
  {
    label: "People & Lifecycle",
    tiles: [
      { label: "Employees", href: "/employees", icon: UsersRound, hint: "Directory & profiles" },
      { label: "Organogram", href: "/organogram", icon: Network, hint: "Reporting structure" },
      { label: "Vacancies Report", href: "/reports/vacancies", icon: BriefcaseBusiness, hint: "Open seats & gaps" },
      { label: "CV Database", href: "/cv-database", icon: FileSpreadsheet, hint: "Talent pipeline" },
      { label: "Offer Lifecycle", href: "/offers", icon: IdCard, hint: "Hiring funnel" },
      { label: "Hiring Documents", href: "/hiring-documents", icon: FileCheck2, hint: "Onboarding readiness" },
      { label: "Probation", href: "/probation", icon: Hourglass, hint: "90-day reviews" },
      { label: "Contract Renewal", href: "/contracts", icon: CalendarClock, hint: "Renewal cliffs" },
      { label: "Resignations", href: "/resignations", icon: FileSpreadsheet, hint: "Attrition & exits" },
    ],
  },
  {
    label: "Sales & Field",
    tiles: [
      { label: "Sales Dashboard", href: "/sales", icon: ChartNoAxesColumnIncreasing, hint: "Achievement vs target" },
      { label: "Monthly Sales", href: "/sales/queue", icon: FileUp, hint: "Import batches" },
      { label: "Field Coaching", href: "/coaching", icon: ClipboardCheck, hint: "Coaching reports" },
      { label: "Coaching Analytics", href: "/coaching/analytics", icon: ChartColumnBig, hint: "Capability trends" },
      { label: "Workforce Compliance", href: "/admin/field-workforce-compliance", icon: ClipboardCheck, hint: "Activity thresholds" },
      { label: "Marketing Requests", href: "/employee-portals/marketing-requests", icon: Megaphone, hint: "HCP / PH activity" },
    ],
  },
  {
    label: "Finance & Cost",
    tiles: [
      { label: "Payroll Report", href: "/payroll", icon: FileSpreadsheet, hint: "Batch disbursement" },
      { label: "Payslips Center", href: "/admin/payslips-center", icon: ScrollText, hint: "Payslip governance" },
      { label: "Outstation Expenses", href: "/payroll/expenses/dashboard", icon: ChartColumnBig, hint: "Field spend" },
      { label: "Outstation Heatmaps", href: "/admin/outstation/heatmaps", icon: MapPinned, hint: "Geographic variance" },
      { label: "Expense Requests", href: "/admin/outstation/requests", icon: MapPinned, hint: "Approval queue" },
      { label: "Deductions Governance", href: "/admin/deductions-governance", icon: ShieldCheck, hint: "Payroll deductions" },
    ],
  },
  {
    label: "Attendance, Leave & Ops",
    tiles: [
      { label: "Vacation Report", href: "/leave-management/vacation-report", icon: FileSpreadsheet, hint: "Leave & approvals" },
      { label: "HR Calendar", href: "/hr-calendar", icon: CalendarDays, hint: "Holidays & events" },
      { label: "Fingerprint Report", href: "/attendance/fingerprint-report", icon: Fingerprint, hint: "Attendance source" },
      { label: "Data Health", href: "/admin/data-health", icon: Database, hint: "Integrity & flags" },
      { label: "Monitoring", href: "/admin/monitoring", icon: Radar, hint: "Platform activity" },
      { label: "Audit Logs", href: "/admin/logs", icon: ScrollText, hint: "Security trail" },
      { label: "Workflow Control", href: "/admin/workflow-control", icon: Settings2, hint: "Process governance" },
    ],
  },
];

function ReportNavTile({ label, href, icon: Icon, hint }: ReportTile) {
  return (
    <Link
      aria-label={`Open ${label}`}
      className="group flex items-center gap-3 rounded-[14px] border border-[#E2E8F0] bg-white px-3.5 py-3 shadow-[0_2px_8px_rgba(15,23,42,0.05)] outline-none transition duration-200 hover:-translate-y-0.5 hover:border-orange-200/70 hover:bg-orange-50/30 hover:shadow-md focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2"
      href={href}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-50 text-slate-500 ring-1 ring-slate-200/70 transition group-hover:bg-orange-50 group-hover:text-orange-600">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-slate-800">{label}</span>
        <span className="block truncate text-[11px] text-slate-400">{hint}</span>
      </span>
      <ArrowUpRight className="h-4 w-4 shrink-0 text-slate-300 transition duration-200 group-hover:translate-x-0.5 group-hover:text-orange-500" />
    </Link>
  );
}

function ReportNavigator() {
  return (
    <section className={`group relative min-w-0 overflow-hidden ${adminPanelClassName} bg-gradient-to-br from-white to-slate-50/40 p-5`}>
      <div className={PANEL_ACCENT_LINE} />
      <header className="mb-4 flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-50 text-orange-600 ring-1 ring-orange-100/70">
          <LayoutGrid className="h-4 w-4" />
        </span>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-600">Jump to any report</h2>
      </header>
      <div className="space-y-5">
        {REPORT_GROUPS.map((group) => (
          <div key={group.label}>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{group.label}</p>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {group.tiles.map((tile) => (
                <ReportNavTile key={tile.href} {...tile} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function SectionHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <div className="flex items-center gap-2.5">
        <span className="h-4 w-1 rounded-full bg-gradient-to-b from-orange-500 to-amber-400 shadow-[0_0_10px_rgba(249,115,22,0.45)]" />
        <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-slate-700">{title}</h2>
      </div>
      {hint ? <span className="shrink-0 text-[11px] font-medium text-slate-400">{hint}</span> : null}
    </div>
  );
}

function HeroPill({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  tone: "emerald" | "rose" | "amber" | "slate";
}) {
  const toneClass = {
    emerald: "text-emerald-400",
    rose: "text-rose-400",
    amber: "text-amber-400",
    slate: "text-slate-400",
  }[tone];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300 backdrop-blur-sm">
      <Icon className={`h-3.5 w-3.5 ${toneClass}`} />
      <span className="font-semibold text-white">{value}</span>
      <span className="text-slate-400">{label}</span>
    </span>
  );
}

export function CeoCommandCenter({ data, loadError, viewer, generatedAtIso, brief, risk, health }: CeoCommandCenterProps) {
  if (!data) {
    return <CommandCenterUnavailable message={loadError} />;
  }

  const o = data.overview;
  const showFinancial = data.access.showFinancialModules;
  const unavailable = Array.from(new Set(data.dataUnavailable.filter(Boolean)));

  const platformDown = hasUnavailable(unavailable, "platform metrics");
  const payrollDown = platformDown || hasUnavailable(unavailable, "payroll data", "payroll metrics");
  const salesDown = platformDown || hasUnavailable(unavailable, "sales data", "sales metrics");
  const expensesDown = platformDown || hasUnavailable(unavailable, "expense data", "expense metrics");
  const workforceDown = platformDown || hasUnavailable(unavailable, "employee directory", "data health", "workforce");
  const recruitmentDown = platformDown || hasUnavailable(unavailable, "recruitment");
  const leaveDown = platformDown || hasUnavailable(unavailable, "leave data", "leave metrics");
  const operationsDown = hasUnavailable(unavailable, "operational activity");
  // Attendance readiness is sourced from platform metrics; if those fail it falls back to
  // defaults, so we treat the panel as unavailable rather than show a misleading 100%.
  const attendanceDown = platformDown;
  // Executive attention signals (P1/P2) — each isolated so one outage never fakes a zero.
  const resignationsDown = hasUnavailable(unavailable, "resignation data");
  const probationDown = hasUnavailable(unavailable, "probation data");
  const contractsDown = hasUnavailable(unavailable, "contract renewal data");
  const salaryFlagsDown = hasUnavailable(unavailable, "salary flag data");
  const coachingDown = hasUnavailable(unavailable, "coaching data");
  const leaveSlaDown = hasUnavailable(unavailable, "leave sla data");
  const deductionsDown = hasUnavailable(unavailable, "deductions data");

  const ex = o.executive;
  const ded = o.deductions;

  const workforceHealth = ratioPercent(data.health.healthyEmployees, data.health.totalEmployees);
  const positionFill = ratioPercent(o.hr.totalStructure - o.hr.vacantPositions, o.hr.totalStructure);
  const offerAcceptance = ratioPercent(o.recruitment.acceptedOffers, o.recruitment.totalOffers);
  const salesAchievement = o.sales.achievementRate * 100;
  const criticalRiskCount = risk.rows.filter((row) => row.severity === "critical").length;
  const activeRiskCount = risk.rows.length;

  return (
    <div className="space-y-7">
      <section className="relative overflow-hidden rounded-[24px] border border-[#1a1a1a] bg-[linear-gradient(135deg,#000000_0%,#070707_55%,#1C0E02_100%)] p-6 shadow-[0_28px_80px_rgba(0,0,0,0.45)] ring-1 ring-white/5 sm:p-8">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-orange-400/60 to-transparent" />
        <div className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full bg-orange-500/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -left-10 h-60 w-60 rounded-full bg-amber-500/15 blur-3xl" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-orange-300">
              <Radar className="h-4 w-4" />
              <span className="text-[11px] font-semibold uppercase tracking-[0.22em]">Executive Command Center</span>
            </div>
            <h1 className="mt-3 truncate text-2xl font-bold text-white sm:text-3xl">{viewer.fullName}</h1>
            <p className="mt-1 truncate text-sm text-slate-300">
              {viewer.roleLabel}
              {viewer.hrId ? <span className="text-slate-500"> · {viewer.hrId}</span> : null}
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300 backdrop-blur-sm">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                Read-only · as of {formatAsOf(generatedAtIso)}
              </span>
              <HeroPill
                icon={ClipboardCheck}
                label="Health"
                tone="emerald"
                value={health.available ? `${formatNumber(health.overall ?? 0)}/100` : "—"}
              />
              <HeroPill
                icon={ShieldCheck}
                label="Critical"
                tone={criticalRiskCount > 0 ? "rose" : "emerald"}
                value={formatNumber(criticalRiskCount)}
              />
              <HeroPill
                icon={AlertCircle}
                label="Active risks"
                tone={activeRiskCount > 0 ? "amber" : "slate"}
                value={formatNumber(activeRiskCount)}
              />
            </div>
          </div>
          <div className="grid w-full grid-cols-1 gap-3 xs:grid-cols-2 lg:max-w-md">
            <HeroStat label="Active Workforce" unavailable={workforceDown} value={formatNumber(o.hr.activeEmployees)} />
            {showFinancial ? (
              <HeroStat label="Monthly Payroll" unavailable={payrollDown} value={formatEgp(o.payroll.net)} />
            ) : (
              <HeroStat label="Org Structure" unavailable={workforceDown} value={formatNumber(o.hr.totalStructure)} />
            )}
            <HeroStat label="Sales Achievement" unavailable={salesDown} value={formatPercent(salesAchievement)} />
            <HeroStat label="Open Vacancies" unavailable={workforceDown} value={formatNumber(o.hr.vacantPositions)} />
          </div>
        </div>
      </section>

      {unavailable.length > 0 ? (
        <div className="flex items-start gap-3 rounded-[16px] border border-amber-200 bg-amber-50 px-4 py-3 text-amber-800">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
          <div className="min-w-0 text-sm">
            <p className="font-semibold">Some intelligence is temporarily unavailable</p>
            <p className="mt-0.5 text-amber-700">
              Affected tiles show &ldquo;Unavailable&rdquo; rather than zero: {unavailable.join(" · ")}
            </p>
          </div>
        </div>
      ) : null}

      {/* Strategic brief + risk register — CEO attention first, before any dashboard */}
      <CeoWeeklyBrief attention={risk.rows.slice(0, 3)} brief={brief} health={health} />
      <CeoRiskRegister register={risk} />

      <section>
        <SectionHeading hint="Company-wide headline metrics" title="Key Performance" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          accentClassName="bg-gradient-to-r from-sky-400 to-sky-500"
          href="/employees"
          iconClassName="bg-sky-50 text-sky-600"
          icon={UsersRound}
          label="Active Workforce"
          sublabel={`${formatNumber(o.hr.totalStructure)} positions · ${formatNumber(o.hr.vacantPositions)} vacant`}
          unavailable={workforceDown}
          value={formatNumber(o.hr.activeEmployees)}
        />
        <KpiTile
          accentClassName="bg-gradient-to-r from-orange-400 to-orange-500"
          href={showFinancial ? "/payroll" : "/reports/vacancies"}
          iconClassName="bg-orange-50 text-orange-600"
          icon={ScrollText}
          label={showFinancial ? "Net Payroll (latest)" : "Org Structure"}
          sublabel={
            showFinancial
              ? `${o.payroll.batchLabel} · ${formatNumber(o.payroll.employees)} paid`
              : `${formatNumber(o.hr.uniqueLines)} lines · ${formatNumber(o.hr.uniqueAreas)} areas`
          }
          unavailable={showFinancial ? payrollDown : workforceDown}
          value={showFinancial ? formatEgp(o.payroll.net) : formatNumber(o.hr.totalStructure)}
        />
        <KpiTile
          accentClassName="bg-gradient-to-r from-emerald-400 to-emerald-500"
          href="/sales"
          iconClassName="bg-emerald-50 text-emerald-600"
          icon={ChartNoAxesColumnIncreasing}
          label="Sales Achievement"
          sublabel={`${formatEgp(o.sales.salesValue)} of ${formatEgp(o.sales.targetValue)}`}
          unavailable={salesDown}
          value={formatPercent(salesAchievement)}
        />
        <KpiTile
          accentClassName="bg-gradient-to-r from-violet-400 to-violet-500"
          href={showFinancial ? "/payroll/expenses/dashboard" : undefined}
          iconClassName="bg-violet-50 text-violet-600"
          icon={ReceiptText}
          label="Approved Expenses"
          sublabel={
            showFinancial
              ? `${formatNumber(o.expenses.reportCount)} reports · ${formatEgp(o.expenses.totalAmount)} total`
              : "Not available for this role"
          }
          unavailable={showFinancial ? expensesDown : false}
          value={showFinancial ? formatEgp(o.expenses.approvedAmount) : "Restricted"}
        />
        </div>
      </section>

      <section>
        <SectionHeading hint="Forward-looking risk — drill in to act" title="Executive Attention" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <KpiTile
            accentClassName="bg-gradient-to-r from-rose-400 to-rose-500"
            href="/resignations"
            iconClassName="bg-rose-50 text-rose-600"
            icon={TrendingDown}
            label="Attrition (30d)"
            sublabel="Rolling 30-day departures"
            unavailable={resignationsDown}
            value={formatPercent(ex.attritionRate30d, 1)}
          />
          <KpiTile
            accentClassName="bg-gradient-to-r from-amber-400 to-amber-500"
            href="/resignations"
            iconClassName="bg-amber-50 text-amber-600"
            icon={UserMinus}
            label="Pending Resignations"
            sublabel={`${formatNumber(ex.totalResignations)} in workflow`}
            unavailable={resignationsDown}
            value={formatNumber(ex.pendingResignations)}
          />
          <KpiTile
            accentClassName="bg-gradient-to-r from-sky-400 to-sky-500"
            href="/probation"
            iconClassName="bg-sky-50 text-sky-600"
            icon={Hourglass}
            label="Critical Probation"
            sublabel="≤30 days to decision"
            unavailable={probationDown}
            value={formatNumber(ex.criticalProbation)}
          />
          <KpiTile
            accentClassName="bg-gradient-to-r from-violet-400 to-violet-500"
            href="/contracts"
            iconClassName="bg-violet-50 text-violet-600"
            icon={CalendarClock}
            label="Contracts Due ≤7d"
            sublabel="Renewals next 7 days"
            unavailable={contractsDown}
            value={formatNumber(ex.contractsDueSoon)}
          />
          <KpiTile
            accentClassName="bg-gradient-to-r from-orange-400 to-orange-500"
            href={showFinancial ? "/admin/data-health" : undefined}
            iconClassName="bg-orange-50 text-orange-600"
            icon={Flag}
            label="Open Salary Flags"
            sublabel={showFinancial ? "Need resolution" : "Not available for this role"}
            unavailable={showFinancial ? salaryFlagsDown : false}
            value={showFinancial ? formatNumber(data.unresolvedSalaryFlags) : "Restricted"}
          />
          <KpiTile
            accentClassName="bg-gradient-to-r from-rose-400 to-rose-500"
            href="/leave-management/vacation-report"
            iconClassName="bg-rose-50 text-rose-600"
            icon={CalendarDays}
            label="Overdue Leave (SLA)"
            sublabel="Past manager/HR deadline"
            unavailable={leaveSlaDown}
            value={formatNumber(ex.overdueLeaveSla)}
          />
          <KpiTile
            accentClassName="bg-gradient-to-r from-emerald-400 to-emerald-500"
            href="/coaching/analytics"
            iconClassName="bg-emerald-50 text-emerald-600"
            icon={ClipboardCheck}
            label="Coaching Quality"
            sublabel={`${formatNumber(ex.coachingRedZone)} in red zone`}
            unavailable={coachingDown}
            value={formatPercent(ex.coachingScore)}
          />
        </div>
      </section>

      <Panel icon={ClipboardCheck} title="Operational Health">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <GaugeRing
            accent="#10B981"
            label="Workforce Health"
            sublabel={`${formatNumber(data.health.healthyEmployees)}/${formatNumber(data.health.totalEmployees)} complete`}
            unavailable={workforceDown}
            value={workforceHealth}
          />
          <GaugeRing accent="#F97316" label="Sales Achievement" sublabel="vs target" unavailable={salesDown} value={salesAchievement} />
          <GaugeRing
            accent="#0EA5E9"
            label="Positions Filled"
            sublabel={`${formatNumber(o.hr.vacantPositions)} open`}
            unavailable={workforceDown}
            value={positionFill}
          />
          <GaugeRing
            accent="#8B5CF6"
            label="Offer Acceptance"
            sublabel={`${formatNumber(o.recruitment.acceptedOffers)}/${formatNumber(o.recruitment.totalOffers)} offers`}
            unavailable={recruitmentDown}
            value={offerAcceptance}
          />
        </div>
      </Panel>

      <section>
        <SectionHeading hint="Drill any panel into its full report" title="Domain Intelligence" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        <Panel href="/sales" icon={ChartNoAxesColumnIncreasing} title="Sales & Field Performance">
          {salesDown ? (
            <PanelUnavailable />
          ) : (
            <>
              <div className="mb-4">
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="text-slate-500">Achievement</span>
                  <span className="font-semibold text-slate-900">{formatPercent(salesAchievement)}</span>
                </div>
                <ProgressBar accent="bg-gradient-to-r from-emerald-400 to-emerald-500" value={salesAchievement} />
              </div>
              <MetricRow label="Sales value" value={formatEgp(o.sales.salesValue)} />
              <MetricRow label="Target value" value={formatEgp(o.sales.targetValue)} />
              <MetricRow label="Active products" value={formatNumber(o.sales.activeProducts)} />
            </>
          )}
        </Panel>

        <Panel href="/payroll" icon={ScrollText} title="Payroll & Cost Intelligence">
          {!showFinancial ? (
            <p className="py-6 text-center text-sm text-slate-400">Financial intelligence is not available for this role.</p>
          ) : payrollDown ? (
            <PanelUnavailable />
          ) : (
            <>
              <MetricRow label="Net payroll (latest batch)" value={formatEgp(o.payroll.net)} />
              <MetricRow label="Gross payroll (latest batch)" value={formatEgp(o.payroll.gross)} />
              <MetricRow label="Employees paid" value={formatNumber(o.payroll.employees)} />
              <MetricRow label="Payroll-eligible" value={formatNumber(data.payrollEligibleCount)} />
              <MetricRow label="Open payroll flags" value={formatNumber(o.payroll.flags)} />
              <MetricRow label="Batch" value={o.payroll.batchLabel} />
            </>
          )}
        </Panel>

        <Panel href="/reports/vacancies" icon={Network} title="Workforce Structure">
          {workforceDown ? (
            <PanelUnavailable />
          ) : (
            <>
              <MetricRow label="Active employees" value={formatNumber(o.hr.activeEmployees)} />
              <MetricRow label="Total structure" value={formatNumber(o.hr.totalStructure)} />
              <MetricRow label="Open vacancies" value={formatNumber(o.hr.vacantPositions)} />
              <MetricRow label="Lines" value={formatNumber(o.hr.uniqueLines)} />
              <MetricRow label="Areas" value={formatNumber(o.hr.uniqueAreas)} />
              <MetricRow label="Without a manager" value={formatNumber(o.hr.employeesWithoutManagers)} />
            </>
          )}
        </Panel>

        <Panel href="/offers" icon={BriefcaseBusiness} title="Recruitment & Onboarding">
          {recruitmentDown ? (
            <PanelUnavailable />
          ) : (
            <>
              <div className="mb-4">
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="text-slate-500">Acceptance</span>
                  <span className="font-semibold text-slate-900">{formatPercent(offerAcceptance)}</span>
                </div>
                <ProgressBar accent="bg-gradient-to-r from-violet-400 to-violet-500" value={offerAcceptance} />
              </div>
              <MetricRow label="Total offers" value={formatNumber(o.recruitment.totalOffers)} />
              <MetricRow label="Pending" value={formatNumber(o.recruitment.pendingOffers)} />
              <MetricRow label="Accepted" value={formatNumber(o.recruitment.acceptedOffers)} />
              <MetricRow label="Rejected" value={formatNumber(o.recruitment.rejectedOffers)} />
            </>
          )}
        </Panel>

        <Panel href="/leave-management/vacation-report" icon={CalendarDays} title="Leave Pulse">
          {leaveDown ? (
            <PanelUnavailable />
          ) : (
            <>
              <MetricRow label="Pending requests" value={formatNumber(o.leave.pendingRequests)} />
              <MetricRow label="Approved" value={formatNumber(o.leave.approvedRequests)} />
              <MetricRow label="Rejected" value={formatNumber(o.leave.rejectedRequests)} />
              <MetricRow label="Paid days" value={formatNumber(o.leave.paidDays)} />
              <MetricRow label="Unpaid days" value={formatNumber(o.leave.unpaidDays)} />
            </>
          )}
        </Panel>

        <Panel href="/admin/data-health" icon={Radar} title="System Integrity">
          {operationsDown ? (
            <PanelUnavailable />
          ) : (
            <>
              <MetricRow label="Events (24h)" value={formatNumber(data.operations.totalEvents24h)} />
              <MetricRow label="Failures (24h)" value={formatNumber(data.operations.failureCount24h)} />
              <MetricRow label="Stale sources" value={formatNumber(data.operations.staleSources.length)} />
              <MetricRow label="Unavailable feeds" value={formatNumber(unavailable.length)} />
            </>
          )}
        </Panel>

        <Panel href="/attendance/fingerprint-report" icon={Fingerprint} title="Attendance & Compliance">
          {attendanceDown ? (
            <PanelUnavailable />
          ) : (
            <>
              <MetricRow label="Device mapping readiness" value={formatPercent(o.attendance.mappingReadinessRate * 100)} />
              <MetricRow label="Policy coverage" value={formatPercent(o.attendance.policyCoverageRate * 100)} />
              <MetricRow label="Missing device mappings" value={formatNumber(o.attendance.missingDeviceMappings)} />
              <MetricRow label="Active policies" value={formatNumber(o.attendance.activePolicies)} />
              <MetricRow label="Working days (this month)" value={formatNumber(o.attendance.currentMonthWorkingDays)} />
            </>
          )}
        </Panel>

        <Panel href="/admin/deductions-governance" icon={ShieldCheck} title="Deductions Governance">
          {deductionsDown ? (
            <PanelUnavailable />
          ) : (
            <>
              <MetricRow label="Pending review" value={formatNumber(ded.pending)} />
              <MetricRow label="Disputed" value={formatNumber(ded.disputed)} />
              <MetricRow label="Needs follow-up" value={formatNumber(ded.needsFollowUp)} />
              <MetricRow label="Employees affected" value={formatNumber(ded.employeesAffected)} />
              {showFinancial ? <MetricRow label="Estimated amount" value={formatEgp(ded.estimatedAmount)} /> : null}
            </>
          )}
        </Panel>
        </div>
      </section>

      <ReportNavigator />
    </div>
  );
}
