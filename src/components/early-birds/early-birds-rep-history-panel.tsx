import Link from "next/link";
import { AlertTriangle, CalendarRange, Clock, Sunrise, Trophy, X } from "lucide-react";

import { SectionHead, rankChipClass } from "@/components/employee-portal/portal-command-center";
import type { EarlyBirdsRepHistory } from "@/lib/early-birds/history";
import type { EarlyBirdsPeriod } from "@/lib/early-birds/period";
import type { EarlyBirdsRepProfile, EarlyBirdsRepScore } from "@/lib/early-birds/types";
import {
  formatDayShort,
  formatPercent,
  formatPeriodChip,
  formatPoints,
  formatStartClock,
  formatStartDelta,
  startTierClass,
  startTierLabel,
} from "./early-birds-format";
import { earlyBirdsHref } from "./early-birds-links";

// ONE REP, ACROSS FORTNIGHTS — the panel the owner asked for on 2026-09-18:
//
//   "what if a medical rep wants to see his history in early birds? what if a manager wants to see
//    his team or a medical rep in his team — when does he start?"
//
// Two different questions, and they need two different sections, which is why this panel is not
// just a longer table:
//
//   * WHEN DOES HE START — a per-DAY answer, and only for the fortnight on screen. A median is an
//     average of a habit; "he was at his first doctor at 11:40 on the 3rd" is the thing a manager
//     acts on. That is the timeline strip, straight off the live ranking.
//   * HIS HISTORY — a per-FORTNIGHT answer, over as long as the module has existed. That is the
//     record table, read from frozen snapshots (see lib/early-birds/history.ts for why frozen).
//
// The rep is reached by `?rep=`, and the page validates him against the district roster it just
// authorised — a viewer can never open a rep outside the district he is already allowed to read.

const REASON_LABEL: Record<string, string> = {
  insufficient_active_days: "Too few active days",
  insufficient_period_coverage: "Joined mid-fortnight",
  no_start_time_evidence: "No start time recorded",
  not_active_at_period_end: "Not active at period end",
  no_submissions: "No visits submitted",
};

function reasonText(reasons: readonly string[]): string {
  return reasons.map((reason) => REASON_LABEL[reason] ?? reason).join(" · ");
}

/** A labelled number in the summary strip. Square, hairline-separated, wraps. */
function Stat({
  icon: Icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: typeof Clock;
  label: string;
  value: string;
  sub?: string;
  accent: string;
}) {
  return (
    <div className="relative min-w-0 bg-white px-4 py-3">
      <span className={`absolute inset-x-0 top-0 h-[3px] ${accent}`} />
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center bg-slate-900 text-white">
          <Icon className="h-3 w-3" />
        </span>
        <p className="min-w-0 break-words text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-400">
          {label}
        </p>
      </div>
      <p className="mt-2 break-words text-lg font-black leading-tight tabular-nums text-slate-900">{value}</p>
      {sub ? <p className="break-words text-phx-2xs font-medium leading-snug text-slate-500">{sub}</p> : null}
    </div>
  );
}

/** The fortnight on screen, day by day. THE answer to "when does he start". */
function DayTimeline({ score, period }: { score: EarlyBirdsRepScore; period: EarlyBirdsPeriod }) {
  if (score.timeline.length === 0) {
    return (
      <p className="bg-white px-4 py-4 text-sm text-slate-500">
        No day of {period.label} has a verified start time for this rep yet.
      </p>
    );
  }

  return (
    <div className="bg-white px-4 py-4 sm:px-5">
      {/* auto-fit over a 46px floor: the cells WRAP to a second row rather than scrolling
          sideways, which is the only remedy the fits-the-screen golden rule allows. */}
      <div className="grid gap-px [grid-template-columns:repeat(auto-fit,minmax(46px,1fr))]">
        {score.timeline.map((day) => (
          <div
            key={day.dateIso}
            className="min-w-0 border border-slate-200"
            title={`${formatDayShort(day.dateIso)} — ${startTierLabel(day.startMinutes, day.expectedWeight)}`}
          >
            <div className={`h-[3px] ${startTierClass(day.startMinutes, day.expectedWeight)}`} />
            <div className="px-1 py-1.5 text-center">
              <p className="text-phx-3xs font-black uppercase tracking-wide text-slate-400">
                {Number(day.dateIso.slice(8, 10))}
              </p>
              <p className="break-words text-phx-2xs font-black tabular-nums text-slate-900">
                {day.startMinutes === null ? "—" : formatStartClock(day.startMinutes)}
              </p>
              {day.wonDay ? (
                <p className="text-phx-3xs font-black uppercase tracking-wide text-amber-600">1st</p>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 break-words text-phx-2xs font-semibold text-slate-500">
        Green is before 09:00, amber 09:00-10:00, orange after 10:00. A grey cell is a day with no
        GPS check-in — worked, but with no verified start; it is never read as late.
      </p>
    </div>
  );
}

export function EarlyBirdsRepHistoryPanel({
  history,
  profile,
  name,
  score,
  period,
  basePath,
  district,
}: {
  history: EarlyBirdsRepHistory;
  profile: EarlyBirdsRepProfile | null;
  /** Display name — from the profile when known, else whatever the roster called him. */
  name: string;
  /** This rep's row in the fortnight currently on screen, when he is in it. */
  score: EarlyBirdsRepScore | null;
  period: EarlyBirdsPeriod;
  basePath: string;
  district?: string | null;
}) {
  const closeHref = earlyBirdsHref(basePath, { district, period: period.periodKey });
  const entries = history.entries;

  return (
    <div className="overflow-hidden border border-slate-200 bg-white" role="region" aria-label="Rep history">
      <SectionHead
        title="Rep record"
        right={
          <Link
            aria-label="Close this rep's record"
            className="inline-flex shrink-0 items-center gap-1 border border-white/20 bg-white/10 px-2 py-0.5 text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-200 hover:bg-white/20"
            href={closeHref}
          >
            <X className="h-3 w-3 shrink-0" />
            Close
          </Link>
        }
      />

      {/* Identity. The largest type on the panel holding the longest string on it, so it wraps. */}
      <div className="border-b border-slate-200 px-4 py-4 sm:px-5">
        <p className="break-words text-xl font-black leading-tight text-slate-900" dir="auto">
          {name}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-phx-xs font-semibold uppercase tracking-wider text-slate-400">
          <span className="min-w-0 break-words" dir="auto">
            {profile?.areaName ?? "—"}
          </span>
          {profile?.lineName ? (
            <span className="min-w-0 break-words" dir="auto">
              · {profile.lineName}
            </span>
          ) : null}
        </p>
      </div>

      {history.error ? (
        // An outage, NOT an empty record. A rep who has never been in a closed fortnight is a real
        // answer; showing that copy to someone whose read failed is the misleading zero.
        <div className="flex items-start gap-3 border-b border-slate-200 bg-amber-50 px-4 py-4 sm:px-5">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <p className="break-words text-sm text-amber-900">
            This rep&apos;s past fortnights could not be read just now. That is a data-read problem on
            our side — it is not a statement that he has no record. The fortnight below is still live
            and correct.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-px border-b border-slate-200 bg-slate-200 xl:grid-cols-4">
          <Stat
            accent="bg-slate-900"
            icon={Clock}
            label="Typical start"
            sub="median of his fortnight medians"
            value={formatStartClock(history.typicalMedianStartMinutes)}
          />
          <Stat
            accent="bg-emerald-500"
            icon={Sunrise}
            label="Earliest fortnight"
            sub="his best median start"
            value={formatStartClock(history.earliestMedianStartMinutes)}
          />
          <Stat
            accent="bg-amber-400"
            icon={Trophy}
            label="Fortnights won"
            sub={entries.length > 0 ? `over ${entries.length} closed` : "no closed fortnight yet"}
            value={String(history.wins)}
          />
          <Stat
            accent="bg-orange-500"
            icon={CalendarRange}
            label="Best rank"
            sub="highest he has finished"
            value={history.bestRank === null ? "—" : `#${history.bestRank}`}
          />
        </div>
      )}

      {/* ── The fortnight on screen, day by day ─────────────────────────────── */}
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 sm:px-5">
        <p className="break-words text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-500">
          Every day of {period.label}
        </p>
      </div>
      {score ? (
        <DayTimeline period={period} score={score} />
      ) : (
        <p className="bg-white px-4 py-4 text-sm text-slate-500 sm:px-5">
          This rep is not in the ranking for {period.label} — he was not one of the district&apos;s
          active medical reps in that fortnight.
        </p>
      )}

      {/* ── The record, fortnight by fortnight ──────────────────────────────── */}
      <div className="border-y border-slate-200 bg-slate-50 px-4 py-2 sm:px-5">
        <p className="break-words text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-500">
          Closed fortnights
        </p>
      </div>

      {entries.length === 0 ? (
        <p className="bg-white px-4 py-5 text-sm text-slate-500 sm:px-5">
          {history.error
            ? "His record could not be read — see the note above."
            : "No closed fortnight has this rep in it yet. A fortnight joins this record the day after it ends, once its ranking is frozen."}
        </p>
      ) : (
        <>
          {/* Phone: cards. The owner's rule is desktop tables, mobile cards — never a squeezed table. */}
          <div className="divide-y divide-slate-100 md:hidden">
            {entries.map((entry, index) => {
              const delta = formatStartDelta(
                entry.medianStartMinutes,
                entries[index + 1]?.medianStartMinutes ?? null,
              );
              return (
                <div className="bg-white px-4 py-3" key={entry.periodKey}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center text-phx-xs font-black ${rankChipClass(
                        entry.rank - 1,
                      )}`}
                    >
                      {entry.rank}
                    </span>
                    <p className="min-w-0 flex-1 break-words text-sm font-bold text-slate-900">
                      {entry.periodLabel}
                    </p>
                    {entry.won ? (
                      <span className="shrink-0 bg-amber-400 px-1.5 py-0.5 text-phx-3xs font-black uppercase tracking-wide text-slate-900">
                        {entry.isNational ? "National" : "Won"}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {[
                      ["Median start", formatStartClock(entry.medianStartMinutes)],
                      ["Finished", entry.repCount > 0 ? `${entry.rank} of ${entry.repCount}` : `#${entry.rank}`],
                      ["Days", `${entry.daysWithSubmission}/${entry.expectedWorkingDays}`],
                      ["1st places", String(entry.dailyWins)],
                      ["GPS days", entry.gpsShare === null ? "—" : formatPercent(entry.gpsShare)],
                      ["Points", entry.eligible ? formatPoints(entry.totalScore) : "—"],
                    ].map(([label, value]) => (
                      <div className="min-w-0 border border-slate-200 px-2 py-1.5" key={label}>
                        <p className="break-words text-phx-3xs font-black uppercase tracking-wider text-slate-400">
                          {label}
                        </p>
                        <p className="break-words text-xs font-bold tabular-nums text-slate-900">{value}</p>
                      </div>
                    ))}
                  </div>
                  {delta ? (
                    <p
                      className={`mt-2 break-words text-phx-2xs font-black uppercase tracking-wide ${
                        delta.earlier ? "text-emerald-700" : "text-orange-600"
                      }`}
                    >
                      {delta.text} than the fortnight before
                    </p>
                  ) : null}
                  {!entry.eligible ? (
                    <p className="mt-2 break-words text-phx-xs font-semibold text-amber-700">
                      {reasonText(entry.ineligibleReasons)}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>

          {/* Desktop: a real table, sized by a colgroup so it fits without a horizontal scroll. */}
          <div className="hidden md:block">
            <table className="w-full table-fixed text-xs">
              <colgroup>
                <col className="w-[26%]" />
                <col className="w-[16%]" />
                <col className="w-[14%]" />
                <col className="w-[12%]" />
                <col className="w-[12%]" />
                <col className="w-[10%]" />
                <col className="w-[10%]" />
              </colgroup>
              <thead>
                <tr className="bg-slate-900">
                  {["Fortnight", "Median start", "Finished", "Days", "1st places", "GPS", "Points"].map(
                    (heading) => (
                      <th
                        className="break-words px-3 py-2.5 text-left text-phx-2xs font-black uppercase tracking-[0.12em] text-white"
                        key={heading}
                      >
                        {heading}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {entries.map((entry, index) => {
                  const delta = formatStartDelta(
                    entry.medianStartMinutes,
                    entries[index + 1]?.medianStartMinutes ?? null,
                  );
                  return (
                    <tr className="bg-white hover:bg-slate-50" key={entry.periodKey}>
                      <td className="px-3 py-2 align-top">
                        <p className="break-words font-bold text-slate-900">{formatPeriodChip(entry)}</p>
                        <p className="break-words text-phx-3xs font-semibold uppercase tracking-wide text-slate-400">
                          {entry.periodLabel}
                        </p>
                        {entry.won ? (
                          <span className="mt-1 inline-block bg-amber-400 px-1.5 py-0.5 text-phx-3xs font-black uppercase tracking-wide text-slate-900">
                            {entry.isNational ? "National winner" : "District winner"}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <p className="break-words font-black tabular-nums text-slate-900">
                          {formatStartClock(entry.medianStartMinutes)}
                        </p>
                        {delta ? (
                          <p
                            className={`break-words text-phx-3xs font-black uppercase tracking-wide ${
                              delta.earlier ? "text-emerald-700" : "text-orange-600"
                            }`}
                          >
                            {delta.text}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <p className="break-words tabular-nums text-slate-700">
                          {entry.repCount > 0 ? `${entry.rank} of ${entry.repCount}` : `#${entry.rank}`}
                        </p>
                        {!entry.eligible ? (
                          <p className="break-words text-phx-3xs font-semibold text-amber-700">
                            {reasonText(entry.ineligibleReasons)}
                          </p>
                        ) : null}
                      </td>
                      <td className="break-words px-3 py-2 align-top tabular-nums text-slate-700">
                        {entry.daysWithSubmission}/{entry.expectedWorkingDays}
                      </td>
                      <td className="break-words px-3 py-2 align-top tabular-nums text-slate-700">
                        {entry.dailyWins}
                      </td>
                      <td className="break-words px-3 py-2 align-top tabular-nums text-slate-700">
                        {entry.gpsShare === null ? "—" : formatPercent(entry.gpsShare)}
                      </td>
                      <td className="break-words px-3 py-2 align-top font-black tabular-nums text-slate-900">
                        {entry.eligible ? formatPoints(entry.totalScore) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
