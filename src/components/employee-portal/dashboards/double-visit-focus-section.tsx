import { ArrowRight } from "lucide-react";

import {
  LandingBar,
  LandingCta,
  LandingEmpty,
  LandingFigure,
  LandingMeta,
  LandingPanel,
} from "@/components/employee-portal/landing-kit";
import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";
import type {
  DoubleVisitFocusProbationEntry,
  DoubleVisitFocusTrendPoint,
  DoubleVisitPortalFocus,
  DoubleVisitScopeFocus,
} from "@/lib/double-visit-analytics/types";

// The double-visit focus — the trend, the scope's coverage and the probation watchlist — in the
// landing language (owner, 2026-11-20 redesign): three white panels with the tick title, the bars in
// navy ink rather than orange (orange is the title tick and the navy board's line, never a fill),
// every list a set of ruled rows, and the report link the one navy button at each panel's foot.

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
  });
}

/** The panel's foot: the one action, right-aligned on a hairline. */
function PanelFoot({ href, children, variant = "outline" }: { href: string; children: React.ReactNode; variant?: "outline" | "solid" }) {
  return (
    <div className="flex justify-end border-t border-slate-200 px-3 py-2.5 sm:px-4">
      <LandingCta href={href} variant={variant}>
        {children}
        <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
      </LandingCta>
    </div>
  );
}

function DvTrendBlock({ trend, reportHref }: { trend: DoubleVisitFocusTrendPoint[]; reportHref: string }) {
  const max = Math.max(1, ...trend.map((point) => point.count));
  const total = trend.reduce((sum, point) => sum + point.count, 0);
  return (
    <LandingPanel title="Your Double-Visit Trend">
      {total === 0 ? (
        <LandingEmpty>You haven&apos;t logged a double visit since {trend[0]?.label ?? "tracking began"}.</LandingEmpty>
      ) : (
        // FITS THE SCREEN. This used to be a fixed 44px-per-month floor inside an overflow-x-auto
        // band: at 375px the nine months needed 436px, so the three most recent — the only ones a
        // rep is likely to care about — sat off the right edge behind a scrollbar nobody looks for.
        // `overflow-x-auto` over a min-width floor IS the bug the owner's rule names, not the fix
        // (AGENTS.md §4), and it is invisible to a scrollWidth check on `main`, which read 351/351
        // throughout. The columns now SHARE the width instead of claiming it: each one flexes, and
        // the 44px cap keeps the bars looking exactly as they did wherever there is room for them.
        <div className="px-3 pb-3 pt-4 sm:px-4">
          <div className="flex items-end justify-between gap-1.5 sm:gap-4">
            {trend.map((point) => (
              <div key={point.month} className="flex min-w-0 flex-1 flex-col items-center gap-2 sm:max-w-[44px]">
                <span className="text-phx-sm font-bold leading-none tabular-nums text-[#08111f]">{point.count}</span>
                <div className="flex h-24 w-full items-end bg-slate-100">
                  <div
                    className="w-full bg-[#08111f]"
                    style={{ height: `${Math.max(point.count > 0 ? 6 : 0, Math.round((point.count / max) * 100))}%` }}
                  />
                </div>
                {/* Wraps to "Jul" / "26" in a narrow column rather than running out of the card.
                    Never truncated — the month is the whole point of the label. */}
                <span className="break-words text-center text-phx-xs font-bold uppercase leading-tight tracking-[0.08em] text-slate-500">
                  {point.label}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      <PanelFoot href={`${reportHref}?tab=log&visitor=me`}>View full visit log</PanelFoot>
    </LandingPanel>
  );
}

/** The coverage scale: under 40% rose, under 70% amber, 70% and up emerald. */
function coverageFill(pct: number): string {
  return pct < 40 ? "bg-rose-500" : pct < 70 ? "bg-amber-400" : "bg-emerald-500";
}

/**
 * The share of the scope covered — the one figure the Scope Focus panel exists to show. It was a
 * ring, and before that a ring whose percentage was drawn WHITE ON WHITE: the panel's body is
 * white, so for as long as it shipped the figure simply was not there. It is now the landing's own
 * figure and bar: the number in navy ink, the colour on the bar beneath it, the 100% mark at its end.
 */
function CoverageFigure({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const whole = Math.round(clamped);
  return (
    <div aria-label={`${whole} percent of your scope covered`} role="img">
      <LandingFigure unit="% covered">{whole}</LandingFigure>
      <div className="mt-3">
        <LandingBar fill={coverageFill(clamped)} pct={clamped} />
      </div>
    </div>
  );
}

function ScopeFocusPanel({
  periodFrom,
  periodTo,
  scope,
  reportHref,
}: {
  periodFrom: string;
  periodTo: string;
  scope: DoubleVisitScopeFocus;
  reportHref: string;
}) {
  return (
    <LandingPanel right={<LandingMeta items={[`${formatDate(periodFrom)} – ${formatDate(periodTo)}`]} />} title="Scope Focus">
      <div className="border-b border-slate-200 px-3 py-4 sm:px-4">
        <CoverageFigure pct={scope.coveragePct ?? 0} />
        <p className="mt-3 break-words text-phx-sm leading-snug text-slate-600">{scope.summarySentence}</p>
      </div>

      {/* No rule under the counts when no list follows: the foot's own hairline closes them. */}
      <div className={`grid grid-cols-2 divide-x divide-slate-200 ${scope.neglected.length > 0 ? "border-b border-slate-200" : ""}`}>
        <div className="min-w-0 px-3 py-2.5 sm:px-4">
          <p className="text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500">Covered</p>
          <p className="mt-1 text-[22px] font-bold leading-none tracking-[-0.02em] tabular-nums text-emerald-700">{scope.coveredCount}</p>
        </div>
        <div className="min-w-0 px-3 py-2.5 sm:px-4">
          <p className="text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500">Neglected</p>
          <p className="mt-1 text-[22px] font-bold leading-none tracking-[-0.02em] tabular-nums text-rose-700">{scope.neglectedCount}</p>
        </div>
      </div>

      {scope.neglected.length > 0 && (
        <ul>
          {scope.neglected.map((entry) => (
            <li key={entry.hrId} className="flex min-w-0 items-center gap-3 border-b border-slate-200 px-3 py-2.5 last:border-b-0 sm:px-4">
              {/* A flagged colleague carries the rose rail; everyone else a quiet one, so the rows align. */}
              <span aria-hidden="true" className={`w-1 shrink-0 self-stretch ${entry.flagged ? "bg-rose-500" : "bg-slate-200"}`} />
              <p className="min-w-0 flex-1 break-words text-phx-md font-bold leading-snug text-[#08111f]" dir="auto">
                {entry.name}
              </p>
              <span
                className={`shrink-0 text-right text-phx-xs font-bold uppercase tracking-[0.08em] ${
                  entry.flagged ? "text-rose-700" : "text-slate-500"
                }`}
              >
                {entry.daysSinceHire != null ? `${entry.daysSinceHire}d since hire` : "hire date unknown"}
              </span>
            </li>
          ))}
          {scope.neglectedTruncated && (
            <li className="px-3 py-2.5 text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500 sm:px-4">
              +{scope.neglectedCount - scope.neglected.length} more in the full report
            </li>
          )}
        </ul>
      )}

      <PanelFoot href={`${reportHref}?tab=neglected`} variant="solid">
        Open Double Visit Report
      </PanelFoot>
    </LandingPanel>
  );
}

/** Where a probationer stands on the double visit, as ink on the row's right — never a filled badge. */
function ProbationDvState({ entry }: { entry: DoubleVisitFocusProbationEntry }) {
  if (entry.dvDone === null) {
    return (
      <span className="shrink-0 text-right text-phx-md font-bold tabular-nums text-[#08111f]">
        {entry.dvCount} DV{entry.dvCount === 1 ? "" : "s"}
      </span>
    );
  }
  return (
    <span
      className={`shrink-0 text-right text-phx-xs font-bold uppercase tracking-[0.08em] ${
        entry.dvDone ? "text-emerald-700" : "text-rose-700"
      }`}
    >
      {entry.dvDone ? "DV done" : "DV pending"}
    </span>
  );
}

function ProbationWatchlistBlock({
  probation,
  probationTruncated,
  reportHref,
}: {
  probation: DoubleVisitFocusProbationEntry[];
  probationTruncated: boolean;
  reportHref: string;
}) {
  return (
    <LandingPanel title="Probation Watchlist">
      {probation.length === 0 ? (
        <LandingEmpty>No one in your scope is currently on probation.</LandingEmpty>
      ) : (
        <ul>
          {probation.map((entry) => (
            <li key={entry.hrId} className="flex min-w-0 items-center gap-3 border-b border-slate-200 px-3 py-2.5 last:border-b-0 sm:px-4">
              <span
                aria-hidden="true"
                className={`w-1 shrink-0 self-stretch ${entry.dvDone === false ? "bg-rose-500" : entry.dvDone ? "bg-emerald-500" : "bg-slate-200"}`}
              />
              <div className="min-w-0 flex-1">
                <p className="break-words text-phx-md font-bold leading-snug text-[#08111f]" dir="auto">
                  {entry.name}
                </p>
                <p className="mt-0.5 break-words text-phx-xs tabular-nums text-slate-500">
                  Hired {formatDate(entry.hireDate)} · {entry.daysRemaining > 0 ? `${entry.daysRemaining}d left` : "ending"}
                </p>
              </div>
              <ProbationDvState entry={entry} />
            </li>
          ))}
          {probationTruncated && (
            <li className="border-t border-slate-200 px-3 py-2.5 text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500 sm:px-4">
              More in the full report
            </li>
          )}
        </ul>
      )}
      <PanelFoot href={`${reportHref}?tab=probation`}>Open Double Visit Report</PanelFoot>
    </LandingPanel>
  );
}

export function DoubleVisitFocusSection({ focus }: { focus: DoubleVisitPortalFocus | null }) {
  if (!focus) return null;
  return (
    <>
      <DvTrendBlock reportHref={focus.reportHref} trend={focus.trend} />
      {focus.scope && (
        <ScopeFocusPanel
          periodFrom={focus.periodFrom}
          periodTo={focus.periodTo}
          reportHref={focus.reportHref}
          scope={focus.scope}
        />
      )}
      <ProbationWatchlistBlock
        probation={focus.probation}
        probationTruncated={focus.probationTruncated}
        reportHref={focus.reportHref}
      />
    </>
  );
}
