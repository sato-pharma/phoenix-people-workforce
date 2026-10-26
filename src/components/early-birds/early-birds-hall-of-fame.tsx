import { Sunrise, Trophy } from "lucide-react";

import { SectionHead, rankChipClass } from "@/components/employee-portal/portal-command-center";
import { countWinsByHrIdKey, listMostStars, winnerKey } from "@/lib/early-birds/win-counts";
import type { EarlyBirdsWinnerRecord } from "@/lib/early-birds/service";

// Past winners. This is what turns Early Birds from a one-off card into a season-long standings
// table — the ×N badge on a repeat winner is the second reason a rep keeps coming back, after his
// own row in the race.
//
// ─── THE 2026-09-18 REBUILD: NAMES COLLIDED, ON A DESKTOP SCREEN. ─────────────────────────────
// The owner sent a screenshot of this band with four winners' names printed ON TOP OF each other —
// "Hassan Mohamed Raffat Mohamed Elsherbiny" overlapping its neighbours twice over, unreadable. The
// mechanism was two classes one line apart: each winner sat in a FIXED `w-36`/`sm:w-40` column and
// the name carried `whitespace-nowrap`, so a five-part Egyptian name (the normal case here, not the
// long tail) rendered ~330px wide inside a 144px box and bled symmetrically into the columns either
// side of it. `flex-wrap` could not save it — every item measured exactly 144px, so the row never
// wrapped and the overflow had nowhere to go.
//
// The fix is the one remedy the owner's fits-the-screen golden rule allows: WRAPPING, inside a grid
// of `minmax(0,1fr)` columns that cannot be overflowed by their own content. Not a smaller type
// scale, not `truncate`, and not `overflow-x-auto` over a min-width floor — the rule names that
// last one as the bug rather than the fix. Pinned by tests/early-birds-board-wraps.test.ts.
//
// ─── BREAKPOINTS READ THE BAND, NOT THE WINDOW. ──────────────────────────────────────────────
// Same lesson as early-bird-of-the-fortnight-card.tsx, which learned it the expensive way on
// 2026-09-05: this board renders full-width in the admin shell and inside the portal page shell,
// and those are not the same number of pixels. `@container` + `@` variants measure the band itself,
// so the column count follows the space the band actually has rather than the browser window's.

/** A fortnight's winner, as one cell of the grid. */
function WinnerCell({ winner, wins }: { winner: EarlyBirdsWinnerRecord; wins: number }) {
  return (
    <div className="relative min-w-0 bg-white px-4 py-4">
      {/* The house keycard accent: amber for a national winner, navy for a district star. Once the
          chips below have wrapped, this rule is the only thing separating the two at a glance. */}
      <span
        className={`absolute inset-x-0 top-0 h-[3px] ${winner.isNational ? "bg-amber-400" : "bg-slate-900"}`}
      />

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex h-5 shrink-0 items-center gap-1 bg-slate-900 px-1.5 text-phx-3xs font-black uppercase tracking-[0.12em] text-white">
          <Sunrise className="h-3 w-3 text-amber-400" />
          Winner
        </span>
        {wins > 1 && (
          <span
            className="inline-flex h-5 shrink-0 items-center bg-orange-500 px-1.5 text-phx-3xs font-black text-white"
            title={`Won ${wins} fortnights`}
          >
            ×{wins}
          </span>
        )}
        {winner.isNational && (
          <span
            className="inline-flex h-5 shrink-0 items-center gap-1 bg-amber-400 px-1.5 text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-900"
            title="National Early Bird"
          >
            <Trophy className="h-3 w-3" />
            National
          </span>
        )}
      </div>

      {/* Egyptian names run four and five parts long. This is the line the screenshot broke. */}
      <p className="mt-2 break-words text-sm font-black leading-tight text-slate-900" dir="auto">
        {winner.employeeName}
      </p>
      <p
        className="mt-1 break-words text-phx-2xs font-semibold uppercase tracking-wider text-slate-400"
        dir="auto"
      >
        {winner.areaName ?? "—"}
      </p>
      <p className="mt-2 break-words text-phx-2xs font-black uppercase tracking-[0.12em] text-orange-500">
        {winner.periodLabel}
      </p>
    </div>
  );
}

export function EarlyBirdsHallOfFame({ winners }: { winners: EarlyBirdsWinnerRecord[] }) {
  // The CoachingStarsOfMonthCard rule: an empty recognition surface is worse than no surface.
  if (winners.length === 0) return null;

  // Keyed on the hr id (win-counts.ts), never the name: one rep is stored under several spellings.
  const winCount = countWinsByHrIdKey(winners);
  const mostStars = listMostStars(winners);

  return (
    <div
      className="@container overflow-hidden border border-slate-200 bg-white"
      role="region"
      aria-label="Early Birds hall of fame"
    >
      <SectionHead
        title="Hall of Fame"
        right={
          <span className="text-phx-2xs font-bold uppercase tracking-widest text-slate-400">
            {winners.length} {winners.length === 1 ? "fortnight" : "fortnights"}
          </span>
        }
      />
      {/* `gap-px` over a slate background is this repo's hairline grid — KeycardGrid uses exactly
          it — one pixel of rule between cells rather than a border box around each, which is what
          keeps a dense band reading as a single object. The columns are minmax(0,1fr), so a cell
          can never be pushed wider than its share whatever the name inside it is. */}
      <div className="grid grid-cols-1 gap-px bg-slate-200 @sm:grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-4">
        {winners.map((winner) => {
          return <WinnerCell key={winner.id} winner={winner} wins={winCount.get(winnerKey(winner)) ?? 1} />;
        })}
      </div>

      {mostStars.length > 0 && (
        <div className="border-t border-slate-200 px-4 py-3 sm:px-5">
          <p className="mb-2 text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">Most stars</p>
          <div className="divide-y divide-slate-100">
            {mostStars.map((entry, index) => (
              <div key={entry.key} className="flex items-center gap-3 py-1.5">
                {/* The same medal ladder the race panel and every ranking card in the portal use —
                    gold, silver, bronze, then navy — so a rank reads identically across surfaces. */}
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center text-phx-xs font-black ${rankChipClass(index)}`}
                >
                  {index + 1}
                </span>
                <span className="min-w-0 break-words text-xs font-bold text-slate-900" dir="auto">
                  {entry.name}
                </span>
                <span className="ml-auto shrink-0 text-xs font-black tabular-nums text-orange-600">
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
