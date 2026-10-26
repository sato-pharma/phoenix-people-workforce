import { AlertTriangle, CheckCircle2, Clock, Sunrise, Trophy } from "lucide-react";

import { KeycardGrid, SectionHead, type Keycard } from "@/components/employee-portal/portal-command-center";
import type { EarlyBirdsBoardData } from "@/lib/early-birds/service";
import { EarlyBirdsHallOfFame } from "./early-birds-hall-of-fame";
import { EarlyBirdsRacePanel } from "./early-birds-race-panel";
import { EarlyBirdsRepTable } from "./early-birds-rep-table";
import { EarlyBirdsWinnerPanel } from "./early-birds-winner-panel";
import { formatFortnightHeading, formatStartClock } from "./early-birds-format";
import type { EarlyBirdsRepLinkContext } from "./early-birds-rep-link";

// One board, rendered by both the admin page and the portal page. Only the surrounding shell
// differs — the doctor-coverage precedent, so a CEO and a District Manager can never be looking at
// two different implementations of the same ranking.

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function EarlyBirdsBoard({
  data,
  viewerHrIdKey,
  action,
  repLink,
  openRepHrIdKey,
}: {
  data: EarlyBirdsBoardData;
  viewerHrIdKey?: string | null;
  /** Sync-now island, rendered in the header. */
  action?: React.ReactNode;
  /** Where a rep's name links to. Both pages pass it; it carries the open fortnight forward. */
  repLink?: EarlyBirdsRepLinkContext | null;
  /** The rep whose record is open, so the board can mark his row rather than only the panel. */
  openRepHrIdKey?: string | null;
}) {
  if (data.error) {
    return (
      <div className="overflow-hidden border border-slate-200 bg-white">
        <SectionHead title="Early Birds" right={action} />
        <div className="flex items-center gap-3 bg-white px-4 py-5 sm:px-5">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
          <p className="text-sm text-slate-500">
            The Early Birds board is temporarily unavailable — this is a data-read issue, not a
            performance gap. Try again shortly.
          </p>
        </div>
      </div>
    );
  }

  const eligible = data.ranking.candidates;
  const leader = eligible[0] ?? null;
  const medianStart = median(
    data.ranking.scores.map((score) => score.medianStartMinutes).filter((value): value is number => value !== null),
  );

  const submittedDays = data.ranking.scores.reduce((total, score) => total + score.daysWithSubmission, 0);
  const expectedDays = data.ranking.scores.reduce((total, score) => total + score.expectedWorkingDays, 0);
  const disciplinePct = expectedDays > 0 ? Math.round((submittedDays / expectedDays) * 100) : 0;

  const cards: Keycard[] = [
    {
      icon: Sunrise,
      label: "Fortnight leader",
      value: leader ? leader.name : "—",
      sub: leader ? (data.closed ? "finished #1" : "current #1") : "nobody eligible yet",
      accent: "bg-amber-400",
      valueClass: "text-slate-900",
    },
    {
      icon: Clock,
      label: "Median first visit",
      value: formatStartClock(medianStart),
      sub: `across ${data.scopeLabel}`,
      accent: "bg-slate-900",
      valueClass: "text-slate-900",
    },
    {
      icon: CheckCircle2,
      label: "Discipline",
      value: `${disciplinePct}%`,
      sub: "working days with a first visit",
      accent:
        disciplinePct >= 90 ? "bg-emerald-500" : disciplinePct >= 70 ? "bg-amber-400" : "bg-rose-500",
      valueClass:
        disciplinePct >= 90 ? "text-emerald-600" : disciplinePct >= 70 ? "text-amber-600" : "text-rose-600",
    },
    {
      icon: Trophy,
      label: data.closed ? "Fortnight" : "Days left",
      value: data.closed ? "Closed" : String(data.daysRemaining),
      sub: data.closed ? "awaiting confirmation" : "until the fortnight closes",
      accent: "bg-orange-500",
      valueClass: "text-slate-900",
    },
  ];

  return (
    <div className="space-y-3" dir="auto">
      <EarlyBirdsWinnerPanel periodLabel={data.period.label} winner={data.winner} />

      <div className="overflow-hidden border border-slate-200 bg-white">
        <SectionHead
          title={formatFortnightHeading(data.period.label, data.closed)}
          right={
            action ?? (
              // No nowrap: SectionHead's bar is overflow-hidden, so a chip that cannot wrap is
              // CLIPPED rather than scrolled — invisible to a scrollWidth check (AGENTS.md §4).
              <span className="text-phx-2xs font-bold uppercase tracking-widest text-slate-400">
                {data.scopeLabel}
              </span>
            )
          }
        />
        <KeycardGrid cards={cards} />
      </div>

      <EarlyBirdsRacePanel
        openRepHrIdKey={openRepHrIdKey}
        repLink={repLink}
        scores={data.ranking.scores}
        viewerHrIdKey={viewerHrIdKey}
        winCountByHrIdKey={data.winCountByHrIdKey}
      />

      <EarlyBirdsRepTable
        openRepHrIdKey={openRepHrIdKey}
        profiles={data.profiles}
        repLink={repLink}
        scores={data.ranking.scores}
      />

      <EarlyBirdsHallOfFame winners={data.hallOfFame} />
    </div>
  );
}
