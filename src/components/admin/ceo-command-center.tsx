import Link from "next/link";
import { type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  BriefcaseBusiness,
  Building2,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  HeartPulse,
  MapPinned,
  Megaphone,
  ShieldCheck,
  Users,
  Wallet,
} from "lucide-react";

import { AdminHeroFrame } from "@/components/admin/admin-design-system";
import { CeoHeroIdentity } from "@/components/admin/ceo-hero-identity";
import { CeoTopMoversTable } from "@/components/admin/ceo-top-movers-table";
import type { AccessContext } from "@/lib/auth/permissions";
import type {
  CeoAttentionTone,
  CeoCommandCenterData,
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

function n(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "-";
}

function pct(value: number) {
  return `${Math.round(Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100)}%`;
}

function MetricTile({
  icon,
  label,
  value,
  sub,
  tone = "slate",
}: {
  icon: ReactNode;
  label: string;
  value: string;
  sub: string;
  tone?: "slate" | "emerald" | "amber" | "rose";
}) {
  const toneClass = {
    amber: "text-amber-700",
    emerald: "text-emerald-700",
    rose: "text-rose-700",
    slate: "text-slate-900",
  }[tone];

  return (
    <div className="min-h-32 border border-slate-200 bg-white px-4 py-4">
      <div className="flex items-center gap-2 text-[9px] font-black uppercase tracking-[0.14em] text-slate-500">
        <span className="text-orange-600">{icon}</span>
        {label}
      </div>
      <p className={`mt-4 text-3xl font-black leading-none ${toneClass}`}>{value}</p>
      <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">{sub}</p>
    </div>
  );
}

function DataUnavailableNotice({ sources }: { sources: string[] }) {
  if (sources.length === 0) return null;

  return (
    <div className="border border-amber-200 bg-amber-50 px-5 py-4">
      <div className="flex items-start gap-3">
        <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
        <div>
          <p className="text-sm font-black text-amber-900">Some CEO data sources are unavailable.</p>
          <p className="mt-1 text-xs font-medium text-amber-800">
            All-clear status is paused until these sources recover: {sources.join(", ")}.
          </p>
        </div>
      </div>
    </div>
  );
}


// ── Attention tone mapping ────────────────────────────────────────────────────

const toneStyles: Record<CeoAttentionTone, { border: string; badge: string; text: string; label: string }> = {
  rose:  { border: "border-l-rose-500",   badge: "bg-rose-500 text-white",    text: "text-rose-700",   label: "URGENT"  },
  amber: { border: "border-l-amber-400",  badge: "bg-amber-400 text-white",   text: "text-amber-700",  label: "WARNING" },
  blue:  { border: "border-l-blue-400",   badge: "bg-blue-400 text-white",    text: "text-blue-700",   label: "INFO"    },
};

// ── Area sparkline ────────────────────────────────────────────────────────────

export function AreaSparkline({
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

// ── Two-series bar chart ──────────────────────────────────────────────────────

export function TwoSeriesBars({
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

export function SectionShell({
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

// ── Quick-link card (instant — no data fetch) ─────────────────────────────────

function QuickLinkCard({
  title,
  icon,
  headline,
  sub,
  href,
}: {
  title: string;
  icon: ReactNode;
  headline: string;
  sub: string;
  href: string;
}) {
  return (
    <Link href={href} className="group flex flex-col border border-slate-200 bg-white hover:border-orange-300">
      <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-900 px-4 py-3">
        <span className="text-orange-400">{icon}</span>
        <span className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-300">{title}</span>
      </div>
      <div className="flex flex-1 flex-col items-start justify-between gap-6 px-4 py-5">
        <div>
          <p className="text-[28px] font-black leading-none tracking-tight text-slate-900">Open →</p>
          <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">{headline}</p>
        </div>
        <div className="border border-slate-200 px-3 py-2 text-xs text-slate-500 group-hover:border-orange-300 group-hover:text-orange-700">
          {sub}
        </div>
      </div>
    </Link>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function CeoCommandCenter({
  data,
  welcome: _welcome,
  access: _access,
}: {
  data: CeoCommandCenterData;
  welcome: CeoWelcomeProfile;
  access: AccessContext;
}) {
  const { attention, approvals, dataUnavailable, headcount, health, payroll, sos } = data;
  const generatedLabel = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(data.generatedAt));

  const dataAvailable = dataUnavailable.length === 0;
  const totalApprovals = (approvals.leavePending ?? 0) + (approvals.plansPending ?? 0);
  const hasUnavailableApprovals = approvals.leavePending === null || approvals.plansPending === null;
  const allClear = dataAvailable && attention.length === 0 && totalApprovals === 0;

  return (
    <div className="space-y-0 divide-y divide-slate-200">

      {/* ── Hero ────────────────────────────────────────────────────────────── */}
      <AdminHeroFrame>
        <div className="p-5 sm:p-6 lg:p-8">
          <div className="mb-5 inline-flex items-center gap-2 border border-orange-400/40 bg-orange-500/15 px-3 py-1.5 text-[9px] font-black uppercase tracking-[0.22em] text-orange-100">
            <HeartPulse aria-hidden="true" className="h-3.5 w-3.5" />
            CEO Command Center
          </div>
          <CeoHeroIdentity
            fullName={_welcome.fullName}
            roleLabel={_welcome.roleLabel}
            imageUrl={_welcome.imageUrl}
          />
        </div>
      </AdminHeroFrame>

      <DataUnavailableNotice sources={dataUnavailable} />

      <SectionShell
        title="Workforce & payroll snapshot"
        description="Company-level totals from CEO-safe aggregate loaders."
      >
        <div className="grid gap-2 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile
            icon={<Users className="h-3.5 w-3.5" />}
            label="Active employees"
            value={n(headcount.active)}
            sub="Active and on leave"
            tone={headcount.active > 0 ? "emerald" : "amber"}
          />
          <MetricTile
            icon={<BriefcaseBusiness className="h-3.5 w-3.5" />}
            label="Total structure"
            value={n(headcount.total)}
            sub="Employees plus vacancies"
          />
          <MetricTile
            icon={<Building2 className="h-3.5 w-3.5" />}
            label="Vacancies"
            value={n(headcount.vacancies)}
            sub="Open positions"
            tone={headcount.vacancies > 0 ? "amber" : "emerald"}
          />
          <MetricTile
            icon={<ShieldCheck className="h-3.5 w-3.5" />}
            label="Employee health"
            value={pct(health.employeeHealthRate)}
            sub="Active/total quality"
            tone={health.employeeHealthRate >= 0.9 ? "emerald" : "amber"}
          />
          <MetricTile
            icon={<BarChart3 className="h-3.5 w-3.5" />}
            label="Lines"
            value={n(headcount.uniqueLines)}
            sub="Lookup-backed count"
          />
          <MetricTile
            icon={<MapPinned className="h-3.5 w-3.5" />}
            label="Areas"
            value={n(headcount.uniqueAreas)}
            sub="Lookup-backed count"
          />
          <MetricTile
            icon={<Wallet className="h-3.5 w-3.5" />}
            label="Net payroll"
            value={egp(payroll.net)}
            sub={payroll.batchLabel}
            tone={payroll.available ? "slate" : "amber"}
          />
          <MetricTile
            icon={<ClipboardCheck className="h-3.5 w-3.5" />}
            label="Salary flags"
            value={n(payroll.unresolvedSalaryFlags)}
            sub="Unresolved payroll risks"
            tone={payroll.unresolvedSalaryFlags > 0 ? "rose" : "emerald"}
          />
        </div>
      </SectionShell>

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
              {dataUnavailable.length > 0 ? (
                <div className="flex items-start gap-3 border border-amber-200 bg-amber-50 px-4 py-3">
                  <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                  <span className="text-sm font-semibold text-amber-900">
                    Not all executive risk sources loaded. This section is not treated as all clear.
                  </span>
                </div>
              ) : null}

              {totalApprovals > 0 || hasUnavailableApprovals ? (
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
        description="Source of Sales (monthly, live) — plus one-click access to Weekly Sales and Marketing ROI dashboards."
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
            <div className="space-y-5">
              <div>
                <p className="mb-2 text-[9px] font-black uppercase tracking-[0.16em] text-slate-400">Top Lines</p>
                <CeoTopMoversTable
                  movers={sos?.topLines ?? []}
                  title="SoS Top Lines"
                  exportTitle="Source of Sales — Top Lines"
                  subtitle={sos?.period ?? undefined}
                  labelHeader="Product Line"
                  empty="No monthly sales loaded yet."
                />
              </div>
              <div>
                <p className="mb-2 text-[9px] font-black uppercase tracking-[0.16em] text-slate-400">Top Regions</p>
                <CeoTopMoversTable
                  movers={sos?.topRegions ?? []}
                  title="SoS Top Regions"
                  exportTitle="Source of Sales — Top Regions"
                  subtitle={sos?.period ?? undefined}
                  labelHeader="Region"
                  empty="No regional sales data yet."
                />
              </div>
            </div>
          </PerfCard>

          {/* Weekly Sales — instant link card */}
          <QuickLinkCard
            title="Weekly Sales"
            icon={<Activity className="h-3.5 w-3.5" />}
            headline="7-week trend + region breakdown"
            sub="Click to open Weekly Sales"
            href="/sales/weekly/dashboard"
          />

          {/* Marketing ROI — instant link card */}
          <QuickLinkCard
            title="Marketing ROI"
            icon={<Megaphone className="h-3.5 w-3.5" />}
            headline="Coverage, spend at risk, top risk accounts"
            sub="Click to open ROI Tracking"
            href="/admin/marketing-requests/roi-tracking"
          />
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
