import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Building2,
  Minus,
  ShieldAlert,
  Stethoscope,
  Target,
  TrendingUp,
  Users,
} from "lucide-react";

import { egp } from "@/components/employee-portal/portal-command-center";
import type { AccessContext } from "@/lib/auth/permissions";
import { buildCoachingReportAnalytics } from "@/lib/coaching/analytics";
import { getCoachingReports } from "@/lib/coaching/service";
import { getDoubleVisitDashboardData } from "@/lib/double-visit-analytics/service";
import { getEmployeePortalVacancies } from "@/lib/employee-portal/service";
import { getSalesMarketingDashboard } from "@/lib/sales-marketing-intelligence/service";
import { loadPortalClosingTrend, loadPortalMonthlyClosing } from "@/lib/sales/monthly-closing-portal";
import { salesPacing, type AchievementBand } from "@/lib/employee-portal/rsm-home-summary";

/* ── Shared shells (premium skin: slate-900 header + orange rule, square corners) ── */

function Shell({ title, icon: Icon, children }: { title: string; icon: typeof Activity; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden border border-slate-200">
      <div className="flex items-center justify-between gap-3 bg-slate-900 px-4 py-3 sm:px-5">
        <h2 className="flex min-w-0 items-center gap-2 break-words text-phx-xs font-bold uppercase tracking-widest text-slate-300">
          <Icon className="h-3.5 w-3.5 shrink-0 text-orange-400" />
          {title}
        </h2>
        <div className="h-1.5 w-12 shrink-0 bg-orange-500" />
      </div>
      {children}
    </div>
  );
}

function StatGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-px bg-slate-200 sm:grid-cols-3">{children}</div>;
}

function Stat({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  tone?: "default" | "danger";
}) {
  return (
    <div className="bg-white px-4 py-3">
      <p className="text-phx-xs font-medium uppercase tracking-wider text-slate-500 whitespace-nowrap">{label}</p>
      <p className={`mt-1 text-xl font-bold whitespace-nowrap ${tone === "danger" ? "text-rose-600" : "text-slate-900"}`}>{value}</p>
      {sub ? <div className="mt-0.5">{sub}</div> : null}
    </div>
  );
}

/** Honest in-section notice: a failed/empty source must read as such, never as a real zero. */
function Note({ children, tone = "info" }: { children: React.ReactNode; tone?: "info" | "warn" }) {
  const cls = tone === "warn" ? "border-amber-200 bg-amber-50 text-amber-800" : "bg-white text-slate-500";
  return (
    <p className={`flex items-center gap-2 px-5 py-5 text-sm ${cls}`}>
      {tone === "warn" ? <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" /> : null}
      {children}
    </p>
  );
}

/** vs-last-period delta pill in percentage points. up = good for coverage. */
function DeltaPts({ value, goodWhenUp = true }: { value: number | null; goodWhenUp?: boolean }) {
  if (value == null || value === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-phx-xs font-medium text-slate-400 whitespace-nowrap">
        <Minus className="h-3 w-3" /> vs last period
      </span>
    );
  }
  const up = value > 0;
  const good = up === goodWhenUp;
  const tone = good ? "text-emerald-600" : "text-rose-600";
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-1 text-phx-xs font-semibold whitespace-nowrap ${tone}`}>
      <Icon className="h-3 w-3" />
      {Math.abs(value)} pts vs last period
    </span>
  );
}

export function MmSectionSkeleton({ title }: { title: string }) {
  return (
    <div className="overflow-hidden border border-slate-200">
      <div className="flex items-center justify-between gap-3 bg-slate-900 px-4 py-3 sm:px-5">
        <h2 className="min-w-0 break-words text-phx-xs font-bold uppercase tracking-widest text-slate-300">{title}</h2>
        <div className="h-1.5 w-12 shrink-0 bg-slate-700" />
      </div>
      <div className="grid grid-cols-1 gap-px bg-slate-200 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="bg-white px-4 py-5">
            <div className="h-3 w-20 animate-pulse bg-slate-100" />
            <div className="mt-2 h-5 w-16 animate-pulse bg-slate-100" />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Line ROI vs Spend (line-scoped, confidential-excluded in the RPC) ── */

export async function MmRoiSection({ access }: { access: AccessContext }) {
  let snapshot;
  try {
    snapshot = await getSalesMarketingDashboard(access);
  } catch {
    return (
      <Shell title="Line ROI vs Spend" icon={TrendingUp}>
        <Note tone="warn">Couldn&apos;t load ROI intelligence right now — refresh to try again.</Note>
      </Shell>
    );
  }

  const s = snapshot.summary;
  const trend = snapshot.roiTrend;
  const noSpend = s.marketingRequestCount === 0 || s.requiredRoiValue === 0;
  if (noSpend) {
    return (
      <Shell title="Line ROI vs Spend" icon={TrendingUp}>
        <Note>No marketing spend tracked for your line yet.</Note>
      </Shell>
    );
  }

  const coveragePct = Math.round((s.actualRoiCoverage ?? 0) * 100);
  const pointCoverage = (p: (typeof trend)[number] | undefined) =>
    p && p.requiredRoiValue > 0 ? p.actualSalesValue / p.requiredRoiValue : null;
  const prev = trend.length >= 2 ? pointCoverage(trend[trend.length - 2]) : null;
  const curr = trend.length >= 1 ? pointCoverage(trend[trend.length - 1]) : null;
  const deltaPts = prev != null && curr != null ? Math.round((curr - prev) * 100) : null;

  return (
    <Shell title="Line ROI vs Spend" icon={TrendingUp}>
      <StatGrid>
        <Stat
          label="ROI coverage"
          value={`${coveragePct}%`}
          sub={trend.length >= 2 ? <DeltaPts value={deltaPts} goodWhenUp /> : <span className="text-phx-xs text-slate-400 whitespace-nowrap">no prior period</span>}
        />
        <Stat label="Spend at risk" value={egp(s.spendAtRisk)} tone="danger" />
        <Stat label="Coverage gap" value={egp(s.coverageGap)} />
      </StatGrid>
    </Shell>
  );
}

/* ── Field Activity Health — exceptions first (coaching + double-visit) ── */

export async function MmFieldHealthSection({ access }: { access: AccessContext }) {
  const [coaching, dv] = await Promise.all([
    getCoachingReports({}, access)
      .then((rows) => buildCoachingReportAnalytics(rows))
      .catch(() => null),
    getDoubleVisitDashboardData({ access }).catch(() => null),
  ]);

  const dvReady = !!dv && dv.schemaReady;
  const neglected = dvReady ? dv.executiveReports.reduce((sum, r) => sum + (r.neglectedMrCount ?? 0), 0) : null;
  const mappedVisits = dvReady ? dv.kpis.activeMappedVisitCount : null;
  const avgCoaching = coaching && coaching.coachingCount > 0 ? `${Math.round(coaching.averageScore)}%` : "—";

  return (
    <Shell title="Field Activity Health" icon={Activity}>
      {dv && !dv.schemaReady ? <Note tone="warn">Double-visit analytics not yet configured — visit metrics unavailable.</Note> : null}
      <StatGrid>
        <Stat
          label="Neglected reps"
          value={neglected == null ? "—" : String(neglected)}
          tone={neglected && neglected > 0 ? "danger" : "default"}
          sub={<span className="inline-flex items-center gap-1 text-phx-xs text-slate-400 whitespace-nowrap"><ShieldAlert className="h-3 w-3" /> no double-visit cover</span>}
        />
        <Stat
          label="Avg coaching score"
          value={avgCoaching}
          sub={coaching ? <span className="inline-flex items-center gap-1 text-phx-xs text-slate-400 whitespace-nowrap"><Stethoscope className="h-3 w-3" /> {coaching.coachingCount} reports</span> : undefined}
        />
        <Stat
          label="Mapped visits (mo)"
          value={mappedVisits == null ? "—" : String(mappedVisits)}
          sub={<span className="inline-flex items-center gap-1 text-phx-xs text-slate-400 whitespace-nowrap"><Target className="h-3 w-3" /> this month</span>}
        />
      </StatGrid>
    </Shell>
  );
}

/* ── Line Sales Pacing (published monthly closing, confidential-stripped at source) ── */

const PACING_INK: Record<AchievementBand, string> = {
  met: "text-emerald-600",
  near: "text-amber-600",
  behind: "text-orange-600",
  far: "text-rose-600",
};

/**
 * The viewer's published closing, month by month (premium pass, 9 Nov 2026; docs/rsm-home.md).
 *
 * The figures are the published Monthly Closing's, scoped exactly as `loadPortalClosingTrend`
 * scopes them: the whole line for a National Sales Manager or a Marketing Manager, the region's
 * areas for a Regional Manager, the district's for a District Manager. So the caller names the scope
 * in `title`; "Line" on a Regional Manager's region figures was the wrong word.
 *
 * `salesPacing` (rsm-home-summary.ts) decides every word: the latest month is named, the change is a
 * percent of the named month before (never "pts"), and each month carries its sales and its
 * achievement under the bar, so a phone needs no hover to read it.
 */
export async function LineSalesPacingSection({ access, title = "Line Sales Pacing" }: { access: AccessContext; title?: string }) {
  let monthly: Awaited<ReturnType<typeof loadPortalMonthlyClosing>>;
  let trend: Awaited<ReturnType<typeof loadPortalClosingTrend>>;
  try {
    [monthly, trend] = await Promise.all([
      loadPortalMonthlyClosing({ access }),
      loadPortalClosingTrend({ access, maxMonths: 4 }),
    ]);
  } catch {
    return (
      <Shell title={title} icon={BarChart3}>
        <Note tone="warn">Couldn&apos;t load sales pacing right now — refresh to try again.</Note>
      </Shell>
    );
  }

  if (!monthly.line) {
    return (
      <Shell title={title} icon={BarChart3}>
        <Note>No line mapped to your profile — contact an administrator.</Note>
      </Shell>
    );
  }
  const pacing = salesPacing(trend);
  if (monthly.awaitingPublish || pacing.state === "empty") {
    return (
      <Shell title={title} icon={BarChart3}>
        <Note>No Monthly Closing is published for {monthly.line} yet, so there is nothing to pace against.</Note>
      </Shell>
    );
  }

  const { latest, months, change } = pacing;
  const changeInk =
    change == null ? "text-slate-500" : change.direction === "up" ? "text-emerald-600" : change.direction === "down" ? "text-rose-600" : "text-slate-600";
  const ChangeIcon = change == null ? Minus : change.direction === "up" ? ArrowUpRight : change.direction === "down" ? ArrowDownRight : Minus;

  return (
    <Shell title={title} icon={BarChart3}>
      <div className="grid grid-cols-1 gap-px bg-slate-200 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="min-w-0 bg-white px-4 py-4 sm:px-5">
          <p className="break-words text-phx-xs font-bold uppercase tracking-widest text-slate-500">{pacing.headline}</p>
          <p className="mt-1 break-words text-2xl font-black leading-tight tabular-nums text-slate-900">{latest.salesText}</p>
          <p className={`mt-1 break-words text-sm font-semibold ${latest.band ? PACING_INK[latest.band] : "text-slate-500"}`}>
            {pacing.targetText}
          </p>
          {change ? (
            <p className={`mt-2 flex items-center gap-1 text-sm font-semibold ${changeInk}`}>
              <ChangeIcon className="h-4 w-4 shrink-0" />
              <span className="min-w-0 break-words">{change.text}</span>
            </p>
          ) : (
            <p className="mt-2 break-words text-phx-sm text-slate-500">{pacing.changeNote}</p>
          )}
          <p className="mt-3 break-words text-phx-xs font-medium text-slate-400">
            {monthly.line} · published closings only
          </p>
        </div>
        <div className="min-w-0 bg-white px-4 py-4 sm:px-5">
          <p className="break-words text-phx-xs font-bold uppercase tracking-widest text-slate-500">
            {months.length === 1 ? "The published month" : `The last ${months.length} published months`}
          </p>
          <div className="mt-3 grid gap-2" style={{ gridTemplateColumns: `repeat(${months.length}, minmax(0, 1fr))` }}>
            {months.map((month) => (
              <div key={month.period} className="flex min-w-0 flex-col">
                <div className="flex h-16 items-end bg-slate-50">
                  <div
                    className={`w-full ${month.latest ? "bg-orange-500" : "bg-slate-300"}`}
                    style={{ height: `${month.barHeight}%` }}
                  />
                </div>
                <p className={`mt-1.5 text-phx-xs font-black uppercase tracking-wide ${month.latest ? "text-slate-900" : "text-slate-500"}`}>
                  {month.label}
                </p>
                <p className="break-words text-phx-xs font-semibold tabular-nums text-slate-700">{month.salesText}</p>
                <p className={`break-words text-phx-xs font-semibold ${month.band ? PACING_INK[month.band] : "text-slate-400"}`}>
                  {month.achievementText}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Shell>
  );
}

/* ── My Line People (line-scoped vacancies — a signal MM is genuinely authorized to see) ── */

export async function MmPeopleSection({ access }: { access: AccessContext }) {
  const vacancies = await getEmployeePortalVacancies(access).catch(() => null);

  if (!vacancies) {
    return (
      <Shell title="My Line People" icon={Users}>
        <Note>No vacancy data for your scope.</Note>
      </Shell>
    );
  }

  const { summary } = vacancies;
  return (
    <Shell title="My Line People" icon={Users}>
      <StatGrid>
        <Stat
          label="Open vacancies"
          value={String(summary.openVacancies)}
          tone={summary.openVacancies > 0 ? "danger" : "default"}
          sub={<span className="inline-flex items-center gap-1 text-phx-xs text-slate-400 whitespace-nowrap"><Building2 className="h-3 w-3" /> {summary.totalAreas} areas</span>}
        />
        <Stat
          label="DSM seats vacant"
          value={String(summary.districtManagerVacancies)}
          tone={summary.districtManagerVacancies > 0 ? "danger" : "default"}
        />
        <Stat label="Total vacancies" value={String(summary.totalVacancies)} />
      </StatGrid>
    </Shell>
  );
}
