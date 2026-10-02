import { Sunrise } from "lucide-react";

import { SectionHead, rankChipClass } from "@/components/employee-portal/portal-command-center";
import type { EarlyBirdsRepScore } from "@/lib/early-birds/types";
import { formatPoints, formatStartClock, startTierClass, startTierLabel } from "./early-birds-format";
import { EarlyBirdsRepLink, type EarlyBirdsRepLinkContext } from "./early-birds-rep-link";

// The centrepiece. Two things here are what make a rep open this daily rather than once a fortnight:
//
//   * the STREAK STRIP — one cell per day, coloured by start time. It answers "how am I doing" as a
//     SHAPE rather than a number: six green against a teammate's nine is instantly legible.
//   * PINNING THE VIEWER'S OWN ROW when they are below the visible cut. A rep sitting 14th still has
//     a reason to look, which a top-10 list alone never gives him.

function StreakStrip({ score }: { score: EarlyBirdsRepScore }) {
  return (
    <div className="hidden gap-px sm:flex" aria-hidden>
      {score.timeline.map((day) => (
        <span
          key={day.dateIso}
          className={`h-2.5 w-[3px] ${startTierClass(day.startMinutes, day.expectedWeight)}`}
          title={`${day.dateIso} — ${startTierLabel(day.startMinutes, day.expectedWeight)}`}
        />
      ))}
    </div>
  );
}

function beforeNineCount(score: EarlyBirdsRepScore): number {
  return score.timeline.filter((day) => day.startMinutes !== null && day.startMinutes < 9 * 60).length;
}

function RaceRow({
  score,
  index,
  leaderScore,
  isViewer,
  winCount,
  repLink,
  openRepHrIdKey,
}: {
  score: EarlyBirdsRepScore;
  index: number;
  leaderScore: number;
  isViewer: boolean;
  winCount: number;
  repLink?: EarlyBirdsRepLinkContext | null;
  openRepHrIdKey?: string | null;
}) {
  const share = leaderScore > 0 ? Math.max(2, Math.round((score.totalScore / leaderScore) * 100)) : 2;
  const accent =
    index === 0 ? "border-l-[3px] border-amber-400"
    : index === 1 ? "border-l-[3px] border-slate-300"
    : index === 2 ? "border-l-[3px] border-orange-300"
    : "border-l-[3px] border-transparent";

  return (
    <div className={`flex items-center gap-3 px-3 py-2 ${accent} ${isViewer ? "bg-orange-50" : "bg-white"}`}>
      <span
        className={`flex h-5 w-5 shrink-0 items-center justify-center text-phx-xs font-black ${
          score.eligible ? rankChipClass(index) : "bg-slate-100 text-slate-400"
        }`}
      >
        {index + 1}
      </span>

      <div className="min-w-0 flex-1">
        {/* flex-wrap, and the name itself breaks. A five-part Egyptian name runs ~200px at 12px/700
            while this column is ~150px on a phone once the rank chip and the right-hand figures
            have taken their share — so on `whitespace-nowrap` it ran under the median-start column.
            The two chips keep their own nowrap: they are two characters each, and breaking "×4"
            across lines would read worse than the overflow it prevents. */}
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs font-bold text-slate-900" dir="auto">
          <EarlyBirdsRepLink
            active={score.hrIdKey === openRepHrIdKey}
            hrId={score.hrId}
            link={repLink}
            name={score.name}
          />
          {isViewer && (
            <span className="shrink-0 whitespace-nowrap bg-orange-500 px-1 py-0.5 text-phx-3xs font-black uppercase tracking-wide text-white">
              You
            </span>
          )}
          {winCount > 1 && (
            <span
              className="shrink-0 whitespace-nowrap bg-slate-700 px-1 py-0.5 text-phx-3xs font-black text-white"
              title={`Won ${winCount} fortnights`}
            >
              ×{winCount}
            </span>
          )}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <StreakStrip score={score} />
          <span className="text-phx-2xs font-semibold text-slate-400 sm:hidden">
            {beforeNineCount(score)}/{score.daysWithSubmission} days before 09:00
          </span>
        </div>
      </div>

      <div className="shrink-0 text-right">
        <p className="whitespace-nowrap text-sm font-black tabular-nums text-slate-900">
          {formatStartClock(score.medianStartMinutes)}
        </p>
        {/* No time is ever shown here without saying where it came from — the same rule the CRM
            master table states: a clock with no GPS behind it is not proof of being on site.
            Since the 2026-08-09 change only GPS check-ins are ranked, so this badge is GPS or
            nothing; it stays visible so "no clock" reads as unverified rather than as late. A
            started Phoenix CRM team's rep starts at his first Phoenix visit (owner, 2026-10-02),
            named as such and never as GPS: he is never told his location is read. */}
        <p className="whitespace-nowrap text-phx-3xs font-bold uppercase tracking-wide">
          {score.medianStartMinutes === null && score.phoenixClock ? (
            <span className="text-slate-400" title="No visit with a start time in this fortnight yet">
              No start
            </span>
          ) : score.medianStartMinutes === null ? (
            <span className="text-slate-400" title="No GPS check-in in this fortnight — worked, but no verified start time">
              No GPS
            </span>
          ) : score.visitStartDays ? (
            <span
              className="text-emerald-700"
              title={`Median of ${score.gpsVerifiedDays + score.visitStartDays} day${score.gpsVerifiedDays + score.visitStartDays === 1 ? "" : "s"}, each from the time of the day's first visit`}
            >
              First visit · {score.gpsVerifiedDays + score.visitStartDays}d
            </span>
          ) : (
            <span className="text-emerald-700" title={`Median of ${score.gpsVerifiedDays} GPS-verified day${score.gpsVerifiedDays === 1 ? "" : "s"}`}>
              GPS · {score.gpsVerifiedDays}d
            </span>
          )}
        </p>
        <p className="whitespace-nowrap text-phx-2xs font-semibold text-slate-400">
          {score.eligible ? `${formatPoints(score.totalScore)} pts` : "Not eligible"}
        </p>
        <div className="mt-1 h-1 w-16 bg-slate-100">
          <div
            className={`h-full ${score.eligible ? "bg-orange-500" : "bg-slate-300"}`}
            style={{ width: `${share}%` }}
          />
        </div>
      </div>
    </div>
  );
}

export function EarlyBirdsRacePanel({
  scores,
  winCountByHrIdKey,
  viewerHrIdKey,
  mobileLimit = 10,
  repLink,
  openRepHrIdKey,
}: {
  scores: EarlyBirdsRepScore[];
  winCountByHrIdKey: Map<string, number>;
  viewerHrIdKey?: string | null;
  mobileLimit?: number;
  /** Where a name links to. Omitted on a surface with no board URL — the names go inert, not dead. */
  repLink?: EarlyBirdsRepLinkContext | null;
  openRepHrIdKey?: string | null;
}) {
  if (scores.length === 0) {
    return (
      <div className="overflow-hidden border border-slate-200 bg-white">
        <SectionHead title="The Race" />
        <p className="bg-white px-5 py-6 text-sm text-slate-500">
          No medical reps are mapped to this district yet, so there is nothing to rank.
        </p>
      </div>
    );
  }

  const leaderScore = scores[0]?.totalScore ?? 0;
  const viewerIndex = viewerHrIdKey ? scores.findIndex((score) => score.hrIdKey === viewerHrIdKey) : -1;
  const viewerBelowMobileCut = viewerIndex >= mobileLimit;

  return (
    <div className="overflow-hidden border border-slate-200 bg-white" role="region" aria-label="Early Birds race">
      <SectionHead
        title="The Race"
        right={
          <span className="inline-flex min-w-0 items-center gap-1.5 text-phx-2xs font-bold uppercase tracking-widest text-slate-400">
            <Sunrise className="h-3.5 w-3.5 shrink-0 text-orange-400" />
            {scores.length} reps
          </span>
        }
      />

      {/* Desktop shows the whole district — a manager acts on the bottom of this list, not the top. */}
      <div className="hidden divide-y divide-slate-100 md:block">
        {scores.map((score, index) => (
          <RaceRow
            key={score.hrIdKey}
            index={index}
            isViewer={score.hrIdKey === viewerHrIdKey}
            leaderScore={leaderScore}
            openRepHrIdKey={openRepHrIdKey}
            repLink={repLink}
            score={score}
            winCount={winCountByHrIdKey.get(score.hrIdKey) ?? 0}
          />
        ))}
      </div>

      {/* Mobile shows the top N, then pins the viewer so their own standing is never off-screen. */}
      <div className="divide-y divide-slate-100 md:hidden">
        {scores.slice(0, mobileLimit).map((score, index) => (
          <RaceRow
            key={score.hrIdKey}
            index={index}
            isViewer={score.hrIdKey === viewerHrIdKey}
            leaderScore={leaderScore}
            openRepHrIdKey={openRepHrIdKey}
            repLink={repLink}
            score={score}
            winCount={winCountByHrIdKey.get(score.hrIdKey) ?? 0}
          />
        ))}
        {viewerBelowMobileCut && (
          <>
            <div className="bg-slate-50 px-3 py-1 text-center text-phx-2xs font-bold uppercase tracking-widest text-slate-400">
              Your position
            </div>
            <RaceRow
              index={viewerIndex}
              isViewer
              leaderScore={leaderScore}
              openRepHrIdKey={openRepHrIdKey}
              repLink={repLink}
              score={scores[viewerIndex]}
              winCount={winCountByHrIdKey.get(scores[viewerIndex].hrIdKey) ?? 0}
            />
          </>
        )}
      </div>
    </div>
  );
}
