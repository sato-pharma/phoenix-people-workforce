import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import {
  coachingZoneLabel,
  getCoachingScoreColor,
  type CoachingTopScoreEntry,
} from "@/lib/coaching/landing-insights";

/**
 * "Top coaching scores" leaderboard for a single month (highest score first).
 * Server component — a static ranked list, framed in the portal's premium design
 * language. Renders nothing when the month has no completed scored reports.
 */
export function CoachingTopScoresCard({
  entries,
  monthLabel,
  reportHrefBase = "/employee-portals/training-manager/field-coaching",
}: {
  entries: CoachingTopScoreEntry[];
  monthLabel: string;
  reportHrefBase?: string;
}) {
  if (entries.length === 0) return null;

  return (
    <div className="overflow-hidden border border-slate-200 bg-white" role="region" aria-label="Top coaching scores last month">
      <div className="flex items-center justify-between bg-slate-900 px-5 py-3">
        <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">
          Top Coaching Scores · {monthLabel}
        </h2>
        <div className="h-1.5 w-12 bg-orange-500" />
      </div>
      <ol className="divide-y divide-slate-100">
        {entries.map((entry) => (
          <li key={entry.reportId}>
            <Link
              href={`${reportHrefBase}/${entry.reportId}`}
              className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-orange-50/50 sm:px-5"
            >
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center text-xs font-black ${
                  entry.rank === 1 ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-600"
                }`}
              >
                {entry.rank}
              </span>
              <div className="min-w-0 flex-1">
                <p className="whitespace-nowrap text-sm font-bold text-slate-900">
                  {entry.medicalRepName}
                  <span className="ml-1.5 text-[11px] font-medium text-slate-400">{entry.medicalRepHrId}</span>
                </p>
                <p className="whitespace-nowrap text-[11px] text-slate-400">
                  by {entry.coachName} · {coachingZoneLabel(entry.performanceZone)}
                </p>
              </div>
              <span
                className="whitespace-nowrap text-base font-black tabular-nums"
                style={{ color: getCoachingScoreColor(entry.finalScorePercent) }}
              >
                {entry.finalScorePercent.toFixed(1)}%
              </span>
              <ArrowUpRight className="h-4 w-4 shrink-0 text-slate-300" />
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}
