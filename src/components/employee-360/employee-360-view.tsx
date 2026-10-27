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
  MapPin,
  Megaphone,
  Sparkles,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import type { ReactNode } from "react";

import {
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
} from "@/components/admin/admin-design-tokens";
import { Card } from "@/components/ui/card";
import { formatPharmacyFigure, pharmacyTileFigure, type VisitCountSplit } from "@/lib/crm/visit-count-buckets";
import { cn } from "@/lib/utils";
import { LineChart } from "./charts";
import type {
  CoachingCompetency,
  Employee360Profile,
  ImpactSet,
  LeadershipActivity,
  SalesMonthPoint,
} from "@/lib/employee-360/deep-service";
import type {
  Employee360BrickCoverage,
  Employee360BrickPanel,
  Employee360BrickStatus,
} from "@/lib/employee-360/brick-coverage";
import type { CustomerLane, TopCustomersByLane } from "@/lib/employee-360/service";
import type { TeamHealthSummary } from "@/lib/employee-360/team-health";
import type { TeamLifecycleSummary } from "@/lib/employee-360/team-lifecycle";
import type { TrainingManagerAnalytics } from "@/lib/employee-360/tm-analytics";
import type { PmMarketingSummary } from "@/lib/employee-360/pm-marketing";
import type { Employee360Comparison, MetricDelta } from "@/lib/employee-360/period";
import { EMPLOYEE_360_ROLE_META, type Employee360RoleCategory } from "@/lib/employee-360/roles";
import { planEmployee360Sections } from "@/lib/employee-360/report-sections";
import { crmInsightState, type Employee360CrmInsights } from "@/lib/employee-360/crm-insights";
import { Employee360CrmInsightsSections } from "./crm-insights-sections";

const CHART_COLORS = { regular: "#0ea5e9", campaign: "#f97316", sales: "#10b981", target: "#94a3b8", coverage: "#6366f1" };

/**
 * The profile's visits as the golden-rule split (src/lib/crm/visit-count-buckets.ts), so the pharmacy
 * figure of a rep whose team works in Phoenix CRM reads "not recorded in Phoenix", never 0 — Phoenix
 * CRM logs no pharmacy visit. A profile cached before `phoenixVisits` existed reads as none.
 */
function visitSplitOf(visits: { amVisits: number; pmVisits: number; pharmacyVisits?: number; phoenixVisits?: number }): VisitCountSplit {
  return {
    am: visits.amVisits,
    pm: visits.pmVisits,
    pharmacies: visits.pharmacyVisits ?? 0,
    ...(visits.phoenixVisits ? { phoenix: visits.phoenixVisits } : {}),
  };
}

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

// Human labels for the DATE-ONLY keys this report carries ("2026-08", "2026-08-14"). They are
// calendar values, not instants, so they format in UTC — a zone offset must never move the day.
// Anything that does not look like one is shown as it came, never guessed at.
const monthLabelFmt = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const monthOnlyFmt = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const dayLabelFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** "2026-08" → "Aug 2026". */
function monthLabel(period: string): string {
  const [year, month] = period.split("-").map(Number);
  if (!year || !month) return period;
  return monthLabelFmt.format(new Date(Date.UTC(year, month - 1, 1)));
}

/**
 * Chart axis labels for a run of "YYYY-MM" keys: just "Aug" while every point sits in one year,
 * "Aug 2026" once the run crosses a year, so a label is never ambiguous.
 */
function monthAxisLabels(periods: string[]): string[] {
  const years = new Set(periods.map((period) => period.slice(0, 4)));
  if (years.size > 1) return periods.map(monthLabel);
  return periods.map((period) => {
    const [year, month] = period.split("-").map(Number);
    if (!year || !month) return period;
    return monthOnlyFmt.format(new Date(Date.UTC(year, month - 1, 1)));
  });
}

/** "2026-08-14" → "14 Aug 2026". */
function dayLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  return dayLabelFmt.format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))));
}

/** A company benchmark, spelled out: "vs 1,234 company avg", never "vs 1,234 co.". */
function companyAvg(value: string | number): string {
  return `${value} company avg`;
}

const MOMENTUM_LABEL: Record<Employee360Profile["momentumTrend"], string> = {
  up: "rising",
  down: "falling",
  flat: "steady",
};

type FieldBenchmarks = Employee360Profile["fieldBenchmarks"];

/** "98 of 131 reps have linked sales through Aug 2026" — computed live, never a written-down share. */
function salesCoverageText(field: FieldBenchmarks): string | null {
  if (!field || field.fieldReps === 0) return null;
  return `${intFmt.format(field.repsWithSales)} of ${intFmt.format(field.fieldReps)} reps have linked sales${field.salesThroughLabel ? ` through ${field.salesThroughLabel}` : ""}`;
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
  "Doubles received": "Visits where a manager came along with them in the field (a joint or double visit), and on how many days.",
  "Admin / non-visit": "Days spent on things other than seeing customers — meetings, training, or leave.",
  "Last 30 days": "Productive visits in the most recent 30 days, with the previous 30 days shown for comparison.",
  "Avg visits / customer": "On average, how many times each customer was visited during this period.",
  Utilization: "How much of their available working days were actually used for field visits (active days out of working days).",
  // Check-ins (GPS)
  "GPS check-ins": "How many times their phone recorded a GPS location while in the field.",
  "Check-in : visit": "How many GPS check-ins there are for each visit — higher means visits are better backed up by location data.",
  "Check-in coverage": "The share of their active visiting days that have at least one GPS check-in. The GPS feed is partial, so this is evidence, never a score.",
  "Late-night tail": "The share of GPS check-ins that happened very late (10pm–1am); unusually high can be a red flag.",
  "Field window": "The typical time of day their fieldwork starts and ends, based on GPS check-ins.",
  "Check-ins / active day": "On active days, the average number of GPS check-ins per day.",
  "Uncorroborated days": "Days they logged a visit but their phone recorded no GPS location to back it up. The GPS feed is partial and can stop for a working rep, so this is evidence, never a score.",
  "Distinct locations": "How many different physical spots (about 110m apart) their GPS check-ins came from.",
  // Leadership
  "Coaching delivered": "How many coaching reports this manager wrote for their team members.",
  "Double-visits conducted": "How many times this manager went into the field alongside a team member, and on how many days.",
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
  "Double-visits received": "How many times a manager joined this person in the field, and on how many days.",
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
  Flagged: "How many outstation requests have an eligibility or territory issue to review.",
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
  const tileClass =
    "group rounded-[14px] border border-slate-200/80 bg-slate-50/60 p-3.5 transition-all duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:bg-white hover:shadow-[0_10px_24px_rgba(15,23,42,0.07)]";
  const body = (
    <>
      <span className="flex items-center gap-1 text-phx-2xs font-black uppercase tracking-wide text-slate-400">
        <span className="min-w-0 break-words">{label}</span>
        {tip ? <Info className="h-3 w-3 shrink-0 text-slate-300 transition-colors group-hover:text-slate-500" aria-hidden /> : null}
      </span>
      <span className={cn("mt-1.5 block break-words text-2xl font-black tabular-nums", tone)}>{value}</span>
      {benchmark ? <span className="mt-1 block text-phx-xs font-bold text-slate-400">vs {benchmark}</span> : null}
      {hint ? <span className="mt-0.5 block break-words text-phx-xs text-slate-400">{hint}</span> : null}
    </>
  );
  if (!tip) return <div className={tileClass}>{body}</div>;
  // The explanation used to live only in a `title` tooltip, which a touch screen never shows — the
  // field force reads this on a phone. The whole tile now opens it (no client JS: <details>); the
  // hover tooltip stays for a mouse.
  return (
    <details className={tileClass} title={tip}>
      <summary className="block cursor-pointer list-none outline-none focus-visible:ring-2 focus-visible:ring-orange-500/40 [&::-webkit-details-marker]:hidden">
        {body}
        <span className="sr-only"> — tap for what this means</span>
      </summary>
      <p className="mt-2 border-t border-slate-200 pt-2 text-phx-xs leading-snug text-slate-500">{tip}</p>
    </details>
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
  "Visits / day": "Average productive visits per active field day, versus the previous period.",
  Customers: "How many different customers were visited this period, versus the previous period.",
  "Campaign share": "Share of visits that were campaign visits, versus the previous period (pp = percentage points). A fall is better: 100% regular is the best case.",
  "Check-in coverage": "Share of active days that had a GPS check-in, versus the previous period.",
  "Check-ins": "Total GPS check-ins this period, versus the previous period.",
};

// `judged={false}` shows the change without calling it good or bad. The GPS chips use it: the feed is
// partial and can stop for a rep who is working normally, so a drop there is never a verdict on them.
function DeltaChip({ label, delta, kind, goodUp = true, judged = true }: { label: string; delta: MetricDelta; kind: "int" | "ratio" | "pct"; goodUp?: boolean; judged?: boolean }) {
  const fmt = (v: number | null) => (v == null ? "—" : kind === "int" ? intFmt.format(Math.round(v)) : kind === "ratio" ? v.toFixed(1) : `${Math.round(v * 100)}%`);
  const rawDelta = delta.cur != null && delta.prev != null ? (kind === "pct" ? (delta.cur - delta.prev) * 100 : delta.cur - delta.prev) : null;
  const tone = rawDelta == null || rawDelta === 0 || !judged ? "text-slate-400" : (rawDelta > 0) === goodUp ? "text-emerald-600" : "text-amber-600";
  const deltaText =
    rawDelta == null ? "—" : `${rawDelta >= 0 ? "▲ +" : "▼ "}${Math.abs(rawDelta) < 10 && kind !== "int" ? rawDelta.toFixed(1) : Math.round(rawDelta)}${kind === "pct" ? "pp" : ""}`;
  const tip = DELTA_EXPLAIN[label];
  const chipClass = "group min-w-0 rounded-[12px] border border-slate-200/80 bg-slate-50/60 p-2.5";
  const body = (
    <>
      <span className="flex items-center gap-1 text-phx-2xs font-black uppercase tracking-wide text-slate-400">
        <span className="min-w-0 break-words">{label}</span>
        {tip ? <Info className="h-3 w-3 shrink-0 text-slate-300 transition-colors group-hover:text-slate-500" aria-hidden /> : null}
      </span>
      <span className="mt-0.5 block text-lg font-black tabular-nums text-slate-900">{fmt(delta.cur)}</span>
      <span className={cn("block break-words text-phx-xs font-bold tabular-nums", tone)}>
        {deltaText} <span className="font-medium text-slate-400">vs {fmt(delta.prev)}</span>
      </span>
    </>
  );
  if (!tip) return <div className={chipClass}>{body}</div>;
  // Visible on a tap, not only in a hover `title` that a phone never shows (see KpiTile).
  return (
    <details className={chipClass} title={tip}>
      <summary className="block cursor-pointer list-none outline-none focus-visible:ring-2 focus-visible:ring-orange-500/40 [&::-webkit-details-marker]:hidden">
        {body}
        <span className="sr-only"> — tap for what this means</span>
      </summary>
      <p className="mt-2 border-t border-slate-200 pt-2 text-phx-xs leading-snug text-slate-500">{tip}</p>
    </details>
  );
}

function ComparisonStrip({ comparison }: { comparison: Employee360Comparison }) {
  return (
    <Card className={PREMIUM_CARD}>
      <div className="mb-3 text-phx-xs font-black uppercase tracking-wide text-slate-400">
        Period-over-period — this period vs {comparison.previousLabel}
      </div>
      {/* Columns follow the CARD's width, not the window's: at 1024 with the sidebar open a
          window-sized lg: split six chips into ~59px each. */}
      <div className="@container">
      <div className="grid grid-cols-2 gap-2.5 @lg:grid-cols-3 @3xl:grid-cols-6">
        <DeltaChip label="Productive visits" delta={comparison.productiveVisits} kind="int" />
        <DeltaChip label="Visits / day" delta={comparison.visitsPerActiveDay} kind="ratio" />
        <DeltaChip label="Customers" delta={comparison.distinctCustomers} kind="int" />
        <DeltaChip label="Campaign share" delta={comparison.campaignShare} kind="pct" goodUp={false} />
        <DeltaChip label="Check-in coverage" delta={comparison.checkinCoverage} kind="pct" judged={false} />
        <DeltaChip label="Check-ins" delta={comparison.checkinCount} kind="int" judged={false} />
      </div>
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

// FITS THE SCREEN, NO ELLIPSIS (AGENTS.md §4). A labelled bar row used to be a fixed-width label
// beside a fixed-width figure with the bar squeezed between them: at 375px the card holds ~277px,
// so a w-40 + w-20 row left a 13px bar (and a w-40 + w-28 or w-48 + w-16 row left none at all)
// while `truncate` cut the label. In a narrow list the label and its figure now share the first
// line — the label WRAPS — and the bar takes the full width beneath; once the LIST is 28rem wide
// the three sit on one line. A container query, not a window one: two of these lists sit in half
// of a two-column card, which at 640px or at 1024px with the sidebar open is ~270px wide.
const BAR_LIST = "@container space-y-1.5";
const BAR_ROW = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 @md:grid-cols-[10rem_minmax(0,1fr)_7rem]";
const BAR_LABEL = "min-w-0 break-words text-xs text-slate-500";
const BAR_TRACK = "col-span-2 h-3 overflow-hidden rounded-full bg-slate-100 @md:col-span-1 @md:col-start-2 @md:row-start-1";
const BAR_FIGURE = "text-right text-xs tabular-nums text-slate-400 @md:col-start-3 @md:row-start-1";

// The bordered name-and-figures lists (products, double visits, reps reached, trips). A name used
// to `truncate` beside a `shrink-0` figure inside an `overflow-hidden` box, so a long product,
// manager or customer name was cut with no sign at 375px. Now both sides WRAP: the name takes the
// room, the figures keep at most a little over half of it, and nothing is clipped.
const LIST_BOX = "rounded-[14px] border border-slate-200";
const LIST_ROW = "flex items-start justify-between gap-3 border-b border-slate-100 px-3 py-2 text-sm last:border-b-0 hover:bg-slate-50/70";
const LIST_NAME = "min-w-0 flex-1 break-words text-slate-800";
const LIST_SIDE = "min-w-0 max-w-[55%] break-words text-right text-xs text-slate-400";
const LIST_DATED = "flex min-w-0 flex-1 items-start gap-2";
const LIST_DATE = "w-20 shrink-0 pt-px text-xs text-slate-400";

/** Shown where a person's name is missing — never their raw HR ID in its place. */
const NAME_NOT_ON_RECORD = "Name not on record";

/** "A", "A and B", "A, B and C" — everyone on a visit, however many went (2026-10-27). */
function namesInWords(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function MixRows({ items }: { items: { label: string; count: number; pct: number }[] }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <div className={BAR_LIST}>
      {items.map((it) => (
        <div key={it.label} className={BAR_ROW}>
          <div className={BAR_LABEL}>{it.label}</div>
          <div className={BAR_FIGURE}>{it.count} · {Math.round(it.pct * 100)}%</div>
          <div className={BAR_TRACK}>
            <div className="h-full rounded-full bg-indigo-500/70" style={{ width: `${(it.count / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// A pharmacy is not a contact (owner rule): AM doctors, PM doctors and pharmacies are three lists,
// never one ranking.
const CUSTOMER_LANE_ORDER = ["am", "pm", "pharmacy"] as const satisfies readonly CustomerLane[];
const CUSTOMER_LANE_TITLE: Record<CustomerLane, string> = { am: "AM doctors", pm: "PM doctors", pharmacy: "Pharmacies" };

function MostVisitedCustomers({ top }: { top: TopCustomersByLane }) {
  if (CUSTOMER_LANE_ORDER.every((lane) => top[lane].customers === 0) && top.unplaced === 0) return null;
  return (
    <div className="mt-5">
      <div className="mb-2 text-xs font-bold text-slate-500">Most-visited customers</div>
      <div className="grid gap-4 sm:grid-cols-3">
        {CUSTOMER_LANE_ORDER.map((lane) => {
          const group = top[lane];
          return (
            <div key={lane} className="min-w-0 border-t-2 border-slate-200 pt-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-phx-2xs font-black uppercase tracking-wide text-slate-500">{CUSTOMER_LANE_TITLE[lane]}</span>
                <span className="shrink-0 text-phx-2xs tabular-nums text-slate-400">{intFmt.format(group.customers)} visited</span>
              </div>
              {group.top.length === 0 ? (
                <p className="mt-2 text-xs italic text-slate-400">None visited in this period.</p>
              ) : (
                <ol className="mt-1.5 space-y-1">
                  {group.top.map((customer, index) => (
                    <li key={`${customer.name}-${index}`} className="flex items-start gap-2 text-sm leading-5">
                      <span className="w-4 shrink-0 text-right text-phx-2xs font-bold tabular-nums text-slate-400">{index + 1}</span>
                      <span dir="auto" className="min-w-0 flex-1 break-words text-slate-800">{customer.name}</span>
                      <span className="shrink-0 text-xs tabular-nums text-slate-500">
                        {intFmt.format(customer.count)} {customer.count === 1 ? "visit" : "visits"}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          );
        })}
      </div>
      {top.unplaced > 0 ? (
        <p className="mt-2 text-phx-2xs text-slate-400">
          {intFmt.format(top.unplaced)} {top.unplaced === 1 ? "customer" : "customers"} not listed: no list, no pharmacy mark and no AM/PM flag on the visits.
        </p>
      ) : null}
    </div>
  );
}

// Owner rule, 2026-09-21: 100% regular is the best case, and campaign falling while regular rises is
// the best direction. There is no target mix to sit inside — the more regular, the better.
const campaignMixCopy: Record<Employee360Profile["campaignMix"], { label: string; tone: string }> = {
  all_regular: { label: "All regular · the best case", tone: "text-emerald-600" },
  mostly_regular: { label: "Mostly regular", tone: "text-emerald-600" },
  campaign_heavy: { label: "Campaign-heavy", tone: "text-amber-600" },
  no_data: { label: "No data", tone: "text-slate-400" },
};

function campaignTrendCopy(trend: Employee360Profile["campaignTrend"]): { label: string; tone: string } | null {
  if (!trend) return null;
  const from = `${Math.round(trend.fromCampaignShare * 100)}%`;
  const to = `${Math.round(trend.toCampaignShare * 100)}%`;
  const span = `${monthLabel(trend.fromMonth)} → ${monthLabel(trend.toMonth)}`;
  if (trend.direction === "improving") return { label: `▼ Campaign falling, regular rising (${from} → ${to} campaign, ${span}) · the best direction`, tone: "text-emerald-600" };
  if (trend.direction === "worsening") return { label: `▲ Campaign rising, regular falling (${from} → ${to} campaign, ${span})`, tone: "text-amber-600" };
  if (trend.fromCampaignShare === 0 && trend.toCampaignShare === 0) return { label: `Held at all regular (${span})`, tone: "text-emerald-600" };
  return { label: `Steady mix (${from} → ${to} campaign, ${span})`, tone: "text-slate-500" };
}

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
  chrome,
  subject,
  tenure,
  windowLabel,
  benchmarkLabel,
  roleLabel,
}: {
  chrome: "admin" | "portal";
  subject: Employee360Subject;
  tenure: string | null;
  windowLabel: string;
  benchmarkLabel: string;
  roleLabel: string;
}) {
  // NO DARK BAND. Flattened 2026-09-03 at the owner's instruction — "remove from all pages this
  // dump block" — the same removal made the same day on `AdminPageHero` (131 pages), the HR, CEO
  // and Finance command centers and My Workspace. This was an `AdminHeroFrame`: a full-bleed
  // black gradient at p-5 / sm:p-6 / lg:p-7, four decorative layers deep.
  //
  // NOTHING HERE WAS DELETED, only recoloured, and that is the difference between this page and
  // the others. Everywhere else the band was restating the name of the page you had just opened,
  // so it went. Here it says WHOSE record you are reading — the name, HR ID, employment status,
  // job title, line, area, manager and tenure — and dropping it would leave a review page with no
  // subject on it. So it is now a compact line on the page's own surface.
  //
  // THE COLOURS ALL HAD TO MOVE WITH IT. `AdminHeroFrame` supplied a dark surface, so every value
  // above was written to be legible on black — `text-white`, `text-slate-300/400`,
  // `text-phx-paper`, `bg-white/10`, `ring-white/10`. Kept as-is over white they paint white on
  // white: present in the DOM, invisible on screen, and reading as missing data rather than as a
  // styling bug. If anything here ever goes blank, that is the first thing to check.
  return (
    // POLISHED 2026-09-03 (second pass): the rail and fading rule from the shared tokens, so this
    // person's header matches every page header around it. The rail sits OUTSIDE the avatar, at
    // the block's leading edge, which is where it sits on every other header - it marks the start
    // of the header, not the start of the text.
    <section className="min-w-0">
      <div className="flex flex-col gap-3 pb-4 lg:flex-row lg:items-center lg:justify-between lg:gap-6">
      <div className="relative flex min-w-0 items-center gap-3 pl-3.5">
        <span aria-hidden="true" className={pageHeaderRailClassName} />
        <span
          aria-hidden
          className={cn(
            "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-[13px] font-black text-white ring-1 ring-slate-900/10",
            avatarTone(subject.hrId),
          )}
        >
          {initials(subject.displayName)}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {/* Literal bracket sizes, not the named text-phx-* scale — cn() runs over this
                subtree and tailwind-merge silently drops custom NAMED font sizes.

                THE LEVEL IS THE SHELL'S TO DECIDE, THE LOOK IS NOT. Owner, 2026-09-30: "change the
                employee 360 h1 to an h2". This is the PERSON's name, never the page title, so on a
                portal page — where `EmployeePortalPageShell` already renders `<h1>Employee 360</h1>`
                — it is a section heading and a second <h1> is simply wrong for a screen reader, which
                announces the employee's name as the name of the page.

                🔴 IT COULD NOT BE SWAPPED OUTRIGHT. `app/(admin)/employee-360/[hrId]/page.tsx`
                renders this view with NO shell, and its own three <h1>s are all in not-found and
                error branches — so on the admin SUCCESS path this is the page's ONLY <h1>, and an
                unconditional demotion would have left that page with no top-level heading at all.
                Gated instead, on the same `chrome` prop `KpisBoardView`, `FieldActivityView` and
                `TerritoryMapWorkspace` already use.

                The className is identical on both branches, so nothing moves by a pixel — Tailwind's
                preflight resets heading margins and sizes, and the sizes here are explicit. */}
            {chrome === "admin" ? (
              <h1 className="min-w-0 break-words text-[1.05rem] font-black tracking-[-0.03em] text-slate-900 sm:text-[1.2rem]">
                {subject.displayName}
              </h1>
            ) : (
              <h2 className="min-w-0 break-words text-[1.05rem] font-black tracking-[-0.03em] text-slate-900 sm:text-[1.2rem]">
                {subject.displayName}
              </h2>
            )}
            <span className="rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-600">
              {subject.hrId.toUpperCase()}
            </span>
            {subject.employmentStatus && subject.employmentStatus !== "active" ? (
              <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-amber-700">
                {subject.employmentStatus.replace(/_/g, " ")}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-[13px] leading-5 text-slate-600">
            {[subject.jobTitle, subject.lineName, subject.areaName || subject.regionName].filter(Boolean).join(" · ") || "—"}
          </p>
          <p className="text-[12px] leading-5 text-slate-500">
            {subject.managerName ? `Reports to ${subject.managerName}` : "No manager on record"}
            {tenure ? ` · ${tenure}` : ""}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 flex-row flex-wrap items-center gap-2 lg:flex-col lg:items-end lg:gap-1.5">
        <span className="rounded-full border border-slate-300 bg-slate-100 px-3 py-1 text-[10px] font-black uppercase tracking-[0.14em] text-slate-600">
          {roleLabel}
        </span>
        <span className="rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-[11px] font-bold text-amber-700">
          {windowLabel}
        </span>
        <span className="text-[11px] text-slate-500">{benchmarkLabel}</span>
      </div>
      </div>
      <div aria-hidden="true" className={pageHeaderRuleClassName} />
    </section>
  );
}

export function Employee360View({
  chrome = "admin",
  subject,
  summary,
  comparison,
  showExpenses = true,
  category,
  teamHealth = null,
  teamLifecycle = null,
  tmAnalytics = null,
  pmMarketing = null,
  crmInsights = null,
  bare = false,
}: {
  /**
   * Which shell this report is rendered in, and therefore whether the subject's name is the page's
   * top-level heading or a section heading inside one. `admin` (the default) keeps the `<h1>`, because
   * `app/(admin)/employee-360/[hrId]/page.tsx` renders this view bare and that heading is the page's
   * only one. `portal` demotes it to `<h2>`, because `EmployeePortalPageShell` already renders the
   * page's `<h1>`. Same vocabulary as `KpisBoardView`, `FieldActivityView` and `TerritoryMapWorkspace`.
   */
  chrome?: "admin" | "portal";
  subject: Employee360Subject;
  summary: Employee360Profile;
  comparison?: Employee360Comparison | null;
  showExpenses?: boolean;
  category: Employee360RoleCategory;
  teamHealth?: TeamHealthSummary | null;
  teamLifecycle?: TeamLifecycleSummary | null;
  tmAnalytics?: TrainingManagerAnalytics | null;
  pmMarketing?: PmMarketingSummary | null;
  /** Phoenix CRM plan compliance and visit frequency by grade (`crm-insights.ts`). */
  crmInsights?: Employee360CrmInsights | null;
  /**
   * The employee portal's page shell already pads and sizes the content column, so its two call
   * sites render the report BARE: no second padding (32px lost at 375px) and no max-width, which
   * also lines the report up with the period filter above it. The admin page keeps both.
   */
  bare?: boolean;
}) {
  const b = summary.benchmarks;
  const salesCoverage = salesCoverageText(summary.fieldBenchmarks);
  const tenure = tenureLabel(subject.hireDate);
  const monthlyMax = Math.max(1, ...summary.monthly.map((m) => m.regular + m.campaign));
  const trendCopy = campaignTrendCopy(summary.campaignTrend);
  const hourMax = Math.max(1, ...summary.hourHistogram);

  // Role-driven section composition. A leader (DM / RM / NSM / PM / TM) leads with
  // what they DELIVER (team sales + coaching/double-visits given); a Medical Rep
  // leads with their own field work and the received-side coaching/impact. The plan
  // lives in the domain so its tests read the same answer this page renders; a
  // Regional Manager's report drops any section with nothing to show (owner,
  // 2026-10-20: "bring him back but do not show empty data, tailor the report on him").
  const plan = planEmployee360Sections(
    category,
    {
      productiveVisits: summary.productiveVisits,
      doublesReceived: summary.doublesReceived,
      leadershipHasData: Boolean(summary.leadership?.hasData),
      salesHasData: summary.sales.hasData,
      expensesHaveData: summary.expenses.payroll.hasData || summary.expenses.outstation.hasData,
      crmPlanCompliance: crmInsightState(crmInsights?.planCompliance),
      crmFrequency: crmInsightState(crmInsights?.frequency),
    },
    showExpenses,
  );
  const { isLeader, showCampaign, showCheckin, showReceivedSide } = plan;

  return (
    <div className={bare ? "space-y-6" : "mx-auto max-w-5xl space-y-6 p-4 sm:p-6"}>
      {/* Header / identity */}
      <IdentityHero chrome={chrome} subject={subject} tenure={tenure} windowLabel={summary.window.label} benchmarkLabel={b.windowLabel} roleLabel={EMPLOYEE_360_ROLE_META[category].label} />

      {/* Trust strip */}
      <div className="flex flex-wrap gap-2 text-xs">
        <TrustChip ok={summary.isMapped} okText="CRM visits linked" badText="No CRM visits linked to this employee" />
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
      {plan.showComparison && comparison ? <ComparisonStrip comparison={comparison} /> : null}

      {/* Leaders lead with what they DELIVER. */}
      {plan.showLeadership && summary.leadership ? (
        <LeadershipSection leadership={summary.leadership} isTM={category === "training-manager"} />
      ) : null}

      {/* Training Manager god-mode: coverage / neglect / concentration + verdict. */}
      {tmAnalytics ? <TrainingManagerSection a={tmAnalytics} /> : null}

      {/* Team / line sales — leaders show it up top (reps see their own further down). */}
      {plan.showTeamSales ? <SalesSection sales={summary.sales} field={summary.fieldBenchmarks} /> : null}

      {/* Team development — coaching coverage of a field manager's own reps. */}
      {teamHealth ? <TeamHealthSection teamHealth={teamHealth} /> : null}

      {/* Team compliance — weekly plans, field discipline & probation of their reps. */}
      {teamLifecycle ? <TeamLifecycleSection lifecycle={teamLifecycle} /> : null}

      {/* PM / Group PM — ROI on the marketing requests they submitted. */}
      {pmMarketing ? <MarketingRoiSection m={pmMarketing} /> : null}

      {/* Visits & Coverage — reps: full field performance; leaders: their OWN field presence. */}
      {plan.showOwnVisits ? (
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
          <KpiTile label="Productive visits" value={intFmt.format(summary.productiveVisits)} benchmark={companyAvg(intFmt.format(b.productiveVisits))} hint={tenure ? "total — read with tenure" : undefined} />
          <KpiTile label="Visits / active day" value={ratio1(summary.visitsPerActiveDay)} benchmark={companyAvg(b.visitsPerActiveDay)} goodWhenAbove={summary.visitsPerActiveDay == null ? null : summary.visitsPerActiveDay >= b.visitsPerActiveDay} />
          <KpiTile label="Active days" value={intFmt.format(summary.activeDays)} benchmark={companyAvg(b.activeDays)} />
          <KpiTile label="Distinct customers" value={intFmt.format(summary.distinctCustomers)} benchmark={companyAvg(b.distinctCustomers)} />
          <KpiTile label="Regular visits" value={intFmt.format(summary.regularVisits)} benchmark={companyAvg(intFmt.format(b.regularVisits))} />
          <KpiTile label="Campaign visits" value={intFmt.format(summary.campaignVisits)} benchmark={companyAvg(intFmt.format(b.campaignVisits))} />
          {plan.showDoublesReceived ? (
            <KpiTile label="Doubles received" value={intFmt.format(summary.doublesReceived)} benchmark={companyAvg(b.doublesReceived)} hint={`${onDays(summary.doublesReceivedDays, summary.doublesReceived)}${doublesReceivedHint(summary.doublesReceivedByKind)}`} />
          ) : null}
          <KpiTile label="Admin / non-visit" value={intFmt.format(summary.adminVisits + summary.trainingVisits)} hint="meetings, training, leave, etc." />
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <KpiTile label="Last 30 days" value={intFmt.format(summary.last30)} hint={`previous 30 days: ${intFmt.format(summary.prev30)} · ${MOMENTUM_LABEL[summary.momentumTrend]}`} goodWhenAbove={summary.momentumTrend === "up" ? true : summary.momentumTrend === "down" ? false : null} />
          <KpiTile label="Avg visits / customer" value={ratio1(summary.avgVisitsPerCustomer)} hint={`${summary.repeatCustomers} repeat · ${summary.oneTimeCustomers} one-time`} />
          <KpiTile
            label="Utilization"
            value={pct(summary.utilization)}
            hint={`${summary.activeDays}/${summary.workingDaysInWindow} working days, Saturday to Wednesday less national holidays${summary.holidaysComplete === false ? " (the holiday calendar could not be read, so holidays may still be counted)" : ""}`}
          />
        </div>

        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <div>
            <DayOfWeekBars counts={summary.visitDayOfWeek} title="Visits by day of week — Sat–Wed full · Thu AM · Fri off" />
            <div className="mt-3 text-xs text-slate-400">
              Single visits {intFmt.format(summary.singleVisits)}
              {plan.showDoublesReceived ? ` · Double visits ${intFmt.format(summary.doublesReceived)}${summary.doublesReceived > 0 ? ` on ${daysWord(summary.doublesReceivedDays)}` : ""}` : ""}
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-xs font-bold text-slate-500">Activity mix (all visit types)</div>
            <MixRows items={summary.activityMix} />
          </div>
        </div>

        <MostVisitedCustomers top={summary.topCustomers} />
      </Card>
      ) : null}

      {/* Campaign vs Regular */}
      {showCampaign ? (
      <Card className={PREMIUM_CARD}>
        <SectionHeader icon={Megaphone} tone="orange" sub="100% regular is the best case; campaign falling while regular rises is the best direction. Each month shows the company's SAME-month campaign share beside it.">
          Campaign vs Regular
        </SectionHeader>
        <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-slate-600">
          <span>
            Mix: <span className="font-black tabular-nums text-slate-900">{pct(summary.regularShare)} regular / {pct(summary.campaignShare)} campaign</span>
          </span>
          <span className={cn("font-bold", campaignMixCopy[summary.campaignMix].tone)}>● {campaignMixCopy[summary.campaignMix].label}</span>
          {trendCopy ? <span className={cn("font-bold", trendCopy.tone)}>{trendCopy.label}</span> : null}
        </div>
        {summary.monthly.length > 1 ? (
          <div className="mb-5">
            <div className="mb-1.5 text-xs font-bold text-slate-500">Monthly visit trend</div>
            <LineChart
              labels={monthAxisLabels(summary.monthly.map((m) => m.month))}
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
                  <div className="w-16 shrink-0 text-xs font-semibold text-slate-500">{monthLabel(m.month)}</div>
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
          sub="Visit records have no clock time — timing below is from GPS check-ins. Visit-level intra-day is AM/PM only."
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
              <KpiTile label="Check-in : visit" value={ratio1(summary.checkinToVisitRatio)} benchmark={companyAvg(b.checkinToVisitRatio)} hint="GPS corroboration of visits" />
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
              <KpiTile label="Check-ins / active day" value={ratio1(summary.checkinsPerActiveDay)} hint="per day with GPS" />
              <KpiTile label="Uncorroborated days" value={intFmt.format(summary.uncorroboratedDays)} hint="visit days with no GPS" />
              <KpiTile label="Distinct locations" value={intFmt.format(summary.distinctLocations)} hint="GPS points (~110m)" />
            </div>

            <div className="mt-5 grid gap-5 sm:grid-cols-2">
              <DayOfWeekBars counts={summary.checkinDayOfWeek} title="Check-ins by day of week — Sat–Wed full · Thu AM · Fri off" />
              <div>
                <div className="mb-1.5 text-xs font-bold text-slate-500">GPS coverage by month</div>
                <LineChart
                  labels={monthAxisLabels(summary.coverageTrend.map((m) => m.month))}
                  series={[{ name: "Coverage", color: CHART_COLORS.coverage, points: summary.coverageTrend.map((m) => (m.coverage == null ? null : m.coverage * 100)), area: true }]}
                  height={150}
                  yMax={100}
                  yFormat={(n) => `${Math.round(n)}%`}
                />
              </div>
            </div>

            <div className="mt-4 text-xs text-slate-400">
              Visit split (self-reported): <span className="font-bold text-slate-700">{intFmt.format(summary.amVisits)} AM · {intFmt.format(summary.pmVisits)} PM · {formatPharmacyFigure(visitSplitOf(summary), { formatNumber: (value) => intFmt.format(value), numberFirst: true })}</span>
            </div>
          </>
        )}
      </Card>
      ) : null}

      {/* Sales & Achievement — reps see their own here (leaders saw team sales up top). */}
      {plan.showOwnSales ? <SalesSection sales={summary.sales} field={summary.fieldBenchmarks} /> : null}

      {/* Bricks — the rep's area against the rep's CURRENT list (Medical Reps only; null otherwise). */}
      {plan.showBricks && summary.bricks ? <BrickCoverageSection panel={summary.bricks} /> : null}

      {/* Phoenix CRM — plan compliance and visit frequency by grade, each only with something to say. */}
      <Employee360CrmInsightsSections
        insights={crmInsights}
        showPlanCompliance={plan.showCrmPlanCompliance}
        showFrequency={plan.showCrmFrequency}
      />

      {/* Expenses & Outstation — leaders only (DM / RM / NSM / PM / TM). */}
      {plan.showExpenses ? (
        <ExpensesSection
          expenses={summary.expenses}
          activity={{
            amVisits: summary.amVisits,
            pmVisits: summary.pmVisits,
            pharmacyVisits: summary.pharmacyVisits ?? 0,
            phoenixVisits: summary.phoenixVisits ?? 0,
            regularVisits: summary.regularVisits,
            campaignVisits: summary.campaignVisits,
          }}
        />
      ) : null}

      {/* Coaching / impact / double-visits RECEIVED — a rep-side view (Medical Reps). */}
      {showReceivedSide ? (
        <>
          <CoachingSection coaching={summary.coaching} field={summary.fieldBenchmarks} />
          <ImpactSection impact={summary.impact} />
          <DoubleVisitSection dv={summary.doubleVisits} />
        </>
      ) : null}

      <p className="px-1 text-phx-xs text-slate-400">
        Employee 360 · {EMPLOYEE_360_ROLE_META[category].label} view — sections are tailored to this role. Sales lag visits ~2 months
        {salesCoverage ? ` (${salesCoverage})` : ""}; coaching is a single-rater signal — light pillars are coverage states, never a punishing zero. Benchmarks are company 2026 YTD averages.
      </p>
    </div>
  );
}

/** The kinds of double visit a leader conducts, in the order the tiles show them. */
const CONDUCTED_KINDS: ReadonlyArray<{ key: keyof NonNullable<LeadershipActivity["dvByKind"]>; label: string; hint: string }> = [
  { key: "doubles", label: "Double visits", hint: "the leader and one rep" },
  { key: "chains", label: "Chain visits", hint: "two leaders and a rep" },
  { key: "productManagerVisits", label: "Product manager visits", hint: "in the product or training manager's seat" },
];

/** "12 with a manager · 3 chain · 1 with a product or training manager" — only the kinds that happened. */
function doublesReceivedHint(byKind: { withManager: number; chain: number; withProductManager: number } | undefined): string {
  if (!byKind) return "visits with a manager alongside";
  const parts = [
    byKind.withManager > 0 ? `${intFmt.format(byKind.withManager)} with a manager` : null,
    byKind.chain > 0 ? `${intFmt.format(byKind.chain)} chain` : null,
    byKind.withProductManager > 0 ? `${intFmt.format(byKind.withProductManager)} with a product or training manager` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : "visits with a manager alongside";
}

/** "1 day" · "12 days" — the distinct days a set of double visits was made on (owner, 2026-10-27). */
function daysWord(days: number): string {
  return `${intFmt.format(days)} day${days === 1 ? "" : "s"}`;
}

/** "on 12 days · " ahead of a double-visit tile's own hint; nothing when there were no visits to place on a day. */
function onDays(days: number | null | undefined, visits: number | null | undefined): string {
  return days != null && (visits ?? 0) > 0 ? `on ${daysWord(days)} · ` : "";
}

/** "AM 2 · PM 9 · Pharmacies 5" — the three figures apart, never added (owner, 2026-10-23). */
function splitLine(split: { am: number; pm: number; pharmacies: number }): string {
  return `AM ${intFmt.format(split.am)} · PM ${intFmt.format(split.pm)} · Pharmacies ${intFmt.format(split.pharmacies)}`;
}

function LeadershipSection({ leadership, isTM }: { leadership: LeadershipActivity; isTM: boolean }) {
  return (
    <Card className={PREMIUM_CARD}>
      <SectionHeader
        icon={Award}
        tone="violet"
        sub="Coaching reports authored, double-visits conducted and single visits made BY this leader in the period — the delivering end, and how many distinct reps it reached."
      >
        Leadership Activity{isTM ? " & Impact" : ""}
      </SectionHeader>
      {!leadership.hasData ? (
        <EmptyState>No coaching reports authored, double-visits conducted or own visits logged in this period.</EmptyState>
      ) : (
        <>
          <SummaryLine text={leadership.summaryText} />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            <KpiTile
              label="Coaching delivered"
              value={intFmt.format(leadership.coachingDelivered)}
              hint={`${leadership.coachingRepsReached} rep${leadership.coachingRepsReached === 1 ? "" : "s"} coached`}
            />
            {/* iReports360 double visits plus his Phoenix CRM ride-alongs; "—" when the Phoenix CRM read failed. */}
            <KpiTile
              label="Double-visits conducted"
              value={leadership.dvConducted == null ? "—" : intFmt.format(leadership.dvConducted)}
              hint={
                leadership.dvSplit
                  ? `${onDays(leadership.dvDays, leadership.dvConducted)}${leadership.dvRepsReached} rep${leadership.dvRepsReached === 1 ? "" : "s"} accompanied · ${splitLine(leadership.dvSplit)}`
                  : "the Phoenix CRM visits could not be read just now"
              }
            />
            {/* One figure per kind he conducted, only the kinds that happened. */}
            {leadership.dvByKind
              ? CONDUCTED_KINDS.filter((kind) => (leadership.dvByKind?.[kind.key] ?? 0) > 0).map((kind) => (
                  <KpiTile key={kind.key} label={kind.label} value={intFmt.format(leadership.dvByKind?.[kind.key] ?? 0)} hint={kind.hint} />
                ))
              : null}
            {/* His own single visits, logged in Phoenix CRM (owner, 2026-10-23) — kept apart from the double visits and
                from every rep's figures. A visit on a half-day planned with his own manager is never single (owner,
                2026-10-27): it has a tile of its own. "—" when the read failed: never a zero that was not measured. */}
            <KpiTile
              label="Own single visits"
              value={leadership.ownSingle ? intFmt.format(leadership.ownSingle.visits) : "—"}
              hint={leadership.ownSingle ? splitLine(leadership.ownSingle.split) : "could not be read just now"}
            />
            {leadership.ownSingle && leadership.ownSingle.withSenior.visits > 0 ? (
              <KpiTile
                label="Own visits with a senior"
                value={intFmt.format(leadership.ownSingle.withSenior.visits)}
                hint={`with their own manager or a product manager · ${splitLine(leadership.ownSingle.withSenior.split)}`}
              />
            ) : null}
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
              <div className={LIST_BOX}>
                {leadership.byRep.map((r) => {
                  const parts = [
                    r.coachingReports > 0 ? `${r.coachingReports} coaching` : null,
                    r.doubleVisits > 0 ? `${r.doubleVisits} double-visit${r.doubleVisits === 1 ? "" : "s"}` : null,
                    r.avgScoreGiven != null ? `${Math.round(r.avgScoreGiven)}% avg` : null,
                  ].filter(Boolean);
                  return (
                    <div key={r.hrId} className={LIST_ROW}>
                      <span className={LIST_NAME}>{r.name ?? r.hrId}</span>
                      <span className={cn(LIST_SIDE, "tabular-nums")}>{parts.join(" · ")}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {leadership.recentDv.length > 0 ? (
            <div className="mt-5">
              <div className="mb-1.5 text-xs font-bold text-slate-500">Recent double-visits conducted</div>
              <div className={LIST_BOX}>
                {leadership.recentDv.map((e, i) => (
                  <div key={`${e.date}-${i}`} className={LIST_ROW}>
                    <div className={LIST_DATED}>
                      <span className={LIST_DATE}>{dayLabel(e.date)}</span>
                      <span className={LIST_NAME}>{e.repName ?? "—"}</span>
                    </div>
                    <span className={LIST_SIDE}>{e.kind}{e.customerName ? ` · ${e.customerName}` : ""}</span>
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

/** A month whose closing is not published shows no figure at all — never a zero (owner, 2026-10-27). */
function UnpublishedSalesMonths({ months }: { months: readonly string[] }) {
  return (
    <div className="mt-5 space-y-1.5">
      <div className="text-xs font-bold text-slate-500">Months waiting for the closing</div>
      {months.map((month) => (
        <div key={month} className="flex items-center gap-3">
          <div className="w-16 shrink-0 text-xs font-semibold text-slate-500">{monthLabel(month)}</div>
          <div className="flex min-h-4 flex-1 items-center border border-dashed border-slate-300 bg-white px-2 text-phx-2xs font-semibold text-slate-500">
            Not published yet
          </div>
        </div>
      ))}
    </div>
  );
}

function SalesSection({ sales, field }: { sales: Employee360Profile["sales"]; field: FieldBenchmarks }) {
  const untargeted = sales.untargetedLabel;
  const coverage = salesCoverageText(field);
  const companyAchievement =
    field?.companyAchievementPct != null
      ? `${companyAvg(pctPoints(field.companyAchievementPct))}${field.salesThroughLabel ? ` · through ${field.salesThroughLabel}` : ""}`
      : undefined;
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
        sales.teamUnreadable ? (
          <EmptyState>{sales.summaryText}</EmptyState>
        ) : sales.unpublishedMonths.length > 0 ? (
          <UnpublishedSalesMonths months={sales.unpublishedMonths} />
        ) : (
          <EmptyState>No validated sales records for this employee yet{coverage ? ` (${coverage})` : ""}.</EmptyState>
        )
      ) : (
        <>
          <SummaryLine text={sales.summaryText} />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiTile label={sales.isTeamRollup ? "Team sales" : "Total sales"} value={compactFmt.format(sales.totalSales)} hint={sales.isTeamRollup ? `${sales.teamRepCount} reps` : sales.latestMonth ? `through ${monthLabel(sales.latestMonth)}` : undefined} />
            <KpiTile
              label={sales.isTeamRollup ? "Team target" : "Total target"}
              value={compactFmt.format(sales.totalTarget)}
              hint={untargeted ? `none set for ${untargeted}` : undefined}
            />
            <KpiTile
              label="Achievement"
              value={pctPoints(sales.achievementPct)}
              benchmark={companyAchievement}
              goodWhenAbove={sales.achievementPct == null ? null : sales.achievementPct >= 100}
              hint={untargeted ? "months with a target only" : undefined}
              explain={
                untargeted
                  ? `Sales in the months that carry a target, divided by that target — the Monthly Closing's rule. ${untargeted} carry no target, so their ${compactFmt.format(sales.totalSales - sales.gradedSales)} of sales is in Total sales but not in this percentage.`
                  : undefined
              }
            />
            <KpiTile label="Months covered" value={intFmt.format(sales.monthsCount)} hint={untargeted ? `${sales.targetedMonthsCount} with a target` : undefined} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiTile
              label="Months hit target"
              value={sales.targetedMonthsCount > 0 ? `${sales.monthsHitTarget}/${sales.targetedMonthsCount}` : "—"}
              hint={untargeted ? "of the months with a target" : undefined}
              goodWhenAbove={sales.targetedMonthsCount > 0 ? sales.monthsHitTarget / sales.targetedMonthsCount >= 0.5 : null}
            />
            <KpiTile label="Growth (1st→latest)" value={sales.growthPct == null ? "—" : `${sales.growthPct >= 0 ? "+" : ""}${Math.round(sales.growthPct)}%`} goodWhenAbove={sales.growthPct == null ? null : sales.growthPct >= 0} />
            <KpiTile label="Sales / visit" value={sales.salesPerVisit == null ? "—" : compactFmt.format(sales.salesPerVisit)} hint="window months, per productive visit" />
            <KpiTile label="Sales / customer" value={sales.salesPerCustomer == null ? "—" : compactFmt.format(sales.salesPerCustomer)} hint="window months, per doctor reached" />
          </div>
          {sales.monthly.length > 1 ? (
            <div className="mt-5">
              <div className="mb-1.5 text-xs font-bold text-slate-500">Sales vs target trend</div>
              <LineChart
                labels={monthAxisLabels(sales.monthly.map((m) => m.month))}
                series={[
                  { name: "Sales", color: CHART_COLORS.sales, points: sales.monthly.map((m) => m.sales), area: true },
                  // A month with no target is a GAP in the target line, never a dive to zero.
                  { name: "Target", color: CHART_COLORS.target, points: sales.monthly.map((m) => (m.hasTarget ? m.target : null)) },
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
                if (!m.hasTarget) {
                  // The month's sales are real and shown; there is no target to grade them against.
                  return (
                    <div key={m.month} className="flex items-center gap-3">
                      <div className="w-16 shrink-0 text-xs font-semibold text-slate-500">{monthLabel(m.month)}</div>
                      <div className="flex min-h-4 flex-1 items-center border border-dashed border-slate-300 bg-white px-2 text-phx-2xs font-semibold text-slate-500">
                        No target set · sales only
                      </div>
                      <div className="w-32 shrink-0 text-right text-xs tabular-nums text-slate-600">
                        {compactFmt.format(m.sales)} <span className="text-slate-400">sales</span>
                      </div>
                    </div>
                  );
                }
                const achv = m.achievementPct ?? 0;
                const width = Math.min(150, achv) / 1.5; // % of bar
                const tone = achv >= 100 ? "bg-emerald-500" : achv >= 70 ? "bg-amber-500" : "bg-red-500";
                return (
                  <div key={m.month} className="flex items-center gap-3">
                    <div className="w-16 shrink-0 text-xs font-semibold text-slate-500">{monthLabel(m.month)}</div>
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
          {sales.unpublishedMonths.length > 0 ? <UnpublishedSalesMonths months={sales.unpublishedMonths} /> : null}
          {sales.topProducts.length > 0 ? (
            <div className="mt-5">
              <div className="mb-1.5 text-xs font-bold text-slate-500">Top products by sales</div>
              <div className={LIST_BOX}>
                {sales.topProducts.map((p) => (
                  <div key={p.product} className={LIST_ROW}>
                    <span className={LIST_NAME}>{p.product}</span>
                    <span className="min-w-0 max-w-[55%] break-words text-right tabular-nums text-slate-400">{compactFmt.format(p.sales)} · {pctPoints(p.achievementPct)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {sales.byFamily.length > 1 ? (
            <div className="mt-5">
              <div className="mb-1.5 text-xs font-bold text-slate-500">Achievement by product family</div>
              <div className={BAR_LIST}>
                {sales.byFamily.slice(0, 6).map((f) => {
                  const achv = f.achievementPct ?? 0;
                  const tone = achv >= 100 ? "bg-emerald-500" : achv >= 70 ? "bg-amber-500" : "bg-red-500";
                  return (
                    <div key={f.family} className={BAR_ROW}>
                      <div className={BAR_LABEL}>{f.family}</div>
                      <div className={BAR_FIGURE}>{pctPoints(f.achievementPct)} · {compactFmt.format(f.sales)}</div>
                      <div className={BAR_TRACK}><div className={cn("h-full rounded-full", tone)} style={{ width: `${Math.min(150, achv) / 1.5}%` }} /></div>
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

// ── Bricks: the rep's area against the rep's current list ────────────────────
// The owner's request, 2026-09-21: every brick his area's sales are counted on, sold or not, beside
// the bricks holding the doctors on his list TODAY. Built in `src/lib/employee-360/brick-coverage.ts`.

const BRICK_STATUS: Record<Employee360BrickStatus, { label: string; className: string }> = {
  covered: { label: "Sales + doctors", className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  "sales-no-doctor": { label: "Sales, no listed doctor", className: "border-amber-200 bg-amber-50 text-amber-700" },
  "doctor-no-sales": { label: "Doctors, no sales", className: "border-sky-200 bg-sky-50 text-sky-700" },
  idle: { label: "No sales, no doctors", className: "border-slate-200 bg-slate-50 text-slate-500" },
};

// Brick months use the report-wide monthLabel ("Aug 2026"), defined at the top of this file.
function brickMonthsLabel(months: string[]): string {
  if (months.length === 0) return "no landed month";
  if (months.length === 1) return monthLabel(months[0]);
  return `${monthLabel(months[0])} to ${monthLabel(months[months.length - 1])}`;
}

function plural(count: number, one: string, many: string): string {
  return `${intFmt.format(count)} ${count === 1 ? one : many}`;
}

function BrickStatusChip({ status }: { status: Employee360BrickStatus }) {
  const meta = BRICK_STATUS[status];
  return (
    <span className={cn("inline-block border px-1.5 py-0.5 text-phx-2xs font-black uppercase leading-4 tracking-wide", meta.className)}>
      {meta.label}
    </span>
  );
}

function brickSummaryText(coverage: Employee360BrickCoverage): string {
  const { totals } = coverage;
  const areas = coverage.areaNames.join(" + ") || "the area";
  const months = brickMonthsLabel(coverage.salesMonths);
  const parts = [
    `${intFmt.format(totals.bricksWithSales)} of ${plural(totals.areaBricks, "brick", "bricks")} in ${areas} booked sales in ${months}; the current list puts ${intFmt.format(totals.doctorsInArea)} of ${plural(totals.listDoctors, "doctor", "doctors")} in them.`,
  ];
  if (totals.salesNoDoctor > 0) {
    parts.push(
      `${plural(totals.salesNoDoctor, "selling brick has", "selling bricks have")} no listed doctor — ${pct(totals.salesNoDoctorShare)} of the bricks' sales.`,
    );
  }
  if (totals.doctorsOutside > 0) {
    parts.push(
      `${plural(totals.doctorsOutside, "listed doctor sits", "listed doctors sit")} in ${plural(coverage.outside.length, "brick", "bricks")} outside the area.`,
    );
  }
  return parts.join(" ");
}

function BrickCoverageSection({ panel }: { panel: Employee360BrickPanel }) {
  if (panel.status === "no-seat") return null;
  if (panel.status === "failed") {
    return (
      <Card className={PREMIUM_CARD}>
        <SectionHeader icon={MapPin} tone="indigo">
          Bricks — Area vs Current List
        </SectionHeader>
        <EmptyState>The brick comparison could not be loaded just now. The rest of this page is unaffected.</EmptyState>
      </Card>
    );
  }

  const { coverage } = panel;
  const { totals } = coverage;
  const months = brickMonthsLabel(coverage.salesMonths);
  const monthNote =
    coverage.salesMonths.length === 0
      ? "No distributor files have landed since this rep's hire month, so no brick shows sales yet."
      : coverage.salesMonthsFallback
        ? `Sales are ${months}, the latest month whose distributor files have landed — none of this period's months has landed yet.`
        : `Sales are ${months}.`;
  const areaLabel = coverage.areaNames.join(" + ") || "This rep's area";
  const sub = `${coverage.lineName} · ${areaLabel}. Every brick of the area this rep carries the target for, sold or not, against the doctors on the rep's CURRENT CRM list — never the area's old lists. ${monthNote} A brick's sales are what distributors booked on it, so they do not add up to the Sales figure above, which also credits the area with city splits, the Office allocation and direct orders.`;

  if (coverage.bricks.length === 0 && coverage.outside.length === 0 && totals.listDoctors + totals.listPharmacies === 0) {
    return (
      <Card className={PREMIUM_CARD}>
        <SectionHeader icon={MapPin} tone="indigo" sub={sub}>
          Bricks — Area vs Current List
        </SectionHeader>
        <EmptyState>No bricks on file for this area, and nobody on this rep&apos;s current list.</EmptyState>
      </Card>
    );
  }

  const doctorNoSales = coverage.bricks.filter((brick) => brick.status === "doctor-no-sales").length;
  return (
    <Card className={PREMIUM_CARD}>
      <SectionHeader icon={MapPin} tone="indigo" sub={sub}>
        Bricks — Area vs Current List
      </SectionHeader>
      <SummaryLine text={brickSummaryText(coverage)} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiTile
          label="Area bricks"
          value={intFmt.format(totals.areaBricks)}
          hint={`${intFmt.format(totals.bricksWithSales)} with sales`}
          explain="Every brick of the area this rep carries the target for — the ones that sold and the ones that did not."
        />
        <KpiTile
          label="Bricks with doctors"
          value={intFmt.format(totals.bricksWithDoctors)}
          hint={`of ${intFmt.format(totals.areaBricks)} · ${plural(totals.doctorsInArea, "doctor", "doctors")}`}
          explain="How many of the area's bricks hold at least one doctor (AM or PM) from the rep's current CRM list."
        />
        <KpiTile
          label="Sales, no doctor"
          value={intFmt.format(totals.salesNoDoctor)}
          hint={totals.salesNoDoctorShare == null ? "no brick sales" : `${pct(totals.salesNoDoctorShare)} of brick sales`}
          goodWhenAbove={totals.salesNoDoctor > 0 ? false : null}
          explain="Bricks that booked sales but hold no doctor from the rep's current list — sales nobody on the list is placed to support."
        />
        <KpiTile
          label="Doctors, no sales"
          value={intFmt.format(doctorNoSales)}
          hint="bricks"
          goodWhenAbove={doctorNoSales > 0 ? false : null}
          explain="Bricks of the area holding listed doctors where no sales were booked in the months shown."
        />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiTile
          label="Brick sales"
          value={compactFmt.format(totals.brickSales)}
          hint={months}
          explain="What distributors booked on the area's bricks in the months shown. It does not add up to the rep's Sales figure, which also credits money no brick holds."
        />
        <KpiTile
          label="Current list"
          value={intFmt.format(totals.listDoctors)}
          hint={`doctors · ${plural(totals.listPharmacies, "pharmacy", "pharmacies")} apart`}
          explain="The doctors (AM + PM) on the rep's CRM list today. Pharmacies are counted apart — a pharmacy is not a contact."
        />
        <KpiTile
          label="Doctors outside"
          value={intFmt.format(totals.doctorsOutside)}
          hint={`in ${plural(coverage.outside.length, "brick", "bricks")}`}
          goodWhenAbove={totals.doctorsOutside > 0 ? false : null}
          explain="Doctors on the rep's current list whose brick belongs to another area."
        />
        <KpiTile
          label="Not on a brick"
          value={intFmt.format(coverage.unmapped.doctors)}
          hint={`doctors · ${plural(coverage.unmapped.regions, "CRM region", "CRM regions")}`}
          explain="Doctors on the current list whose CRM region is not yet placed on any brick, so they sit in neither column."
        />
      </div>

      {coverage.bricks.length > 0 ? (
        <div className="mt-5">
          <div className="mb-1.5 text-xs font-bold text-slate-500">The area&apos;s bricks — biggest seller first, unsold bricks after</div>
          {/*
            Fits-the-screen golden rule (AGENTS.md §4): a fixed table on desktop, cards on a phone,
            never a horizontal scroll. Doctors and pharmacies share one cell to win the width.
          */}
          <table className="hidden w-full table-fixed border-collapse text-sm sm:table">
            <colgroup>
              <col className="w-[42%]" />
              <col className="w-[18%]" />
              <col className="w-[16%]" />
              <col className="w-[24%]" />
            </colgroup>
            <thead>
              <tr className="text-phx-xs font-black uppercase tracking-wide text-slate-400">
                <th className="py-1.5 pr-2 text-left align-bottom">Brick</th>
                <th className="px-2 py-1.5 text-right align-bottom">Sales</th>
                <th className="px-2 py-1.5 text-right align-bottom">
                  Doctors
                  <span className="block font-black text-slate-300">pharmacies</span>
                </th>
                <th className="py-1.5 pl-2 text-left align-bottom">Status</th>
              </tr>
            </thead>
            <tbody>
              {coverage.bricks.map((brick) => (
                <tr key={brick.brickId} className="border-t border-slate-100 align-top">
                  <td className="break-words py-1.5 pr-2">
                    <span className="block font-semibold text-slate-800">{brick.brickName}</span>
                    {coverage.areaNames.length > 1 && brick.areaName ? (
                      <span className="block text-phx-xs text-slate-400">{brick.areaName}</span>
                    ) : null}
                  </td>
                  <td className={cn("px-2 py-1.5 text-right tabular-nums", brick.salesValue > 0 ? "font-bold text-slate-800" : "text-slate-300")}>
                    {brick.salesValue > 0 ? compactFmt.format(brick.salesValue) : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    <span className={cn("block", brick.doctors > 0 ? "font-bold text-slate-800" : "text-slate-300")}>{intFmt.format(brick.doctors)}</span>
                    <span className="block text-phx-xs text-slate-400">{intFmt.format(brick.pharmacies)}</span>
                  </td>
                  <td className="py-1.5 pl-2">
                    <BrickStatusChip status={brick.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border border-slate-200 sm:hidden">
            {coverage.bricks.map((brick) => (
              <div key={brick.brickId} className="border-b border-slate-100 px-3 py-2.5 last:border-b-0">
                <div className="break-words text-sm font-semibold text-slate-800">{brick.brickName}</div>
                {coverage.areaNames.length > 1 && brick.areaName ? (
                  <div className="text-phx-xs text-slate-400">{brick.areaName}</div>
                ) : null}
                <div className="mt-1 text-xs tabular-nums text-slate-500">
                  Sales {brick.salesValue > 0 ? compactFmt.format(brick.salesValue) : "—"} · {plural(brick.doctors, "doctor", "doctors")} ·{" "}
                  {plural(brick.pharmacies, "pharmacy", "pharmacies")}
                </div>
                <div className="mt-1.5">
                  <BrickStatusChip status={brick.status} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-5">
          <EmptyState>No bricks on file for this area yet.</EmptyState>
        </div>
      )}

      {coverage.outside.length > 0 ? (
        <div className="mt-5">
          <div className="mb-1.5 text-xs font-bold text-slate-500">On the current list, but in another area&apos;s brick</div>
          <div className="border border-slate-200">
            {coverage.outside.map((brick) => (
              <div key={brick.brickId} className="flex items-start justify-between gap-3 border-b border-slate-100 px-3 py-2 text-sm last:border-b-0 hover:bg-slate-50/70">
                <div className="min-w-0 break-words">
                  <span className="block text-slate-800">{brick.brickName}</span>
                  <span className="block text-phx-xs text-slate-400">{brick.areaName ?? "Area not named"}</span>
                </div>
                <span className="shrink-0 text-right text-xs tabular-nums text-slate-400">
                  {plural(brick.doctors, "doctor", "doctors")}
                  <span className="block">{plural(brick.pharmacies, "pharmacy", "pharmacies")}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {coverage.unmapped.doctors + coverage.unmapped.pharmacies > 0 || coverage.salesWithoutBrick !== 0 ? (
        <div className="mt-4 space-y-1 text-xs text-slate-400">
          {coverage.unmapped.doctors + coverage.unmapped.pharmacies > 0 ? (
            <p>
              {plural(coverage.unmapped.doctors, "doctor", "doctors")} and {plural(coverage.unmapped.pharmacies, "pharmacy", "pharmacies")} on the
              current list are in {plural(coverage.unmapped.regions, "CRM region", "CRM regions")} not yet placed on a brick.
            </p>
          ) : null}
          {coverage.salesWithoutBrick !== 0 ? (
            <p>{compactFmt.format(coverage.salesWithoutBrick)} of the sales booked to the area carry no brick, so no row above holds them.</p>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

function CoachingSection({ coaching, field }: { coaching: Employee360Profile["coaching"]; field: FieldBenchmarks }) {
  return (
    <Card className={PREMIUM_CARD}>
      <SectionHeader icon={GraduationCap} tone="violet" sub="Received coaching (double-visit assessments). Single-rater signal — read as guidance, not objective truth.">
        Coaching
      </SectionHeader>
      {!coaching.hasData ? (
        <EmptyState>
          No coaching reports on record for this employee.
          {coaching.futureDatedExcluded > 0 ? ` (${coaching.futureDatedExcluded} future-dated row(s) excluded.)` : ""}
          {field && field.fieldReps > 0 && field.repsEverCoached != null
            ? ` Field-wide, ${intFmt.format(field.repsEverCoached)} of ${intFmt.format(field.fieldReps)} reps have ever been coached (as of ${field.asOfLabel}).`
            : ""}
        </EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiTile
              label="Latest score"
              value={pctPoints(coaching.latest?.finalScorePercent ?? null)}
              hint={coaching.latest ? `${zoneOf(coaching.latest.zone).label} · ${dayLabel(coaching.latest.date)}` : undefined}
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
                      <div className="text-phx-2xs text-slate-400">{dayLabel(r.date)}</div>
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
              <div className={BAR_LIST}>
                {coaching.weakestCompetencies.map((c: CoachingCompetency) => {
                  const tone = c.avgPercent >= 80 ? "bg-emerald-500" : c.avgPercent >= 60 ? "bg-amber-500" : "bg-red-500";
                  return (
                    <div key={c.key} className={BAR_ROW}>
                      {/* The category rode only in a hover title before; it is printed now. */}
                      <div className={BAR_LABEL}>
                        {c.label}
                        {c.category ? <span className="block text-phx-2xs text-slate-400">{c.category}</span> : null}
                      </div>
                      <div className={BAR_FIGURE}>{Math.round(c.avgPercent)}% · {c.avgScore.toFixed(1)}/5</div>
                      <div className={BAR_TRACK}>
                        <div className={cn("h-full rounded-full", tone)} style={{ width: `${c.avgPercent}%` }} />
                      </div>
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
      // A fall in campaign share is the improvement: 100% regular is the best case.
      goodUp: false,
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

/**
 * One line of Phoenix detail under a double visit — the work, then the proof.
 *
 * The vendor feed carried none of this, so a vendor row returns null and the list reads exactly as it
 * did. A Phoenix row gains what its reader's tier earns, decided server-side in `phoenix-visit-detail.ts`.
 */
function phoenixDoubleVisitLine(event: Employee360Profile["doubleVisits"]["events"][number]): string | null {
  const detail = event.phoenix;
  if (!detail) return null;
  const parts = [
    detail.kindLabel,
    detail.products.length > 0 ? detail.products.join(", ") : null,
    detail.samples,
    detail.availability,
    detail.objection,
    detail.nextStep,
    detail.pharmacyFeedback,
    detail.offPlan,
    detail.location,
    detail.evidence,
    detail.capture,
  ]
    .map((part) => (part ?? "").trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
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
          {/* One column on a phone: three across left ~54px tiles at 375px, labels spilling out. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <KpiTile label="Double-visits received" value={intFmt.format(dv.totalReceived)} hint={`on ${daysWord(dv.daysReceived)}`} />
            <KpiTile label="With Training Manager" value={intFmt.format(dv.tmCount)} hint="TM field coaching" />
            <KpiTile label="Distinct visitors" value={intFmt.format(dv.distinctVisitors)} />
          </div>

          {dv.byVisitor.length > 0 ? (
            <div className="mt-5">
              <div className="mb-1.5 text-xs font-bold text-slate-500">Who accompanied this rep</div>
              <div className="flex flex-wrap gap-2">
                {dv.byVisitor.map((v) => (
                  <span key={v.hrId} className={cn("rounded-full border px-2.5 py-1 text-xs font-semibold", v.isTrainingManager ? "border-indigo-200 bg-indigo-50 text-indigo-700" : "border-slate-200 text-slate-500")}>
                    {v.name ?? NAME_NOT_ON_RECORD} · {v.count}{v.isTrainingManager ? " · TM" : ""}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div className="mt-5">
            <div className="mb-1.5 text-xs font-bold text-slate-500">Recent double-visits{dv.totalReceived > dv.events.length ? ` (latest ${dv.events.length} of ${dv.totalReceived})` : ""}</div>
            <div className={LIST_BOX}>
              {dv.events.map((e, i) => (
                <div key={`${e.date}-${i}`} className={LIST_ROW}>
                  <div className={LIST_DATED}>
                    <span className={LIST_DATE}>{dayLabel(e.date)}</span>
                    <span className="min-w-0 break-words text-slate-800">
                      {namesInWords([e.doubleName ?? NAME_NOT_ON_RECORD, ...(e.double2Name ? [e.double2Name] : []), ...e.otherNames.map((n) => n ?? NAME_NOT_ON_RECORD)])}
                      {e.isTrainingManager ? <span className="ml-1.5 inline-block rounded bg-indigo-100 px-1.5 py-0.5 text-phx-2xs font-bold text-indigo-700">TM</span> : null}
                    </span>
                  </div>
                  <span className={LIST_SIDE}>
                    {e.kind}{e.ampm ? ` · ${e.ampm.toUpperCase()}` : ""}{e.customerName ? ` · ${e.customerName}` : ""}
                    {/* The Phoenix field set, under the cell rather than beside it — this list is already
                        two columns wide at 375px and the fits-the-screen rule says fit by MERGING. What
                        the reader may see was decided on the server; a `distance` reader simply has no
                        accuracy to print. */}
                    {phoenixDoubleVisitLine(e) ? (
                      <span className="block text-phx-2xs font-semibold leading-4 text-slate-400">{phoenixDoubleVisitLine(e)}</span>
                    ) : null}
                  </span>
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
                labels={monthAxisLabels(a.monthly.map((m) => m.month))}
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
                      <span className="min-w-0 break-words text-slate-600">
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
                    <span className="min-w-0 break-words text-slate-600">
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
                    <span className="min-w-0 break-words text-slate-600">{r.name}</span>
                    <span className="shrink-0 text-xs tabular-nums text-slate-400">
                      {r.coachingCount}× · {r.averageScore == null ? "—" : `${Math.round(r.averageScore)}%`}
                      {r.latestCoachingDate ? ` · ${dayLabel(r.latestCoachingDate)}` : ""}
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
  // The team is the Medical Reps AND the district and regional managers beneath this manager
  // (owner, 2026-10-20), so every count here reads "team", never "reps".
  const teamCount = lifecycle.repCount + lifecycle.managerCount;
  return (
    <Card className={PREMIUM_CARD}>
      <SectionHeader
        icon={ClipboardCheck}
        tone="amber"
        sub="The operational health of this manager's team — the Medical Reps and the district and regional managers beneath them: weekly-plan compliance, confirmed field no-activity flags, and who is still inside their 90-day probation."
      >
        Team Compliance — Plans, Field Discipline &amp; Probation
      </SectionHeader>
      {!lifecycle.hasData ? (
        <EmptyState>No Medical Rep, district manager or regional manager rolls up to this manager, so there is no team compliance to show.</EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {/* A failed plan read is "—" with the reason, never a zero nobody measured. */}
            <KpiTile
              label="Plans submitted"
              value={lifecycle.planSubmittedCount == null ? "—" : `${intFmt.format(lifecycle.planSubmittedCount)} / ${intFmt.format(teamCount)}`}
              hint={
                cov == null
                  ? (lifecycle.planUnavailableReason ?? "The weekly plans could not be read just now.")
                  : lifecycle.managerCount > 0
                    ? `${Math.round(cov * 100)}% of ${intFmt.format(lifecycle.repCount)} reps and ${intFmt.format(lifecycle.managerCount)} managers`
                    : `${Math.round(cov * 100)}% of reps`
              }
              goodWhenAbove={cov == null ? null : cov >= 0.6}
            />
            <KpiTile
              label="Plans approved"
              value={lifecycle.planApprovedCount == null ? "—" : intFmt.format(lifecycle.planApprovedCount)}
              hint={lifecycle.planApprovedCount == null ? (lifecycle.planUnavailableReason ?? "The weekly plans could not be read just now.") : undefined}
            />
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
      {/*
        Bound by the owner's fits-the-screen golden rule (AGENTS.md §4): never a horizontal scroll.
        This was `overflow-x-auto` over a `min-w-[440px]` floor, which is the bug the rule names
        explicitly, not the fix — 440px cannot fit a 375px phone, so a manager reading her own
        outstation history had to drag the table sideways to reach the change column.

        Fixed the way the rule prescribes: `table-fixed` with a `<colgroup>`, and the width won
        by MERGING columns rather than shrinking the type. "Cost" and "Cost / trip" were two
        columns saying one thing; they are now one cell, the total above and the per-trip rate
        beneath it. Four columns share 100% of whatever width there is, at any viewport.
      */}
      <table className="w-full table-fixed border-collapse text-sm">
        <colgroup>
          <col className="w-[28%]" />
          <col className="w-[16%]" />
          <col className="w-[30%]" />
          <col className="w-[26%]" />
        </colgroup>
        <thead>
          <tr className="text-phx-xs font-black uppercase tracking-wide text-slate-400">
            <th className="py-1.5 pr-2 text-left align-bottom">Month</th>
            <th className="px-2 py-1.5 text-right align-bottom">Trips</th>
            <th className="px-2 py-1.5 text-right align-bottom">
              Cost
              <span className="block font-black text-slate-300">per trip</span>
            </th>
            <th className="py-1.5 pl-2 text-right align-bottom">Δ cost vs prev</th>
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
                <td className="break-words py-1.5 pr-2 text-left font-semibold tabular-nums text-slate-600">{monthLabel(m.month)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{intFmt.format(m.trips)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  <span className="block font-bold text-slate-800">{compactFmt.format(m.cost)}</span>
                  <span className="block text-phx-xs text-slate-400">{costPerTrip == null ? "—" : compactFmt.format(costPerTrip)}</span>
                </td>
                <td
                  className={cn(
                    "py-1.5 pl-2 text-right font-bold tabular-nums",
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
  );
}

function ExpensesSection({
  expenses,
  activity,
}: {
  expenses: Employee360Profile["expenses"];
  activity: { amVisits: number; pmVisits: number; pharmacyVisits: number; phoenixVisits?: number; regularVisits: number; campaignVisits: number };
}) {
  const { payroll, outstation } = expenses;
  const hasAny = payroll.hasData || outstation.hasData;
  // Never "0" for a rep whose team works in Phoenix CRM, which logs no pharmacy visit.
  const pharmacyTile = pharmacyTileFigure(visitSplitOf(activity), { formatNumber: (value) => intFmt.format(value) });
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
                  <LineChart labels={monthAxisLabels(payroll.monthly.map((m) => m.month))} series={[{ name: "Cost", color: "#f43f5e", points: payroll.monthly.map((m) => m.cost), area: true }]} height={160} yFormat={(n) => compactFmt.format(n)} />
                </div>
              ) : null}

              {payroll.monthly.length > 1 ? <MonthCompareTable months={payroll.monthly} /> : null}

              <div className="mt-5 grid gap-5 sm:grid-cols-2">
                <div>
                  <div className="mb-1.5 text-xs font-bold text-slate-500">Where the money goes</div>
                  <div className={BAR_LIST}>
                    {payroll.categories.map((c) => (
                      <div key={c.key} className={BAR_ROW}>
                        <div className={BAR_LABEL}>{c.label}</div>
                        <div className={BAR_FIGURE}>{compactFmt.format(c.amount)} · {Math.round(c.pct * 100)}%</div>
                        <div className={BAR_TRACK}><div className="h-full rounded-full bg-rose-500/70" style={{ width: `${(c.amount / catMax) * 100}%` }} /></div>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-1.5 text-xs font-bold text-slate-500">Top destinations by cost</div>
                  <div className={BAR_LIST}>
                    {payroll.byDestination.map((d) => (
                      <div key={d.name} className={BAR_ROW}>
                        <div className={BAR_LABEL}>{d.name}</div>
                        <div className={BAR_FIGURE}>{compactFmt.format(d.cost)} · {d.trips}t</div>
                        <div className={BAR_TRACK}><div className="h-full rounded-full bg-amber-500/70" style={{ width: `${(d.cost / destMax) * 100}%` }} /></div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {payroll.unresolvedTrips.length > 0 ? (
                <div className="mt-5 rounded-[14px] border border-amber-200 bg-amber-50/50">
                  <div className="border-b border-amber-200/70 px-3 py-2">
                    <div className="text-xs font-bold text-amber-700">
                      Unresolved trips ({payroll.unresolvedTrips.length})
                    </div>
                    <p className="mt-0.5 text-phx-xs text-slate-500">
                      Travel with no recorded destination — held out of the breakdown and “most expensive trips” above until resolved. A location is never guessed, and home/origin is never shown as a destination. Meetings are separate and need no destination.
                    </p>
                  </div>
                  {payroll.unresolvedTrips.map((t, i) => (
                    <div key={i} className="flex items-start justify-between gap-3 border-b border-amber-200/50 px-3 py-1.5 text-sm last:border-b-0">
                      <div className={LIST_DATED}>
                        <span className={LIST_DATE}>{dayLabel(t.date)}</span>
                        <span className="min-w-0 break-words text-slate-500">{t.type} · no destination recorded</span>
                      </div>
                      <span className={cn(LIST_SIDE, "tabular-nums")}>
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
                <div className={LIST_BOX}>
                  {payroll.topTrips.map((t, i) => (
                    <div key={i} className={LIST_ROW}>
                      <div className={LIST_DATED}>
                        <span className={LIST_DATE}>{dayLabel(t.date)}</span>
                        <span className={LIST_NAME}>{t.destination || (t.type === "Meeting" ? "Meeting" : "—")}</span>
                      </div>
                      <span className={cn(LIST_SIDE, "tabular-nums")}>
                        {compactFmt.format(t.total)}
                        {t.km != null ? ` · ${Math.round(t.km)}km` : ""}
                        {t.transport ? ` · ${t.transport}` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Field activity behind the spend — AM · PM · Pharmacies apart and the Regular vs
                  Campaign visit mix (from the visits system, this period). */}
              <div className="mt-5">
                <div className="mb-1.5 text-xs font-bold text-slate-500">Field activity (visits this period)</div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                  <KpiTile label="AM visits" value={intFmt.format(activity.amVisits)} />
                  <KpiTile label="PM visits" value={intFmt.format(activity.pmVisits)} />
                  <KpiTile label="Pharmacy visits" value={pharmacyTile.value} hint={pharmacyTile.note ?? undefined} />
                  <KpiTile label="Regular visits" value={intFmt.format(activity.regularVisits)} />
                  <KpiTile label="Campaign visits" value={intFmt.format(activity.campaignVisits)} />
                </div>
                <div className="mt-2 text-xs text-slate-400">
                  {/* AM · PM · Pharmacies, three figures apart. A trip stamped before the split carries its
                      pharmacy visits inside AM/PM, so it is named rather than silently read as 0. */}
                  Workload logged on trips: AM {intFmt.format(payroll.amWorkload)} · PM {intFmt.format(payroll.pmWorkload)} · Pharmacies{" "}
                  {payroll.pharmacyWorkload === null || payroll.pharmacyWorkload === undefined
                    ? "not counted separately"
                    : intFmt.format(payroll.pharmacyWorkload)}
                  {payroll.pharmacyWorkload !== null && payroll.pharmacyWorkload !== undefined && (payroll.pharmacyUncountedTrips ?? 0) > 0
                    ? ` (${intFmt.format(payroll.pharmacyUncountedTrips)} earlier ${payroll.pharmacyUncountedTrips === 1 ? "trip carries its" : "trips carry their"} pharmacy visits inside AM and PM)`
                    : null}
                </div>
              </div>
            </>
          ) : null}

          {outstation.hasData ? (
            <div className="mt-5 rounded-[14px] border border-slate-200 p-3.5">
              <div className="mb-2 text-sm font-bold text-slate-800">Outstation requests submitted in Phoenix</div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <KpiTile label="Trips" value={intFmt.format(outstation.tripCount)} />
                <KpiTile label="Claimed" value={compactFmt.format(outstation.claimedTotal)} hint={`expected ${compactFmt.format(outstation.expectedTotal)}`} />
                <KpiTile label="Flagged" value={intFmt.format(outstation.flaggedCount)} goodWhenAbove={!(outstation.flaggedCount > 0)} hint="eligibility or territory issue" />
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
