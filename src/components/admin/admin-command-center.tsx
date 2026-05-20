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
  Fingerprint,
  FileSpreadsheet,
  FileUp,
  HeartPulse,
  Hourglass,
  IdCard,
  LockKeyhole,
  Mail,
  Network,
  Receipt,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
  Users,
  Wallet,
  XCircle,
} from "lucide-react";

import type { AdminCommandCenterData } from "@/lib/admin/command-center";
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

type IconType = typeof Users;
type MiniMetric = { label: string; ok?: boolean; value: string };
type AccentColor = "amber" | "blue" | "emerald" | "orange" | "rose" | "violet";
type Health = "attention" | "healthy" | "warning";

const commandCenterProfileImagesByHrId: Record<string, string> = {
  "A-16": "/images/hr/youmna-kotb.jpg",
  A16: "/images/hr/youmna-kotb.jpg",
};

function profileImageForHrId(hrId: string | null) {
  const normalized = String(hrId ?? "").trim().toUpperCase();
  const compact = normalized.replace(/[^A-Z0-9]/g, "");
  return commandCenterProfileImagesByHrId[normalized] ?? commandCenterProfileImagesByHrId[compact] ?? null;
}

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
  { button: string; icon: string; metric: string; text: string }
> = {
  amber: {
    button: "bg-amber-600 hover:bg-amber-700",
    icon: "bg-amber-50 text-amber-700 ring-amber-200",
    metric: "from-amber-50 to-white",
    text: "text-amber-700",
  },
  blue: {
    button: "bg-sky-600 hover:bg-sky-700",
    icon: "bg-sky-50 text-sky-700 ring-sky-200",
    metric: "from-sky-50 to-white",
    text: "text-sky-700",
  },
  emerald: {
    button: "bg-emerald-600 hover:bg-emerald-700",
    icon: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    metric: "from-emerald-50 to-white",
    text: "text-emerald-700",
  },
  orange: {
    button: "bg-orange-600 hover:bg-orange-700",
    icon: "bg-orange-50 text-orange-700 ring-orange-200",
    metric: "from-orange-50 to-white",
    text: "text-orange-700",
  },
  rose: {
    button: "bg-rose-600 hover:bg-rose-700",
    icon: "bg-rose-50 text-rose-700 ring-rose-200",
    metric: "from-rose-50 to-white",
    text: "text-rose-700",
  },
  violet: {
    button: "bg-violet-600 hover:bg-violet-700",
    icon: "bg-violet-50 text-violet-700 ring-violet-200",
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
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-orange-700">
          {eyebrow}
        </p>
        <h2 className="mt-1 text-lg font-black tracking-[-0.02em] text-slate-950">
          {title}
        </h2>
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
      className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold ${toneClassName}`}
    >
      {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
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
      className={`group relative overflow-hidden rounded-lg border bg-gradient-to-br px-4 py-4 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:shadow-md ${
        warn
          ? "border-amber-200 from-amber-50 to-white"
          : accent
            ? "border-orange-200 from-orange-50 to-white"
            : "border-slate-200 from-white to-slate-50"
      } ${primary ? "ring-1 ring-orange-200/70" : ""}`}
    >
      {primary ? <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-orange-600 via-amber-500 to-sky-500" /> : null}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-h-5 items-center gap-2">
            <p className="truncate text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">
              {label}
            </p>
            {TrendIcon ? <TrendIcon className={`h-3.5 w-3.5 ${trendClassName}`} /> : null}
          </div>
          <p className={`${primary ? "text-2xl" : "text-xl"} mt-2 font-black tracking-[-0.03em] ${style.text}`}>
            {value}
          </p>
          {sub ? <p className="mt-1.5 text-xs leading-5 text-slate-500">{sub}</p> : null}
        </div>
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ring-1 ${style.icon}`}>
          <Icon className="h-5 w-5" />
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
    <div className="group flex min-h-[236px] flex-col rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md">
      <div className="flex items-start gap-3">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ring-1 ${style.icon}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-sm font-black tracking-[-0.01em] text-slate-950">{title}</h3>
            <span className={`inline-flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-bold ${healthStyle}`}>
              {health === "healthy" ? <CheckCircle2 className="h-3 w-3" /> : null}
              {health === "attention" ? <AlertTriangle className="h-3 w-3" /> : null}
              {health === "warning" ? <XCircle className="h-3 w-3" /> : null}
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
              className={`rounded-lg border border-slate-200 bg-gradient-to-b ${style.metric} px-2.5 py-2`}
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
        className={`mt-4 inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-xs font-black uppercase tracking-[0.08em] text-white shadow-sm transition duration-200 hover:shadow-md ${style.button}`}
        href={href}
      >
        Open
        <ArrowRight className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
      </Link>
    </div>
  );
}

function QuickAction({ href, icon: Icon, label }: { href: string; icon: IconType; label: string }) {
  return (
    <Link
      className="inline-flex h-9 items-center gap-2 rounded-lg border border-white/15 bg-white/10 px-3 text-xs font-semibold text-white shadow-sm backdrop-blur transition hover:border-orange-300/70 hover:bg-orange-500/20"
      href={href}
    >
      <Icon className="h-3.5 w-3.5 text-orange-200" />
      {label}
    </Link>
  );
}

function RiskStrip({ expiringContracts, probationEndings }: { expiringContracts: number; probationEndings: number }) {
  const hasRisk = expiringContracts > 0 || probationEndings > 0;
  if (!hasRisk) return null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 shadow-sm sm:flex-row sm:items-center">
      <div className="flex items-center gap-2 text-sm font-black text-amber-950">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
        Attention required
      </div>
      <div className="flex flex-wrap gap-2">
        {expiringContracts > 0 ? (
          <Link className="rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-amber-800 ring-1 ring-amber-200 transition hover:bg-amber-100" href="/contracts">
            {expiringContracts} contract{expiringContracts !== 1 ? "s" : ""} expiring soon
          </Link>
        ) : null}
        {probationEndings > 0 ? (
          <Link className="rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-amber-800 ring-1 ring-amber-200 transition hover:bg-amber-100" href="/probation">
            {probationEndings} probation{probationEndings !== 1 ? "s" : ""} ending soon
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function DataUnavailableBanner({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;

  return (
    <div className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <Activity className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
      <div>
        <p className="text-sm font-black text-slate-800">Some data sources are temporarily unavailable</p>
        <ul className="mt-1.5 space-y-1">
          {messages.map((message) => (
            <li className="text-xs font-medium text-slate-500" key={message}>
              {message}
            </li>
          ))}
        </ul>
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
      className="group flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-4 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md"
      href={href}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ring-1 ${style.icon}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-black text-slate-950">{label}</p>
          <p className="mt-1 truncate text-xs text-slate-500">{sub}</p>
        </div>
      </div>
      <ArrowRight className="h-4 w-4 shrink-0 text-slate-300 transition duration-200 group-hover:translate-x-0.5 group-hover:text-orange-600" />
    </Link>
  );
}

export function AdminCommandCenter({
  data,
  welcomeProfile = null,
}: {
  data: AdminCommandCenterData;
  welcomeProfile?: CommandCenterWelcomeProfile | null;
}) {
  const { overview: o, health, payrollEligibleCount, dataUnavailable } = data;
  const isHrSpecialistWorkspace = welcomeProfile?.systemRoleLabel === "HR Specialist";
  const showAdminModules = !isHrSpecialistWorkspace;
  const showFinancialModules = !isHrSpecialistWorkspace;
  const showSalesModules = !isHrSpecialistWorkspace;
  const salesAchievement = o.sales.achievementRate * 100;
  const offerAcceptance = o.recruitment.acceptanceRate * 100;
  const pendingRisk = o.risk.expiringContracts + o.risk.probationEndings;
  const heroDescription = isHrSpecialistWorkspace
    ? "Focused people operations, hiring workflow, leave governance, coaching, and HR communication in one workspace."
    : showFinancialModules
    ? "Unified workforce, payroll, sales, and operational intelligence in one executive surface."
    : "Unified workforce, people operations, sales, and operational intelligence in one executive surface.";
  const profileImage = profileImageForHrId(welcomeProfile?.hrId ?? null);
  const heroTitle = welcomeProfile
    ? <>Hello, {firstNameFrom(welcomeProfile.fullName)} <span aria-hidden="true">👋🏻</span></>
    : "Admin Command Center";
  const heroCopy = welcomeProfile
    ? "Your Phoenix command center is ready for a focused, confident day. Keep the employee journey moving, protect every detail, and turn today's HR work into progress people can feel."
    : heroDescription;
  const welcomeHrId = formatHrIdForDisplay(welcomeProfile?.hrId) ?? "-";

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#F8FAFC_0%,#F1F5F9_48%,#E8EEF5_100%)] px-3 py-5 sm:px-5 lg:px-6">
      <div className="mx-auto max-w-[1480px] space-y-7">
        <section className="relative overflow-hidden rounded-lg border border-slate-950 bg-[linear-gradient(135deg,#070707_0%,#111827_52%,#2C1605_100%)] shadow-[0_22px_70px_rgba(15,23,42,0.32)]">
          <div className="absolute inset-0 opacity-[0.16] [background-image:linear-gradient(rgba(255,255,255,.18)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.18)_1px,transparent_1px)] [background-size:44px_44px]" />
          <div className="relative grid gap-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:p-8 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div>
              <div className="inline-flex items-center gap-2 rounded-lg border border-orange-400/25 bg-orange-500/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-orange-100">
                {welcomeProfile ? <Sparkles className="h-3.5 w-3.5" /> : <span className="h-1.5 w-1.5 rounded-full bg-orange-300" />}
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
                  <div className="rounded-lg border border-white/10 bg-white/10 px-3 py-2 backdrop-blur">
                    <p className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">HR ID</p>
                    <p className="mt-1 truncate text-sm font-black text-white">{welcomeHrId}</p>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-white/10 px-3 py-2 backdrop-blur">
                    <p className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">Manager</p>
                    <p className="mt-1 truncate text-sm font-black text-white">{welcomeProfile.managerName ?? "Unassigned"}</p>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-white/10 px-3 py-2 backdrop-blur">
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
                {showAdminModules ? <QuickAction href="/imports/employees" icon={FileUp} label="Import" /> : null}
                <QuickAction href="/organogram" icon={Network} label="Org Chart" />
              </div>
            </div>

            {welcomeProfile ? (
              <div className="group relative mx-auto flex h-[260px] w-full max-w-[260px] items-center justify-center rounded-[28px] border border-orange-300/25 bg-gradient-to-tr from-orange-500/20 via-white/10 to-sky-500/20 p-2 shadow-[0_24px_54px_rgba(0,0,0,0.24)] sm:h-[310px] sm:max-w-[300px] lg:mx-0 lg:h-[330px]">
                <div className="absolute -inset-1 rounded-[32px] bg-gradient-to-br from-orange-300/35 via-white/0 to-sky-300/30 opacity-80 blur-sm transition-opacity duration-300 group-hover:opacity-100" />
                <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[22px] bg-white/95 shadow-inner">
                  {profileImage ? (
                    <Image
                      alt={`${welcomeProfile.fullName} profile photo`}
                      className="h-full w-full object-cover object-[center_18%] transition-transform duration-500 group-hover:scale-105"
                      height={330}
                      priority
                      src={profileImage}
                      width={300}
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-orange-500/10 text-orange-500 transition-transform duration-500 group-hover:scale-105">
                      <span className="text-[50px] font-black tracking-normal">{initialsFrom(welcomeProfile.fullName)}</span>
                    </div>
                  )}
                </div>
                <div className="absolute -bottom-3 left-4 right-4 flex items-center justify-center gap-2 rounded-lg border border-white/70 bg-white px-3 py-2 text-[11px] font-black uppercase tracking-normal text-emerald-700 shadow-[0_16px_34px_rgba(15,23,42,0.18)]">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Phoenix Verified
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-white/10 bg-black/20 p-4 backdrop-blur">
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
                    <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs">
                      <span className="font-semibold text-slate-300">Payroll synced</span>
                      <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs">
                    <span className="font-semibold text-slate-300">Governance active</span>
                    <ShieldCheck className="h-4 w-4 text-sky-300" />
                  </div>
                  {isHrSpecialistWorkspace ? (
                    <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs">
                      <span className="font-semibold text-slate-300">HR modules scoped</span>
                      <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs">
                    <span className="font-semibold text-slate-300">Access protected</span>
                    <LockKeyhole className="h-4 w-4 text-violet-300" />
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        <RiskStrip expiringContracts={o.risk.expiringContracts} probationEndings={o.risk.probationEndings} />
        <DataUnavailableBanner messages={dataUnavailable} />

        <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs font-semibold text-slate-700">
              <span>{n(o.hr.totalEmployees)} employees</span>
              <span>{n(o.hr.activeEmployees)} active</span>
              <span>{pendingRisk} pending risks</span>
              {showFinancialModules ? <span>{n(o.payroll.flags)} payroll flags</span> : null}
              {isHrSpecialistWorkspace ? <span>{n(o.recruitment.pendingOffers)} pending offers</span> : null}
              {isHrSpecialistWorkspace ? <span>{pendingRisk} lifecycle follow-ups</span> : null}
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
                <KpiCard icon={CheckCircle2} label="Active Employees" primary sub={`of ${n(o.hr.totalEmployees)} total`} trend="up" value={n(o.hr.activeEmployees)} />
                <KpiCard accent icon={Briefcase} label="Hiring Pipeline" primary sub={`${n(o.recruitment.pendingOffers)} pending offers`} value={n(o.recruitment.totalOffers)} />
                <KpiCard icon={Hourglass} label="Lifecycle Follow-up" sub={`${n(o.risk.probationEndings)} probation / ${n(o.risk.expiringContracts)} contracts`} value={n(pendingRisk)} warn={pendingRisk > 0} />
                <KpiCard
                  accent={health.employeeHealthRate >= 90}
                  icon={HeartPulse}
                  label="Data Quality"
                  sub={`${n(health.healthyEmployees)} / ${n(health.totalEmployees || o.hr.totalEmployees)} healthy`}
                  value={pct(health.employeeHealthRate)}
                  warn={health.employeeHealthRate < 70}
                />
              </>
            ) : (
              <>
                <KpiCard icon={CheckCircle2} label="Active Employees" primary sub={`of ${n(o.hr.totalEmployees)} total`} trend="up" value={n(o.hr.activeEmployees)} />
                {showFinancialModules ? (
                  <KpiCard accent icon={Wallet} label="Net Payroll" primary sub={`Gross ${egp(o.payroll.gross)}`} value={egp(o.payroll.net)} />
                ) : null}
                {showSalesModules ? (
                  <KpiCard
                    accent={salesAchievement >= 90}
                    icon={Target}
                    label="Sales Achievement"
                    primary
                    sub={`${n(o.sales.activeProducts)} active products`}
                    trend={salesAchievement >= 90 ? "up" : salesAchievement < 70 ? "down" : "neutral"}
                    value={pct(salesAchievement)}
                    warn={salesAchievement < 70}
                  />
                ) : null}
                <KpiCard icon={Users} label="Total Employees" sub={`${n(o.hr.uniqueLines)} lines / ${n(o.hr.uniqueAreas)} areas`} value={n(o.hr.totalEmployees)} />
                {showFinancialModules ? (
                  <KpiCard icon={IdCard} label="Payroll Eligible" sub={o.payroll.batchLabel || "Latest batch"} value={n(payrollEligibleCount)} />
                ) : null}
                {showSalesModules ? (
                  <KpiCard icon={TrendingUp} label="Total Sales" sub={`vs ${egp(o.sales.targetValue)} target`} value={egp(o.sales.salesValue)} />
                ) : null}
                {showFinancialModules ? (
                  <KpiCard icon={Receipt} label="Expense Claims" sub={`${n(o.expenses.totalRows)} entries`} value={egp(o.expenses.approvedAmount)} />
                ) : null}
                <KpiCard
                  accent={health.employeeHealthRate >= 90}
                  icon={HeartPulse}
                  label="Data Health"
                  sub={`${n(health.healthyEmployees)} / ${n(health.totalEmployees || o.hr.activeEmployees)} healthy employees`}
                  trend={health.employeeHealthRate >= 90 ? "up" : health.employeeHealthRate < 70 ? "down" : "neutral"}
                  value={pct(health.employeeHealthRate)}
                  warn={health.employeeHealthRate < 70}
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
                    { label: "Total", value: n(o.hr.totalEmployees) },
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
                    { label: "Lines", value: n(o.hr.uniqueLines) },
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
                    { label: "Risk", ok: pendingRisk === 0, value: n(pendingRisk) },
                    { label: "Probation", value: n(o.risk.probationEndings) },
                    { label: "Contracts", value: n(o.risk.expiringContracts) },
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
                    { label: "Employees", value: n(o.hr.totalEmployees) },
                    { label: "Lines", value: n(o.hr.uniqueLines) },
                    { label: "No Mgr", ok: o.hr.employeesWithoutManagers === 0, value: n(o.hr.employeesWithoutManagers) },
                  ]}
                  title="Fingerprint Report"
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
                { label: "Total", value: n(o.hr.totalEmployees) },
                { label: "Active", value: n(o.hr.activeEmployees) },
                { label: "Lines", value: n(o.hr.uniqueLines) },
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
                title="Field Expenses"
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
                href="/imports/employees"
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

        {!isHrSpecialistWorkspace ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <SecondaryLink
              href="/probation"
              icon={Activity}
              label="Probation Tracker"
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

        <footer className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white/85 px-4 py-3 text-xs text-slate-500 shadow-sm backdrop-blur sm:flex-row sm:items-center sm:justify-between">
          <p className="font-semibold">Phoenix Workforce / Admin Command Center</p>
          <p>Data refreshes on each page load</p>
        </footer>
      </div>
    </div>
  );
}
