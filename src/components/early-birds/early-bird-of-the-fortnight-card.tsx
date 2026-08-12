import Link from "next/link";
import { ArrowUpRight, Star, Trophy } from "lucide-react";

import type { EarlyBirdsWinnerRecord } from "@/lib/early-birds/service";
import { formatHireDate } from "./early-birds-format";

// The compact stars card for a landing page.
//
// One star per line (Pedia / Anti Infective / CNS), never a single company-wide "best of the
// best" — that could go whole fortnights without ever being a CNS rep's own line. Each line gets
// its own column, so a rep always sees a name from their own line, not someone else's.
//
// Renders NOTHING when there are no stars. An empty "no winner yet" box sitting on every role's home
// screen for the module's first fortnight is worse than no box at all — the same rule the coaching
// Stars of the Month card follows.

function StarColumn({ star }: { star: EarlyBirdsWinnerRecord }) {
  return (
    <div className="flex flex-1 items-center gap-3 px-4 py-4 sm:px-5">
      {star.isNational && (
        <span
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-amber-400 text-slate-900 shadow"
          title="Also this fortnight's overall national winner"
        >
          <Star className="h-3 w-3" fill="currentColor" />
        </span>
      )}
      <div className="min-w-0">
        <p className="whitespace-nowrap text-[10px] font-black uppercase tracking-widest text-orange-500" dir="auto">
          {star.lineName ?? "—"}
        </p>
        <p className="whitespace-nowrap text-base font-black text-slate-900" dir="auto">
          {star.employeeName}
        </p>
        <p className="whitespace-nowrap text-[11px] font-semibold uppercase tracking-wider text-slate-400" dir="auto">
          {star.areaName ?? "—"}
        </p>
        <p className="mt-0.5 whitespace-nowrap text-[11px] font-semibold text-slate-500">
          Joined {formatHireDate(star.hireDate)}
        </p>
      </div>
    </div>
  );
}

export function EarlyBirdOfTheFortnightCard({
  stars,
  href = "/employee-portals/early-birds",
}: {
  stars: EarlyBirdsWinnerRecord[];
  href?: string;
}) {
  if (stars.length === 0) return null;

  return (
    <div className="overflow-hidden border border-slate-200 bg-white" role="region" aria-label="Early Birds of the fortnight">
      <div className="flex items-center justify-between bg-slate-900 px-4 py-2.5 sm:px-5">
        <h2 className="flex items-center gap-1.5 whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-slate-300">
          <Trophy className="h-3.5 w-3.5 text-amber-400" />
          {stars.length > 1 ? "Stars of the Fortnight" : "Early Bird"} · {stars[0].periodLabel}
        </h2>
        <Link
          className="inline-flex items-center gap-1 whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-orange-400"
          href={href}
        >
          View board
          <ArrowUpRight className="h-3 w-3" />
        </Link>
      </div>

      <div className="flex flex-col divide-y divide-slate-100 sm:flex-row sm:divide-x sm:divide-y-0">
        {stars.map((star) => (
          <StarColumn key={star.id} star={star} />
        ))}
      </div>
    </div>
  );
}
