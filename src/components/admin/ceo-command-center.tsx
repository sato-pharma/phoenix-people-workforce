import Image from "next/image";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import {
  Activity,
  ArrowRight,
  BarChart3,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Megaphone,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";

import { AdminHeroFrame } from "@/components/admin/admin-design-system";
import { CeoHiddenNote } from "@/components/admin/ceo-hidden-note";
import type { AccessContext } from "@/lib/auth/permissions";
import { getCeoSalesDeferred } from "@/lib/ceo/command-center";
import type {
  CeoAttentionTone,
  CeoCommandCenterData,
  CeoTopMover,
} from "@/lib/ceo/command-center";

export type CeoWelcomeProfile = {
  fullName: string;
  roleLabel: string;
  hrId: string | null;
  imageUrl?: string | null;
};

// ── Formatters ───────────────────────────────────────────────────────────────

function egp(value: number) {
  const safe = Number.isFinite(value) ? value : 0;
  if (Math.abs(safe) >= 1_000_000) return `EGP ${(safe / 1_000_000).toFixed(1)}M`;
  if (Math.abs(safe) >= 1_000) return `EGP ${(safe / 1_000).toFixed(0)}K`;
  return `EGP ${Math.round(safe).toLocaleString("en-US")}`;
}

function n(value: number) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "0";
}

function pct(value: number, decimals = 0) {
  return `${(Number.isFinite(value) ? value : 0).toFixed(decimals)}%`;
}

const HONORIFICS = new Set(["dr", "prof", "eng", "mr", "mrs", "ms", "miss"]);

function firstNameFrom(full: string) {
  const parts = (full || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "there";
  if (parts.length >= 2 && HONORIFICS.has(parts[0].toLowerCase().replace(/\.$/, ""))) {
    return `${parts[0]} ${parts[1]}`;
  }
  return parts[0];
}

// ── Attention tone mapping ────────────────────────────────────────────────────

const toneStyles: Record<CeoAttentionTone, { border: string; badge: string; text: string; label: string }> = {
  rose:  { border: "border-l-rose-500",   badge: "bg-rose-500 text-white",    text: "text-rose-700",   label: "URGENT"  },
  amber: { border: "border-l-amber-400",  badge: "bg-amber-400 text-white",   text: "text-amber-700",  label: "WARNING" },
  blue:  { border: "border-l-blue-400",   badge: "bg-blue-400 text-white",    text: "text-blue-700",   label: "INFO"    },
};

// ── HealthGauge ───────────────────────────────────────────────────────────────

function HealthGauge({ score, size = 144 }: { score: number; size?: number }) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0));
  const stroke = size >= 130 ? 14 : 10;
  const radius = size / 2 - stroke - 4;
  const circumference = 2 * Math.PI * radius;
  const dash = (clamped / 100) * circumference;
  const color = clamped >= 75 ? "#10B981" : clamped >= 50 ? "#F59E0B" : "#F43F5E";
  const label = clamped >= 75 ? "Strong" : clamped >= 50 ? "Moderate" : "Needs attention";
  const numClass = size >= 130 ? "text-[42px]" : size >= 100 ? "text-[28px]" : "text-[20px]";
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative flex items-center justify-center" style={{ height: size, width: size }}>
        <svg viewBox={`0 0 ${size} ${size}`} className="h-full w-full -rotate-90">
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={stroke} />
          <circle
            cx={size / 2} cy={size / 2} r={radius}
            fill="none" stroke={color} strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circumference - dash}`}
          />
        </svg>
        <div className="absolute flex flex-col items-center leading-none">
          <span className={`${numClass} font-black tracking-tight text-white`}>{Math.round(clamped)}</span>
          <span className="text-[8px] font-bold uppercase tracking-[0.22em] text-slate-400">/ 100</span>
        </div>
      </div>
      <span className="text-[10px] font-bold uppercase tracking-[0.18em]" style={{ color }}>{label}</span>
    </div>
  );
}

// ── Hero KPI ribbon cell ──────────────────────────────────────────────────────

function RibbonStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col justify-center gap-0.5 border-b border-white/10 px-5 py-4 sm:border-b-0 sm:border-r sm:last:border-r-0">
      <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-slate-400">{label}</span>
      <span className="text-2xl font-black tracking-tight text-white">{value}</span>
      {sub ? <span className="text-[10px] text-slate-400">{sub}</span> : null}
    </div>
  );
}

// ── Area sparkline ────────────────────────────────────────────────────────────

function AreaSparkline({
  points,
  stroke = "#F97316",
  gradId,
}: {
  points: Array<{ label: string; value: number }>;
  stroke?: string;
  gradId: string;
}) {
  if (points.length < 2) {
    return (
      <div className="flex h-20 items-center justify-center">
        <p className="text-xs text-slate-400">Not enough history yet.</p>
      </div>
    );
  }
  const W = 300;
  const H = 72;
  const vals = points.map((p) => p.value);
  const max = Math.max(...vals, 1);
  const min = Math.min(...vals, 0);
  const range = max - min || 1;
  const step = W / (points.length - 1);
  const pts = points.map((p, i) => ({
    x: i * step,
    y: H - 4 - ((p.value - min) / range) * (H - 12),
  }));
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const area = `${line} L ${pts[pts.length - 1]!.x.toFixed(1)} ${H} L 0 ${H} Z`;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-18 w-full" style={{ height: 72 }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.25" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${gradId})`} />
        <path d={line} fill="none" stroke={stroke} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className="mt-1 flex justify-between text-[9px] text-slate-400">
        <span>{first.label}</span>
        <span>{last.label}</span>
      </div>
    </div>
  );
}

// ── Ranked mover list ─────────────────────────────────────────────────────────

function RankedMoverList({
  movers,
  empty,
  format,
}: {
  movers: CeoTopMover[];
  empty: string;
  format?: (v: number) => string;
}) {
  if (!movers.length) return <p className="text-xs text-slate-400">{empty}</p>;
  const fmt = format ?? egp;
  const top = movers[0]?.value || 1;
  return (
    <ul className="space-y-2.5">
      {movers.map((mover, i) => (
        <li key={mover.label} className="flex items-center gap-2.5">
          <span className="w-5 shrink-0 text-center text-[10px] font-black text-slate-300">#{i + 1}</span>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="truncate text-[11px] font-semibold text-slate-700">{mover.label}</span>
              <span className="shrink-0 text-[11px] font-black text-slate-900">{fmt(mover.value)}</span>
            </div>
            <div className="h-1 w-full bg-slate-100">
              <div
                className="h-full bg-gradient-to-r from-orange-500 to-amber-400"
                style={{ width: `${Math.max(4, (mover.value / top) * 100)}%` }}
              />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ── Two-series bar chart ──────────────────────────────────────────────────────

function TwoSeriesBars({
  data,
  colorA,
  colorB,
}: {
  data: Array<{ label: string; a: number; b: number }>;
  colorA: string;
  colorB: string;
}) {
  if (!data.length) return <p className="text-xs text-slate-400">No data yet.</p>;
  const max = Math.max(...data.flatMap((row) => [row.a, row.b]), 1);
  return (
    <div className="flex h-20 items-end gap-1.5">
      {data.map((row, index) => (
        <div key={`${row.label}-${index}`} className="flex flex-1 flex-col items-center gap-0.5">
          <div className="flex h-16 w-full items-end justify-center gap-0.5">
            <div
              className="w-1/2"
              style={{ height: `${Math.max(3, (row.a / max) * 100)}%`, backgroundColor: colorA }}
            />
            <div
              className="w-1/2"
              style={{ height: `${Math.max(3, (row.b / max) * 100)}%`, backgroundColor: colorB }}
            />
          </div>
          <span className="truncate text-[8px] text-slate-400">{row.label}</span>
        </div>
      ))}
    </div>
  );
}

// ── Section shell ─────────────────────────────────────────────────────────────

function SectionShell({
  title,
  description,
  children,
  action,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="border border-slate-200 bg-white">
      <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-slate-900 px-5 py-4">
        <div>
          <h2 className="text-sm font-black uppercase tracking-[0.12em] text-white">{title}</h2>
          {description ? <p className="mt-0.5 text-[11px] text-slate-400">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

// ── Performance card ──────────────────────────────────────────────────────────

function PerfCard({
  title,
  icon,
  headline,
  headlineSub,
  badge,
  children,
}: {
  title: string;
  icon: ReactNode;
  headline: string;
  headlineSub: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col border border-slate-200 bg-white">
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 bg-slate-900 px-4 py-3">
        <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.16em] text-slate-300">
          <span className="text-orange-400">{icon}</span>
          {title}
        </div>
        {badge}
      </div>
      <div className="border-b border-slate-100 px-4 py-4">
        <p className="text-[32px] font-black leading-none tracking-tight text-slate-900">{headline}</p>
        <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">{headlineSub}</p>
      </div>
      <div className="flex-1 px-4 py-4">{children}</div>
    </div>
  );
}

// ── Skeleton for deferred cards ───────────────────────────────────────────────

function PerfCardSkeleton({ title }: { title: string }) {
  return (
    <div className="flex flex-col border border-slate-200 bg-white">
      <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-900 px-4 py-3">
        <span className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-300">{title}</span>
      </div>
      <div className="border-b border-slate-100 px-4 py-4">
        <div className="h-8 w-36 animate-pulse bg-slate-100" />
        <div className="mt-2 h-3 w-24 animate-pulse bg-slate-100" />
      </div>
      <div className="flex-1 space-y-3 px-4 py-4">
        <div className="h-16 w-full animate-pulse bg-slate-100" />
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-3 w-full animate-pulse bg-slate-100" style={{ opacity: 1 - i * 0.2 }} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Deferred sales cards ──────────────────────────────────────────────────────

async function DeferredSalesCards({ access }: { access: AccessContext }) {
  const { weekly, marketing } = await getCeoSalesDeferred(access);
  return (
    <>
      {/* Weekly Sales */}
      <PerfCard
        title="Weekly Sales"
        icon={<Activity className="h-3.5 w-3.5" />}
        headline={weekly ? egp(weekly.salesValue) : "—"}
        headlineSub={weekly?.weekStart ? `Week of ${weekly.weekStart}` : "This week"}
        badge={
          weekly && !weekly.wowPriorMissing && weekly.wowPct !== null ? (
            <span
              className={`inline-flex items-center gap-1 border px-2 py-0.5 text-[10px] font-black ${
                weekly.wowPct >= 0
                  ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                  : "border-rose-300 bg-rose-50 text-rose-700"
              }`}
            >
              {weekly.wowPct >= 0 ? (
                <TrendingUp aria-hidden="true" className="h-3 w-3" />
              ) : (
                <TrendingDown aria-hidden="true" className="h-3 w-3" />
              )}
              {pct(Math.abs(weekly.wowPct), 1)} WoW
            </span>
          ) : null
        }
      >
        <div className="space-y-4">
          <AreaSparkline
            points={(weekly?.trend ?? []).map((p) => ({ label: p.label, value: p.value }))}
            stroke="#F97316"
            gradId="weekly-grad"
          />
          <div>
            <p className="mb-2 text-[9px] font-black uppercase tracking-[0.16em] text-slate-400">Top Regions</p>
            <RankedMoverList movers={weekly?.topRegions ?? []} empty="No weekly data yet." />
          </div>
        </div>
      </PerfCard>

      {/* Marketing ROI */}
      <PerfCard
        title="Marketing ROI"
        icon={<Megaphone className="h-3.5 w-3.5" />}
        headline={marketing ? pct(marketing.roiCoverage * 100, 0) : "—"}
        headlineSub="ROI coverage rate"
        badge={
          marketing && marketing.actionRequired > 0 ? (
            <span className="inline-flex items-center gap-1 border border-rose-300 bg-rose-50 px-2 py-0.5 text-[10px] font-black text-rose-700">
              {n(marketing.actionRequired)} require action
            </span>
          ) : null
        }
      >
        {marketing ? (
          <div className="space-y-3">
            {/* ROI progress bar */}
            <div>
              <div className="mb-1 flex justify-between text-[10px] text-slate-500">
                <span>Coverage</span>
                <span className="font-bold">{pct(marketing.roiCoverage * 100, 1)}</span>
              </div>
              <div className="h-2 w-full bg-slate-100">
                <div
                  className="h-full bg-gradient-to-r from-orange-500 to-amber-400"
                  style={{ width: `${Math.min(100, marketing.roiCoverage * 100)}%` }}
                />
              </div>
            </div>
            {/* Key stats grid */}
            <div className="grid grid-cols-2 gap-2">
              {[
                { label: "Requests", value: n(marketing.requestCount) },
                { label: "Paid", value: n(marketing.paidRequests) },
                { label: "Total spend", value: egp(marketing.totalCost) },
                { label: "Attributed", value: egp(marketing.attributedSalesValue) },
              ].map(({ label, value }) => (
                <div key={label} className="border border-slate-100 bg-slate-50 px-2.5 py-2">
                  <p className="text-[9px] font-bold uppercase tracking-[0.12em] text-slate-400">{label}</p>
                  <p className="text-sm font-black text-slate-900">{value}</p>
                </div>
              ))}
            </div>
            {/* Spend at risk */}
            {marketing.spendAtRisk > 0 ? (
              <div className="border border-rose-200 bg-rose-50 px-3 py-2">
                <p className="text-[9px] font-bold uppercase tracking-[0.12em] text-rose-500">Spend at risk</p>
                <p className="text-base font-black text-rose-700">{egp(marketing.spendAtRisk)}</p>
              </div>
            ) : null}
            {marketing.topRisk ? (
              <p className="text-[10px] text-slate-500">
                Top risk:{" "}
                <span className="font-semibold text-slate-700">{marketing.topRisk.customer}</span>{" "}
                <span className="text-slate-400">({marketing.topRisk.code})</span>
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-slate-400">Marketing ROI is unavailable right now.</p>
        )}
      </PerfCard>
    </>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function CeoCommandCenter({
  data,
  welcome,
  access,
  isCeo = false,
}: {
  data: CeoCommandCenterData;
  welcome: CeoWelcomeProfile;
  access: AccessContext;
  isCeo?: boolean;
}) {
  const { health, headcount, payroll, attention, approvals, sos, trends } = data;
  const initials = welcome.fullName
    .split(/\s+/)
    .filter((p) => /^[A-Za-z]/.test(p))
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join("");
  const profileImage = welcome.imageUrl ?? null;
  const generatedLabel = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(data.generatedAt));

  const totalApprovals = approvals.leavePending + approvals.plansPending;
  const allClear = attention.length === 0 && totalApprovals === 0;

  return (
    <div className="space-y-0 divide-y divide-slate-200">

      {/* ── Hero — reuses the Admin identity card (profile + Phoenix Verified) ─────── */}
      <AdminHeroFrame>
        <div>
          <div className="relative grid gap-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:p-8 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-orange-400/40 bg-orange-500/15 px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-orange-100 shadow-[0_0_24px_rgba(249,115,22,0.25)]">
                <Sparkles aria-hidden="true" className="h-3.5 w-3.5" />
                CEO Command Center
              </div>
              <div className="mt-4 flex items-start gap-2.5">
                <h1 className="max-w-3xl text-3xl font-black tracking-[-0.04em] text-white sm:text-4xl lg:text-5xl">
                  Hello, {firstNameFrom(welcome.fullName)} <span aria-hidden="true">👋🏻</span>
                </h1>
                {isCeo ? <span className="mt-1.5 shrink-0"><CeoHiddenNote /></span> : null}
              </div>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
                Your full company — people, payroll, sales, expenses, and risk — in one executive surface,
                confidential products included. Everything is arranged the way you like to see it.
              </p>

              <div className="mt-5 grid max-w-3xl grid-cols-1 gap-2 sm:grid-cols-3">
                <div className="border border-white/10 bg-white/10 px-3.5 py-2.5 backdrop-blur transition duration-200 hover:border-orange-300/40 hover:bg-white/[0.14]">
                  <p className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">HR ID</p>
                  <p className="mt-1 truncate text-sm font-black text-white">{welcome.hrId ?? "—"}</p>
                </div>
                <div className="border border-white/10 bg-white/10 px-3.5 py-2.5 backdrop-blur transition duration-200 hover:border-orange-300/40 hover:bg-white/[0.14]">
                  <p className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">Role</p>
                  <p className="mt-1 truncate text-sm font-black text-white">{welcome.roleLabel}</p>
                </div>
                <div className="border border-white/10 bg-white/10 px-3.5 py-2.5 backdrop-blur transition duration-200 hover:border-orange-300/40 hover:bg-white/[0.14]">
                  <p className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">Coverage</p>
                  <p className="mt-1 truncate text-sm font-black text-white">
                    {n(headcount.uniqueLines)} lines · {n(headcount.uniqueAreas)} areas
                  </p>
                </div>
              </div>

              <div className="mt-5 flex flex-wrap gap-2">
                {[
                  { href: "/employees", icon: Users, label: "Employees" },
                  { href: "/payroll", icon: Wallet, label: "Payroll" },
                  { href: "/sales", icon: TrendingUp, label: "Sales" },
                  { href: "/coaching/analytics", icon: Activity, label: "Coaching" },
                  { href: "/admin/action-center", icon: ClipboardCheck, label: "Action Center" },
                  { href: "/admin/data-health", icon: ShieldCheck, label: "Data Health" },
                ].map(({ href, icon: Icon, label }) => (
                  <Link
                    key={href}
                    href={href}
                    className="inline-flex items-center gap-2 border border-white/15 bg-white/10 px-3.5 py-2 text-xs font-bold text-white transition duration-200 hover:border-orange-300/40 hover:bg-white/[0.18]"
                  >
                    <Icon aria-hidden="true" className="h-3.5 w-3.5 text-orange-300" />
                    {label}
                  </Link>
                ))}
              </div>
            </div>

            {/* Identity card — same as the Admin account */}
            <div className="group relative mx-auto flex h-[260px] w-full max-w-[260px] items-center justify-center border border-orange-300/25 bg-gradient-to-tr from-orange-500/20 via-white/10 to-amber-500/20 p-2 shadow-[0_24px_54px_rgba(0,0,0,0.24)] sm:h-[310px] sm:max-w-[300px] lg:mx-0 lg:h-[330px]">
              <div className="absolute -inset-1 bg-gradient-to-br from-orange-300/35 via-white/0 to-amber-300/30 opacity-80 blur-sm transition-opacity duration-300 group-hover:opacity-100" />
              <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-white/95 shadow-inner">
                {profileImage ? (
                  <Image
                    alt={`${welcome.fullName} profile photo`}
                    className="h-full w-full object-cover object-[center_18%] transition-transform duration-500 group-hover:scale-105"
                    height={330}
                    priority
                    src={profileImage}
                    unoptimized={profileImage.startsWith("/api/")}
                    width={300}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-orange-500/10 text-orange-500 transition-transform duration-500 group-hover:scale-105">
                    <span className="text-[50px] font-black tracking-normal">{initials || "CEO"}</span>
                  </div>
                )}
              </div>
              <div className="absolute -bottom-3 left-4 right-4 flex items-center justify-center gap-2 border border-white/70 bg-white px-3 py-2 text-[11px] font-black uppercase tracking-normal text-emerald-700 shadow-[0_16px_34px_rgba(15,23,42,0.18)]">
                <ShieldCheck className="h-3.5 w-3.5" />
                Phoenix Verified
              </div>
            </div>
          </div>

          {/* KPI ribbon — executive readout */}
          <div className="relative z-10 grid grid-cols-2 border-t border-white/10 bg-black/40 sm:grid-cols-4">
            <div className="flex items-center gap-3 border-b border-white/10 px-5 py-4 sm:border-b-0 sm:border-r">
              <HealthGauge score={health.score} size={72} />
              <div>
                <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-slate-400">Company health</p>
                <p className="text-2xl font-black tracking-tight text-white">
                  {Math.round(health.score)}
                  <span className="ml-0.5 text-xs font-bold text-slate-500">/100</span>
                </p>
              </div>
            </div>
            <RibbonStat
              label="Active staff"
              value={n(headcount.active)}
              sub={headcount.vacancies ? `${n(headcount.vacancies)} vacancies` : "Fully staffed"}
            />
            <RibbonStat
              label="Net payroll"
              value={payroll.available ? egp(payroll.net) : "—"}
              sub={payroll.available ? payroll.batchLabel : "Restricted"}
            />
            <RibbonStat
              label="Monthly SoS"
              value={sos ? egp(sos.totalValue) : "—"}
              sub={sos?.period ?? "No data"}
            />
          </div>
        </div>
      </AdminHeroFrame>

      {/* ── Attention & approvals ─────────────────────────────────────────── */}
      <SectionShell
        title="Attention & pending approvals"
        description="What needs your decision or your eye — by priority."
        action={
          !allClear ? (
            <Link
              href="/admin/action-center"
              className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-[10px] font-bold text-white hover:bg-white/20"
            >
              Action Center <ArrowRight aria-hidden="true" className="h-3 w-3" />
            </Link>
          ) : null
        }
      >
        <div className="p-5 sm:p-6">
          {allClear ? (
            <div className="flex items-center gap-3 border border-emerald-200 bg-emerald-50 px-5 py-4">
              <CheckCircle2 aria-hidden="true" className="h-5 w-5 shrink-0 text-emerald-600" />
              <span className="text-sm font-semibold text-emerald-800">
                All clear — nothing awaiting your approval and no open risk signals.
              </span>
            </div>
          ) : (
            <div className="space-y-2">
              {/* Approval tiles */}
              {totalApprovals > 0 ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Link
                    href="/admin/action-center"
                    className="group flex items-center justify-between border border-slate-200 bg-slate-50 px-4 py-3 hover:border-orange-300 hover:bg-orange-50/40"
                  >
                    <span className="flex items-center gap-3">
                      <ClipboardCheck aria-hidden="true" className="h-4 w-4 text-orange-600" />
                      <span className="text-sm font-semibold text-slate-700">Leave requests</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="text-2xl font-black text-slate-900">{n(approvals.leavePending)}</span>
                      <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 text-slate-400 transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </Link>
                  <Link
                    href="/admin/action-center"
                    className="group flex items-center justify-between border border-slate-200 bg-slate-50 px-4 py-3 hover:border-orange-300 hover:bg-orange-50/40"
                  >
                    <span className="flex items-center gap-3">
                      <CalendarClock aria-hidden="true" className="h-4 w-4 text-orange-600" />
                      <span className="text-sm font-semibold text-slate-700">Weekly plans</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="text-2xl font-black text-slate-900">{n(approvals.plansPending)}</span>
                      <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 text-slate-400 transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </Link>
                </div>
              ) : null}

              {/* Attention items: numbered priority list */}
              {attention.length > 0 ? (
                <div className="divide-y divide-slate-100 border border-slate-200">
                  {attention.map((item, idx) => {
                    const tone = toneStyles[item.tone];
                    return (
                      <Link
                        key={item.key}
                        href={item.href}
                        className={`group flex items-center gap-0 hover:bg-slate-50`}
                      >
                        {/* Color bar */}
                        <div className={`w-1 self-stretch ${tone.border.replace("border-l-", "bg-")}`} />
                        {/* Index */}
                        <span className="w-10 shrink-0 text-center text-[11px] font-black text-slate-300">
                          #{idx + 1}
                        </span>
                        {/* Priority label */}
                        <span className={`w-20 shrink-0 text-[9px] font-black uppercase tracking-[0.14em] ${tone.text}`}>
                          {tone.label}
                        </span>
                        {/* Description */}
                        <span className="flex-1 py-3 text-sm font-medium text-slate-700">{item.label}</span>
                        {/* Count */}
                        <span className="w-12 text-center text-xl font-black text-slate-900">{n(item.count)}</span>
                        {/* Arrow */}
                        <ArrowRight
                          aria-hidden="true"
                          className="mr-4 h-3.5 w-3.5 shrink-0 text-slate-300 transition-transform group-hover:translate-x-0.5"
                        />
                      </Link>
                    );
                  })}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </SectionShell>

      {/* ── Sales performance ─────────────────────────────────────────────── */}
      <SectionShell
        title="Sales & marketing performance"
        description="Source of Sales (monthly), Weekly Sales, and Marketing ROI — confidential products included."
      >
        <div className="grid divide-x divide-slate-200 lg:grid-cols-3">
          {/* SoS — immediate */}
          <PerfCard
            title="Source of Sales"
            icon={<BarChart3 className="h-3.5 w-3.5" />}
            headline={sos ? egp(sos.totalValue) : "—"}
            headlineSub={sos?.period ? `Monthly · ${sos.period}` : "Monthly"}
            badge={sos ? <span className="text-[10px] text-slate-400">{n(sos.totalQty)} units</span> : null}
          >
            <div className="space-y-4">
              <div>
                <p className="mb-2 text-[9px] font-black uppercase tracking-[0.16em] text-slate-400">Top Lines</p>
                <RankedMoverList movers={sos?.topLines ?? []} empty="No monthly sales loaded yet." />
              </div>
              <div>
                <p className="mb-2 text-[9px] font-black uppercase tracking-[0.16em] text-slate-400">Top Regions</p>
                <RankedMoverList movers={sos?.topRegions ?? []} empty="—" />
              </div>
            </div>
          </PerfCard>

          {/* Weekly + Marketing — deferred */}
          <Suspense
            fallback={
              <>
                <PerfCardSkeleton title="Weekly Sales" />
                <PerfCardSkeleton title="Marketing ROI" />
              </>
            }
          >
            <DeferredSalesCards access={access} />
          </Suspense>
        </div>
      </SectionShell>

      {/* ── Company health breakdown ──────────────────────────────────────── */}
      <SectionShell
        title="Company health breakdown"
        description="Weighted signal across sales achievement, attendance, employee linkage, and data coverage."
      >
        <div className="grid divide-x divide-slate-200 sm:grid-cols-4">
          {[
            { label: "Sales achievement", value: health.salesAchievementRate, target: 0.9, color: "#F97316" },
            { label: "Attendance readiness", value: health.attendanceReadinessRate, target: 1, color: "#3B82F6" },
            { label: "Employee linkage", value: health.employeeHealthRate, target: 1, color: "#10B981" },
            { label: "Sales linkage rate", value: health.salesLinkageRate, target: 1, color: "#8B5CF6" },
          ].map(({ label, value, target, color }) => {
            const pctVal = Math.round(Math.min(1, value / target) * 100);
            const statusColor = pctVal >= 80 ? "#10B981" : pctVal >= 60 ? "#F59E0B" : "#F43F5E";
            return (
              <div key={label} className="flex flex-col gap-3 px-5 py-5">
                <p className="text-[9px] font-black uppercase tracking-[0.16em] text-slate-500">{label}</p>
                <p className="text-3xl font-black tracking-tight" style={{ color: statusColor }}>
                  {pctVal}%
                </p>
                <div className="h-1.5 w-full bg-slate-100">
                  <div
                    className="h-full transition-all"
                    style={{ width: `${Math.max(2, pctVal)}%`, backgroundColor: color }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </SectionShell>

      {/* ── Trends ────────────────────────────────────────────────────────── */}
      <SectionShell
        title="Trends"
        description="Sales value, people cost, and headcount movement over recent periods."
      >
        <div className="grid divide-x divide-slate-200 lg:grid-cols-3">
          {/* Sales trend */}
          <div className="px-5 py-5">
            <div className="mb-1 flex items-baseline justify-between">
              <p className="text-[9px] font-black uppercase tracking-[0.16em] text-slate-500">Monthly Sales</p>
              {trends.sales.length > 0 ? (
                <p className="text-xs font-bold text-slate-900">
                  {egp(trends.sales[trends.sales.length - 1]?.sales ?? 0)}
                </p>
              ) : null}
            </div>
            <AreaSparkline
              points={trends.sales.map((p) => ({ label: p.label, value: p.sales }))}
              stroke="#F97316"
              gradId="trend-sales-grad"
            />
            <p className="mt-2 text-[9px] text-slate-400">Latest {trends.sales.length} periods</p>
          </div>

          {/* People cost trend */}
          <div className="px-5 py-5">
            <div className="mb-1 flex items-baseline justify-between">
              <p className="text-[9px] font-black uppercase tracking-[0.16em] text-slate-500">Payroll cost</p>
              {trends.financial.length > 0 ? (
                <p className="text-xs font-bold text-slate-900">
                  {egp(trends.financial[trends.financial.length - 1]?.cost ?? 0)}
                </p>
              ) : null}
            </div>
            <AreaSparkline
              points={trends.financial.map((p) => ({ label: p.label, value: p.cost }))}
              stroke="#8B5CF6"
              gradId="trend-cost-grad"
            />
            <p className="mt-2 text-[9px] text-slate-400">Latest {trends.financial.length} periods</p>
          </div>

          {/* Hires vs exits */}
          <div className="px-5 py-5">
            <p className="mb-3 text-[9px] font-black uppercase tracking-[0.16em] text-slate-500">
              Headcount movement
            </p>
            <TwoSeriesBars
              data={trends.hireExit.map((p) => ({ label: p.label, a: p.hires, b: p.exits }))}
              colorA="#10B981"
              colorB="#F43F5E"
            />
            <div className="mt-2 flex items-center gap-4 text-[9px] text-slate-400">
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 bg-emerald-500" /> Hires
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 bg-rose-500" /> Exits
              </span>
            </div>
          </div>
        </div>
      </SectionShell>

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between bg-slate-900 px-5 py-3 text-[10px] text-slate-400">
        <span className="flex items-center gap-2">
          <Users aria-hidden="true" className="h-3 w-3" />
          Phoenix Workforce · CEO Command Center
        </span>
        <span className="flex items-center gap-2">
          <Wallet aria-hidden="true" className="h-3 w-3" />
          Data as of {generatedLabel}
        </span>
      </div>
    </div>
  );
}
