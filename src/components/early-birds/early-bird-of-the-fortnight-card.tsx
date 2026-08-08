import Link from "next/link";
import { ArrowUpRight, Trophy } from "lucide-react";

import { PersonPhoto } from "@/components/people/person-photo";
import type { EarlyBirdsWinnerRecord } from "@/lib/early-birds/service";
import { formatHireDate } from "./early-birds-format";

// The compact winner card for a landing page. It takes an ALREADY-RESOLVED photoSrc and must never
// import src/lib/employees/employee-photo.ts — that module pulls node:crypto and the Supabase admin
// client, and reaching it from a client bundle fails the webpack build.
//
// Renders NOTHING when there is no winner. An empty "no winner yet" box sitting on every role's home
// screen for the module's first fortnight is worse than no box at all — the same rule the coaching
// Stars of the Month card follows.

export function EarlyBirdOfTheFortnightCard({
  winner,
  href = "/employee-portals/early-birds",
}: {
  winner: EarlyBirdsWinnerRecord | null;
  href?: string;
}) {
  if (!winner) return null;

  return (
    <div className="overflow-hidden border border-slate-200 bg-white" role="region" aria-label="Early Bird of the fortnight">
      <div className="flex items-center justify-between bg-slate-900 px-4 py-2.5 sm:px-5">
        <h2 className="flex items-center gap-1.5 whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-slate-300">
          <Trophy className="h-3.5 w-3.5 text-amber-400" />
          {winner.isNational ? "Early Bird of the Fortnight" : "Early Bird"} · {winner.periodLabel}
        </h2>
        <Link
          className="inline-flex items-center gap-1 whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-orange-400"
          href={href}
        >
          View board
          <ArrowUpRight className="h-3 w-3" />
        </Link>
      </div>

      <div className="flex items-center gap-4 px-4 py-4 sm:px-5">
        <PersonPhoto name={winner.employeeName} size="md" src={winner.photoSrc} />
        <div className="min-w-0">
          <p className="whitespace-nowrap text-base font-black text-slate-900" dir="auto">
            {winner.employeeName}
          </p>
          <p className="whitespace-nowrap text-[11px] font-semibold uppercase tracking-wider text-slate-400" dir="auto">
            {winner.areaName ?? "—"}
          </p>
          <p className="mt-0.5 whitespace-nowrap text-[11px] font-semibold text-slate-500">
            Joined {formatHireDate(winner.hireDate)}
          </p>
        </div>
      </div>
    </div>
  );
}
