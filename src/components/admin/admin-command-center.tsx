import Link from "next/link";
import Image from "next/image";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Briefcase,
  CalendarCheck,
  CheckCircle2,
  ChevronDown,
  Clock,
  Fingerprint,
  FileSpreadsheet,
  HeartPulse,
  History,
  Hourglass,
  IdCard,
  LockKeyhole,
  Mail,
  Network,
  Receipt,
  ScrollText,
  Send,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
  Users,
  Wallet,
  XCircle,
} from "lucide-react";

import { AdminHeroFrame } from "@/components/admin/admin-design-system";
import type { AdminCommandCenterData, DataHealthMetrics } from "@/lib/admin/command-center";
import { employeeProfileImageForHrId } from "@/lib/employees/profile-images";
import { formatHrIdForDisplay } from "@/lib/hr-id";

export type CommandCenterWelcomeProfile = {
  fullName: string;
  hrId: string | null;
  managerName: string | null;
  systemRoleLabel: string;
  titleLabel: string;
};

function egp(value: number) {
  const safe = Number.isFinite(value) ? value : 0;
  if (Math.abs(safe) >= 1_000_000) return `EGP ${(safe / 1_000_000).toFixed(1)}M`;
  if (Math.abs(safe) >= 1_000) return `EGP ${(safe / 1_000).toFixed(0)}K`;
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(safe);
}

function pct(value: number, decimals = 1) {
  return `${(Number.isFinite(value) ? value : 0).toFixed(decimals)}%`;
}

function n(value: number) {
  return Number.isFinite(value) ? value.toLocaleString("en-US") : "0";
}

/** Returns a matcher that reports whether any unavailable-source message mentions a keyword. */
function unavailableMatcher(messages: string[]) {
  const lower = messages.map((message) => message.toLowerCase());
  return (keyword: string) => lower.some((message) => message.includes(keyword));
}

/** Replaces a value with an em dash when its data source is unavailable (avoids misleading zeros). */
function orDash(unavailable: boolean, formatted: string) {
  return unavailable ? "—" : formatted;
}

function relativeTime(iso: string | null, now: number) {
  if (!iso) return "—";
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "—";
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function eventStatusTone(status: string) {
  const s = status.toLowerCase();
  if (/(fail|error|reject|denied|block)/.test(s)) return "border-rose-200 bg-rose-50 text-rose-700";
  if (/(success|complete|approv|sent|deliver|pass|ok\b)/.test(s)) return "border-emerald-200 bg-emerald-50 text-emerald-700";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function eventDotClass(status: string) {
  const s = status.toLowerCase();
  if (/(fail|error|reject|denied|block)/.test(s)) return "bg-rose-500";
  if (/(success|complete|approv|sent|deliver|pass|ok\b)/.test(s)) return "bg-emerald-500";
  return "bg-slate-400";
}

type IconType = typeof Users;
type MiniMetric = { label: string; ok?: boolean; value: string };
type AccentColor = "amber" | "blue" | "emerald" | "orange" | "rose" | "violet";
type Health = "attention" | "healthy" | "warning";

function firstNameFrom(fullName: string) {
  return fullName.split(/\s+/).find(Boolean) ?? "there";
}

function initialsFrom(fullName: string) {
  const initials = fullName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join("")
    .toUpperCase();
  return initials || "PH";
}

const accentStyles: Record<
  AccentColor,
  { bar: string; button: string; glow: string; icon: string; metric: string; text: string }
> = {
  amber: {
    bar: "from-amber-500 via-amber-400 to-amber-300",
    button: "bg-gradient-to-r from-amber-600 to-amber-500 hover:from-amber-700 hover:to-amber-600",
    glow: "bg-amber-400/25",
    icon: "bg-gradient-to-br from-amber-100 to-amber-50 text-amber-700 ring-amber-200/70",
    metric: "from-amber-50 to-white",
    text: "text-amber-700",
  },
  blue: {
    bar: "from-sky-500 via-sky-400 to-sky-300",
    button: "bg-gradient-to-r from-sky-600 to-sky-500 hover:from-sky-700 hover:to-sky-600",
    glow: "bg-sky-400/25",
    icon: "bg-gradient-to-br from-sky-100 to-sky-50 text-sky-700 ring-sky-200/70",
    metric: "from-sky-50 to-white",
    text: "text-sky-700",
  },
  emerald: {
    bar: "from-emerald-500 via-emerald-400 to-emerald-300",
    button: "bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-700 hover:to-emerald-600",
    glow: "bg-emerald-400/25",
    icon: "bg-gradient-to-br from-emerald-100 to-emerald-50 text-emerald-700 ring-emerald-200/70",
    metric: "from-emerald-50 to-white",
    text: "text-emerald-700",
  },
  orange: {
    bar: "from-orange-500 via-orange-400 to-amber-300",
    button: "bg-gradient-to-r from-orange-600 to-orange-500 hover:from-orange-700 hover:to-orange-600",
    glow: "bg-orange-400/30",
    icon: "bg-gradient-to-br from-orange-100 to-orange-50 text-orange-700 ring-orange-200/70",
    metric: "from-orange-50 to-white",
    text: "text-orange-700",
  },
  rose: {
    bar: "from-rose-500 via-rose-400 to-rose-300",
    button: "bg-gradient-to-r from-rose-600 to-rose-500 hover:from-rose-700 hover:to-rose-600",
    glow: "bg-rose-400/25",
    icon: "bg-gradient-to-br from-rose-100 to-rose-50 text-rose-700 ring-rose-200/70",
    metric: "from-rose-50 to-white",
    text: "text-rose-700",
  },
  violet: {
    bar: "from-violet-500 via-violet-400 to-violet-300",
    button: "bg-gradient-to-r from-violet-600 to-violet-500 hover:from-violet-700 hover:to-violet-600",
    glow: "bg-violet-400/25",
    icon: "bg-gradient-to-br from-violet-100 to-violet-50 text-violet-700 ring-violet-200/70",
    metric: "from-violet-50 to-white",
    text: "text-violet-700",
  },
};

function SectionLabel({
  action,
  eyebrow,
  title,
}: {
  action?: React.ReactNode;
  eyebrow: string;
  title: string;
}) {
  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="mt-1 h-9 w-1.5 shrink-0 bg-gradient-to-b from-orange-500 to-amber-400" />
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-orange-600">
            {eyebrow}
          </p>
          <h2 className="mt-1 text-xl font-bold tracking-[-0.025em] text-slate-950">
            {title}
          </h2>
        </div>
      </div>
      {action ? <div className="flex flex-wrap gap-2">{action}</div> : null}
    </div>
  );
}

function StatusPill({
  children,
  icon: Icon,
  tone = "slate",
}: {
  children: React.ReactNode;
  icon?: IconType;
  tone?: "emerald" | "sky" | "slate" | "violet";
}) {
  const toneClassName = {
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
    sky: "border-sky-200 bg-sky-50 text-sky-800",
    slate: "border-slate-200 bg-white text-slate-700",
    violet: "border-violet-200 bg-violet-50 text-violet-800",
  }[tone];

  return (
    <span
      className={`inline-flex h-8 items-center gap-1.5 border px-2.5 text-xs font-semibold ${toneClassName}`}
    >
      {Icon ? <Icon aria-hidden="true" className="h-3.5 w-3.5" /> : null}
      {children}
    </span>
  );
}

function KpiCard({
  accent = false,
  icon: Icon,
  label,
  primary = false,
  sub,
  trend,
  value,
  warn = false,
}: {
  accent?: boolean;
  icon: IconType;
  label: string;
  primary?: boolean;
  sub?: string;
  trend?: "down" | "neutral" | "up";
  value: string;
  warn?: boolean;
}) {
  const tone = warn ? "amber" : accent ? "orange" : "blue";
  const style = accentStyles[tone];
  const TrendIcon = trend === "down" ? TrendingDown : trend === "up" ? TrendingUp : null;
  const trendClassName = trend === "down" ? "text-rose-600" : "text-emerald-600";

  return (
    <div
      className={`group relative overflow-hidden border bg-gradient-to-br px-5 py-5 shadow-[0_6px_20px_rgba(15,23,42,0.08)] transition duration-200 hover:-translate-y-1 hover:shadow-[0_14px_34px_rgba(15,23,42,0.12)] ${
        warn
          ? "border-amber-200 from-amber-50 to-white"
          : accent
            ? "border-orange-200 from-orange-50 to-white"
            : "border-slate-200 from-white to-slate-50/60"
      } ${primary ? "ring-1 ring-orange-200/70" : ""}`}
    >
      <div aria-hidden="true" className={`absolute inset-x-0 top-0 ${primary ? "h-1.5" : "h-1"} bg-gradient-to-r ${style.bar}`} />
      <div aria-hidden="true" className={`pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full blur-2xl ${style.glow}`} />
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-h-5 items-center gap-2">
            <p className="truncate text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
              {label}
            </p>
            {TrendIcon ? <TrendIcon aria-hidden="true" className={`h-3.5 w-3.5 ${trendClassName}`} /> : null}
          </div>
          <p className={`${primary ? "text-3xl" : "text-2xl"} mt-2.5 font-black tracking-[-0.035em] ${style.text}`}>
            {value}
          </p>
          {sub ? <p className="mt-2 text-xs leading-5 text-slate-500">{sub}</p> : null}
        </div>
        <div className={`flex h-12 w-12 shrink-0 items-center justify-center shadow-sm ring-1 ${style.icon}`}>
          <Icon aria-hidden="true" className="h-6 w-6" />
        </div>
      </div>
    </div>
  );
}

function ModuleCard({
  accentColor = "orange",
  description,
  health = "healthy",
  href,
  icon: Icon,
  lastSync,
  metrics = [],
  title,
}: {
  accentColor?: AccentColor;
  description: string;
  health?: Health;
  href: string;
  icon: IconType;
  lastSync?: string;
  metrics?: MiniMetric[];
  title: string;
}) {
  const style = accentStyles[accentColor];
  const healthStyle = {
    attention: "border-amber-200 bg-amber-50 text-amber-800",
    healthy: "border-emerald-200 bg-emerald-50 text-emerald-800",
    warning: "border-rose-200 bg-rose-50 text-rose-800",
  }[health];

  return (
    <div className="group relative flex min-h-[236px] flex-col overflow-hidden border border-slate-200 bg-white p-5 shadow-[0_4px_16px_rgba(15,23,42,0.07)] transition duration-200 hover:-translate-y-1 hover:border-orange-200/70 hover:shadow-[0_16px_38px_rgba(15,23,42,0.13)]">
      <div aria-hidden="true" className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r opacity-70 transition-opacity duration-200 group-hover:opacity-100 ${style.bar}`} />
      <div className="flex items-start gap-3">
        <div className={`flex h-12 w-12 shrink-0 items-center justify-center shadow-sm ring-1 ${style.icon}`}>
          <Icon aria-hidden="true" className="h-6 w-6" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-sm font-bold tracking-[-0.01em] text-slate-950">{title}</h3>
            <span className={`inline-flex shrink-0 items-center gap-1 border px-2 py-1 text-[10px] font-bold capitalize ${healthStyle}`}>
              {health === "healthy" ? <CheckCircle2 aria-hidden="true" className="h-3 w-3" /> : null}
              {health === "attention" ? <AlertTriangle aria-hidden="true" className="h-3 w-3" /> : null}
              {health === "warning" ? <XCircle aria-hidden="true" className="h-3 w-3" /> : null}
              {health}
            </span>
          </div>
          <p className="mt-1.5 text-xs leading-5 text-slate-500">{description}</p>
          {lastSync ? <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">Synced: {lastSync}</p> : null}
        </div>
      </div>

      {metrics.length > 0 ? (
        <div className="mt-4 grid grid-cols-3 gap-2">
          {metrics.map((metric) => (
            <div
              className={`border border-slate-200 bg-gradient-to-b ${style.metric} px-2.5 py-2`}
              key={metric.label}
            >
              <p className="truncate text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">
                {metric.label}
              </p>
              <p
                className={`mt-1 truncate text-sm font-black ${
                  metric.ok === false
                    ? "text-rose-700"
                    : metric.ok === true
                      ? "text-emerald-700"
                      : "text-slate-950"
                }`}
              >
                {metric.value}
              </p>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex-1" />

      <Link
        aria-label={`Open ${title}`}
        className={`mt-4 inline-flex h-11 items-center justify-center gap-2 px-4 text-xs font-bold uppercase tracking-[0.08em] text-white shadow-md outline-none transition duration-200 hover:shadow-lg focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 ${style.button}`}
        href={href}
      >
        Open
        <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
      </Link>
    </div>
  );
}

function QuickAction({ href, icon: Icon, label }: { href: string; icon: IconType; label: string }) {
  return (
    <Link
      className="inline-flex h-9 items-center gap-2 border border-white/15 bg-white/10 px-3 text-xs font-semibold text-white shadow-sm outline-none backdrop-blur transition hover:border-orange-300/70 hover:bg-orange-500/20 focus-visible:ring-2 focus-visible:ring-orange-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
      href={href}
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5 text-orange-200" />
      {label}
    </Link>
  );
}

type ActionItem = { count: number; href: string; icon: IconType; label: string; sub: string; tone: AccentColor };

function ActionQueue({ items }: { items: ActionItem[] }) {
  return (
    <section>
      <SectionLabel
        action={
          items.length > 0 ? (
            <span className="inline-flex h-8 items-center gap-1.5 border border-amber-200 bg-amber-50 px-2.5 text-xs font-semibold text-amber-800">
              <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" />
              {items.length} item{items.length !== 1 ? "s" : ""} need action
            </span>
          ) : (
            <StatusPill icon={CheckCircle2} tone="emerald">All caught up</StatusPill>
          )
        }
        eyebrow="Needs your attention"
        title="Action queue"
      />
      {items.length === 0 ? (
        <div className="flex items-center gap-3 border border-emerald-200 bg-gradient-to-r from-emerald-50 to-white px-5 py-4 shadow-[0_2px_8px_rgba(15,23,42,0.06)]">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center bg-emerald-100 text-emerald-600">
            <CheckCircle2 aria-hidden="true" className="h-5 w-5" />
          </span>
          <div>
            <p className="text-sm font-semibold text-slate-900">No pending actions</p>
            <p className="text-xs text-slate-500">Approvals, lifecycle follow-ups, and operational alerts surface here.</p>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => {
            const Icon = item.icon;
            const style = accentStyles[item.tone];
            return (
              <Link
                aria-label={`${item.label}: ${item.count} — ${item.sub}`}
                className="group flex items-center gap-3 border border-slate-200 bg-white px-4 py-3.5 shadow-[0_2px_8px_rgba(15,23,42,0.06)] outline-none transition duration-200 hover:-translate-y-0.5 hover:border-orange-200/70 hover:bg-orange-50/20 hover:shadow-md focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2"
                href={item.href}
                key={item.label}
              >
                <span className={`flex h-11 w-11 shrink-0 items-center justify-center shadow-sm ring-1 ${style.icon}`}>
                  <Icon aria-hidden="true" className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-slate-900">{item.label}</span>
                  <span className="block truncate text-xs text-slate-500">{item.sub}</span>
                </span>
                <span className={`shrink-0 text-2xl font-black tracking-[-0.03em] ${style.text}`}>{n(item.count)}</span>
                <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-300 transition duration-200 group-hover:translate-x-0.5 group-hover:text-orange-600" />
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

function DataUnavailableBanner({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;

  return (
    <details className="group border border-amber-200 bg-amber-50/60 shadow-[0_2px_8px_rgba(15,23,42,0.06)] [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
        <Activity aria-hidden="true" className="h-4 w-4 shrink-0 text-amber-600" />
        <p className="text-sm font-semibold text-amber-900">
          {messages.length} data source{messages.length !== 1 ? "s" : ""} temporarily unavailable
        </p>
        <span className="ml-auto flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-amber-700">
          <span className="hidden sm:inline">Details</span>
          <ChevronDown aria-hidden="true" className="h-4 w-4 transition-transform duration-200 group-open:rotate-180" />
        </span>
      </summary>
      <ul className="space-y-1 border-t border-amber-200/70 px-4 py-3">
        {messages.map((message) => (
          <li className="flex items-start gap-2 text-xs font-medium text-amber-800/90" key={message}>
            <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-amber-500" />
            {message}
          </li>
        ))}
      </ul>
    </details>
  );
}

function DataQualityStrip({ health, show }: { health: DataHealthMetrics; show: boolean }) {
  if (!show) return null;

  const fixes: { href: string; label: string }[] = [];
  if (health.missingManager > 0) {
    fixes.push({ href: "/admin/data-health?view=employee-issues", label: `${n(health.missingManager)} missing manager` });
  }
  if (health.missingJobTitle > 0) {
    fixes.push({ href: "/admin/data-health?view=employee-issues", label: `${n(health.missingJobTitle)} missing job title` });
  }
  if (health.salesLinkageRate < 100) {
    fixes.push({ href: "/admin/data-health?view=sales-issues", label: `Sales linkage ${pct(health.salesLinkageRate)}` });
  }
  if (fixes.length === 0) return null;

  return (
    <div className="flex flex-col gap-3 border border-sky-200 bg-gradient-to-r from-sky-50 to-white px-5 py-3.5 shadow-[0_4px_16px_rgba(15,23,42,0.07)] sm:flex-row sm:items-center">
      <div className="flex items-center gap-2 text-sm font-semibold text-sky-950">
        <HeartPulse aria-hidden="true" className="h-4 w-4 shrink-0 text-sky-600" />
        Data quality — fix at source
      </div>
      <div className="flex flex-wrap gap-2">
        {fixes.map((fix) => (
          <Link
            className="group inline-flex items-center gap-1.5 border border-sky-200 bg-white px-3 py-1.5 text-xs font-bold text-sky-800 outline-none transition hover:bg-sky-50 focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2"
            href={fix.href}
            key={fix.label}
          >
            {fix.label}
            <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
          </Link>
        ))}
      </div>
    </div>
  );
}

function SecondaryLink({
  href,
  icon: Icon,
  label,
  sub,
  tone,
}: {
  href: string;
  icon: IconType;
  label: string;
  sub: string;
  tone: AccentColor;
}) {
  const style = accentStyles[tone];

  return (
    <Link
      aria-label={`${label} — ${sub}`}
      className="group flex items-center justify-between border border-slate-200 bg-white px-5 py-4 shadow-[0_4px_16px_rgba(15,23,42,0.07)] outline-none transition duration-200 hover:-translate-y-1 hover:border-orange-200/70 hover:bg-orange-50/20 hover:shadow-[0_16px_38px_rgba(15,23,42,0.13)] focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2"
      href={href}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className={`flex h-11 w-11 shrink-0 items-center justify-center shadow-sm ring-1 ${style.icon}`}>
          <Icon aria-hidden="true" className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-950">{label}</p>
          <p className="mt-1 truncate text-xs text-slate-500">{sub}</p>
        </div>
      </div>
      <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-300 transition duration-200 group-hover:translate-x-0.5 group-hover:text-orange-600" />
    </Link>
  );
}

export function AdminCommandCenter({
  data,
  welcomeProfile = null,
  profilePhotoUrl = null,
}: {
  data: AdminCommandCenterData;
  welcomeProfile?: CommandCenterWelcomeProfile | null;
  profilePhotoUrl?: string | null;
}) {
  const { overview: o, health, operations, payrollEligibleCount, dataUnavailable, generatedAt } = data;
  const { showAdminModules, showFinancialModules } = data.access;
  const isHrSpecialistWorkspace = !showAdminModules && !showFinancialModules;
  const showSalesModules = !isHrSpecialistWorkspace;
  const salesAchievement = o.sales.achievementRate * 100;
  const offerAcceptance = o.recruitment.acceptanceRate * 100;
  const pendingRisk = o.risk.expiringContracts + o.risk.probationEndings;
  const attendanceAgent = o.attendanceAgent;
  // ModuleCard's health style names are inverted vs. severity: "attention" renders
  // amber (mild) while "warning" renders rose (severe). Map the ingestion-health
  // service statuses (healthy < warning < attention) onto that scale.
  const attendanceAgentCardHealth: "attention" | "healthy" | "warning" = !attendanceAgent
    ? "attention"
    : attendanceAgent.status === "healthy"
      ? "healthy"
      : attendanceAgent.status === "warning"
        ? "attention"
        : "warning";

  // Map unavailable-source messages to per-domain flags so cards can show "—" instead of a misleading 0.
  const isUnavailable = unavailableMatcher(dataUnavailable);
  const workforceDown = isUnavailable("workforce") || isUnavailable("structure") || isUnavailable("employee directory") || isUnavailable("platform metrics");
  const payrollDown = isUnavailable("payroll");
  const salesDown = isUnavailable("sales");
  const expensesDown = isUnavailable("expense");
  const healthDown = isUnavailable("health");
  const recruitmentDown = isUnavailable("recruitment");
  const leaveDown = isUnavailable("leave");
  const riskDown = isUnavailable("risk") || isUnavailable("lifecycle");

  // Consolidated worklist — only surfaces items that actually need action (count > 0),
  // each gated by the same access flags as the rest of the page. Data is already loaded.
  const actionItems: ActionItem[] = [];
  if (showFinancialModules && !payrollDown && o.payroll.flags > 0) {
    actionItems.push({ count: o.payroll.flags, href: "/payroll", icon: FileSpreadsheet, label: "Payroll flags", sub: "Resolve salary exceptions", tone: "rose" });
  }
  if (!recruitmentDown && o.recruitment.pendingOffers > 0) {
    actionItems.push({ count: o.recruitment.pendingOffers, href: "/offers", icon: Briefcase, label: "Pending offers", sub: "Awaiting candidate response", tone: "violet" });
  }
  if (!leaveDown && o.leave.pendingRequests > 0) {
    actionItems.push({ count: o.leave.pendingRequests, href: "/leave-management/vacation-report", icon: CalendarCheck, label: "Pending vacations", sub: "Leave requests to review", tone: "blue" });
  }
  if (!riskDown && o.risk.probationEndings > 0) {
    actionItems.push({ count: o.risk.probationEndings, href: "/probation", icon: Hourglass, label: "Probation endings", sub: "Decisions due soon", tone: "amber" });
  }
  if (!riskDown && o.risk.expiringContracts > 0) {
    actionItems.push({ count: o.risk.expiringContracts, href: "/contracts", icon: IdCard, label: "Contract renewals", sub: "Expiring soon", tone: "blue" });
  }
  if (showAdminModules && operations.failureCount24h > 0) {
    actionItems.push({ count: operations.failureCount24h, href: "/admin/monitoring", icon: AlertTriangle, label: "System failures", sub: "Last 24 hours", tone: "rose" });
  }

  const now = Date.parse(generatedAt);
  const generatedAtLabel = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(now);
  const heroDescription = isHrSpecialistWorkspace
    ? "Focused people operations, hiring workflow, leave governance, coaching, and HR communication in one workspace."
    : showFinancialModules
    ? "Unified workforce, payroll, sales, and operational intelligence in one executive surface."
    : "Unified workforce, people operations, sales, and operational intelligence in one executive surface.";
  const profileImage = profilePhotoUrl ?? employeeProfileImageForHrId(welcomeProfile?.hrId ?? null);
  const heroTitle = welcomeProfile
    ? <>Hello, {firstNameFrom(welcomeProfile.fullName)} <span aria-hidden="true">👋🏻</span></>
    : "Admin Command Center";
  const heroCopy = welcomeProfile
    ? "Your Phoenix command center is ready for a focused, confident day. Keep the employee journey moving, protect every detail, and turn today's HR work into progress people can feel."
    : heroDescription;
  const welcomeHrId = formatHrIdForDisplay(welcomeProfile?.hrId) ?? "-";

  return (
    <div className="space-y-6">
        <AdminHeroFrame>
          <div className="relative grid gap-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:p-8 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-orange-400/40 bg-orange-500/15 px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-orange-100 shadow-[0_0_24px_rgba(249,115,22,0.25)]">
                {welcomeProfile ? <Sparkles aria-hidden="true" className="h-3.5 w-3.5" /> : <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-orange-300" />}
                {welcomeProfile ? "Your Phoenix day starts here" : "Phoenix Workforce"}
              </div>
              <h1 className="mt-4 max-w-3xl text-3xl font-black tracking-[-0.04em] text-white sm:text-4xl lg:text-5xl">
                {heroTitle}
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
                {heroCopy}
              </p>

              {welcomeProfile ? (
                <div className="mt-5 grid max-w-3xl grid-cols-1 gap-2 sm:grid-cols-3">
                  <div className="border border-white/10 bg-white/10 px-3.5 py-2.5 backdrop-blur transition duration-200 hover:border-orange-300/40 hover:bg-white/[0.14]">
                    <p className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">HR ID</p>
                    <p className="mt-1 truncate text-sm font-black text-white">{welcomeHrId}</p>
                  </div>
                  <div className="border border-white/10 bg-white/10 px-3.5 py-2.5 backdrop-blur transition duration-200 hover:border-orange-300/40 hover:bg-white/[0.14]">
                    <p className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">Manager</p>
                    <p className="mt-1 truncate text-sm font-black text-white">{welcomeProfile.managerName ?? "Unassigned"}</p>
                  </div>
                  <div className="border border-white/10 bg-white/10 px-3.5 py-2.5 backdrop-blur transition duration-200 hover:border-orange-300/40 hover:bg-white/[0.14]">
                    <p className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">Title</p>
                    <p className="mt-1 truncate text-sm font-black text-white">{welcomeProfile.titleLabel}</p>
                  </div>
                </div>
              ) : null}

              <div className="mt-5 flex flex-wrap gap-2">
                <QuickAction href="/employees" icon={Users} label="Employees" />
                {showFinancialModules ? <QuickAction href="/payroll" icon={Wallet} label="Payroll" /> : null}
                {showSalesModules ? <QuickAction href="/sales" icon={TrendingUp} label="Sales" /> : null}
                {isHrSpecialistWorkspace ? <QuickAction href="/offers" icon={Briefcase} label="Offers" /> : null}
                {isHrSpecialistWorkspace ? <QuickAction href="/leave-management/vacation-report" icon={CalendarCheck} label="Vacations" /> : null}
                {isHrSpecialistWorkspace ? <QuickAction href="/coaching/analytics" icon={Activity} label="Coaching" /> : null}
                {showAdminModules ? <QuickAction href="/admin/access" icon={ShieldCheck} label="Access" /> : null}
                {showAdminModules ? <QuickAction href="/admin/notifications/telegram" icon={Send} label="Telegram" /> : null}
                <QuickAction href="/organogram" icon={Network} label="Org Chart" />
              </div>
            </div>

            {welcomeProfile ? (
              <div className="group relative mx-auto flex h-[260px] w-full max-w-[260px] items-center justify-center border border-orange-300/25 bg-gradient-to-tr from-orange-500/20 via-white/10 to-amber-500/20 p-2 shadow-[0_24px_54px_rgba(0,0,0,0.24)] sm:h-[310px] sm:max-w-[300px] lg:mx-0 lg:h-[330px]">
                <div className="absolute -inset-1 bg-gradient-to-br from-orange-300/35 via-white/0 to-amber-300/30 opacity-80 blur-sm transition-opacity duration-300 group-hover:opacity-100" />
                <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-white/95 shadow-inner">
                  {profileImage ? (
                    <Image
                      alt={`${welcomeProfile.fullName} profile photo`}
                      className="h-full w-full object-cover object-[center_18%] transition-transform duration-500 group-hover:scale-105"
                      height={330}
                      priority
                      src={profileImage}
                      unoptimized={profileImage.startsWith("/api/")}
                      width={300}
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-orange-500/10 text-orange-500 transition-transform duration-500 group-hover:scale-105">
                      <span className="text-[50px] font-black tracking-normal">{initialsFrom(welcomeProfile.fullName)}</span>
                    </div>
                  )}
                </div>
                <div className="absolute -bottom-3 left-4 right-4 flex items-center justify-center gap-2 border border-white/70 bg-white px-3 py-2 text-[11px] font-black uppercase tracking-normal text-emerald-700 shadow-[0_16px_34px_rgba(15,23,42,0.18)]">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Phoenix Verified
                </div>
              </div>
            ) : (
              <div className="border border-white/10 bg-black/20 p-4 backdrop-blur">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Operational status
                    </p>
                    <p className="mt-2 text-xl font-black text-white">Live data</p>
                  </div>
                  <span className="relative flex h-3 w-3">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" style={{ animationDuration: "1.5s" }} />
                    <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-400" />
                  </span>
                </div>
                <div className="mt-5 grid gap-2">
                  {showFinancialModules ? (
                    <div className="flex items-center justify-between border border-white/10 bg-white/5 px-3 py-2 text-xs">
                      <span className="font-semibold text-slate-300">Payroll synced</span>
                      <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between border border-white/10 bg-white/5 px-3 py-2 text-xs">
                    <span className="font-semibold text-slate-300">Governance active</span>
                    <ShieldCheck className="h-4 w-4 text-sky-300" />
                  </div>
                  {isHrSpecialistWorkspace ? (
                    <div className="flex items-center justify-between border border-white/10 bg-white/5 px-3 py-2 text-xs">
                      <span className="font-semibold text-slate-300">HR modules scoped</span>
                      <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between border border-white/10 bg-white/5 px-3 py-2 text-xs">
                    <span className="font-semibold text-slate-300">Access protected</span>
                    <LockKeyhole className="h-4 w-4 text-violet-300" />
                  </div>
                </div>
              </div>
            )}
          </div>
        </AdminHeroFrame>

        <ActionQueue items={actionItems} />
        <DataQualityStrip health={health} show={showAdminModules && !healthDown} />
        <DataUnavailableBanner messages={dataUnavailable} />

        <div className="relative overflow-hidden border border-slate-200 bg-white px-5 py-3.5 shadow-[0_4px_16px_rgba(15,23,42,0.07)]">
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-orange-400/0 via-orange-400/50 to-orange-400/0" />
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs font-semibold text-slate-700">
              <span>{n(o.hr.totalStructure)} structure positions</span>
              <span>{n(o.hr.activeEmployees)} active</span>
              <span>{n(o.hr.vacantPositions)} vacant</span>
              <span>{pendingRisk} pending risks</span>
              {showFinancialModules ? <span>{n(o.payroll.flags)} payroll flags</span> : null}
              {isHrSpecialistWorkspace ? <span>{n(o.recruitment.pendingOffers)} pending offers</span> : null}
              {isHrSpecialistWorkspace ? <span>{n(o.leave.pendingRequests)} pending vacations</span> : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {showFinancialModules ? <StatusPill tone="emerald">Payroll synced</StatusPill> : null}
              <StatusPill icon={ShieldCheck} tone="sky">{isHrSpecialistWorkspace ? "HR scope active" : "Audit healthy"}</StatusPill>
              <StatusPill icon={LockKeyhole} tone="violet">Access protected</StatusPill>
            </div>
          </div>
        </div>

        <section>
          <SectionLabel
            action={
              <>
                <StatusPill tone="emerald">Governance active</StatusPill>
                <StatusPill icon={ShieldCheck} tone="sky">RLS protected</StatusPill>
              </>
            }
            eyebrow="Command metrics"
            title="Key operating signals"
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {isHrSpecialistWorkspace ? (
              <>
                <KpiCard icon={CheckCircle2} label="Active Employees" primary sub={`of ${n(o.hr.totalStructure)} structure`} trend="up" value={orDash(workforceDown, n(o.hr.activeEmployees))} />
                <KpiCard accent icon={Briefcase} label="Hiring Pipeline" primary sub={`${n(o.recruitment.pendingOffers)} pending offers`} value={orDash(recruitmentDown, n(o.recruitment.totalOffers))} />
                <KpiCard icon={Hourglass} label="Lifecycle Follow-up" sub={`${n(o.risk.probationEndings)} probation / ${n(o.risk.expiringContracts)} contracts`} value={orDash(riskDown, n(pendingRisk))} warn={!riskDown && pendingRisk > 0} />
                <KpiCard icon={CalendarCheck} label="Vacation Requests" sub={`${n(o.leave.pendingRequests)} pending`} value={orDash(leaveDown, n(o.leave.totalRequests))} />
              </>
            ) : (
              <>
                <KpiCard icon={CheckCircle2} label="Active Employees" primary sub={`of ${n(o.hr.totalStructure)} structure`} trend="up" value={orDash(workforceDown, n(o.hr.activeEmployees))} />
                {showFinancialModules ? (
                  <KpiCard accent icon={Wallet} label="Net Payroll" primary sub={`Gross ${egp(o.payroll.gross)}`} value={orDash(payrollDown, egp(o.payroll.net))} />
                ) : null}
                {showSalesModules ? (
                  <KpiCard
                    accent={salesAchievement >= 90}
                    icon={Target}
                    label="Sales Achievement"
                    primary
                    sub={`${n(o.sales.activeProducts)} active products`}
                    trend={salesAchievement >= 90 ? "up" : salesAchievement < 70 ? "down" : "neutral"}
                    value={orDash(salesDown, pct(salesAchievement))}
                    warn={!salesDown && salesAchievement < 70}
                  />
                ) : null}
                <KpiCard icon={Users} label="Total Structure" sub={`${n(o.hr.activeEmployees)} active / ${n(o.hr.vacantPositions)} vacant`} value={orDash(workforceDown, n(o.hr.totalStructure))} />
                {showFinancialModules ? (
                  <KpiCard icon={IdCard} label="Payroll Eligible" sub={o.payroll.batchLabel || "Latest batch"} value={orDash(payrollDown, n(payrollEligibleCount))} />
                ) : null}
                {showSalesModules ? (
                  <KpiCard icon={TrendingUp} label="Total Sales" sub={`vs ${egp(o.sales.targetValue)} target`} value={orDash(salesDown, egp(o.sales.salesValue))} />
                ) : null}
                {showFinancialModules ? (
                  <KpiCard icon={Receipt} label="Outstation Expenses" sub={`${n(o.expenses.totalRows)} entries`} value={orDash(expensesDown, egp(o.expenses.approvedAmount))} />
                ) : null}
                <KpiCard
                  accent={health.employeeHealthRate >= 90}
                  icon={HeartPulse}
                  label="Data Health"
                  sub={`${n(health.healthyEmployees)} / ${n(health.totalEmployees || o.hr.activeEmployees)} healthy employees`}
                  trend={health.employeeHealthRate >= 90 ? "up" : health.employeeHealthRate < 70 ? "down" : "neutral"}
                  value={orDash(healthDown, pct(health.employeeHealthRate))}
                  warn={!healthDown && health.employeeHealthRate < 70}
                />
              </>
            )}
          </div>
        </section>

        <section>
          <SectionLabel
            action={<StatusPill icon={LockKeyhole} tone="violet">Audit enabled</StatusPill>}
            eyebrow="Workspace map"
            title="Core operating modules"
          />
          <div className={isHrSpecialistWorkspace ? "grid gap-4 sm:grid-cols-2 lg:grid-cols-4" : "grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"}>
            {isHrSpecialistWorkspace ? (
              <>
                <ModuleCard
                  accentColor="blue"
                  description="Employees, organogram, structure, and reporting-line visibility."
                  health={o.hr.employeesWithoutManagers > 0 ? "attention" : "healthy"}
                  href="/employees"
                  icon={Users}
                  lastSync="Live"
                  metrics={[
                    { label: "Active", value: n(o.hr.activeEmployees) },
                    { label: "Vacant", value: n(o.hr.vacantPositions) },
                    { label: "No Mgr", ok: o.hr.employeesWithoutManagers === 0, value: n(o.hr.employeesWithoutManagers) },
                  ]}
                  title="People Management"
                />
                <ModuleCard
                  accentColor="violet"
                  description="Offers, vacancies, CV database, and hiring document workflow."
                  health={offerAcceptance >= 70 ? "healthy" : "attention"}
                  href="/offers"
                  icon={Briefcase}
                  lastSync="Live"
                  metrics={[
                    { label: "Offers", value: n(o.recruitment.totalOffers) },
                    { label: "Pending", value: n(o.recruitment.pendingOffers) },
                    { label: "Vacant", value: n(o.hr.vacantPositions) },
                  ]}
                  title="Hiring Pipeline"
                />
                <ModuleCard
                  accentColor="amber"
                  description="Probation endings and contract renewal follow-up."
                  health={pendingRisk > 0 ? "attention" : "healthy"}
                  href="/probation"
                  icon={Hourglass}
                  lastSync="Live"
                  metrics={[
                    { label: "Risk", ok: pendingRisk === 0, value: n(pendingRisk) },
                    { label: "Probation", value: n(o.risk.probationEndings) },
                    { label: "Contracts", value: n(o.risk.expiringContracts) },
                  ]}
                  title="Lifecycle Follow-up"
                />
                <ModuleCard
                  accentColor="rose"
                  description="Vacation request creation and HR leave report review."
                  href="/leave-management/vacation-report"
                  icon={CalendarCheck}
                  lastSync="Live"
                  metrics={[
                    { label: "Total", value: n(o.leave.totalRequests) },
                    { label: "Pending", value: n(o.leave.pendingRequests) },
                    { label: "Approved", value: n(o.leave.approvedRequests) },
                  ]}
                  title="Vacation Management"
                />
                <ModuleCard
                  accentColor="emerald"
                  description="Fingerprint attendance report review and export."
                  href="/attendance/fingerprint-report"
                  icon={Fingerprint}
                  lastSync="Live"
                  metrics={[
                    { label: "Days", value: n(o.attendance.currentMonthWorkingDays) },
                    { label: "Policies", value: n(o.attendance.activePolicies) },
                    { label: "Maps", value: n(o.attendance.activeMappings) },
                  ]}
                  title="Fingerprint Report"
                />
                <ModuleCard
                  accentColor="amber"
                  description="Fingerprint device sync freshness — flags when the local agent stops sending punches."
                  health={attendanceAgentCardHealth}
                  href="/attendance/device-user-mapping"
                  icon={Fingerprint}
                  lastSync={attendanceAgent ? attendanceAgent.lastIngestedLabel : "Check failed"}
                  metrics={[
                    { label: "Missed", ok: (attendanceAgent?.missedWorkingDays ?? 99) === 0, value: attendanceAgent ? n(attendanceAgent.missedWorkingDays) : "—" },
                    { label: "Status", ok: attendanceAgent?.status === "healthy", value: attendanceAgent ? attendanceAgent.status : "—" },
                  ]}
                  title="Attendance Agent"
                />
                <ModuleCard
                  accentColor="orange"
                  description="Field coaching report visibility and coaching analytics."
                  href="/coaching/analytics"
                  icon={BarChart3}
                  lastSync="Live"
                  title="Coaching Analytics"
                />
                <ModuleCard
                  accentColor="violet"
                  description="Email composer and HR reporting templates."
                  href="/admin/email-reply-composer"
                  icon={Mail}
                  lastSync="Live"
                  title="HR Communication"
                />
                <ModuleCard
                  accentColor="emerald"
                  description="Self-service payslip access for this HR account."
                  href="/payslips"
                  icon={ScrollText}
                  lastSync="Self only"
                  title="My Payslips"
                />
              </>
            ) : (
              <>
            <ModuleCard
              accentColor="blue"
              description="Employee directory, HR records, profile governance, and people updates."
              health={o.hr.employeesWithoutManagers > 0 ? "attention" : "healthy"}
              href="/employees"
              icon={Users}
              lastSync="Live"
              metrics={[
                { label: "Structure", value: n(o.hr.totalStructure) },
                { label: "Active", value: n(o.hr.activeEmployees) },
                { label: "Vacant", value: n(o.hr.vacantPositions) },
              ]}
              title="Employees"
            />
            {showFinancialModules ? (
              <ModuleCard
                accentColor="emerald"
                description="Salary batches, payslip distribution, deductions, and financial reconciliation."
                health={o.payroll.flags > 0 ? "attention" : "healthy"}
                href="/payroll"
                icon={FileSpreadsheet}
                lastSync={o.payroll.batchLabel || "Latest"}
                metrics={[
                  { label: "Net", value: egp(o.payroll.net) },
                  { label: "Staff", value: n(o.payroll.employees) },
                  { label: "Flags", ok: o.payroll.flags === 0, value: n(o.payroll.flags) },
                ]}
                title="Payroll Operations"
              />
            ) : null}
            {showSalesModules ? (
              <ModuleCard
                accentColor="orange"
                description="Rep achievement tracking, product analytics, and territory-level targets."
                health={salesAchievement >= 90 ? "healthy" : salesAchievement < 70 ? "warning" : "attention"}
                href="/sales"
                icon={BarChart3}
                lastSync="Live"
                metrics={[
                  { label: "Sales", value: egp(o.sales.salesValue) },
                  { label: "Achieve", ok: salesAchievement >= 90, value: pct(salesAchievement) },
                  { label: "Products", value: n(o.sales.activeProducts) },
                ]}
                title="Sales Performance"
              />
            ) : null}
            {showFinancialModules ? (
              <ModuleCard
                accentColor="amber"
                description="Trip reports, fuel claims, and expense approval workflow."
                href="/payroll/expenses/dashboard"
                icon={Receipt}
                lastSync="Live"
                metrics={[
                  { label: "Approved", value: egp(o.expenses.approvedAmount) },
                  { label: "Reports", value: n(o.expenses.reportCount) },
                  { label: "Entries", value: n(o.expenses.totalRows) },
                ]}
                title="Outstation Expenses"
              />
            ) : null}
            <ModuleCard
              accentColor="violet"
              description="Offer lifecycle management, acceptance tracking, and pipeline overview."
              health={offerAcceptance >= 70 ? "healthy" : "attention"}
              href="/offers"
              icon={Briefcase}
              lastSync="Live"
              metrics={[
                { label: "Total", value: n(o.recruitment.totalOffers) },
                { label: "Pending", value: n(o.recruitment.pendingOffers) },
                { label: "Accept", ok: offerAcceptance >= 70, value: pct(offerAcceptance) },
              ]}
              title="Job Offers"
            />
            {showAdminModules ? (
              <ModuleCard
                accentColor="rose"
                description="Employee linkage integrity, HR ID orphan detection, and sales data quality."
                health={health.employeeHealthRate >= 90 ? "healthy" : health.employeeHealthRate < 70 ? "warning" : "attention"}
                href="/admin/data-health"
                icon={HeartPulse}
                lastSync="Live"
                metrics={[
                  { label: "HR", ok: health.employeeHealthRate >= 90, value: pct(health.employeeHealthRate) },
                  { label: "Sales", ok: health.salesLinkageRate >= 90, value: pct(health.salesLinkageRate) },
                  { label: "No Mgr", ok: health.missingManager === 0, value: n(health.missingManager) },
                ]}
                title="Data Health"
              />
            ) : null}
            <ModuleCard
              accentColor="amber"
              description="Fingerprint device sync freshness — flags when the local agent stops sending punches."
              health={attendanceAgentCardHealth}
              href="/attendance/device-user-mapping"
              icon={Fingerprint}
              lastSync={attendanceAgent ? attendanceAgent.lastIngestedLabel : "Check failed"}
              metrics={[
                { label: "Missed", ok: (attendanceAgent?.missedWorkingDays ?? 99) === 0, value: attendanceAgent ? n(attendanceAgent.missedWorkingDays) : "—" },
                { label: "Status", ok: attendanceAgent?.status === "healthy", value: attendanceAgent ? attendanceAgent.status : "—" },
              ]}
              title="Attendance Agent"
            />
            {!isHrSpecialistWorkspace ? (
              <ModuleCard
                accentColor="blue"
                description="Interactive org chart with hierarchy visualization and role mapping."
                health={o.hr.employeesWithoutManagers > 0 ? "attention" : "healthy"}
                href="/organogram"
                icon={Network}
                lastSync="Live"
                metrics={[
                  { label: "Lines", value: n(o.hr.uniqueLines) },
                  { label: "Areas", value: n(o.hr.uniqueAreas) },
                  { label: "No Mgr", ok: o.hr.employeesWithoutManagers === 0, value: n(o.hr.employeesWithoutManagers) },
                ]}
                title="Organogram"
              />
            ) : null}
            {showAdminModules ? (
              <ModuleCard
                accentColor="violet"
                description="User accounts, role permissions, authentication, and audit trail."
                href="/admin/access"
                icon={ShieldCheck}
                lastSync="Live"
                title="Access Control"
              />
            ) : null}
              </>
            )}
          </div>
        </section>

        <section>
          <SectionLabel
            action={
              <>
                <StatusPill icon={History} tone="sky">{n(operations.totalEvents24h)} events · 24h</StatusPill>
                {operations.failureCount24h > 0 ? (
                  <span className="inline-flex h-8 items-center gap-1.5 border border-rose-200 bg-rose-50 px-2.5 text-xs font-semibold text-rose-700">
                    <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" />
                    {n(operations.failureCount24h)} failures · 24h
                  </span>
                ) : (
                  <StatusPill icon={CheckCircle2} tone="emerald">No failures · 24h</StatusPill>
                )}
              </>
            }
            eyebrow="Live operations"
            title="System pulse"
          />
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
            <div className="relative overflow-hidden border border-slate-200 bg-white p-5 shadow-[0_4px_16px_rgba(15,23,42,0.07)]">
              <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-orange-500 via-orange-400 to-amber-300 opacity-70" />
              {operations.recent.length > 0 ? (
                <ul className="divide-y divide-slate-100">
                  {operations.recent.map((event, index) => (
                    <li className="flex items-start gap-3 py-3 first:pt-1 last:pb-1" key={`${event.module}-${event.timestamp}-${index}`}>
                      <span aria-hidden="true" className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${eventDotClass(event.status)}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-sm font-semibold text-slate-900">{event.module}</p>
                          <span className={`inline-flex shrink-0 items-center border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] ${eventStatusTone(event.status)}`}>
                            {event.status}
                          </span>
                        </div>
                        <p className="mt-0.5 truncate text-xs text-slate-500">{event.description}</p>
                        <p className="mt-1 truncate text-[11px] font-medium text-slate-400">
                          {event.userName} · {relativeTime(event.timestamp, now)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
                  <span className="flex h-12 w-12 items-center justify-center bg-orange-50 text-orange-500 ring-1 ring-orange-200/70">
                    <History aria-hidden="true" className="h-6 w-6" />
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-slate-700">No recent operational activity</p>
                    <p className="mt-1 text-xs text-slate-500">Events from payroll, sales, and approvals appear here as they happen.</p>
                  </div>
                </div>
              )}
            </div>
            <aside className="grid grid-cols-2 gap-3 lg:grid-cols-1">
              <div className="border border-slate-200 bg-gradient-to-br from-white to-slate-50/60 px-4 py-3 shadow-[0_2px_8px_rgba(15,23,42,0.06)]">
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Events · 24h</p>
                <p className="mt-1.5 text-2xl font-black tracking-[-0.03em] text-slate-900">{n(operations.totalEvents24h)}</p>
              </div>
              <div className={`border px-4 py-3 shadow-[0_2px_8px_rgba(15,23,42,0.06)] ${operations.failureCount24h > 0 ? "border-rose-200 bg-gradient-to-br from-rose-50 to-white" : "border-emerald-200 bg-gradient-to-br from-emerald-50 to-white"}`}>
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Failures · 24h</p>
                <p className={`mt-1.5 text-2xl font-black tracking-[-0.03em] ${operations.failureCount24h > 0 ? "text-rose-700" : "text-emerald-700"}`}>{n(operations.failureCount24h)}</p>
              </div>
              <div className="border border-slate-200 bg-gradient-to-br from-white to-slate-50/60 px-4 py-3 shadow-[0_2px_8px_rgba(15,23,42,0.06)]">
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Last event</p>
                <p className="mt-1.5 flex items-center gap-1.5 text-sm font-bold text-slate-900">
                  <Clock aria-hidden="true" className="h-3.5 w-3.5 text-slate-400" />
                  {relativeTime(operations.lastEventAt, now)}
                </p>
              </div>
              {operations.staleSources.length > 0 ? (
                <div className="border border-amber-200 bg-gradient-to-br from-amber-50 to-white px-4 py-3 shadow-[0_2px_8px_rgba(15,23,42,0.06)]">
                  <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Stale sources</p>
                  <p className="mt-1.5 text-2xl font-black tracking-[-0.03em] text-amber-700">{n(operations.staleSources.length)}</p>
                </div>
              ) : null}
            </aside>
          </div>
        </section>

        {!isHrSpecialistWorkspace ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <SecondaryLink
              href="/probation"
              icon={Activity}
              label="Probation Period"
              sub={o.risk.probationEndings > 0 ? `${o.risk.probationEndings} ending soon` : "All on track"}
              tone="amber"
            />
            <SecondaryLink
              href="/contracts"
              icon={IdCard}
              label="Contract Renewal"
              sub={o.risk.expiringContracts > 0 ? `${o.risk.expiringContracts} expiring soon` : "No urgent renewals"}
              tone="blue"
            />
          </div>
        ) : null}

        <footer className="flex flex-col gap-2 border border-slate-200 bg-white/85 px-4 py-3 text-xs text-slate-500 shadow-[0_2px_8px_rgba(15,23,42,0.06)] backdrop-blur sm:flex-row sm:items-center sm:justify-between">
          <p className="font-semibold">Phoenix Workforce / Admin Command Center</p>
          <p className="flex items-center gap-2">
            <span aria-hidden="true" className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" style={{ animationDuration: "1.8s" }} />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            Live · data as of {generatedAtLabel}
          </p>
        </footer>
    </div>
  );
}
