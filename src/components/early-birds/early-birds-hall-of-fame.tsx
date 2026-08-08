import { Trophy } from "lucide-react";

import { SectionHead } from "@/components/employee-portal/portal-command-center";
import { PersonPhoto } from "@/components/people/person-photo";
import { normalizeHrIdForAccess } from "@/lib/hr-id";
import type { EarlyBirdsWinnerRecord } from "@/lib/early-birds/service";

// Past winners. This is what turns Early Birds from a one-off card into a season-long standings
// table — the ×N badge on a repeat winner is the second reason a rep keeps coming back, after his
// own row in the race.

export function EarlyBirdsHallOfFame({ winners }: { winners: EarlyBirdsWinnerRecord[] }) {
  // The CoachingStarsOfMonthCard rule: an empty recognition surface is worse than no surface.
  if (winners.length === 0) return null;

  const winCount = new Map<string, number>();
  for (const winner of winners) {
    const key = normalizeHrIdForAccess(winner.employeeHrId);
    if (key) winCount.set(key, (winCount.get(key) ?? 0) + 1);
  }

  const mostStars = Array.from(
    winners
      .reduce((acc, winner) => {
        const key = normalizeHrIdForAccess(winner.employeeHrId) ?? winner.employeeHrId;
        const entry = acc.get(key);
        if (entry) entry.wins += 1;
        else acc.set(key, { name: winner.employeeName, wins: 1 });
        return acc;
      }, new Map<string, { name: string; wins: number }>())
      .values(),
  )
    .filter((entry) => entry.wins > 1)
    .sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name))
    .slice(0, 5);

  return (
    <div className="overflow-hidden border border-slate-200 bg-white" role="region" aria-label="Early Birds hall of fame">
      <SectionHead
        title="Hall of Fame"
        right={
          <span className="whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-slate-400">
            {winners.length} fortnights
          </span>
        }
      />
      <div className="flex flex-wrap justify-center gap-6 px-5 py-6 sm:justify-start sm:gap-8">
        {winners.map((winner) => {
          const key = normalizeHrIdForAccess(winner.employeeHrId) ?? winner.employeeHrId;
          const wins = winCount.get(key) ?? 1;
          return (
            <div key={winner.id} className="flex w-36 flex-col items-center gap-2 text-center sm:w-40">
              <div className="relative">
                <PersonPhoto name={winner.employeeName} size="md" src={winner.photoSrc} />
                {wins > 1 && (
                  <span
                    className="absolute -right-2 -top-2 flex h-7 w-7 items-center justify-center rounded-md bg-slate-700 text-[11px] font-black text-white shadow"
                    title={`Won ${wins} fortnights`}
                  >
                    ×{wins}
                  </span>
                )}
                {winner.isNational && (
                  <span
                    className="absolute -bottom-2 -left-2 flex h-6 w-6 items-center justify-center rounded-md bg-amber-400 text-slate-900 shadow"
                    title="National Early Bird"
                  >
                    <Trophy className="h-3.5 w-3.5" />
                  </span>
                )}
              </div>
              <p className="whitespace-nowrap text-xs font-bold text-slate-900" dir="auto">
                {winner.employeeName}
              </p>
              <p className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                {winner.periodLabel}
              </p>
            </div>
          );
        })}
      </div>

      {mostStars.length > 0 && (
        <div className="border-t border-slate-200 px-4 py-3 sm:px-5">
          <p className="mb-2 text-[10px] font-black uppercase tracking-[0.14em] text-slate-400">Most stars</p>
          <div className="divide-y divide-slate-100">
            {mostStars.map((entry, index) => (
              <div key={entry.name} className="flex items-center gap-3 py-1.5">
                <span className="w-5 whitespace-nowrap text-[11px] font-black text-slate-300">{index + 1}</span>
                <span className="whitespace-nowrap text-xs font-bold text-slate-900" dir="auto">
                  {entry.name}
                </span>
                <span className="ml-auto whitespace-nowrap text-xs font-black tabular-nums text-orange-600">
                  ×{entry.wins}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
