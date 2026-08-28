import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  Award,
  BadgeCheck,
  CalendarClock,
  ClipboardCheck,
  Clock,
  Footprints,
  GraduationCap,
  Info,
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
import type { TeamHealthSummary } from "@/lib/employee-360/team-health";
import type { TeamLifecycleSummary } from "@/lib/employee-360/team-lifecycle";
import type { TrainingManagerAnalytics } from "@/lib/employee-360/tm-analytics";
import type { PmMarketingSummary } from "@/lib/employee-360/pm-marketing";
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

// Plain-English, simple-vocabulary explanation for each key card, keyed by its label.
// Surfaced as a hover tooltip (native title) with a small info cue so a non-analyst can
// tell exactly what the number means. Keep the wording jargon-free.
const KPI_EXPLAIN: Record<string, string> = {
  // Visits & coverage
  "Productive visits": "How many real customer visits this person made — only doctor and pharmacy calls count, not office or admin days.",
  "Visits / active day": "On the days they actually worked in the field, the average number of customers seen per day.",
  "Active days": "The number of different days they made at least one real customer visit.",
  "Distinct customers": "How many different customers (doctors/pharmacies) they saw — each one counted once, no matter how often visited.",
  "Regular visits": "Normal day-to-day customer visits, not tied to a special campaign.",
  "Campaign visits": "Visits made as part of a marketing campaign or special push.",
  "Doubles received": "Visits where a manager came along with them in the field (a joint or double visit).",
  "Admin / non-visit": "Days spent on things other than seeing customers — meetings, training, or leave.",
  "Last 30 days": "Productive visits in the most recent 30 days, with the previous 30 days shown for comparison.",
  "Avg visits / customer": "On average, how many times each customer was visited during this period.",
  Utilization: "How much of their available working days were actually used for field visits (active days out of working days).",
  // Check-ins (GPS)
  "GPS check-ins": "How many times their phone recorded a GPS location while in the field.",
  "Check-in : visit": "How many GPS check-ins there are for each visit — higher means visits are better backed up by location data.",
  "Check-in coverage": "The share of working days that have at least one GPS check-in.",
  "Late-night tail": "The share of GPS check-ins that happened very late (10pm–1am); unusually high can be a red flag.",
  "Field window": "The typical time of day their fieldwork starts and ends, based on GPS check-ins.",
  "Check-ins / active day": "On active days, the average number of GPS check-ins per day.",
  "Uncorroborated days": "Days they logged a visit but their phone recorded no GPS location to back it up.",
  "Distinct locations": "How many different physical spots (about 110m apart) their GPS check-ins came from.",
  // Leadership
  "Coaching delivered": "How many coaching reports this manager wrote for their team members.",
  "Double-visits conducted": "How many times this manager went into the field alongside a team member.",
  "Reps reached": "How many different team members this manager coached or joined in the field.",
  "Avg score given": "The average coaching score this manager awarded to their team.",
  // Team development (manager) & Training-Manager effectiveness
  "Reps on team": "How many Medical Reps roll up to this manager — the team whose development they're responsible for.",
  Coached: "How many of their reps received at least one coaching session this period.",
  "Never coached": "How many of their reps were not coached at all this period — the ones being missed.",
  "Avg coaching score": "The average coaching score across their reps who were coached.",
  "Field-force pool": "Every active Medical Rep — the full set this Training Manager is expected to develop.",
  "Reps coached": "How many of all active reps this Training Manager coached at least once this period.",
  "Sessions delivered": "The total number of coaching sessions this Training Manager ran this period.",
  "Top-5 focus share": "The share of all their coaching that went to just their five most-coached reps — high means effort is concentrated on a few.",
  "Over-focused reps": "Reps coached three or more times — a sign of over-focus when many others were never coached.",
  Coverage: "The share of the whole field-force pool this Training Manager reached with coaching.",
  "Double-visited": "How many of this manager's reps they personally joined in the field (a double-visit) this period.",
  "DV coverage": "The share of this manager's reps they double-visited at least once this period.",
  "Fully neglected": "Reps who got NEITHER a coaching session NOR a double-visit this period — the ones being completely missed.",
  "Team reach": "The share of the team touched at least once this period — coached or double-visited.",
  // Team compliance (manager) — plans, field discipline, probation
  "Plans submitted": "How many of this manager's reps submitted a weekly plan for this period — weekly-planning compliance.",
  "Plans approved": "How many of their reps had a weekly plan fully approved this period.",
  "No-activity flags": "How many of their reps were flagged for confirmed no-activity days — the field-force equivalent of absence — this period.",
  "In probation": "How many of their reps are still inside their first 90 days (probation window), soonest to finish first.",
  // Marketing ROI (PM/GPM)
  Requests: "How many marketing requests this Product Manager has submitted.",
  "Est. spend": "The total estimated cost of the marketing requests they submitted.",
  "Expected ROI": "The forecast sales return expected from those marketing investments.",
  "Realized value": "The actual sales value realized so far, versus the required return.",
  // Sales
  "Total sales": "The total sales value achieved in this period.",
  "Team sales": "The combined sales value of this manager's whole team.",
  "Total target": "The sales target they were expected to reach in this period.",
  "Team target": "The combined sales target for this manager's whole team.",
  Achievement: "How much of the target was met — 100% means they hit target exactly.",
  "Months covered": "How many months of sales data are included here.",
  "Months hit target": "In how many of those months they reached or beat their target.",
  "Growth (1st→latest)": "How much sales changed from the first month to the latest month in this period.",
  "Sales / visit": "Average sales value generated for each productive customer visit.",
  "Sales / customer": "Average sales value generated per customer.",
  // Coaching received
  "Latest score": "The score from their most recent coaching report.",
  Improvement: "How much their coaching score changed from their first report to their latest one.",
  Reports: "How many coaching reports they have received.",
  "Average score": "The average of all their coaching scores.",
  // Double-visits received
  "Double-visits received": "How many times a manager joined this person in the field.",
  "With Training Manager": "Of those joint visits, how many were with a Training Manager (field coaching).",
  "Distinct visitors": "How many different managers accompanied them in the field.",
  // Expenses
  "Total cost": "The total money claimed for their field trips in this period.",
  Trips: "The number of trips claimed.",
  "Cost / trip": "The average money claimed per trip.",
  "Total km": "The total distance claimed across all trips.",
  "Cost / visit": "Trip cost divided by productive visits — the travel cost behind each customer seen.",
  "Cost / trip-visit": "Trip cost divided by the visits actually logged on trip days.",
  "Expenses vs sales": "Their trip costs as a share of the sales they brought in — lower is more efficient.",
  "Approved cost": "The portion of the claimed cost that has been approved.",
  // Activity split
  "AM visits": "How many visits were made in the morning.",
  "PM visits": "How many visits were made in the afternoon.",
  // Outstation
  Claimed: "The total amount claimed for outstation trips.",
  Variance: "The gap between what was claimed and what was expected — positive means more was claimed than expected.",
  Flagged: "How many trips were flagged for review (possible fraud, eligibility, or territory issues).",
};

function KpiTile({
  label,
  value,
  benchmark,
  goodWhenAbove,
  hint,
  explain,
}: {
  label: string;
  value: string;
  benchmark?: string;
  goodWhenAbove?: boolean | null;
  hint?: string;
  explain?: string;
}) {
  const tone = goodWhenAbove == null ? "text-slate-900" : goodWhenAbove ? "text-emerald-600" : "text-amber-600";
  const tip = explain ?? KPI_EXPLAIN[label];
  return (
    <div
      title={tip}
      className="group rounded-[14px] border border-slate-200/80 bg-slate-50/60 p-3.5 transition-all duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:bg-white hover:shadow-[0_10px_24px_rgba(15,23,42,0.07)]"
    >
      <div className="flex items-center gap-1 text-phx-2xs font-black uppercase tracking-wide text-slate-400">
        <span>{label}</span>
        {tip ? <Info className="h-3 w-3 shrink-0 text-slate-300 transition-colors group-hover:text-slate-500" aria-hidden /> : null}
      </div>
      <div className={cn("mt-1.5 text-2xl font-black tabular-nums", tone)}>{value}</div>
      {benchmark ? <div className="mt-1 text-phx-xs font-bold text-slate-400">vs {benchmark}</div> : null}
      {hint ? <div className="mt-0.5 text-phx-xs text-slate-400">{hint}</div> : null}
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
        <h2 className="text-phx-md font-black uppercase tracking-wider text-slate-900">{children}</h2>
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

// Plain-English explanation for each period-over-period comparison chip. Each one shows the
// current value plus its change (▲ up / ▼ down) versus the previous period.
const DELTA_EXPLAIN: Record<string, string> = {
  "Productive visits": "Real customer visits this period, and how that compares to the previous period (▲ up / ▼ down).",
  "Visits / day": "Average customers seen per active field day, versus the previous period.",
  Customers: "How many different customers were visited this period, versus the previous period.",
  "Campaign share": "Share of visits that were campaign visits, versus the previous period (pp = percentage points).",
  "Check-in coverage": "Share of active days that had a GPS check-in, versus the previous period.",
  "Check-ins": "Total GPS check-ins this period, versus the previous period.",
};

function DeltaChip({ label, delta, kind, goodUp = true }: { label: string; delta: MetricDelta; kind: "int" | "ratio" | "pct"; goodUp?: boolean }) {
  const fmt = (v: number | null) => (v == null ? "—" : kind === "int" ? intFmt.format(Math.round(v)) : kind === "ratio" ? v.toFixed(1) : `${Math.round(v * 100)}%`);
  const rawDelta = delta.cur != null && delta.prev != null ? (kind === "pct" ? (delta.cur - delta.prev) * 100 : delta.cur - delta.prev) : null;
  const tone = rawDelta == null || rawDelta === 0 ? "text-slate-400" : (rawDelta > 0) === goodUp ? "text-emerald-600" : "text-amber-600";
  const deltaText =
    rawDelta == null ? "—" : `${rawDelta >= 0 ? "▲ +" : "▼ "}${Math.abs(rawDelta) < 10 && kind !== "int" ? rawDelta.toFixed(1) : Math.round(rawDelta)}${kind === "pct" ? "pp" : ""}`;
  const tip = DELTA_EXPLAIN[label];
  return (
    <div title={tip} className="group rounded-[12px] border border-slate-200/80 bg-slate-50/60 p-2.5">
      <div className="flex items-center gap-1 text-phx-2xs font-black uppercase tracking-wide text-slate-400">
        <span>{label}</span>
        {tip ? <Info className="h-3 w-3 shrink-0 text-slate-300 transition-colors group-hover:text-slate-500" aria-hidden /> : null}
      </div>
      <div className="mt-0.5 text-lg font-black tabular-nums text-slate-900">{fmt(delta.cur)}</div>
      <div className={cn("text-phx-xs font-bold tabular-nums", tone)}>
        {deltaText} <span className="font-medium text-slate-400">vs {fmt(delta.prev)}</span>
      </div>
    </div>
  );
}

function ComparisonStrip({ comparison }: { comparison: Employee360Comparison }) {
  return (
    <Card className={PREMIUM_CARD}>
      <div className="mb-3 text-phx-xs font-black uppercase tracking-wide text-slate-400">
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
            <span className={cn("text-phx-2xs font-semibold", i === OFF_DAY ? "text-slate-300" : "text-slate-400")}>{DOW_LABELS[i]}</span>
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
              <span className="rounded-full border border-white/20 bg-white/10 px-2 py-0.5 text-phx-xs font-bold text-phx-paper backdrop-blur">
                {subject.hrId.toUpperCase()}
              </span>
              {subject.employmentStatus && subject.employmentStatus !== "active" ? (
                <span className="rounded-full border border-phx-warn-line/40 bg-phx-warn/15 px-2 py-0.5 text-phx-2xs font-black uppercase tracking-wide text-phx-warn-bg">
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
          <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1 text-phx-2xs font-black uppercase tracking-[0.14em] text-phx-paper backdrop-blur">
            {roleLabel}
          </span>
          <span className="rounded-full border border-phx-warn-line/40 bg-phx-warn/15 px-3 py-1 text-phx-xs font-bold text-phx-warn-bg">
            {windowLabel}
          </span>
          <span className="text-phx-xs text-slate-400">{benchmarkLabel}</span>
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
  teamHealth = null,
  teamLifecycle = null,
  tmAnalytics = null,
  pmMarketing = null,
}: {
  subject: Employee360Subject;
  summary: Employee360Profile;
  comparison?: Employee360Comparison | null;
  showExpenses?: boolean;
  category: Employee360RoleCategory;
  teamHealth?: TeamHealthSummary | null;
  teamLifecycle?: TeamLifecycleSummary | null;
  tmAnalytics?: TrainingManagerAnalytics | null;
  pmMarketing?: PmMarketingSummary | null;
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
  // Only Medical Reps submit their own regular visits, so only they log GPS
  // check-ins. Managers (DM/RM/NSM) and Product Managers coach/join in the field
  // via double-visits (shown in Leadership Activity) — a GPS check-in section for
  // them would be empty and misleading, so it is a Medical-Rep authenticity view.
  const showCheckin = category === "medical-rep";
  const showReceivedSide = category === "medical-rep";

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      {/* Header / identity */}
      <IdentityHero subject={subject} tenure={tenure} windowLabel={summary.window.label} benchmarkLabel={b.windowLabel} roleLabel={EMPLOYEE_360_ROLE_META[category].label} />

      {/* Trust strip */}
      <div className="flex flex-wrap gap-2 text-xs">
        <TrustChip ok={summary.isMapped} okText="CRM visits linked" badText="No CRM visits linked to this HR_ID" />
        {showCheckin ? (
          <TrustChip ok={summary.hasGpsCheckins} okText={`${intFmt.format(summary.checkinCount)} GPS check-ins`} badText="No GPS check-ins ever logged" />
        ) : null}
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

      {/* Training Manager god-mode: coverage / neglect / concentration + verdict. */}
      {tmAnalytics ? <TrainingManagerSection a={tmAnalytics} /> : null}

      {/* Team / line sales — leaders show it up top (reps see their own further down). */}
      {isLeader && category !== "training-manager" ? <SalesSection sales={summary.sales} /> : null}

      {/* Team development — coaching coverage of a field manager's own reps. */}
      {teamHealth ? <TeamHealthSection teamHealth={teamHealth} /> : null}

      {/* Team compliance — weekly plans, field discipline & probation of their reps. */}
      {teamLifecycle ? <TeamLifecycleSection lifecycle={teamLifecycle} /> : null}

      {/* PM / Group PM — ROI on the marketing requests they submitted. */}
      {pmMarketing ? <MarketingRoiSection m={pmMarketing} /> : null}

      {/* Visits & Coverage — reps: full field performance; leaders: their OWN field presence. */}
      <Card className={PREMIUM_CARD}>
        <SectionHeader
          icon={Footprints}
          tone="sky"
          sub={
            isLeader
              ? "This manager's OWN field visits — occasional single/campaign calls, not their team's output. Managers coach in the field via double-visits (Leadership Activity above); they don't log GPS check-ins."
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
                    <span key={c.name} className="rounded-full border border-phx-line bg-phx-paper px-2 py-0.5 text-xs text-phx-ink-soft">{c.name} · {c.count}</span>
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
              <div className="mt-1 flex justify-between text-phx-2xs font-semibold text-slate-400"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
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

      <p className="px-1 text-phx-xs text-slate-400">
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
                      <div className="text-phx-2xs text-slate-400">{r.date}</div>
                      <div className={cn("text-phx-2xs font-bold", z.tone)}>{z.label}</div>
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
        <div className="text-phx-xs text-slate-400">{set.eventCount} event{set.eventCount === 1 ? "" : "s"} · ±{set.windowDays}d windows</div>
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
      <div className="mt-2 text-phx-xs text-slate-400">
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
                    {e.isTrainingManager ? <span className="shrink-0 rounded bg-indigo-100 px-1.5 py-0.5 text-phx-2xs font-bold text-indigo-700">TM</span> : null}
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

const TM_VERDICT: Record<TrainingManagerAnalytics["verdict"], { label: string; tone: string; bg: string }> = {
  efficient: { label: "Efficient", tone: "text-emerald-700", bg: "border-emerald-200 bg-emerald-50" },
  adequate: { label: "Adequate", tone: "text-amber-700", bg: "border-amber-200 bg-amber-50" },
  needs_improvement: { label: "Needs improvement", tone: "text-rose-700", bg: "border-rose-200 bg-rose-50" },
};

function TrainingManagerSection({ a }: { a: TrainingManagerAnalytics }) {
  const v = TM_VERDICT[a.verdict];
  return (
    <Card className={PREMIUM_CARD}>
      <SectionHeader
        icon={GraduationCap}
        tone="violet"
        sub="Coaching effectiveness across the WHOLE field force — who this trainer reaches, who's neglected, how focused the effort is, and the bottom line."
      >
        Training-Manager Effectiveness
      </SectionHeader>
      {!a.hasData ? (
        <EmptyState>No active Medical Reps to assess coverage against.</EmptyState>
      ) : (
        <>
          <div className={cn("mb-4 rounded-[14px] border p-4", v.bg)}>
            <div className="text-phx-xs font-black uppercase tracking-wide text-slate-400">Efficiency verdict</div>
            <div className={cn("text-xl font-black", v.tone)}>
              {v.label} · {a.efficiencyScore}/100
            </div>
            <p className="mt-1 text-xs text-slate-600">{a.rationale}</p>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiTile label="Field-force pool" value={intFmt.format(a.poolSize)} hint="active Medical Reps" />
            <KpiTile label="Reps coached" value={intFmt.format(a.coachedByTm)} hint={`${Math.round(a.coverageRate * 100)}% coverage`} goodWhenAbove={a.coverageRate >= 0.5} />
            <KpiTile label="Never coached" value={intFmt.format(a.neglectedByTm)} goodWhenAbove={a.neglectedByTm === 0} />
            <KpiTile label="Sessions delivered" value={intFmt.format(a.sessionsDelivered)} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiTile label="Avg score given" value={a.avgScoreGiven == null ? "—" : `${Math.round(a.avgScoreGiven)}%`} />
            <KpiTile label="Top-5 focus share" value={a.topFocusShare == null ? "—" : `${Math.round(a.topFocusShare * 100)}%`} goodWhenAbove={a.topFocusShare == null ? null : !(a.topFocusShare > 0.5)} hint="lower = effort spread wider" />
            <KpiTile label="Over-focused reps" value={intFmt.format(a.overFocusedCount)} hint="coached 3+ times" />
            <KpiTile label="Coverage" value={`${Math.round(a.coverageRate * 100)}%`} goodWhenAbove={a.coverageRate >= 0.5} />
          </div>

          {a.monthly.length > 1 ? (
            <div className="mt-5">
              <div className="mb-1.5 text-xs font-bold text-slate-500">Coaching cadence — sessions &amp; reps reached per month</div>
              <LineChart
                labels={a.monthly.map((m) => m.month.slice(5))}
                series={[
                  { name: "Sessions", color: CHART_COLORS.regular, points: a.monthly.map((m) => m.sessions), area: true },
                  { name: "Reps", color: CHART_COLORS.campaign, points: a.monthly.map((m) => m.reps) },
                ]}
                height={160}
              />
            </div>
          ) : null}

          <div className="mt-5 grid gap-5 sm:grid-cols-2">
            <div>
              <div className="mb-1.5 text-xs font-bold text-slate-500">Most-coached reps (their focus)</div>
              {a.concentratedReps.length > 0 ? (
                <div className="space-y-1">
                  {a.concentratedReps.map((r) => (
                    <div key={r.hrId} className="flex items-center justify-between gap-3 text-sm">
                      <span className="min-w-0 truncate text-slate-600">
                        {r.name}
                        {r.line ? <span className="text-slate-400"> · {r.line}</span> : null}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-slate-400">{r.count}×</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-slate-400">No coaching delivered in this period.</div>
              )}
            </div>
            <div>
              <div className="mb-1.5 text-xs font-bold text-amber-600">Neglected — never coached ({a.neglectedByTm})</div>
              {a.neglectedReps.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {a.neglectedReps.map((r) => (
                    <span key={r.hrId} className="rounded-full border border-phx-warn-line bg-phx-warn-bg px-2 py-0.5 text-xs text-phx-warn" title={r.line ?? undefined}>
                      {r.name}
                    </span>
                  ))}
                  {a.neglectedByTm > a.neglectedReps.length ? (
                    <span className="self-center text-xs text-slate-400">+{a.neglectedByTm - a.neglectedReps.length} more</span>
                  ) : null}
                </div>
              ) : (
                <div className="text-xs font-semibold text-emerald-600">Every active rep was coached at least once. 🎯</div>
              )}
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

function MarketingRoiSection({ m }: { m: PmMarketingSummary }) {
  return (
    <Card className={PREMIUM_CARD}>
      <SectionHeader
        icon={Megaphone}
        tone="orange"
        sub="Return on the marketing investments this Product Manager requested — spend, expected vs realized value, and how the requests are tracking."
      >
        Marketing ROI — Requests Submitted
      </SectionHeader>
      {!m.hasData ? (
        <EmptyState>This Product Manager has not submitted any marketing requests.</EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiTile label="Requests" value={intFmt.format(m.requestCount)} />
            <KpiTile label="Est. spend" value={compactFmt.format(m.totalEstimatedCost)} />
            <KpiTile label="Expected ROI" value={compactFmt.format(m.totalExpectedRoi)} hint="forecast return" />
            <KpiTile
              label="Realized value"
              value={compactFmt.format(m.totalActualValue)}
              hint={`${Math.round(m.coverageRatio * 100)}% of required`}
              goodWhenAbove={m.coverageRatio >= 1}
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span className="font-bold text-slate-400">Tracking:</span>
            <span className="font-semibold text-emerald-600">● {intFmt.format(m.onTrack)} on track</span>
            <span className="font-semibold text-amber-600">● {intFmt.format(m.behind)} behind</span>
            <span className="text-slate-400">● {intFmt.format(m.awaiting)} awaiting data</span>
            <span className="text-slate-400">● {intFmt.format(m.noData)} no data</span>
          </div>
          {m.topRequests.length > 0 ? (
            <div className="mt-4">
              <div className="mb-1.5 text-xs font-bold text-slate-500">Largest requests by spend</div>
              <div className="space-y-1">
                {m.topRequests.map((r) => (
                  <div key={r.code} className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate text-slate-600">
                      {r.code}
                      {r.line ? <span className="text-slate-400"> · {r.line}</span> : null}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-slate-400">
                      {compactFmt.format(r.estimatedCost)} spend · {compactFmt.format(r.actual)} realized
                    </span>
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

function TeamHealthSection({ teamHealth }: { teamHealth: TeamHealthSummary }) {
  const cov = teamHealth.coverageRate;
  return (
    <Card className={PREMIUM_CARD}>
      <SectionHeader
        icon={GraduationCap}
        tone="violet"
        sub="How well this manager's OWN reps are being developed — coaching AND field double-visit coverage this period. The headline gap: reps who got neither."
      >
        Team Development — Coaching &amp; Double-Visits
      </SectionHeader>
      {!teamHealth.hasData ? (
        <EmptyState>No Medical Reps roll up to this manager, so there is no team development coverage to show.</EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiTile label="Reps on team" value={intFmt.format(teamHealth.repCount)} />
            <KpiTile label="Coached" value={intFmt.format(teamHealth.coachedCount)} hint={`${Math.round(cov * 100)}% coverage`} goodWhenAbove={cov >= 0.6} />
            <KpiTile label="Never coached" value={intFmt.format(teamHealth.neverCoachedCount)} goodWhenAbove={teamHealth.neverCoachedCount === 0} />
            <KpiTile label="Avg coaching score" value={teamHealth.avgScore == null ? "—" : `${Math.round(teamHealth.avgScore)}%`} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiTile label="Double-visited" value={intFmt.format(teamHealth.dvCoveredCount)} hint={`${Math.round(teamHealth.dvCoverageRate * 100)}% of reps`} goodWhenAbove={teamHealth.dvCoverageRate >= 0.5} />
            <KpiTile label="DV coverage" value={`${Math.round(teamHealth.dvCoverageRate * 100)}%`} goodWhenAbove={teamHealth.dvCoverageRate >= 0.5} />
            <KpiTile label="Fully neglected" value={intFmt.format(teamHealth.fullyNeglectedCount)} goodWhenAbove={teamHealth.fullyNeglectedCount === 0} hint="no coaching AND no double-visit" />
            <KpiTile label="Team reach" value={`${Math.round(((teamHealth.repCount - teamHealth.fullyNeglectedCount) / Math.max(1, teamHealth.repCount)) * 100)}%`} hint="touched at least once" goodWhenAbove={teamHealth.fullyNeglectedCount === 0} />
          </div>
          {teamHealth.fullyNeglected.length > 0 ? (
            <div className="mt-4 rounded-[14px] border border-rose-200 bg-rose-50/60 p-3">
              <div className="mb-1.5 text-xs font-black text-rose-700">Fully neglected — neither coached nor double-visited ({teamHealth.fullyNeglected.length})</div>
              <div className="flex flex-wrap gap-1.5">
                {teamHealth.fullyNeglected.map((r) => (
                  <span key={r.hrId} className="rounded-full border border-phx-danger-line bg-white px-2 py-0.5 text-xs text-phx-danger">{r.name}</span>
                ))}
              </div>
            </div>
          ) : null}
          {teamHealth.neglected.length > 0 ? (
            <div className="mt-4">
              <div className="mb-1.5 text-xs font-bold text-amber-600">Never coached this period ({teamHealth.neglected.length})</div>
              <div className="flex flex-wrap gap-1.5">
                {teamHealth.neglected.map((r) => (
                  <span key={r.hrId} className="rounded-full border border-phx-warn-line bg-phx-warn-bg px-2 py-0.5 text-xs text-phx-warn">{r.name}</span>
                ))}
              </div>
            </div>
          ) : null}
          {teamHealth.coached.length > 0 ? (
            <div className="mt-4">
              <div className="mb-1.5 text-xs font-bold text-slate-500">Coached — most recent first</div>
              <div className="space-y-1">
                {teamHealth.coached.map((r) => (
                  <div key={r.hrId} className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate text-slate-600">{r.name}</span>
                    <span className="shrink-0 text-xs tabular-nums text-slate-400">
                      {r.coachingCount}× · {r.averageScore == null ? "—" : `${Math.round(r.averageScore)}%`}
                      {r.latestCoachingDate ? ` · ${r.latestCoachingDate}` : ""}
                    </span>
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

// Team Compliance — the operational (non-development) side of a manager's team:
// are their reps planning, showing up in the field, and who is still on probation.
function TeamLifecycleSection({ lifecycle }: { lifecycle: TeamLifecycleSummary }) {
  const cov = lifecycle.planCoverageRate;
  return (
    <Card className={PREMIUM_CARD}>
      <SectionHeader
        icon={ClipboardCheck}
        tone="amber"
        sub="The operational health of this manager's reps — weekly-plan compliance, confirmed field no-activity flags, and who is still inside their 90-day probation."
      >
        Team Compliance — Plans, Field Discipline &amp; Probation
      </SectionHeader>
      {!lifecycle.hasData ? (
        <EmptyState>No Medical Reps roll up to this manager, so there is no team compliance to show.</EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiTile
              label="Plans submitted"
              value={`${intFmt.format(lifecycle.planSubmittedCount)} / ${intFmt.format(lifecycle.repCount)}`}
              hint={`${Math.round(cov * 100)}% of reps`}
              goodWhenAbove={cov >= 0.6}
            />
            <KpiTile label="Plans approved" value={intFmt.format(lifecycle.planApprovedCount)} />
            <KpiTile
              label="No-activity flags"
              value={lifecycle.disciplineHasData ? intFmt.format(lifecycle.disciplineFlaggedReps) : "—"}
              hint={lifecycle.disciplineHasData ? `${intFmt.format(lifecycle.disciplineNoActivityDays)} days flagged` : undefined}
              goodWhenAbove={lifecycle.disciplineHasData ? lifecycle.disciplineFlaggedReps === 0 : null}
            />
            <KpiTile label="In probation" value={intFmt.format(lifecycle.probationCount)} hint="within first 90 days" />
          </div>
          {lifecycle.probationReps.length > 0 ? (
            <div className="mt-4 rounded-[14px] border border-blue-200 bg-blue-50/50 p-3">
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-black text-blue-700">
                <CalendarClock className="h-3.5 w-3.5" />
                On probation — soonest to finish first ({lifecycle.probationReps.length})
              </div>
              <div className="flex flex-wrap gap-1.5">
                {lifecycle.probationReps.map((r) => (
                  <span key={r.hrId} className="rounded-full border border-phx-info-line bg-white px-2 py-0.5 text-xs text-phx-info">
                    {r.name} · <span className="tabular-nums text-blue-500">{r.daysRemaining}d left</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

// Compare-by-month: trips, cost, cost/trip, and the month-over-month cost change.
// For expenses a rise is unfavourable (rose) and a drop favourable (emerald).
function MonthCompareTable({ months }: { months: { month: string; cost: number; trips: number }[] }) {
  return (
    <div className="mt-5">
      <div className="mb-1.5 text-xs font-bold text-slate-500">Month-by-month — trips, cost &amp; change vs the previous month</div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[440px] border-collapse text-sm">
          <thead>
            <tr className="text-phx-xs font-black uppercase tracking-wide text-slate-400">
              <th className="py-1.5 pr-3 text-left">Month</th>
              <th className="px-3 py-1.5 text-right">Trips</th>
              <th className="px-3 py-1.5 text-right">Cost</th>
              <th className="px-3 py-1.5 text-right">Cost / trip</th>
              <th className="py-1.5 pl-3 text-right">Δ cost vs prev</th>
            </tr>
          </thead>
          <tbody>
            {months.map((m, i) => {
              const prev = i > 0 ? months[i - 1] : null;
              const delta = prev && prev.cost > 0 ? (m.cost - prev.cost) / prev.cost : null;
              const costPerTrip = m.trips > 0 ? m.cost / m.trips : null;
              const up = delta != null && delta > 0;
              return (
                <tr key={m.month} className="border-t border-slate-100">
                  <td className="py-1.5 pr-3 text-left font-semibold tabular-nums text-slate-600">{m.month}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{intFmt.format(m.trips)}</td>
                  <td className="px-3 py-1.5 text-right font-bold tabular-nums text-slate-800">{compactFmt.format(m.cost)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{costPerTrip == null ? "—" : compactFmt.format(costPerTrip)}</td>
                  <td
                    className={cn(
                      "py-1.5 pl-3 text-right font-bold tabular-nums",
                      delta == null ? "text-slate-300" : up ? "text-rose-600" : "text-emerald-600",
                    )}
                  >
                    {delta == null ? "—" : `${up ? "▲ +" : "▼ "}${Math.abs(Math.round(delta * 100))}%`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
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
                      <span key={b.type} className="rounded-full border border-phx-line bg-phx-paper px-2.5 py-1 text-xs text-phx-ink-soft">
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

              {payroll.monthly.length > 1 ? <MonthCompareTable months={payroll.monthly} /> : null}

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
                    <p className="mt-0.5 text-phx-xs text-slate-500">
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
                      <span key={t.name} className="rounded-full border border-phx-line px-2 py-0.5 text-xs text-phx-ink-soft">{t.name} · {t.trips}t · {compactFmt.format(t.cost)}</span>
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
