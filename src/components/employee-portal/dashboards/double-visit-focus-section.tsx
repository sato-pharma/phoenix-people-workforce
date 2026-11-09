import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2, Target } from "lucide-react";

import { cn } from "@/lib/utils";
import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";
import type {
  DoubleVisitFocusProbationEntry,
  DoubleVisitFocusTrendPoint,
  DoubleVisitPortalFocus,
  DoubleVisitScopeFocus,
} from "@/lib/double-visit-analytics/types";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
  });
}

function DvTrendBlock({ trend, reportHref }: { trend: DoubleVisitFocusTrendPoint[]; reportHref: string }) {
  const max = Math.max(1, ...trend.map((point) => point.count));
  const total = trend.reduce((sum, point) => sum + point.count, 0);
  return (
    <div className={`overflow-hidden border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
      <div className="flex items-center justify-between bg-slate-900 px-5 py-3">
        <h2 className="text-phx-sm font-bold uppercase tracking-widest text-slate-300">Your Double-Visit Trend</h2>
        <div className="h-1.5 w-12 bg-orange-500" />
      </div>
      {total === 0 ? (
        <p className="px-5 py-6 text-sm text-slate-500">You haven&apos;t logged a double visit since {trend[0]?.label ?? "tracking began"}.</p>
      ) : (
        // FITS THE SCREEN. This used to be a fixed 44px-per-month floor inside an overflow-x-auto
        // band: at 375px the nine months needed 436px, so the three most recent — the only ones a
        // rep is likely to care about — sat off the right edge behind a scrollbar nobody looks for.
        // `overflow-x-auto` over a min-width floor IS the bug the owner's rule names, not the fix
        // (AGENTS.md §4), and it is invisible to a scrollWidth check on `main`, which read 351/351
        // throughout. The columns now SHARE the width instead of claiming it: each one flexes, and
        // the 44px cap keeps the bars looking exactly as they did wherever there is room for them.
        <div className="px-5 pb-2 pt-5 sm:px-6">
          <div className="flex items-end justify-between gap-1.5 sm:gap-4">
            {trend.map((point) => (
              <div key={point.month} className="flex min-w-0 flex-1 flex-col items-center gap-2 sm:max-w-[44px]">
                <span className="text-sm font-black text-slate-900">{point.count}</span>
                <div className="flex h-24 w-full items-end bg-slate-100">
                  <div
                    className="w-full bg-orange-500"
                    style={{ height: `${Math.max(point.count > 0 ? 6 : 0, Math.round((point.count / max) * 100))}%` }}
                  />
                </div>
                {/* Wraps to "Jul" / "26" in a narrow column rather than running out of the card.
                    Never truncated — the month is the whole point of the label. */}
                <span className="break-words text-center text-phx-sm font-semibold uppercase leading-tight tracking-widest text-slate-400">
                  {point.label}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      <Link
        href={`${reportHref}?tab=log&visitor=me`}
        className="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-xs font-bold uppercase tracking-wider text-orange-600 transition-colors hover:bg-orange-50"
      >
        View full visit log
        <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  );
}

function CoverageRing({ pct }: { pct: number }) {
  const radius = 46;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, pct));
  const dash = (clamped / 100) * circumference;
  const color = clamped < 40 ? "#F43F5E" : clamped < 70 ? "#F59E0B" : "#10B981";
  return (
    <svg viewBox="0 0 120 120" className="h-28 w-28 shrink-0" role="img" aria-label={`${Math.round(clamped)} percent of your scope covered`}>
      {/* The unfilled part of the ring. Slate-200, because this ring sits on a WHITE card
          (ScopeFocusPanel's body) — the near-black it used to be read as a second, competing
          ring rather than as the space left to cover. */}
      <circle cx="60" cy="60" r={radius} fill="none" stroke="#e2e8f0" strokeWidth="10" />
      <circle
        cx="60"
        cy="60"
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={`${dash} ${circumference}`}
        transform="rotate(-90 60 60)"
      />
      {/* WHITE ON WHITE: this number was invisible on every screen it has ever rendered on.
          The ring's card body is bg-white, so the coverage percentage — the one figure the whole
          panel exists to show — simply was not there. Slate-900 to match every other headline
          number in the portal. */}
      <text x="60" y="58" textAnchor="middle" fontSize="24" fontWeight="900" fill="#0f172a">
        {Math.round(clamped)}%
      </text>
      <text x="60" y="75" textAnchor="middle" fontSize="9" fill="#94a3b8" letterSpacing="1.5">
        COVERED
      </text>
    </svg>
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
    <div className="overflow-hidden shadow-[0_4px_24px_rgba(0,0,0,0.08)]">
      <div className="relative flex items-center justify-between bg-[#0b1f3a] px-4 py-3 sm:px-6 sm:py-4">
        <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-[#f47b20]/60 via-[#f47b20]/20 to-transparent" />
        <div className="flex items-center gap-3">
          <span className="inline-block h-4 w-[3px] bg-[#f47b20]" />
          <div>
            <h2 className="text-phx-xs font-black uppercase tracking-[0.22em] text-white">Scope Focus</h2>
            <p className="mt-0.5 text-phx-xs font-semibold uppercase tracking-wider text-white/40">
              {formatDate(periodFrom)} – {formatDate(periodTo)}
            </p>
          </div>
        </div>
        <Target className="h-4 w-4 text-[#f47b20]/60" />
      </div>

      <div className="bg-white p-4 sm:p-6">
        <div className="flex flex-col items-center gap-4 border-b border-slate-100 pb-5 sm:flex-row sm:gap-6">
          <CoverageRing pct={scope.coveragePct ?? 0} />
          <div className="flex-1 text-center sm:text-left">
            <p className="text-sm font-semibold leading-snug text-slate-800">{scope.summarySentence}</p>
            <div className="mt-3 flex justify-center gap-4 sm:justify-start">
              <span className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-600">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                {scope.coveredCount} covered
              </span>
              <span className="inline-flex items-center gap-1.5 text-xs font-bold text-rose-600">
                <span className="h-2 w-2 rounded-full bg-rose-500" />
                {scope.neglectedCount} neglected
              </span>
            </div>
          </div>
        </div>

        {scope.neglected.length > 0 && (
          <div className="mt-4 space-y-1.5">
            {scope.neglected.map((entry) => (
              <div
                key={entry.hrId}
                className={cn(
                  "flex items-center justify-between gap-3 border px-3 py-2",
                  entry.flagged ? "border-rose-200 bg-rose-50" : "border-slate-200 bg-slate-50",
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  {entry.flagged && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-500" />}
                  <p className="break-words text-xs font-semibold leading-snug text-slate-800">{entry.name}</p>
                </div>
                <span
                  className={cn(
                    "shrink-0 text-phx-sm font-bold uppercase tracking-wider",
                    entry.flagged ? "text-rose-600" : "text-slate-400",
                  )}
                >
                  {entry.daysSinceHire != null ? `${entry.daysSinceHire}d since hire` : "hire date unknown"}
                </span>
              </div>
            ))}
            {scope.neglectedTruncated && (
              <p className="pt-1 text-center text-phx-sm font-semibold uppercase tracking-wider text-slate-400">
                +{scope.neglectedCount - scope.neglected.length} more in the full report
              </p>
            )}
          </div>
        )}
      </div>

      <Link
        href={`${reportHref}?tab=neglected`}
        className="group flex items-center justify-between bg-[#0b1f3a] px-4 py-3 text-xs font-bold uppercase tracking-wider text-white transition-colors hover:bg-[#0d2547] sm:px-6"
      >
        Open Double Visit Report
        <ArrowRight className="h-3.5 w-3.5 text-[#f47b20] transition-transform group-hover:translate-x-1" />
      </Link>
    </div>
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
    <div className="overflow-hidden border border-slate-200">
      <div className="flex items-center justify-between bg-slate-900 px-5 py-3">
        <h2 className="text-phx-sm font-bold uppercase tracking-widest text-slate-300">Probation Watchlist</h2>
        <div className="h-1.5 w-12 bg-orange-500" />
      </div>
      {probation.length === 0 ? (
        <p className="bg-white px-5 py-6 text-sm text-slate-500">No one in your scope is currently on probation.</p>
      ) : (
        <div className="divide-y divide-slate-100 bg-white">
          {probation.map((entry) => (
            <div key={entry.hrId} className="flex items-center justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <p className="break-words text-sm font-semibold leading-snug text-slate-900">{entry.name}</p>
                <p className="text-phx-xs text-slate-500">
                  Hired {formatDate(entry.hireDate)} · {entry.daysRemaining > 0 ? `${entry.daysRemaining}d left` : "ending"}
                </p>
              </div>
              {entry.dvDone === null ? (
                <span className="shrink-0 whitespace-nowrap text-xs font-bold text-slate-700">
                  {entry.dvCount} DV{entry.dvCount === 1 ? "" : "s"}
                </span>
              ) : entry.dvDone ? (
                <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap border border-emerald-200 bg-emerald-50 px-2 py-1 text-phx-sm font-bold uppercase text-emerald-700">
                  <CheckCircle2 className="h-3 w-3" /> DV done
                </span>
              ) : (
                <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap border border-rose-200 bg-rose-50 px-2 py-1 text-phx-sm font-bold uppercase text-rose-700">
                  <AlertTriangle className="h-3 w-3" /> DV pending
                </span>
              )}
            </div>
          ))}
          {probationTruncated && (
            <p className="px-5 py-2 text-center text-phx-sm font-semibold uppercase tracking-wider text-slate-400">
              More in the full report
            </p>
          )}
        </div>
      )}
      <Link
        href={`${reportHref}?tab=probation`}
        className="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-xs font-bold uppercase tracking-wider text-orange-600 transition-colors hover:bg-orange-50"
      >
        Open Double Visit Report
        <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </div>
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
