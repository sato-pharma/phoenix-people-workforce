import { AlertTriangle, ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

import { egp } from "@/components/employee-portal/portal-command-center";
import {
  LANDING_NAVY_TILE,
  LandingBar,
  LandingEmpty,
  LandingMeta,
  LandingNavyBoard,
  LandingPanel,
  landingTone,
} from "@/components/employee-portal/landing-kit";
import type { AccessContext } from "@/lib/auth/permissions";
import { buildCoachingReportAnalytics } from "@/lib/coaching/analytics";
import { getCoachingReports } from "@/lib/coaching/service";
import { getDoubleVisitDashboardData } from "@/lib/double-visit-analytics/service";
import { getEmployeePortalVacancies } from "@/lib/employee-portal/service";
import { getSalesMarketingDashboard } from "@/lib/sales-marketing-intelligence/service";
import { loadPortalClosingTrend, loadPortalMonthlyClosing } from "@/lib/sales/monthly-closing-portal";
import { salesPacing, type AchievementBand } from "@/lib/employee-portal/rsm-home-summary";

/* ── The parts (the landing kit's language: white panels with a tick title, one navy board) ── */

/**
 * One figure in a white intel panel. In a narrow panel it is a ROW — label left, figure right, the
 * quiet line under the label — so three figures read as three short lines on a 280px phone rather
 * than three tall tiles. From 36rem of PANEL width the three stand side by side as columns, the
 * figure under its label and the quiet line under the figure. One markup does both: a two-track
 * grid whose figure spans both rows, folding to one track at `@xl`.
 */
function IntelFigure({ label, value, sub, tone }: { label: string; value: string; sub?: string | null; tone?: string }) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 bg-white px-3 py-3 sm:px-4 @xl:grid-cols-1 @xl:items-start">
      <p className="break-words text-phx-sm font-bold uppercase tracking-[0.08em] text-slate-500">{label}</p>
      <p
        className={`row-span-2 max-w-[11rem] break-words text-right text-[22px] font-bold leading-none tracking-[-0.02em] tabular-nums @xl:row-span-1 @xl:mt-2 @xl:max-w-none @xl:text-left @xl:text-[28px] ${tone ?? "text-[#08111f]"}`}
      >
        {value}
      </p>
      {sub ? <p className="mt-1 break-words text-phx-xs leading-snug text-slate-400 @xl:mt-2">{sub}</p> : null}
    </div>
  );
}

/** Three figures, hairlines between them. The grid is keyed to the PANEL's width, never the window's. */
function IntelFigures({ children }: { children: React.ReactNode }) {
  return (
    <div className="@container">
      <div className="grid grid-cols-1 gap-px bg-slate-200 @xl:grid-cols-3">{children}</div>
    </div>
  );
}

/**
 * Honest in-section notice: a failed/empty source must read as such, never as a real zero. `warn`
 * is a source that could not be read (an amber rail and its sign); plain is a source with nothing in
 * it, which is the kit's calm empty line.
 */
function Note({ children, tone = "info", onNavy = false }: { children: React.ReactNode; tone?: "info" | "warn"; onNavy?: boolean }) {
  if (tone !== "warn") return <LandingEmpty onNavy={onNavy}>{children}</LandingEmpty>;
  return (
    <p
      className={`flex items-start gap-2 break-words border-l-2 border-amber-500 px-3 py-3 text-phx-sm leading-snug sm:px-4 ${
        onNavy ? "text-white/70" : "bg-amber-50 text-amber-900"
      }`}
    >
      <AlertTriangle aria-hidden="true" className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${onNavy ? "text-amber-300" : "text-amber-600"}`} />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/**
 * One tile on the ROI board: a step lighter than the navy, the label in small capitals, the figure
 * white. Colour rides on the 2px rail and the small words only, never on the figure — the rule of the
 * Medical Rep's month board, so the two boards read alike.
 */
function RoiTile({ label, rail, children, foot }: { label: string; rail?: string; children: React.ReactNode; foot?: React.ReactNode }) {
  return (
    <div className={`relative flex min-w-0 flex-col border border-white/[0.08] p-3 pl-3.5 ${LANDING_NAVY_TILE}`}>
      <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-0.5 ${rail ?? "bg-white/15"}`} />
      <span className="break-words text-phx-sm font-bold uppercase tracking-[0.1em] text-white/65">{label}</span>
      <div className="mt-3">{children}</div>
      {foot ? <div className="mt-auto pt-3">{foot}</div> : null}
    </div>
  );
}

/** A money figure on the board: white, tight, and allowed to wrap after its currency on a phone. */
function RoiMoney({ value }: { value: number }) {
  return <span className="block break-words text-[26px] font-bold leading-none tracking-[-0.02em] tabular-nums text-white">{egp(value)}</span>;
}

/** vs-last-period change in percentage points of ROI coverage. up = good for coverage. */
function DeltaPts({ value, goodWhenUp = true }: { value: number | null; goodWhenUp?: boolean }) {
  if (value == null || value === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-phx-xs font-bold text-white/45">
        <Minus aria-hidden="true" className="h-3 w-3 shrink-0" /> vs last period
      </span>
    );
  }
  const up = value > 0;
  const good = up === goodWhenUp;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-1 text-phx-xs font-bold ${good ? "text-emerald-300" : "text-rose-300"}`}>
      <Icon aria-hidden="true" className="h-3 w-3 shrink-0" />
      {Math.abs(value)} pts vs last period
    </span>
  );
}

/** The ROI board's three tiles, keyed to the BOARD's width: stacked on a phone, three across from 32rem. */
function RoiTiles({ children }: { children: React.ReactNode }) {
  return (
    <div className="@container">
      <div className="grid grid-cols-1 gap-2 @lg:grid-cols-3">{children}</div>
    </div>
  );
}

export function MmSectionSkeleton({ title }: { title: string }) {
  return (
    <LandingPanel title={title}>
      <div aria-busy="true" className="@container">
        <span className="sr-only">Loading</span>
        <div aria-hidden="true" className="grid grid-cols-1 gap-px bg-slate-200 @xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="bg-white px-3 py-3 sm:px-4">
              <div className="employee-portal-skeleton h-3 w-20" />
              <div className="employee-portal-skeleton mt-2.5 h-[22px] w-16" />
            </div>
          ))}
        </div>
      </div>
    </LandingPanel>
  );
}

/** The ROI board's loading shape: the board itself, its three tiles shimmering where the figures go. */
export function MmRoiBoardSkeleton() {
  return (
    <LandingNavyBoard label="Line ROI vs Spend">
      <div aria-busy="true">
        <span className="sr-only">Loading</span>
        <RoiTiles>
          {["ROI coverage", "Spend at risk", "Coverage gap"].map((label) => (
            <RoiTile key={label} label={label}>
              <div aria-hidden="true" className="employee-portal-skeleton h-[26px] w-24 opacity-20" />
            </RoiTile>
          ))}
        </RoiTiles>
      </div>
    </LandingNavyBoard>
  );
}

/* ── Line ROI vs Spend (line-scoped, confidential-excluded in the RPC) ──
   The Marketing Manager's headline figures, so this is the ONE night-navy board on that landing
   (owner, 2026-11-20 redesign). It is drawn on no other landing. */

export async function MmRoiSection({ access }: { access: AccessContext }) {
  let snapshot;
  try {
    snapshot = await getSalesMarketingDashboard(access);
  } catch {
    return (
      <LandingNavyBoard label="Line ROI vs Spend">
        <Note onNavy tone="warn">Couldn&apos;t load ROI intelligence right now — refresh to try again.</Note>
      </LandingNavyBoard>
    );
  }

  const s = snapshot.summary;
  const trend = snapshot.roiTrend;
  const noSpend = s.marketingRequestCount === 0 || s.requiredRoiValue === 0;
  if (noSpend) {
    return (
      <LandingNavyBoard label="Line ROI vs Spend">
        <Note onNavy>No marketing spend tracked for your line yet.</Note>
      </LandingNavyBoard>
    );
  }

  const coveragePct = Math.round((s.actualRoiCoverage ?? 0) * 100);
  const pointCoverage = (p: (typeof trend)[number] | undefined) =>
    p && p.requiredRoiValue > 0 ? p.actualSalesValue / p.requiredRoiValue : null;
  const prev = trend.length >= 2 ? pointCoverage(trend[trend.length - 2]) : null;
  const curr = trend.length >= 1 ? pointCoverage(trend[trend.length - 1]) : null;
  const deltaPts = prev != null && curr != null ? Math.round((curr - prev) * 100) : null;
  const coverageTone = landingTone(coveragePct);

  return (
    <LandingNavyBoard label="Line ROI vs Spend">
      <RoiTiles>
        <RoiTile
          foot={
            trend.length >= 2 ? (
              <DeltaPts value={deltaPts} goodWhenUp />
            ) : (
              <span className="text-phx-xs font-bold text-white/45">no prior period</span>
            )
          }
          label="ROI coverage"
          rail={coverageTone.onNavyFill}
        >
          <span className="flex flex-wrap items-baseline gap-x-1">
            <span className="text-[28px] font-bold leading-none tracking-[-0.02em] tabular-nums text-white">{coveragePct}</span>
            <span className="text-phx-sm font-bold text-white/45">%</span>
          </span>
          {/* Coverage reads against 100% — the spend fully earned back — so its bar carries the mark. */}
          <div className="mt-3">
            <LandingBar onNavy pct={coveragePct} />
          </div>
        </RoiTile>
        <RoiTile label="Spend at risk" rail={s.spendAtRisk > 0 ? "bg-rose-400" : undefined}>
          <RoiMoney value={s.spendAtRisk} />
        </RoiTile>
        <RoiTile label="Coverage gap">
          <RoiMoney value={s.coverageGap} />
        </RoiTile>
      </RoiTiles>
    </LandingNavyBoard>
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
    <LandingPanel title="Field Activity Health">
      {dv && !dv.schemaReady ? <Note tone="warn">Double-visit analytics not yet configured — visit metrics unavailable.</Note> : null}
      <IntelFigures>
        <IntelFigure
          label="Neglected reps"
          sub="no double-visit cover"
          tone={neglected && neglected > 0 ? "text-rose-700" : undefined}
          value={neglected == null ? "—" : String(neglected)}
        />
        <IntelFigure label="Avg coaching score" sub={coaching ? `${coaching.coachingCount} reports` : null} value={avgCoaching} />
        <IntelFigure label="Mapped visits (mo)" sub="this month" value={mappedVisits == null ? "—" : String(mappedVisits)} />
      </IntelFigures>
    </LandingPanel>
  );
}

/* ── Line Sales Pacing (published monthly closing, confidential-stripped at source) ── */

/** The band's ink on white — the landing kit's tone scale, so a red here means what it means elsewhere. */
const PACING_INK: Record<AchievementBand, string> = {
  met: "text-emerald-700",
  near: "text-amber-700",
  behind: "text-orange-700",
  far: "text-rose-700",
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
 *
 * Drawn on four landings, so it is always a WHITE panel: the District, Regional and National
 * managers' night-navy board is their own team figures, and a landing holds one board. The line and
 * "published closings only" are the header's chips, not a sentence under it (owner, 2026-11-20).
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
      <LandingPanel title={title}>
        <Note tone="warn">Couldn&apos;t load sales pacing right now — refresh to try again.</Note>
      </LandingPanel>
    );
  }

  if (!monthly.line) {
    return (
      <LandingPanel title={title}>
        <Note>No line mapped to your profile — contact an administrator.</Note>
      </LandingPanel>
    );
  }
  const pacing = salesPacing(trend);
  if (monthly.awaitingPublish || pacing.state === "empty") {
    return (
      <LandingPanel title={title}>
        <Note>No Monthly Closing is published for {monthly.line} yet, so there is nothing to pace against.</Note>
      </LandingPanel>
    );
  }

  const { latest, months, change } = pacing;
  const changeInk =
    change == null ? "text-slate-500" : change.direction === "up" ? "text-emerald-700" : change.direction === "down" ? "text-rose-700" : "text-slate-600";
  const ChangeIcon = change == null ? Minus : change.direction === "up" ? ArrowUpRight : change.direction === "down" ? ArrowDownRight : Minus;

  return (
    <LandingPanel right={<LandingMeta items={[monthly.line, "Published closings only"]} />} title={title}>
      <div className="@container">
        <div className="grid grid-cols-1 gap-px bg-slate-200 @2xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div className="min-w-0 bg-white px-3 py-4 sm:px-4">
            <p className="break-words text-phx-sm font-bold uppercase tracking-[0.08em] text-slate-500">{pacing.headline}</p>
            <p className="mt-2.5 break-words text-[28px] font-bold leading-none tracking-[-0.02em] tabular-nums text-[#08111f]">
              {latest.salesText}
            </p>
            <p className={`mt-2 break-words text-phx-sm font-bold tabular-nums ${latest.band ? PACING_INK[latest.band] : "text-slate-500"}`}>
              {pacing.targetText}
            </p>
            {change ? (
              <p className={`mt-3 flex items-center gap-1.5 border-t border-slate-200 pt-3 text-phx-sm font-bold ${changeInk}`}>
                <ChangeIcon aria-hidden="true" className="h-4 w-4 shrink-0" />
                <span className="min-w-0 break-words">{change.text}</span>
              </p>
            ) : (
              <p className="mt-3 break-words border-t border-slate-200 pt-3 text-phx-sm leading-snug text-slate-500">{pacing.changeNote}</p>
            )}
          </div>
          <div className="min-w-0 bg-white px-3 py-4 sm:px-4">
            <p className="break-words text-phx-sm font-bold uppercase tracking-[0.08em] text-slate-500">
              {months.length === 1 ? "The published month" : `The last ${months.length} published months`}
            </p>
            {/* Flat bars on a common baseline: the latest month in navy ink, the ones before it in
                slate. No orange fill — orange is the title tick on a landing and nothing else. */}
            <div className="mt-3 grid gap-2" style={{ gridTemplateColumns: `repeat(${months.length}, minmax(0, 1fr))` }}>
              {months.map((month) => (
                <div key={month.period} className="flex min-w-0 flex-col">
                  <div className="flex h-20 items-end border-b border-[#08111f]/60 bg-slate-50">
                    <div
                      className={`w-full ${month.latest ? "bg-[#08111f]" : "bg-slate-300"}`}
                      style={{ height: `${month.barHeight}%` }}
                    />
                  </div>
                  <p className={`mt-2 break-words text-phx-xs font-black uppercase tracking-[0.08em] ${month.latest ? "text-[#08111f]" : "text-slate-500"}`}>
                    {month.label}
                  </p>
                  <p className="mt-0.5 break-words text-phx-xs font-bold tabular-nums text-[#08111f]">{month.salesText}</p>
                  <p className={`break-words text-phx-xs font-bold ${month.band ? PACING_INK[month.band] : "text-slate-400"}`}>
                    {month.achievementText}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </LandingPanel>
  );
}

/* ── My Line People (line-scoped vacancies — a signal MM is genuinely authorized to see) ── */

export async function MmPeopleSection({ access }: { access: AccessContext }) {
  const vacancies = await getEmployeePortalVacancies(access).catch(() => null);

  if (!vacancies) {
    return (
      <LandingPanel title="My Line People">
        <Note>No vacancy data for your scope.</Note>
      </LandingPanel>
    );
  }

  const { summary } = vacancies;
  return (
    <LandingPanel title="My Line People">
      <IntelFigures>
        <IntelFigure
          label="Open vacancies"
          sub={`${summary.totalAreas} areas`}
          tone={summary.openVacancies > 0 ? "text-rose-700" : undefined}
          value={String(summary.openVacancies)}
        />
        <IntelFigure
          label="DSM seats vacant"
          tone={summary.districtManagerVacancies > 0 ? "text-rose-700" : undefined}
          value={String(summary.districtManagerVacancies)}
        />
        <IntelFigure label="Total vacancies" value={String(summary.totalVacancies)} />
      </IntelFigures>
    </LandingPanel>
  );
}
