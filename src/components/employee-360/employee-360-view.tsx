import type { ReactNode } from "react";

import { Card } from "@/components/ui/card";
import { LineChart } from "./charts";
import type {
  CoachingCompetency,
  Employee360Profile,
  ImpactSet,
  SalesMonthPoint,
} from "@/lib/employee-360/deep-service";
import type { Employee360Comparison, MetricDelta } from "@/lib/employee-360/period";

const CHART_COLORS = { regular: "#0ea5e9", campaign: "#f97316", sales: "#10b981", target: "#94a3b8", coverage: "#6366f1" };

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
  const tone =
    goodWhenAbove == null
      ? "text-foreground"
      : goodWhenAbove
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-amber-600 dark:text-amber-400";
  return (
    <div className="rounded-lg border border-border bg-background/50 p-3">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone}`}>{value}</div>
      {benchmark ? <div className="mt-0.5 text-xs text-muted-foreground">vs {benchmark}</div> : null}
      {hint ? <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

function SectionTitle({ children, sub }: { children: ReactNode; sub?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-base font-semibold text-foreground">{children}</h2>
      {sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function SummaryLine({ text }: { text: string }) {
  return <div className="mb-4 rounded-lg border border-border bg-muted/40 p-3 text-sm leading-relaxed text-foreground">{text}</div>;
}

function DeltaChip({ label, delta, kind, goodUp = true }: { label: string; delta: MetricDelta; kind: "int" | "ratio" | "pct"; goodUp?: boolean }) {
  const fmt = (v: number | null) => (v == null ? "—" : kind === "int" ? intFmt.format(Math.round(v)) : kind === "ratio" ? v.toFixed(1) : `${Math.round(v * 100)}%`);
  const rawDelta = delta.cur != null && delta.prev != null ? (kind === "pct" ? (delta.cur - delta.prev) * 100 : delta.cur - delta.prev) : null;
  const tone = rawDelta == null || rawDelta === 0 ? "text-muted-foreground" : (rawDelta > 0) === goodUp ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400";
  const deltaText =
    rawDelta == null ? "—" : `${rawDelta >= 0 ? "▲ +" : "▼ "}${Math.abs(rawDelta) < 10 && kind !== "int" ? rawDelta.toFixed(1) : Math.round(rawDelta)}${kind === "pct" ? "pp" : ""}`;
  return (
    <div className="rounded-lg border border-border bg-background/50 p-2.5">
      <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">{fmt(delta.cur)}</div>
      <div className={`text-[11px] tabular-nums ${tone}`}>
        {deltaText} <span className="text-muted-foreground/70">vs {fmt(delta.prev)}</span>
      </div>
    </div>
  );
}

function ComparisonStrip({ comparison }: { comparison: Employee360Comparison }) {
  return (
    <Card>
      <div className="mb-2 text-xs text-muted-foreground">Period-over-period — this period vs {comparison.previousLabel}</div>
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
function DayOfWeekBars({ counts, title }: { counts: number[]; title: string }) {
  const max = Math.max(1, ...counts);
  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{title}</div>
      <div className="flex items-end gap-1.5" style={{ height: 56 }}>
        {counts.map((c, i) => (
          <div key={i} className="flex flex-1 flex-col items-center gap-1">
            <div className="flex w-full flex-1 items-end">
              <div
                className={`w-full rounded-t ${i === 5 || i === 6 ? "bg-muted-foreground/40" : "bg-sky-500/80"}`}
                style={{ height: `${(c / max) * 100}%` }}
                title={`${c}`}
              />
            </div>
            <span className="text-[10px] text-muted-foreground">{DOW_LABELS[i]}</span>
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
          <div className="w-40 shrink-0 truncate text-xs text-muted-foreground" title={it.label}>{it.label}</div>
          <div className="h-3 flex-1 overflow-hidden rounded bg-muted">
            <div className="h-full bg-indigo-500/70" style={{ width: `${(it.count / max) * 100}%` }} />
          </div>
          <div className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{it.count} · {Math.round(it.pct * 100)}%</div>
        </div>
      ))}
    </div>
  );
}

const balanceCopy: Record<Employee360Profile["campaignBalanceFlag"], { label: string; tone: string }> = {
  healthy: { label: "Balanced", tone: "text-emerald-600 dark:text-emerald-400" },
  campaign_starved: { label: "Campaign-starved", tone: "text-amber-600 dark:text-amber-400" },
  regular_neglect: { label: "Regular-neglect", tone: "text-amber-600 dark:text-amber-400" },
  no_data: { label: "No data", tone: "text-muted-foreground" },
};

const zoneStyle: Record<string, { label: string; tone: string }> = {
  excellence_zone: { label: "Excellence", tone: "text-indigo-600 dark:text-indigo-400" },
  green_zone: { label: "Green", tone: "text-emerald-600 dark:text-emerald-400" },
  yellow_zone: { label: "Yellow", tone: "text-amber-600 dark:text-amber-400" },
  red_zone: { label: "Red", tone: "text-red-600 dark:text-red-400" },
  critical_red: { label: "Critical", tone: "text-red-700 dark:text-red-500" },
};
function zoneOf(zone: string | null) {
  return (zone && zoneStyle[zone]) || { label: zone ?? "—", tone: "text-muted-foreground" };
}

export function Employee360View({
  subject,
  summary,
  comparison,
  showExpenses = true,
}: {
  subject: Employee360Subject;
  summary: Employee360Profile;
  comparison?: Employee360Comparison | null;
  showExpenses?: boolean;
}) {
  const b = summary.benchmarks;
  const tenure = tenureLabel(subject.hireDate);
  const monthlyMax = Math.max(1, ...summary.monthly.map((m) => m.regular + m.campaign));
  const hourMax = Math.max(1, ...summary.hourHistogram);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      {/* Header / identity */}
      <Card className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold text-foreground">{subject.displayName}</h1>
            <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{subject.hrId.toUpperCase()}</span>
            {subject.employmentStatus ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs capitalize text-muted-foreground">
                {subject.employmentStatus.replace(/_/g, " ")}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {[subject.jobTitle, subject.lineName, subject.areaName || subject.regionName].filter(Boolean).join(" · ") || "—"}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {subject.managerName ? `Reports to ${subject.managerName}` : "No manager on record"}
            {tenure ? ` · ${tenure}` : ""}
          </p>
        </div>
        <div className="text-right">
          <div className="text-xs text-muted-foreground">{summary.window.label}</div>
          <div className="text-xs text-muted-foreground">{b.windowLabel}</div>
        </div>
      </Card>

      {/* Trust strip */}
      <div className="flex flex-wrap gap-2 text-xs">
        <TrustChip ok={summary.isMapped} okText="CRM visits linked" badText="No CRM visits linked to this HR_ID" />
        <TrustChip ok={summary.hasGpsCheckins} okText={`${intFmt.format(summary.checkinCount)} GPS check-ins`} badText="No GPS check-ins ever logged" />
        <TrustChip ok={summary.sales.hasData} okText="Sales linked" badText="No validated sales yet" />
        <TrustChip ok={summary.coaching.hasData} okText={`${summary.coaching.reportCount} coaching reports`} badText="Never coached" />
      </div>

      {/* Period-over-period comparison */}
      {comparison ? <ComparisonStrip comparison={comparison} /> : null}

      {/* Module A — visits & coverage */}
      <Card>
        <SectionTitle sub="Productive = Regular + Campaign. Admin/non-visit codes excluded.">Visits &amp; Coverage</SectionTitle>
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
            <DayOfWeekBars counts={summary.dayOfWeek} title="Visits by day of week (Fri/Sat dimmed)" />
            <div className="mt-3 text-xs text-muted-foreground">Single visits {intFmt.format(summary.singleVisits)} · Double visits {intFmt.format(summary.doublesReceived)}</div>
            {summary.topCustomers.length > 0 ? (
              <div className="mt-3">
                <div className="mb-1 text-xs text-muted-foreground">Most-visited customers</div>
                <div className="flex flex-wrap gap-1.5">
                  {summary.topCustomers.map((c) => (
                    <span key={c.name} className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{c.name} · {c.count}</span>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
          <div>
            <div className="mb-1 text-xs text-muted-foreground">Activity mix (all visit types)</div>
            <MixRows items={summary.activityMix} />
          </div>
        </div>
      </Card>

      {/* Campaign vs Regular */}
      <Card>
        <SectionTitle sub="Each month vs the company's SAME-month campaign share (campaign is seasonal).">Campaign vs Regular</SectionTitle>
        <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
          <span>
            Mix: <span className="font-semibold tabular-nums">{pct(summary.regularShare)} regular / {pct(summary.campaignShare)} campaign</span>
          </span>
          <span className="text-muted-foreground">healthy band {Math.round(b.regularShare * 100)}:{Math.round(b.campaignShare * 100)}</span>
          <span className={balanceCopy[summary.campaignBalanceFlag].tone}>● {balanceCopy[summary.campaignBalanceFlag].label}</span>
        </div>
        {summary.monthly.length > 1 ? (
          <div className="mb-5">
            <div className="mb-1 text-xs text-muted-foreground">Monthly visit trend</div>
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
                  <div className="w-16 shrink-0 text-xs text-muted-foreground">{m.month}</div>
                  <div className="flex h-5 flex-1 overflow-hidden rounded bg-muted">
                    <div className="h-full bg-sky-500" style={{ width: `${(m.regular / monthlyMax) * 100}%` }} title={`${m.regular} regular`} />
                    <div className="h-full bg-orange-500" style={{ width: `${(m.campaign / monthlyMax) * 100}%` }} title={`${m.campaign} campaign`} />
                  </div>
                  <div className="w-28 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {intFmt.format(total)} · {pct(m.campaignShare)} camp
                    {m.companyCampaignShare != null ? <span className="text-muted-foreground/70"> (co {Math.round(m.companyCampaignShare * 100)}%)</span> : null}
                  </div>
                </div>
              );
            })}
            <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-sky-500" /> Regular</span>
              <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-orange-500" /> Campaign</span>
            </div>
          </div>
        )}
      </Card>

      {/* Module B — check-in timing & authenticity */}
      <Card>
        <SectionTitle sub="Visit records have no clock time — timing below is from GPS check-ins (check_date). Visit-level intra-day is AM/PM only.">
          Check-in Timing &amp; Authenticity
        </SectionTitle>
        {!summary.hasGpsCheckins ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            No GPS signal ever logged for this employee in the window. Timing and authenticity cannot be assessed — this usually means the mobile app GPS is off, not misconduct.
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
              <div className="mb-1 text-xs text-muted-foreground">Check-in time of day (Cairo) — company peaks 16:00–19:00</div>
              <div className="flex h-24 items-end gap-[2px]">
                {summary.hourHistogram.map((count, hour) => (
                  <div key={hour} className="flex-1 rounded-t bg-indigo-500/80" style={{ height: `${(count / hourMax) * 100}%` }} title={`${hour}:00 — ${count} check-ins`} />
                ))}
              </div>
              <div className="mt-1 flex justify-between text-[10px] text-muted-foreground"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <KpiTile label="Field window" value={`${fmtHourView(summary.avgFirstHour)}–${fmtHourView(summary.avgLastHour)}`} hint={summary.avgSpanHours != null ? `~${summary.avgSpanHours.toFixed(1)}h/day` : undefined} />
              <KpiTile label="Check-ins / active day" value={ratio1(summary.checkinsPerActiveDay)} />
              <KpiTile label="Uncorroborated days" value={intFmt.format(summary.uncorroboratedDays)} goodWhenAbove={!(summary.uncorroboratedDays > 5)} hint="visit days with no GPS" />
              <KpiTile label="Distinct locations" value={intFmt.format(summary.distinctLocations)} hint="GPS points (~110m)" />
            </div>

            <div className="mt-5 grid gap-5 sm:grid-cols-2">
              <DayOfWeekBars counts={summary.dayOfWeek} title="Check-ins by day of week (Fri/Sat dimmed)" />
              <div>
                <div className="mb-1 text-xs text-muted-foreground">GPS coverage by month</div>
                <LineChart
                  labels={summary.coverageTrend.map((m) => m.month.slice(5))}
                  series={[{ name: "Coverage", color: CHART_COLORS.coverage, points: summary.coverageTrend.map((m) => (m.coverage == null ? null : m.coverage * 100)), area: true }]}
                  height={150}
                  yMax={100}
                  yFormat={(n) => `${Math.round(n)}%`}
                />
              </div>
            </div>

            <div className="mt-4 text-xs text-muted-foreground">
              Visit AM/PM split (self-reported): <span className="font-medium text-foreground">{intFmt.format(summary.amVisits)} AM / {intFmt.format(summary.pmVisits)} PM</span>
              {summary.unknownAmpm > 0 ? ` · ${intFmt.format(summary.unknownAmpm)} unmarked` : ""}
            </div>
          </>
        )}
      </Card>

      {/* Sales & Achievement */}
      <SalesSection sales={summary.sales} />

      {/* Expenses & Outstation — hidden for Medical Reps (expense analysis is a
          manager view: DM / RM / NSM / TM / PM / GPM). */}
      {showExpenses && (
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
      )}

      {/* Coaching */}
      <CoachingSection coaching={summary.coaching} />

      {/* Impact — before/after */}
      <ImpactSection impact={summary.impact} />

      {/* Double-visit history */}
      <DoubleVisitSection dv={summary.doubleVisits} />

      <p className="px-1 text-[11px] text-muted-foreground">
        Employee 360 · consolidated profile. Coaching is a single-rater signal (the Training Manager); sales lags visits ~2 months and covers ~2/3 of reps — light pillars are shown as coverage states, never a punishing zero. Benchmarks are company 2026 YTD averages.
      </p>
    </div>
  );
}

function SalesSection({ sales }: { sales: Employee360Profile["sales"] }) {
  return (
    <Card>
      <SectionTitle sub={sales.isTeamRollup ? "Team roll-up — the sum of this manager's reps' sales vs target. Sales lag visits ~2 months." : "Actual sell-in vs target. Values are period-stamped — sales lag visits ~2 months."}>
        Sales &amp; Achievement{sales.isTeamRollup ? " (Team)" : ""}
      </SectionTitle>
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
              <div className="mb-1 text-xs text-muted-foreground">Sales vs target trend</div>
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
              <div className="text-xs text-muted-foreground">Monthly achievement (bar = achievement %, capped at 150%)</div>
              {sales.monthly.slice(-12).map((m: SalesMonthPoint) => {
                const achv = m.achievementPct ?? 0;
                const width = Math.min(150, achv) / 1.5; // % of bar
                const tone = achv >= 100 ? "bg-emerald-500" : achv >= 70 ? "bg-amber-500" : "bg-red-500";
                return (
                  <div key={m.month} className="flex items-center gap-3">
                    <div className="w-16 shrink-0 text-xs text-muted-foreground">{m.month}</div>
                    <div className="h-4 flex-1 overflow-hidden rounded bg-muted">
                      <div className={`h-full ${tone}`} style={{ width: `${width}%` }} />
                    </div>
                    <div className="w-32 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      {pctPoints(m.achievementPct)} · {compactFmt.format(m.sales)}/{compactFmt.format(m.target)}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
          {sales.topProducts.length > 0 ? (
            <div className="mt-5">
              <div className="mb-1 text-xs text-muted-foreground">Top products by sales</div>
              <div className="overflow-hidden rounded-lg border border-border">
                {sales.topProducts.map((p) => (
                  <div key={p.product} className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 text-sm last:border-b-0">
                    <span className="truncate text-foreground">{p.product}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{compactFmt.format(p.sales)} · {pctPoints(p.achievementPct)}</span>
                  </div>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">Confidential product masking for non-executive viewers is a pending hardening step.</p>
            </div>
          ) : null}
          {sales.byFamily.length > 1 ? (
            <div className="mt-5">
              <div className="mb-1 text-xs text-muted-foreground">Achievement by product family</div>
              <div className="space-y-1.5">
                {sales.byFamily.slice(0, 6).map((f) => {
                  const achv = f.achievementPct ?? 0;
                  const tone = achv >= 100 ? "bg-emerald-500" : achv >= 70 ? "bg-amber-500" : "bg-red-500";
                  return (
                    <div key={f.family} className="flex items-center gap-3">
                      <div className="w-40 shrink-0 truncate text-xs text-muted-foreground" title={f.family}>{f.family}</div>
                      <div className="h-3 flex-1 overflow-hidden rounded bg-muted"><div className={`h-full ${tone}`} style={{ width: `${Math.min(150, achv) / 1.5}%` }} /></div>
                      <div className="w-28 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{pctPoints(f.achievementPct)} · {compactFmt.format(f.sales)}</div>
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
    <Card>
      <SectionTitle sub="Received coaching (double-visit assessments). Single-rater signal — read as guidance, not objective truth.">Coaching</SectionTitle>
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
              <div className="mb-1 text-xs text-muted-foreground">Score progression{coaching.coachNames.length ? ` · coach: ${coaching.coachNames.join(", ")}` : ""}</div>
              <div className="flex flex-wrap gap-2">
                {coaching.reports.map((r, i) => {
                  const z = zoneOf(r.zone);
                  return (
                    <div key={`${r.date}-${i}`} className="rounded-lg border border-border px-3 py-2 text-center">
                      <div className={`text-lg font-semibold tabular-nums ${z.tone}`}>{pctPoints(r.finalScorePercent)}</div>
                      <div className="text-[10px] text-muted-foreground">{r.date}</div>
                      <div className={`text-[10px] ${z.tone}`}>{z.label}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {coaching.weakestCompetencies.length > 0 ? (
            <div className="mt-5">
              <div className="mb-1 text-xs text-muted-foreground">Weakest competencies (avg across reports, worst first)</div>
              <div className="space-y-1.5">
                {coaching.weakestCompetencies.map((c: CoachingCompetency) => {
                  const tone = c.avgPercent >= 80 ? "bg-emerald-500" : c.avgPercent >= 60 ? "bg-amber-500" : "bg-red-500";
                  return (
                    <div key={c.key} className="flex items-center gap-3">
                      <div className="w-48 shrink-0 truncate text-xs text-muted-foreground" title={`${c.label} · ${c.category}`}>{c.label}</div>
                      <div className="h-3 flex-1 overflow-hidden rounded bg-muted">
                        <div className={`h-full ${tone}`} style={{ width: `${c.avgPercent}%` }} />
                      </div>
                      <div className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{Math.round(c.avgPercent)}% · {c.avgScore.toFixed(1)}/5</div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {coaching.reports[coaching.reports.length - 1]?.areaOfDevelopment ? (
            <p className="mt-4 text-xs text-muted-foreground"><span className="font-medium text-foreground">Latest area of development:</span> {coaching.reports[coaching.reports.length - 1].areaOfDevelopment}</p>
          ) : null}
        </>
      )}
    </Card>
  );
}

function BeforeAfterBlock({ title, set }: { title: string; set: ImpactSet }) {
  if (set.eventCount === 0) {
    return (
      <div className="rounded-lg border border-border p-3">
        <div className="text-sm font-medium text-foreground">{title}</div>
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
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-baseline justify-between">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="text-[11px] text-muted-foreground">{set.eventCount} event{set.eventCount === 1 ? "" : "s"} · ±{set.windowDays}d windows</div>
      </div>
      <div className="mt-2 space-y-1.5">
        {rows.map((r) => {
          const deltaTone = r.delta == null ? "text-muted-foreground" : (r.delta >= 0) === r.goodUp ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400";
          const deltaText = r.delta == null ? "—" : `${r.delta >= 0 ? "▲ +" : "▼ "}${Math.abs(r.delta) < 10 ? r.delta.toFixed(1) : Math.round(r.delta)}`;
          return (
            <div key={r.label} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">{r.label}</span>
              <span className="tabular-nums">
                <span className="text-muted-foreground">{r.before}</span>
                <span className="mx-1 text-muted-foreground">→</span>
                <span className="font-medium text-foreground">{r.after}</span>
                <span className={`ml-2 text-xs ${deltaTone}`}>{deltaText}</span>
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-2 text-[11px] text-muted-foreground">
        Sample: {set.before.sampleVisits} visits before / {set.after.sampleVisits} after
      </div>
    </div>
  );
}

function ImpactSection({ impact }: { impact: Employee360Profile["impact"] }) {
  const anything = impact.coaching.eventCount > 0 || impact.trainingDv.eventCount > 0;
  return (
    <Card>
      <SectionTitle sub={`Field activity in the ${impact.windowDays} days BEFORE vs AFTER each intervention. Directional — read with sample sizes.`}>
        Before / After Impact
      </SectionTitle>
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
    <Card>
      <SectionTitle sub="Every visit where a manager accompanied this rep. TM = Training Manager.">Double-Visit History</SectionTitle>
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
              <div className="mb-1 text-xs text-muted-foreground">Who accompanied this rep</div>
              <div className="flex flex-wrap gap-2">
                {dv.byVisitor.map((v) => (
                  <span key={v.hrId} className={`rounded-full border px-2.5 py-1 text-xs ${v.isTrainingManager ? "border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300" : "border-border text-muted-foreground"}`}>
                    {v.name ?? v.hrId.toUpperCase()} · {v.count}{v.isTrainingManager ? " · TM" : ""}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div className="mt-5">
            <div className="mb-1 text-xs text-muted-foreground">Recent double-visits{dv.totalReceived > dv.events.length ? ` (latest ${dv.events.length} of ${dv.totalReceived})` : ""}</div>
            <div className="overflow-hidden rounded-lg border border-border">
              {dv.events.map((e, i) => (
                <div key={`${e.date}-${i}`} className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 text-sm last:border-b-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="w-20 shrink-0 text-xs text-muted-foreground">{e.date}</span>
                    <span className="truncate text-foreground">{e.doubleName ?? e.doubleHrId.toUpperCase()}</span>
                    {e.isTrainingManager ? <span className="shrink-0 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300">TM</span> : null}
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">{e.kind}{e.ampm ? ` · ${e.ampm.toUpperCase()}` : ""}{e.customerName ? ` · ${e.customerName}` : ""}</span>
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
    <Card>
      <SectionTitle sub="Outstation trips & reimbursed expenses (payroll import). Most relevant to travelling managers — DM / NSM / TM / PM / GPM.">
        Expenses &amp; Outstation
      </SectionTitle>
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
                  <div className="mb-1 text-xs text-muted-foreground">By expense type</div>
                  <div className="flex flex-wrap gap-1.5">
                    {payroll.byType.map((b) => (
                      <span key={b.type} className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground">
                        {b.type}: {intFmt.format(b.trips)} · {compactFmt.format(b.cost)}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                <span className="text-muted-foreground">Approval:</span>
                <span className="text-emerald-600 dark:text-emerald-400">✓ {intFmt.format(payroll.approvedCount)} approved</span>
                <span className="text-amber-600 dark:text-amber-400">✗ {intFmt.format(payroll.rejectedCount)} rejected</span>
                <span className="text-muted-foreground">◷ {intFmt.format(payroll.pendingCount)} pending</span>
              </div>

              {payroll.monthly.length > 1 ? (
                <div className="mt-5">
                  <div className="mb-1 text-xs text-muted-foreground">Monthly spend trend</div>
                  <LineChart labels={payroll.monthly.map((m) => m.month.slice(5))} series={[{ name: "Cost", color: "#f43f5e", points: payroll.monthly.map((m) => m.cost), area: true }]} height={160} yFormat={(n) => compactFmt.format(n)} />
                </div>
              ) : null}

              <div className="mt-5 grid gap-5 sm:grid-cols-2">
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">Where the money goes</div>
                  <div className="space-y-1.5">
                    {payroll.categories.map((c) => (
                      <div key={c.key} className="flex items-center gap-3">
                        <div className="w-32 shrink-0 truncate text-xs text-muted-foreground">{c.label}</div>
                        <div className="h-3 flex-1 overflow-hidden rounded bg-muted"><div className="h-full bg-rose-500/70" style={{ width: `${(c.amount / catMax) * 100}%` }} /></div>
                        <div className="w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{compactFmt.format(c.amount)} · {Math.round(c.pct * 100)}%</div>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">Top destinations by cost</div>
                  <div className="space-y-1.5">
                    {payroll.byDestination.map((d) => (
                      <div key={d.name} className="flex items-center gap-3">
                        <div className="w-32 shrink-0 truncate text-xs text-muted-foreground" title={d.name}>{d.name}</div>
                        <div className="h-3 flex-1 overflow-hidden rounded bg-muted"><div className="h-full bg-amber-500/70" style={{ width: `${(d.cost / destMax) * 100}%` }} /></div>
                        <div className="w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{compactFmt.format(d.cost)} · {d.trips}t</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {payroll.unresolvedTrips.length > 0 ? (
                <div className="mt-5 overflow-hidden rounded-lg border border-amber-300/60 bg-amber-50/50 dark:bg-amber-950/20">
                  <div className="border-b border-amber-300/40 px-3 py-2">
                    <div className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                      Unresolved trips ({payroll.unresolvedTrips.length})
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      Travel with no recorded destination — held out of the breakdown and “most expensive trips” above until resolved. A location is never guessed, and home/origin is never shown as a destination. Meetings are separate and need no destination.
                    </p>
                  </div>
                  {payroll.unresolvedTrips.map((t, i) => (
                    <div key={i} className="flex items-center justify-between gap-3 border-b border-amber-300/30 px-3 py-1.5 text-sm last:border-b-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="w-20 shrink-0 text-xs text-muted-foreground">{t.date}</span>
                        <span className="truncate text-muted-foreground">{t.type} · no destination recorded</span>
                      </div>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
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
                  <div className="mb-1 text-xs text-muted-foreground">Transport</div>
                  <div className="flex flex-wrap gap-1.5">
                    {payroll.transportMix.map((t) => (
                      <span key={t.name} className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{t.name} · {t.trips}t · {compactFmt.format(t.cost)}</span>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="mt-5">
                <div className="mb-1 text-xs text-muted-foreground">Most expensive trips</div>
                <div className="overflow-hidden rounded-lg border border-border">
                  {payroll.topTrips.map((t, i) => (
                    <div key={i} className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 text-sm last:border-b-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="w-20 shrink-0 text-xs text-muted-foreground">{t.date}</span>
                        <span className="truncate text-foreground">{t.destination || (t.type === "Meeting" ? "Meeting" : "—")}</span>
                      </div>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
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
                <div className="mb-1 text-xs text-muted-foreground">Field activity (visits this period)</div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <KpiTile label="AM visits" value={intFmt.format(activity.amVisits)} hint={activity.unknownAmpm > 0 ? `${intFmt.format(activity.unknownAmpm)} unmarked` : undefined} />
                  <KpiTile label="PM visits" value={intFmt.format(activity.pmVisits)} />
                  <KpiTile label="Regular visits" value={intFmt.format(activity.regularVisits)} />
                  <KpiTile label="Campaign visits" value={intFmt.format(activity.campaignVisits)} />
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  Workload logged on trips: {intFmt.format(payroll.amWorkload)} AM · {intFmt.format(payroll.pmWorkload)} PM
                </div>
              </div>
            </>
          ) : null}

          {outstation.hasData ? (
            <div className="mt-5 rounded-lg border border-border p-3">
              <div className="mb-2 text-sm font-medium text-foreground">System-submitted outstation (GPS-verified)</div>
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
  return (
    <span
      className={
        ok
          ? "rounded-full border border-emerald-300 bg-emerald-50 px-2 py-1 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
          : "rounded-full border border-amber-300 bg-amber-50 px-2 py-1 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
      }
    >
      {ok ? "✓ " : "! "}
      {ok ? okText : badText}
    </span>
  );
}
