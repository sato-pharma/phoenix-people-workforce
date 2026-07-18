import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  Award,
  BadgeCheck,
  Clock,
  Footprints,
  GraduationCap,
  Megaphone,
  Sparkles,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import type { ReactNode } from "react";

import { AdminHeroFrame } from "@/components/admin/admin-design-system";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { LineChart } from "./charts";
import type {
  CoachingCompetency,
  Employee360Profile,
  ImpactSet,
  LeadershipActivity,
  SalesMonthPoint,
} from "@/lib/employee-360/deep-service";
import type { Employee360Comparison, MetricDelta } from "@/lib/employee-360/period";
import { EMPLOYEE_360_ROLE_META, type Employee360RoleCategory } from "@/lib/employee-360/roles";

const CHART_COLORS = { regular: "#0ea5e9", campaign: "#f97316", sales: "#10b981", target: "#94a3b8", coverage: "#6366f1" };

// ── Premium visual system — shared across every section of this report ──────
type Tone = "sky" | "orange" | "indigo" | "emerald" | "rose" | "violet" | "amber" | "blue";
const TONE_ICON_WRAP: Record<Tone, string> = {
  sky: "bg-sky-50 text-sky-600 ring-sky-100",
  orange: "bg-orange-50 text-orange-600 ring-orange-100",
  indigo: "bg-indigo-50 text-indigo-600 ring-indigo-100",
  emerald: "bg-emerald-50 text-emerald-600 ring-emerald-100",
  rose: "bg-rose-50 text-rose-600 ring-rose-100",
  violet: "bg-violet-50 text-violet-600 ring-violet-100",
  amber: "bg-amber-50 text-amber-600 ring-amber-100",
  blue: "bg-blue-50 text-blue-600 ring-blue-100",
};

const PREMIUM_CARD =
  "rounded-[20px] border-slate-200/80 bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.05)] sm:p-6";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const joined = parts.map((part) => part[0] ?? "").join("");
  return joined ? joined.toUpperCase() : "—";
}

const AVATAR_TONES = [
  "from-orange-500 to-amber-600",
  "from-sky-600 to-indigo-700",
  "from-emerald-600 to-teal-700",
  "from-violet-600 to-purple-700",
  "from-rose-600 to-pink-700",
  "from-slate-700 to-slate-900",
];
function avatarTone(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}

export type Employee360Subject = {
  hrId: string;
  displayName: string;
  jobTitle: string | null;
  lineName: string | null;
  areaName: string | null;
  regionName: string | null;
  managerName: string | null;
  employmentStatus: string | null;
  hireDate: string | null;
};

const intFmt = new Intl.NumberFormat("en-US");
const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

function pct(value: number | null): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}
function pctPoints(value: number | null): string {
  return value == null ? "—" : `${Math.round(value)}%`;
}
function ratio1(value: number | null): string {
  return value == null ? "—" : value.toFixed(1);
}

function tenureLabel(hireDate: string | null): string | null {
  if (!hireDate) return null;
  const start = new Date(hireDate);
  if (Number.isNaN(start.getTime())) return null;
  const months = Math.max(0, Math.round((Date.now() - start.getTime()) / (1000 * 60 * 60 * 24 * 30.44)));
  if (months < 12) return `${months} mo tenure`;
  return `${(months / 12).toFixed(1)} yr tenure`;
}

function KpiTile({
  label,
  value,
  benchmark,
  goodWhenAbove,
  hint,
}: {
  label: string;
  value: string;
  benchmark?: string;
  goodWhenAbove?: boolean | null;
  hint?: string;
}) {
  const tone = goodWhenAbove == null ? "text-slate-900" : goodWhenAbove ? "text-emerald-600" : "text-amber-600";
  return (
    <div className="group rounded-[14px] border border-slate-200/80 bg-slate-50/60 p-3.5 transition-all duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:bg-white hover:shadow-[0_10px_24px_rgba(15,23,42,0.07)]">
      <div className="text-[10px] font-black uppercase tracking-wide text-slate-400">{label}</div>
      <div className={cn("mt-1.5 text-2xl font-black tabular-nums", tone)}>{value}</div>
      {benchmark ? <div className="mt-1 text-[11px] font-bold text-slate-400">vs {benchmark}</div> : null}
      {hint ? <div className="mt-0.5 text-[11px] text-slate-400">{hint}</div> : null}
    </div>
  );
}

function SectionHeader({
  icon: Icon,
  tone = "sky",
  sub,
  children,
}: {
  icon: LucideIcon;
  tone?: Tone;
  sub?: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start gap-3 border-b border-slate-100 pb-3.5">
      <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ring-1 ring-inset", TONE_ICON_WRAP[tone])}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 pt-0.5">
        <h2 className="text-[13px] font-black uppercase tracking-wider text-slate-900">{children}</h2>
        {sub ? <p className="mt-1 text-xs leading-5 text-slate-500">{sub}</p> : null}
      </div>
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return <p className="text-sm italic text-slate-400">{children}</p>;
}

function SummaryLine({ text }: { text: string }) {
  return (
    <div className="mb-4 flex items-start gap-2.5 rounded-[14px] border border-slate-200/70 bg-gradient-to-r from-slate-50 to-white p-3.5 text-sm leading-relaxed text-slate-600">
      <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-orange-400" />
      <span>{text}</span>
    </div>
  );
}

function DeltaChip({ label, delta, kind, goodUp = true }: { label: string; delta: MetricDelta; kind: "int" | "ratio" | "pct"; goodUp?: boolean }) {
  const fmt = (v: number | null) => (v == null ? "—" : kind === "int" ? intFmt.format(Math.round(v)) : kind === "ratio" ? v.toFixed(1) : `${Math.round(v * 100)}%`);
  const rawDelta = delta.cur != null && delta.prev != null ? (kind === "pct" ? (delta.cur - delta.prev) * 100 : delta.cur - delta.prev) : null;
  const tone = rawDelta == null || rawDelta === 0 ? "text-slate-400" : (rawDelta > 0) === goodUp ? "text-emerald-600" : "text-amber-600";
  const deltaText =
    rawDelta == null ? "—" : `${rawDelta >= 0 ? "▲ +" : "▼ "}${Math.abs(rawDelta) < 10 && kind !== "int" ? rawDelta.toFixed(1) : Math.round(rawDelta)}${kind === "pct" ? "pp" : ""}`;
  return (
    <div className="rounded-[12px] border border-slate-200/80 bg-slate-50/60 p-2.5">
      <div className="text-[10px] font-black uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-0.5 text-lg font-black tabular-nums text-slate-900">{fmt(delta.cur)}</div>
      <div className={cn("text-[11px] font-bold tabular-nums", tone)}>
        {deltaText} <span className="font-medium text-slate-400">vs {fmt(delta.prev)}</span>
      </div>
    </div>
  );
}

function ComparisonStrip({ comparison }: { comparison: Employee360Comparison }) {
  return (
    <Card className={PREMIUM_CARD}>
      <div className="mb-3 text-[11px] font-black uppercase tracking-wide text-slate-400">
        Period-over-period — this period vs {comparison.previousLabel}
      </div>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        <DeltaChip label="Productive visits" delta={comparison.productiveVisits} kind="int" />
        <DeltaChip label="Visits / day" delta={comparison.visitsPerActiveDay} kind="ratio" />
        <DeltaChip label="Customers" delta={comparison.distinctCustomers} kind="int" />
        <DeltaChip label="Campaign share" delta={comparison.campaignShare} kind="pct" />
        <DeltaChip label="Check-in coverage" delta={comparison.checkinCoverage} kind="pct" />
        <DeltaChip label="Check-ins" delta={comparison.checkinCount} kind="int" />
      </div>
    </Card>
  );
}

function fmtHourView(h: number | null): string {
  if (h == null) return "—";
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

const DOW_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
// Field-force work week (owner-confirmed, matches production data): Sat–Wed are
// full working days, Thursday is AM-only (half day), Friday is off. Index order
// is getUTCDay(): 0=Sun … 4=Thu, 5=Fri, 6=Sat. Saturday (6) is a FULL working
// day and must never be dimmed.
const OFF_DAY = 5; // Friday
const HALF_DAY = 4; // Thursday (AM only)
function DayOfWeekBars({ counts, title }: { counts: number[]; title: string }) {
  const max = Math.max(1, ...counts);
  return (
    <div>
      <div className="mb-1.5 text-xs font-bold text-slate-500">{title}</div>
      <div className="flex items-end gap-1.5" style={{ height: 56 }}>
        {counts.map((c, i) => (
          // h-full gives each column the row's definite 56px height. Without it, the
          // row's items-end leaves columns content-sized (indefinite), so the inner
          // flex-1 bar track collapses and each bar's height:% resolves against 0 —
          // the chart rendered empty even with correct counts.
          <div key={i} className="flex h-full flex-1 flex-col items-center gap-1">
            <div className="flex w-full flex-1 items-end">
              <div
                className={cn(
                  "w-full rounded-t",
                  i === OFF_DAY ? "bg-slate-300" : i === HALF_DAY ? "bg-sky-400/45" : "bg-sky-500/80",
                )}
                style={{ height: `${(c / max) * 100}%` }}
                title={i === OFF_DAY ? `${c} (Fri — off)` : i === HALF_DAY ? `${c} (Thu — AM only)` : `${c}`}
              />
            </div>
            <span className={cn("text-[10px] font-semibold", i === OFF_DAY ? "text-slate-300" : "text-slate-400")}>{DOW_LABELS[i]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MixRows({ items }: { items: { label: string; count: number; pct: number }[] }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <div className="space-y-1.5">
      {items.map((it) => (
        <div key={it.label} className="flex items-center gap-3">
          <div className="w-40 shrink-0 truncate text-xs text-slate-500" title={it.label}>{it.label}</div>
          <div className="h-3 flex-1 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-indigo-500/70" style={{ width: `${(it.count / max) * 100}%` }} />
          </div>
          <div className="w-20 shrink-0 text-right text-xs tabular-nums text-slate-400">{it.count} · {Math.round(it.pct * 100)}%</div>
        </div>
      ))}
    </div>
  );
}

const balanceCopy: Record<Employee360Profile["campaignBalanceFlag"], { label: string; tone: string }> = {
  healthy: { label: "Balanced", tone: "text-emerald-600" },
  campaign_starved: { label: "Campaign-starved", tone: "text-amber-600" },
  regular_neglect: { label: "Regular-neglect", tone: "text-amber-600" },
  no_data: { label: "No data", tone: "text-slate-400" },
};

const zoneStyle: Record<string, { label: string; tone: string }> = {
  excellence_zone: { label: "Excellence", tone: "text-indigo-600" },
  green_zone: { label: "Green", tone: "text-emerald-600" },
  yellow_zone: { label: "Yellow", tone: "text-amber-600" },
  red_zone: { label: "Red", tone: "text-red-600" },
  critical_red: { label: "Critical", tone: "text-red-700" },
};
function zoneOf(zone: string | null) {
  return (zone && zoneStyle[zone]) || { label: zone ?? "—", tone: "text-slate-400" };
}

function IdentityHero({
  subject,
  tenure,
  windowLabel,
  benchmarkLabel,
  roleLabel,
}: {
  subject: Employee360Subject;
  tenure: string | null;
  windowLabel: string;
  benchmarkLabel: string;
  roleLabel: string;
}) {
  return (
    <AdminHeroFrame>
      <div className="relative flex flex-col gap-5 p-5 sm:p-6 lg:flex-row lg:items-center lg:justify-between lg:p-7">
        <div className="flex min-w-0 items-center gap-4">
          <span
            aria-hidden
            className={cn(
              "flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br text-base font-black text-white shadow-lg ring-2 ring-white/10",
              avatarTone(subject.hrId),
            )}
          >
            {initials(subject.displayName)}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-black text-white sm:text-2xl">{subject.displayName}</h1>
              <span className="rounded-full border border-white/20 bg-white/10 px-2 py-0.5 text-[11px] font-bold text-slate-200 backdrop-blur">
                {subject.hrId.toUpperCase()}
              </span>
              {subject.employmentStatus && subject.employmentStatus !== "active" ? (
                <span className="rounded-full border border-amber-400/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-amber-200">
                  {subject.employmentStatus.replace(/_/g, " ")}
                </span>
              ) : null}
            </div>
            <p className="mt-1.5 truncate text-sm text-slate-300">
              {[subject.jobTitle, subject.lineName, subject.areaName || subject.regionName].filter(Boolean).join(" · ") || "—"}
            </p>
            <p className="mt-0.5 text-xs text-slate-400">
              {subject.managerName ? `Reports to ${subject.managerName}` : "No manager on record"}
              {tenure ? ` · ${tenure}` : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-row flex-wrap items-center gap-2 lg:flex-col lg:items-end lg:gap-1.5">
          <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.14em] text-slate-200 backdrop-blur">
            {roleLabel}
          </span>
          <span className="rounded-full border border-orange-400/40 bg-orange-500/15 px-3 py-1 text-[11px] font-bold text-orange-200">
            {windowLabel}
          </span>
          <span className="text-[11px] text-slate-400">{benchmarkLabel}</span>
        </div>
      </div>
    </AdminHeroFrame>
  );
}

export function Employee360View({
  subject,
  summary,
  comparison,
  showExpenses = true,
  category,
}: {
  subject: Employee360Subject;
  summary: Employee360Profile;
  comparison?: Employee360Comparison | null;
  showExpenses?: boolean;
  category: Employee360RoleCategory;
}) {
  const b = summary.benchmarks;
  const tenure = tenureLabel(subject.hireDate);
  const monthlyMax = Math.max(1, ...summary.monthly.map((m) => m.regular + m.campaign));
  const hourMax = Math.max(1, ...summary.hourHistogram);

  // Role-driven section composition. A leader (DM / RM / NSM / PM / TM) leads with
  // what they DELIVER (team sales + coaching/double-visits given); a Medical Rep
  // leads with their own field work and the received-side coaching/impact.
  const isLeader = category !== "medical-rep";
  const showCampaign = category === "medical-rep" || category === "product-manager";
  const showCheckin = category !== "product-manager";
  const showReceivedSide = category === "medical-rep";

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      {/* Header / identity */}
      <IdentityHero subject={subject} tenure={tenure} windowLabel={summary.window.label} benchmarkLabel={b.windowLabel} roleLabel={EMPLOYEE_360_ROLE_META[category].label} />

      {/* Trust strip */}
      <div className="flex flex-wrap gap-2 text-xs">
        <TrustChip ok={summary.isMapped} okText="CRM visits linked" badText="No CRM visits linked to this HR_ID" />
        <TrustChip ok={summary.hasGpsCheckins} okText={`${intFmt.format(summary.checkinCount)} GPS check-ins`} badText="No GPS check-ins ever logged" />
        {category !== "training-manager" ? (
          <TrustChip ok={summary.sales.hasData} okText="Sales linked" badText="No validated sales yet" />
        ) : null}
        {isLeader ? (
          <TrustChip
            ok={Boolean(summary.leadership?.hasData)}
            okText={`${summary.leadership?.distinctRepsReached ?? 0} reps reached`}
            badText="No coaching / double-visits delivered"
          />
        ) : (
          <TrustChip ok={summary.coaching.hasData} okText={`${summary.coaching.reportCount} coaching reports`} badText="Never coached" />
        )}
      </div>

      {/* Period-over-period — own field-performance trend (reps). */}
      {!isLeader && comparison ? <ComparisonStrip comparison={comparison} /> : null}

      {/* Leaders lead with what they DELIVER. */}
      {isLeader && summary.leadership ? (
        <LeadershipSection leadership={summary.leadership} isTM={category === "training-manager"} />
      ) : null}

      {/* Team / line sales — leaders show it up top (reps see their own further down). */}
      {isLeader && category !== "training-manager" ? <SalesSection sales={summary.sales} /> : null}

      {/* Visits & Coverage — reps: full field performance; leaders: their OWN field presence. */}
      <Card className={PREMIUM_CARD}>
        <SectionHeader
          icon={Footprints}
          tone="sky"
          sub={
            isLeader
              ? "This manager's OWN field visits — their days in the field, not their team's. Team output is in Leadership Activity above."
              : "Productive = Regular + Campaign. Admin/non-visit codes excluded."
          }
        >
          {isLeader ? "Own Field Presence" : "Visits & Coverage"}
        </SectionHeader>
        <SummaryLine text={summary.visitsSummaryText} />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiTile label="Productive visits" value={intFmt.format(summary.productiveVisits)} benchmark={`${intFmt.format(b.productiveVisits)} co.`} hint={tenure ? "total — read with tenure" : undefined} />
          <KpiTile label="Visits / active day" value={ratio1(summary.visitsPerActiveDay)} benchmark={`${b.visitsPerActiveDay} co.`} goodWhenAbove={summary.visitsPerActiveDay == null ? null : summary.visitsPerActiveDay >= b.visitsPerActiveDay} />
          <KpiTile label="Active days" value={intFmt.format(summary.activeDays)} benchmark={`${b.activeDays} co.`} />
          <KpiTile label="Distinct customers" value={intFmt.format(summary.distinctCustomers)} benchmark={`${b.distinctCustomers} co.`} />
          <KpiTile label="Regular visits" value={intFmt.format(summary.regularVisits)} benchmark={`${intFmt.format(b.regularVisits)} co.`} />
          <KpiTile label="Campaign visits" value={intFmt.format(summary.campaignVisits)} benchmark={`${intFmt.format(b.campaignVisits)} co.`} />
          <KpiTile label="Doubles received" value={intFmt.format(summary.doublesReceived)} benchmark={`${b.doublesReceived} co.`} hint="visits with a manager alongside" />
          <KpiTile label="Admin / non-visit" value={intFmt.format(summary.adminVisits + summary.trainingVisits)} hint="meetings, training, leave, etc." />
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <KpiTile label="Last 30 days" value={intFmt.format(summary.last30)} hint={`prior 30d: ${summary.prev30} · ${summary.momentumTrend}`} goodWhenAbove={summary.momentumTrend === "up" ? true : summary.momentumTrend === "down" ? false : null} />
          <KpiTile label="Avg visits / customer" value={ratio1(summary.avgVisitsPerCustomer)} hint={`${summary.repeatCustomers} repeat · ${summary.oneTimeCustomers} one-time`} />
          <KpiTile label="Utilization" value={pct(summary.utilization)} hint={`${summary.activeDays}/${summary.workingDaysInWindow} working days`} />
        </div>

        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <div>
            <DayOfWeekBars counts={summary.visitDayOfWeek} title="Visits by day of week — Sat–Wed full · Thu AM · Fri off" />
            <div className="mt-3 text-xs text-slate-400">Single visits {intFmt.format(summary.singleVisits)} · Double visits {intFmt.format(summary.doublesReceived)}</div>
            {summary.topCustomers.length > 0 ? (
              <div className="mt-3">
                <div className="mb-1.5 text-xs font-bold text-slate-500">Most-visited customers</div>
                <div className="flex flex-wrap gap-1.5">
                  {summary.topCustomers.map((c) => (
                    <span key={c.name} className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-500">{c.name} · {c.count}</span>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
          <div>
            <div className="mb-1.5 text-xs font-bold text-slate-500">Activity mix (all visit types)</div>
            <MixRows items={summary.activityMix} />
          </div>
        </div>
      </Card>

      {/* Campaign vs Regular */}
      {showCampaign ? (
      <Card className={PREMIUM_CARD}>
        <SectionHeader icon={Megaphone} tone="orange" sub="Each month vs the company's SAME-month campaign share (campaign is seasonal).">
          Campaign vs Regular
        </SectionHeader>
        <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-slate-600">
          <span>
            Mix: <span className="font-black tabular-nums text-slate-900">{pct(summary.regularShare)} regular / {pct(summary.campaignShare)} campaign</span>
          </span>
          <span className="text-slate-400">healthy band {Math.round(b.regularShare * 100)}:{Math.round(b.campaignShare * 100)}</span>
          <span className={cn("font-bold", balanceCopy[summary.campaignBalanceFlag].tone)}>● {balanceCopy[summary.campaignBalanceFlag].label}</span>
        </div>
        {summary.monthly.length > 1 ? (
          <div className="mb-5">
            <div className="mb-1.5 text-xs font-bold text-slate-500">Monthly visit trend</div>
            <LineChart
              labels={summary.monthly.map((m) => m.month.slice(5))}
              series={[
                { name: "Regular", color: CHART_COLORS.regular, points: summary.monthly.map((m) => m.regular), area: true },
                { name: "Campaign", color: CHART_COLORS.campaign, points: summary.monthly.map((m) => m.campaign) },
              ]}
              height={170}
            />
          </div>
        ) : null}
        {summary.monthly.length === 0 ? (
          <EmptyState>No productive visits in this window.</EmptyState>
        ) : (
          <div className="space-y-2">
            {summary.monthly.map((m) => {
              const total = m.regular + m.campaign;
              return (
                <div key={m.month} className="flex items-center gap-3">
                  <div className="w-16 shrink-0 text-xs font-semibold text-slate-500">{m.month}</div>
                  <div className="flex h-5 flex-1 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full bg-sky-500" style={{ width: `${(m.regular / monthlyMax) * 100}%` }} title={`${m.regular} regular`} />
                    <div className="h-full bg-orange-500" style={{ width: `${(m.campaign / monthlyMax) * 100}%` }} title={`${m.campaign} campaign`} />
                  </div>
                  <div className="w-28 shrink-0 text-right text-xs tabular-nums text-slate-400">
                    {intFmt.format(total)} · {pct(m.campaignShare)} camp
                    {m.companyCampaignShare != null ? <span className="text-slate-300"> (co {Math.round(m.companyCampaignShare * 100)}%)</span> : null}
                  </div>
                </div>
              );
            })}
            <div className="mt-2 flex gap-4 text-xs text-slate-400">
              <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-sky-500" /> Regular</span>
              <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-orange-500" /> Campaign</span>
            </div>
          </div>
        )}
      </Card>
      ) : null}

      {/* Module B — check-in timing & authenticity */}
      {showCheckin ? (
      <Card className={PREMIUM_CARD}>
        <SectionHeader
          icon={Clock}
          tone="indigo"
          sub="Visit records have no clock time — timing below is from GPS check-ins (check_date). Visit-level intra-day is AM/PM only."
        >
          Check-in Timing &amp; Authenticity
        </SectionHeader>
        {!summary.hasGpsCheckins ? (
          <div className="flex items-start gap-2.5 rounded-[14px] border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>No GPS signal ever logged for this employee in the window. Timing and authenticity cannot be assessed — this usually means the mobile app GPS is off, not misconduct.</span>
          </div>
        ) : (
          <>
            <SummaryLine text={summary.checkinSummaryText} />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <KpiTile label="GPS check-ins" value={intFmt.format(summary.checkinCount)} />
              <KpiTile label="Check-in : visit" value={ratio1(summary.checkinToVisitRatio)} benchmark={`${b.checkinToVisitRatio} co.`} goodWhenAbove={summary.checkinToVisitRatio == null ? null : summary.checkinToVisitRatio >= b.checkinToVisitRatio} hint="GPS corroboration of visits" />
              <KpiTile label="Check-in coverage" value={pct(summary.checkinCoverage)} hint="days with GPS ÷ active days" />
              <KpiTile label="Late-night tail" value={pct(summary.lateNightShare)} goodWhenAbove={summary.lateNightShare == null ? null : !(summary.lateNightShare > 0.2)} hint="check-ins 22:00–01:00" />
            </div>
            <div className="mt-5">
              <div className="mb-1.5 text-xs font-bold text-slate-500">Check-in time of day (Cairo) — company peaks 14:00–16:00</div>
              <div className="flex h-24 items-end gap-[2px]">
                {summary.hourHistogram.map((count, hour) => (
                  <div key={hour} className="flex-1 rounded-t bg-indigo-500/80" style={{ height: `${(count / hourMax) * 100}%` }} title={`${hour}:00 — ${count} check-ins`} />
                ))}
              </div>
              <div className="mt-1 flex justify-between text-[10px] font-semibold text-slate-400"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <KpiTile label="Field window" value={`${fmtHourView(summary.avgFirstHour)}–${fmtHourView(summary.avgLastHour)}`} hint={summary.avgSpanHours != null ? `~${summary.avgSpanHours.toFixed(1)}h/day` : undefined} />
              <KpiTile label="Check-ins / active day" value={ratio1(summary.checkinsPerActiveDay)} />
              <KpiTile label="Uncorroborated days" value={intFmt.format(summary.uncorroboratedDays)} goodWhenAbove={!(summary.uncorroboratedDays > 5)} hint="visit days with no GPS" />
              <KpiTile label="Distinct locations" value={intFmt.format(summary.distinctLocations)} hint="GPS points (~110m)" />
            </div>

            <div className="mt-5 grid gap-5 sm:grid-cols-2">
              <DayOfWeekBars counts={summary.checkinDayOfWeek} title="Check-ins by day of week — Sat–Wed full · Thu AM · Fri off" />
              <div>
                <div className="mb-1.5 text-xs font-bold text-slate-500">GPS coverage by month</div>
                <LineChart
                  labels={summary.coverageTrend.map((m) => m.month.slice(5))}
                  series={[{ name: "Coverage", color: CHART_COLORS.coverage, points: summary.coverageTrend.map((m) => (m.coverage == null ? null : m.coverage * 100)), area: true }]}
                  height={150}
                  yMax={100}
                  yFormat={(n) => `${Math.round(n)}%`}
                />
              </div>
            </div>

            <div className="mt-4 text-xs text-slate-400">
              Visit AM/PM split (self-reported): <span className="font-bold text-slate-700">{intFmt.format(summary.amVisits)} AM / {intFmt.format(summary.pmVisits)} PM</span>
              {summary.unknownAmpm > 0 ? ` · ${intFmt.format(summary.unknownAmpm)} unmarked` : ""}
            </div>
          </>
        )}
      </Card>
      ) : null}

      {/* Sales & Achievement — reps see their own here (leaders saw team sales up top). */}
      {!isLeader ? <SalesSection sales={summary.sales} /> : null}

      {/* Expenses & Outstation — leaders only (DM / RM / NSM / PM / TM). */}
      {showExpenses ? (
        <ExpensesSection
          expenses={summary.expenses}
          activity={{
            amVisits: summary.amVisits,
            pmVisits: summary.pmVisits,
            unknownAmpm: summary.unknownAmpm,
            regularVisits: summary.regularVisits,
            campaignVisits: summary.campaignVisits,
          }}
        />
      ) : null}

      {/* Coaching / impact / double-visits RECEIVED — a rep-side view (Medical Reps). */}
      {showReceivedSide ? (
        <>
          <CoachingSection coaching={summary.coaching} />
          <ImpactSection impact={summary.impact} />
          <DoubleVisitSection dv={summary.doubleVisits} />
        </>
      ) : null}

      <p className="px-1 text-[11px] text-slate-400">
        Employee 360 · {EMPLOYEE_360_ROLE_META[category].label} view — sections are tailored to this role. Sales lag visits ~2 months and cover ~2/3 of reps; coaching is a single-rater signal — light pillars are coverage states, never a punishing zero. Benchmarks are company 2026 YTD averages.
      </p>
    </div>
  );
}

function LeadershipSection({ leadership, isTM }: { leadership: LeadershipActivity; isTM: boolean }) {
  return (
    <Card className={PREMIUM_CARD}>
      <SectionHeader
        icon={Award}
        tone="violet"
        sub="Coaching reports authored and double-visits conducted BY this leader in the period — the delivering end, and how many distinct reps it reached."
      >
        Leadership Activity{isTM ? " & Impact" : ""}
      </SectionHeader>
      {!leadership.hasData ? (
        <EmptyState>No coaching reports authored or double-visits conducted in this period.</EmptyState>
      ) : (
        <>
          <SummaryLine text={leadership.summaryText} />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiTile
              label="Coaching delivered"
              value={intFmt.format(leadership.coachingDelivered)}
              hint={`${leadership.coachingRepsReached} rep${leadership.coachingRepsReached === 1 ? "" : "s"} coached`}
            />
            <KpiTile
              label="Double-visits conducted"
              value={intFmt.format(leadership.dvConducted)}
              hint={`${leadership.dvRepsReached} rep${leadership.dvRepsReached === 1 ? "" : "s"} accompanied`}
            />
            <KpiTile label="Reps reached" value={intFmt.format(leadership.distinctRepsReached)} hint="distinct reps coached or accompanied" />
            <KpiTile
              label="Avg score given"
              value={leadership.avgScoreGiven == null ? "—" : `${Math.round(leadership.avgScoreGiven)}%`}
              hint="mean coaching score awarded"
            />
          </div>

          {isTM && leadership.impact ? (
            <div className="mt-5">
              <div className="mb-1.5 text-xs font-bold text-slate-500">
                Impact of their double-visits — reps&apos; field activity in the {leadership.impact.windowDays} days before vs after
                (averaged across {leadership.impactRepCount} rep{leadership.impactRepCount === 1 ? "" : "s"})
              </div>
              <BeforeAfterBlock title="Across coached reps" set={leadership.impact} />
            </div>
          ) : null}

          {leadership.byRep.length > 0 ? (
            <div className="mt-5">
              <div className="mb-1.5 text-xs font-bold text-slate-500">Reps reached (most-touched first)</div>
              <div className="overflow-hidden rounded-[14px] border border-slate-200">
                {leadership.byRep.map((r) => {
                  const parts = [
                    r.coachingReports > 0 ? `${r.coachingReports} coaching` : null,
                    r.doubleVisits > 0 ? `${r.doubleVisits} double-visit${r.doubleVisits === 1 ? "" : "s"}` : null,
                    r.avgScoreGiven != null ? `${Math.round(r.avgScoreGiven)}% avg` : null,
                  ].filter(Boolean);
                  return (
                    <div key={r.hrId} className="flex items-center justify-between gap-3 border-b border-slate-100 px-3 py-2 text-sm last:border-b-0 hover:bg-slate-50/70">
                      <span className="truncate text-slate-800">{r.name ?? r.hrId}</span>
                      <span className="shrink-0 text-xs tabular-nums text-slate-400">{parts.join(" · ")}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {leadership.recentDv.length > 0 ? (
            <div className="mt-5">
              <div className="mb-1.5 text-xs font-bold text-slate-500">Recent double-visits conducted</div>
              <div className="overflow-hidden rounded-[14px] border border-slate-200">
                {leadership.recentDv.map((e, i) => (
                  <div key={`${e.date}-${i}`} className="flex items-center justify-between gap-3 border-b border-slate-100 px-3 py-2 text-sm last:border-b-0 hover:bg-slate-50/70">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="w-20 shrink-0 text-xs text-slate-400">{e.date}</span>
                      <span className="truncate text-slate-800">{e.repName ?? "—"}</span>
                    </div>
                    <span className="shrink-0 text-xs text-slate-400">{e.kind}{e.customerName ? ` · ${e.customerName}` : ""}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

function SalesSection({ sales }: { sales: Employee360Profile["sales"] }) {
  return (
    <Card className={PREMIUM_CARD}>
      <SectionHeader
        icon={TrendingUp}
        tone="emerald"
        sub={sales.isTeamRollup ? "Team roll-up — the sum of this manager's reps' sales vs target. Sales lag visits ~2 months." : "Actual sell-in vs target. Values are period-stamped — sales lag visits ~2 months."}
      >
        Sales &amp; Achievement{sales.isTeamRollup ? " (Team)" : ""}
      </SectionHeader>
      {!sales.hasData ? (
        <EmptyState>No validated sales records for this employee yet (only ~2/3 of reps have linked sales).</EmptyState>
      ) : (
        <>
          <SummaryLine text={sales.summaryText} />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiTile label={sales.isTeamRollup ? "Team sales" : "Total sales"} value={compactFmt.format(sales.totalSales)} hint={sales.isTeamRollup ? `${sales.teamRepCount} reps` : sales.latestMonth ? `through ${sales.latestMonth}` : undefined} />
            <KpiTile label={sales.isTeamRollup ? "Team target" : "Total target"} value={compactFmt.format(sales.totalTarget)} />
            <KpiTile label="Achievement" value={pctPoints(sales.achievementPct)} benchmark="61% co." goodWhenAbove={sales.achievementPct == null ? null : sales.achievementPct >= 100} />
            <KpiTile label="Months covered" value={intFmt.format(sales.monthsCount)} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiTile label="Months hit target" value={`${sales.monthsHitTarget}/${sales.monthsCount}`} goodWhenAbove={sales.monthsCount > 0 ? sales.monthsHitTarget / sales.monthsCount >= 0.5 : null} />
            <KpiTile label="Growth (1st→latest)" value={sales.growthPct == null ? "—" : `${sales.growthPct >= 0 ? "+" : ""}${Math.round(sales.growthPct)}%`} goodWhenAbove={sales.growthPct == null ? null : sales.growthPct >= 0} />
            <KpiTile label="Sales / visit" value={sales.salesPerVisit == null ? "—" : compactFmt.format(sales.salesPerVisit)} hint="per productive visit" />
            <KpiTile label="Sales / customer" value={sales.salesPerCustomer == null ? "—" : compactFmt.format(sales.salesPerCustomer)} />
          </div>
          {sales.monthly.length > 1 ? (
            <div className="mt-5">
              <div className="mb-1.5 text-xs font-bold text-slate-500">Sales vs target trend</div>
              <LineChart
                labels={sales.monthly.map((m) => m.month.slice(5))}
                series={[
                  { name: "Sales", color: CHART_COLORS.sales, points: sales.monthly.map((m) => m.sales), area: true },
                  { name: "Target", color: CHART_COLORS.target, points: sales.monthly.map((m) => m.target) },
                ]}
                height={170}
                yFormat={(n) => compactFmt.format(n)}
              />
            </div>
          ) : null}
          {sales.monthly.length > 0 ? (
            <div className="mt-5 space-y-1.5">
              <div className="text-xs font-bold text-slate-500">Monthly achievement (bar = achievement %, capped at 150%)</div>
              {sales.monthly.slice(-12).map((m: SalesMonthPoint) => {
                const achv = m.achievementPct ?? 0;
                const width = Math.min(150, achv) / 1.5; // % of bar
                const tone = achv >= 100 ? "bg-emerald-500" : achv >= 70 ? "bg-amber-500" : "bg-red-500";
                return (
                  <div key={m.month} className="flex items-center gap-3">
                    <div className="w-16 shrink-0 text-xs font-semibold text-slate-500">{m.month}</div>
                    <div className="h-4 flex-1 overflow-hidden rounded-full bg-slate-100">
                      <div className={cn("h-full rounded-full", tone)} style={{ width: `${width}%` }} />
                    </div>
                    <div className="w-32 shrink-0 text-right text-xs tabular-nums text-slate-400">
                      {pctPoints(m.achievementPct)} · {compactFmt.format(m.sales)}/{compactFmt.format(m.target)}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
          {sales.topProducts.length > 0 ? (
            <div className="mt-5">
              <div className="mb-1.5 text-xs font-bold text-slate-500">Top products by sales</div>
              <div className="overflow-hidden rounded-[14px] border border-slate-200">
                {sales.topProducts.map((p) => (
                  <div key={p.product} className="flex items-center justify-between gap-3 border-b border-slate-100 px-3 py-2 text-sm last:border-b-0 hover:bg-slate-50/70">
                    <span className="truncate text-slate-800">{p.product}</span>
                    <span className="shrink-0 tabular-nums text-slate-400">{compactFmt.format(p.sales)} · {pctPoints(p.achievementPct)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {sales.byFamily.length > 1 ? (
            <div className="mt-5">
              <div className="mb-1.5 text-xs font-bold text-slate-500">Achievement by product family</div>
              <div className="space-y-1.5">
                {sales.byFamily.slice(0, 6).map((f) => {
                  const achv = f.achievementPct ?? 0;
                  const tone = achv >= 100 ? "bg-emerald-500" : achv >= 70 ? "bg-amber-500" : "bg-red-500";
                  return (
                    <div key={f.family} className="flex items-center gap-3">
                      <div className="w-40 shrink-0 truncate text-xs text-slate-500" title={f.family}>{f.family}</div>
                      <div className="h-3 flex-1 overflow-hidden rounded-full bg-slate-100"><div className={cn("h-full rounded-full", tone)} style={{ width: `${Math.min(150, achv) / 1.5}%` }} /></div>
                      <div className="w-28 shrink-0 text-right text-xs tabular-nums text-slate-400">{pctPoints(f.achievementPct)} · {compactFmt.format(f.sales)}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

function CoachingSection({ coaching }: { coaching: Employee360Profile["coaching"] }) {
  return (
    <Card className={PREMIUM_CARD}>
      <SectionHeader icon={GraduationCap} tone="violet" sub="Received coaching (double-visit assessments). Single-rater signal — read as guidance, not objective truth.">
        Coaching
      </SectionHeader>
      {!coaching.hasData ? (
        <EmptyState>
          No coaching reports on record for this employee.
          {coaching.futureDatedExcluded > 0 ? ` (${coaching.futureDatedExcluded} future-dated row(s) excluded.)` : ""} Field-wide only ~33 of 127 reps have ever been coached.
        </EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiTile
              label="Latest score"
              value={pctPoints(coaching.latest?.finalScorePercent ?? null)}
              hint={coaching.latest ? `${zoneOf(coaching.latest.zone).label} · ${coaching.latest.date}` : undefined}
            />
            <KpiTile
              label="Improvement"
              value={coaching.improvement == null ? "—" : `${coaching.improvement >= 0 ? "+" : ""}${Math.round(coaching.improvement)} pts`}
              goodWhenAbove={coaching.improvement == null ? null : coaching.improvement >= 0}
              hint="first → latest report"
            />
            <KpiTile label="Reports" value={intFmt.format(coaching.reportCount)} hint={coaching.singleRater ? "single coach" : `${coaching.coachNames.length} coaches`} />
            <KpiTile label="Average score" value={pctPoints(coaching.avgScore)} />
          </div>

          {coaching.reports.length > 0 ? (
            <div className="mt-5">
              <div className="mb-1.5 text-xs font-bold text-slate-500">Score progression{coaching.coachNames.length ? ` · coach: ${coaching.coachNames.join(", ")}` : ""}</div>
              <div className="flex flex-wrap gap-2">
                {coaching.reports.map((r, i) => {
                  const z = zoneOf(r.zone);
                  return (
                    <div key={`${r.date}-${i}`} className="rounded-[12px] border border-slate-200 px-3 py-2 text-center">
                      <div className={cn("text-lg font-black tabular-nums", z.tone)}>{pctPoints(r.finalScorePercent)}</div>
                      <div className="text-[10px] text-slate-400">{r.date}</div>
                      <div className={cn("text-[10px] font-bold", z.tone)}>{z.label}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {coaching.weakestCompetencies.length > 0 ? (
            <div className="mt-5">
              <div className="mb-1.5 text-xs font-bold text-slate-500">Weakest competencies (avg across reports, worst first)</div>
              <div className="space-y-1.5">
                {coaching.weakestCompetencies.map((c: CoachingCompetency) => {
                  const tone = c.avgPercent >= 80 ? "bg-emerald-500" : c.avgPercent >= 60 ? "bg-amber-500" : "bg-red-500";
                  return (
                    <div key={c.key} className="flex items-center gap-3">
                      <div className="w-48 shrink-0 truncate text-xs text-slate-500" title={`${c.label} · ${c.category}`}>{c.label}</div>
                      <div className="h-3 flex-1 overflow-hidden rounded-full bg-slate-100">
                        <div className={cn("h-full rounded-full", tone)} style={{ width: `${c.avgPercent}%` }} />
                      </div>
                      <div className="w-16 shrink-0 text-right text-xs tabular-nums text-slate-400">{Math.round(c.avgPercent)}% · {c.avgScore.toFixed(1)}/5</div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {coaching.reports[coaching.reports.length - 1]?.areaOfDevelopment ? (
            <p className="mt-4 text-xs text-slate-500"><span className="font-bold text-slate-700">Latest area of development:</span> {coaching.reports[coaching.reports.length - 1].areaOfDevelopment}</p>
          ) : null}
        </>
      )}
    </Card>
  );
}

function BeforeAfterBlock({ title, set }: { title: string; set: ImpactSet }) {
  if (set.eventCount === 0) {
    return (
      <div className="rounded-[14px] border border-slate-200 p-3.5">
        <div className="text-sm font-bold text-slate-800">{title}</div>
        <EmptyState>No such events for this employee in the window.</EmptyState>
      </div>
    );
  }
  const rows: { label: string; before: string; after: string; delta: number | null; goodUp: boolean }[] = [
    {
      label: "Visits / active day",
      before: ratio1(set.before.visitsPerActiveDay),
      after: ratio1(set.after.visitsPerActiveDay),
      delta: set.after.visitsPerActiveDay != null && set.before.visitsPerActiveDay != null ? set.after.visitsPerActiveDay - set.before.visitsPerActiveDay : null,
      goodUp: true,
    },
    {
      label: "Campaign share",
      before: pct(set.before.campaignShare),
      after: pct(set.after.campaignShare),
      delta: set.after.campaignShare != null && set.before.campaignShare != null ? (set.after.campaignShare - set.before.campaignShare) * 100 : null,
      goodUp: true,
    },
    {
      label: "Customers reached",
      before: intFmt.format(set.before.distinctCustomers),
      after: intFmt.format(set.after.distinctCustomers),
      delta: set.after.distinctCustomers - set.before.distinctCustomers,
      goodUp: true,
    },
  ];
  return (
    <div className="rounded-[14px] border border-slate-200 p-3.5">
      <div className="flex items-baseline justify-between">
        <div className="text-sm font-bold text-slate-800">{title}</div>
        <div className="text-[11px] text-slate-400">{set.eventCount} event{set.eventCount === 1 ? "" : "s"} · ±{set.windowDays}d windows</div>
      </div>
      <div className="mt-2 space-y-1.5">
        {rows.map((r) => {
          const deltaTone = r.delta == null ? "text-slate-400" : (r.delta >= 0) === r.goodUp ? "text-emerald-600" : "text-amber-600";
          const deltaText = r.delta == null ? "—" : `${r.delta >= 0 ? "▲ +" : "▼ "}${Math.abs(r.delta) < 10 ? r.delta.toFixed(1) : Math.round(r.delta)}`;
          return (
            <div key={r.label} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-slate-500">{r.label}</span>
              <span className="tabular-nums">
                <span className="text-slate-400">{r.before}</span>
                <span className="mx-1 text-slate-300">→</span>
                <span className="font-bold text-slate-900">{r.after}</span>
                <span className={cn("ml-2 text-xs font-bold", deltaTone)}>{deltaText}</span>
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-2 text-[11px] text-slate-400">
        Sample: {set.before.sampleVisits} visits before / {set.after.sampleVisits} after
      </div>
    </div>
  );
}

function ImpactSection({ impact }: { impact: Employee360Profile["impact"] }) {
  const anything = impact.coaching.eventCount > 0 || impact.trainingDv.eventCount > 0;
  return (
    <Card className={PREMIUM_CARD}>
      <SectionHeader icon={Sparkles} tone="amber" sub={`Field activity in the ${impact.windowDays} days BEFORE vs AFTER each intervention. Directional — read with sample sizes.`}>
        Before / After Impact
      </SectionHeader>
      {!anything ? (
        <EmptyState>No coaching sessions or Training-Manager double-visits recorded for this employee in the window.</EmptyState>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <BeforeAfterBlock title="After coaching sessions" set={impact.coaching} />
          <BeforeAfterBlock title="After Training-Manager double-visits" set={impact.trainingDv} />
        </div>
      )}
    </Card>
  );
}

function DoubleVisitSection({ dv }: { dv: Employee360Profile["doubleVisits"] }) {
  return (
    <Card className={PREMIUM_CARD}>
      <SectionHeader icon={Users} tone="blue" sub="Every visit where a manager accompanied this rep. TM = Training Manager.">
        Double-Visit History
      </SectionHeader>
      {dv.totalReceived === 0 ? (
        <EmptyState>No double-visits recorded for this employee in the window.</EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <KpiTile label="Double-visits received" value={intFmt.format(dv.totalReceived)} />
            <KpiTile label="With Training Manager" value={intFmt.format(dv.tmCount)} hint="TM field coaching" />
            <KpiTile label="Distinct visitors" value={intFmt.format(dv.distinctVisitors)} />
          </div>

          {dv.byVisitor.length > 0 ? (
            <div className="mt-5">
              <div className="mb-1.5 text-xs font-bold text-slate-500">Who accompanied this rep</div>
              <div className="flex flex-wrap gap-2">
                {dv.byVisitor.map((v) => (
                  <span key={v.hrId} className={cn("rounded-full border px-2.5 py-1 text-xs font-semibold", v.isTrainingManager ? "border-indigo-200 bg-indigo-50 text-indigo-700" : "border-slate-200 text-slate-500")}>
                    {v.name ?? v.hrId.toUpperCase()} · {v.count}{v.isTrainingManager ? " · TM" : ""}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div className="mt-5">
            <div className="mb-1.5 text-xs font-bold text-slate-500">Recent double-visits{dv.totalReceived > dv.events.length ? ` (latest ${dv.events.length} of ${dv.totalReceived})` : ""}</div>
            <div className="overflow-hidden rounded-[14px] border border-slate-200">
              {dv.events.map((e, i) => (
                <div key={`${e.date}-${i}`} className="flex items-center justify-between gap-3 border-b border-slate-100 px-3 py-2 text-sm last:border-b-0 hover:bg-slate-50/70">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="w-20 shrink-0 text-xs text-slate-400">{e.date}</span>
                    <span className="truncate text-slate-800">{e.doubleName ?? e.doubleHrId.toUpperCase()}</span>
                    {e.isTrainingManager ? <span className="shrink-0 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-bold text-indigo-700">TM</span> : null}
                  </div>
                  <span className="shrink-0 text-xs text-slate-400">{e.kind}{e.ampm ? ` · ${e.ampm.toUpperCase()}` : ""}{e.customerName ? ` · ${e.customerName}` : ""}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

function ExpensesSection({
  expenses,
  activity,
}: {
  expenses: Employee360Profile["expenses"];
  activity: { amVisits: number; pmVisits: number; unknownAmpm: number; regularVisits: number; campaignVisits: number };
}) {
  const { payroll, outstation } = expenses;
  const hasAny = payroll.hasData || outstation.hasData;
  const catMax = Math.max(1, ...payroll.categories.map((c) => c.amount));
  const destMax = Math.max(1, ...payroll.byDestination.map((d) => d.cost));
  return (
    <Card className={PREMIUM_CARD}>
      <SectionHeader icon={Wallet} tone="rose" sub="Outstation trips & reimbursed expenses (payroll import). Most relevant to travelling managers — DM / NSM / TM / PM / GPM.">
        Expenses &amp; Outstation
      </SectionHeader>
      {!hasAny ? (
        <EmptyState>No expense or outstation records for this employee in this period.</EmptyState>
      ) : (
        <>
          {payroll.hasData ? <SummaryLine text={payroll.summaryText} /> : null}
          {payroll.hasData ? (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <KpiTile label="Total cost" value={compactFmt.format(payroll.totalCost)} hint={`${payroll.approvedCount}/${payroll.tripCount} approved`} />
                <KpiTile label="Trips" value={intFmt.format(payroll.tripCount)} />
                <KpiTile label="Cost / trip" value={payroll.costPerTrip == null ? "—" : compactFmt.format(payroll.costPerTrip)} />
                <KpiTile label="Total km" value={intFmt.format(Math.round(payroll.totalKm))} hint={payroll.costPerKm != null ? `${payroll.costPerKm.toFixed(1)}/km` : undefined} />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <KpiTile label="Cost / visit" value={payroll.costPerVisit == null ? "—" : compactFmt.format(payroll.costPerVisit)} hint="per productive visit" />
                <KpiTile label="Cost / trip-visit" value={payroll.costPerTripVisit == null ? "—" : compactFmt.format(payroll.costPerTripVisit)} hint="visits logged on trips" />
                <KpiTile
                  label="Expenses vs sales"
                  value={payroll.expenseToSalesPct == null ? "—" : `${payroll.expenseToSalesPct.toFixed(1)}%`}
                  goodWhenAbove={payroll.expenseToSalesPct == null ? null : !(payroll.expenseToSalesPct > 20)}
                  hint={payroll.windowSalesValue != null ? `of ${compactFmt.format(payroll.windowSalesValue)} sales` : "no sales in period"}
                />
                <KpiTile label="Approved cost" value={compactFmt.format(payroll.approvedCost)} hint={`${payroll.approvedCount} approved`} />
              </div>

              {payroll.byType.length > 0 ? (
                <div className="mt-3">
                  <div className="mb-1.5 text-xs font-bold text-slate-500">By expense type</div>
                  <div className="flex flex-wrap gap-1.5">
                    {payroll.byType.map((b) => (
                      <span key={b.type} className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-500">
                        {b.type}: {intFmt.format(b.trips)} · {compactFmt.format(b.cost)}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                <span className="font-bold text-slate-400">Approval:</span>
                <span className="font-semibold text-emerald-600">✓ {intFmt.format(payroll.approvedCount)} approved</span>
                <span className="font-semibold text-amber-600">✗ {intFmt.format(payroll.rejectedCount)} rejected</span>
                <span className="text-slate-400">◷ {intFmt.format(payroll.pendingCount)} pending</span>
              </div>

              {payroll.monthly.length > 1 ? (
                <div className="mt-5">
                  <div className="mb-1.5 text-xs font-bold text-slate-500">Monthly spend trend</div>
                  <LineChart labels={payroll.monthly.map((m) => m.month.slice(5))} series={[{ name: "Cost", color: "#f43f5e", points: payroll.monthly.map((m) => m.cost), area: true }]} height={160} yFormat={(n) => compactFmt.format(n)} />
                </div>
              ) : null}

              <div className="mt-5 grid gap-5 sm:grid-cols-2">
                <div>
                  <div className="mb-1.5 text-xs font-bold text-slate-500">Where the money goes</div>
                  <div className="space-y-1.5">
                    {payroll.categories.map((c) => (
                      <div key={c.key} className="flex items-center gap-3">
                        <div className="w-32 shrink-0 truncate text-xs text-slate-500">{c.label}</div>
                        <div className="h-3 flex-1 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-rose-500/70" style={{ width: `${(c.amount / catMax) * 100}%` }} /></div>
                        <div className="w-24 shrink-0 text-right text-xs tabular-nums text-slate-400">{compactFmt.format(c.amount)} · {Math.round(c.pct * 100)}%</div>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-1.5 text-xs font-bold text-slate-500">Top destinations by cost</div>
                  <div className="space-y-1.5">
                    {payroll.byDestination.map((d) => (
                      <div key={d.name} className="flex items-center gap-3">
                        <div className="w-32 shrink-0 truncate text-xs text-slate-500" title={d.name}>{d.name}</div>
                        <div className="h-3 flex-1 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-amber-500/70" style={{ width: `${(d.cost / destMax) * 100}%` }} /></div>
                        <div className="w-24 shrink-0 text-right text-xs tabular-nums text-slate-400">{compactFmt.format(d.cost)} · {d.trips}t</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {payroll.unresolvedTrips.length > 0 ? (
                <div className="mt-5 overflow-hidden rounded-[14px] border border-amber-200 bg-amber-50/50">
                  <div className="border-b border-amber-200/70 px-3 py-2">
                    <div className="text-xs font-bold text-amber-700">
                      Unresolved trips ({payroll.unresolvedTrips.length})
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      Travel with no recorded destination — held out of the breakdown and “most expensive trips” above until resolved. A location is never guessed, and home/origin is never shown as a destination. Meetings are separate and need no destination.
                    </p>
                  </div>
                  {payroll.unresolvedTrips.map((t, i) => (
                    <div key={i} className="flex items-center justify-between gap-3 border-b border-amber-200/50 px-3 py-1.5 text-sm last:border-b-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="w-20 shrink-0 text-xs text-slate-400">{t.date}</span>
                        <span className="truncate text-slate-500">{t.type} · no destination recorded</span>
                      </div>
                      <span className="shrink-0 text-xs tabular-nums text-slate-400">
                        {compactFmt.format(t.total)}
                        {t.km != null ? ` · ${Math.round(t.km)}km` : ""}
                        {t.transport ? ` · ${t.transport}` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}

              {payroll.transportMix.length > 0 ? (
                <div className="mt-4">
                  <div className="mb-1.5 text-xs font-bold text-slate-500">Transport</div>
                  <div className="flex flex-wrap gap-1.5">
                    {payroll.transportMix.map((t) => (
                      <span key={t.name} className="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-500">{t.name} · {t.trips}t · {compactFmt.format(t.cost)}</span>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="mt-5">
                <div className="mb-1.5 text-xs font-bold text-slate-500">Most expensive trips</div>
                <div className="overflow-hidden rounded-[14px] border border-slate-200">
                  {payroll.topTrips.map((t, i) => (
                    <div key={i} className="flex items-center justify-between gap-3 border-b border-slate-100 px-3 py-2 text-sm last:border-b-0 hover:bg-slate-50/70">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="w-20 shrink-0 text-xs text-slate-400">{t.date}</span>
                        <span className="truncate text-slate-800">{t.destination || (t.type === "Meeting" ? "Meeting" : "—")}</span>
                      </div>
                      <span className="shrink-0 text-xs tabular-nums text-slate-400">
                        {compactFmt.format(t.total)}
                        {t.km != null ? ` · ${Math.round(t.km)}km` : ""}
                        {t.transport ? ` · ${t.transport}` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Field activity behind the spend — AM/PM split and Regular vs Campaign
                  visit mix (from the visits system, this period). */}
              <div className="mt-5">
                <div className="mb-1.5 text-xs font-bold text-slate-500">Field activity (visits this period)</div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <KpiTile label="AM visits" value={intFmt.format(activity.amVisits)} hint={activity.unknownAmpm > 0 ? `${intFmt.format(activity.unknownAmpm)} unmarked` : undefined} />
                  <KpiTile label="PM visits" value={intFmt.format(activity.pmVisits)} />
                  <KpiTile label="Regular visits" value={intFmt.format(activity.regularVisits)} />
                  <KpiTile label="Campaign visits" value={intFmt.format(activity.campaignVisits)} />
                </div>
                <div className="mt-2 text-xs text-slate-400">
                  Workload logged on trips: {intFmt.format(payroll.amWorkload)} AM · {intFmt.format(payroll.pmWorkload)} PM
                </div>
              </div>
            </>
          ) : null}

          {outstation.hasData ? (
            <div className="mt-5 rounded-[14px] border border-slate-200 p-3.5">
              <div className="mb-2 text-sm font-bold text-slate-800">System-submitted outstation (GPS-verified)</div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <KpiTile label="Trips" value={intFmt.format(outstation.tripCount)} />
                <KpiTile label="Claimed" value={compactFmt.format(outstation.claimedTotal)} hint={`expected ${compactFmt.format(outstation.expectedTotal)}`} />
                <KpiTile label="Variance" value={compactFmt.format(outstation.varianceTotal)} goodWhenAbove={!(outstation.varianceTotal > 0)} hint={`${outstation.overClaimCount} over-claim`} />
                <KpiTile label="Flagged" value={intFmt.format(outstation.flaggedCount)} goodWhenAbove={!(outstation.flaggedCount > 0)} hint="fraud / eligibility / territory" />
              </div>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

function TrustChip({ ok, okText, badText }: { ok: boolean; okText: string; badText: string }) {
  const Icon = ok ? BadgeCheck : AlertTriangle;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-bold shadow-sm",
        ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {ok ? okText : badText}
    </span>
  );
}
