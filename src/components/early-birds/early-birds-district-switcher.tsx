import Link from "next/link";
import { Users } from "lucide-react";

import type { EarlyBirdsDistrict } from "@/lib/early-birds/permissions";
import { formatDistrictCountChip } from "./early-birds-format";
import { earlyBirdsHref } from "./early-birds-links";

// WHOSE reps you are looking at — the scope half of the board's control bar.
//
// District switch as LINKS, not a client dropdown, so every switch re-runs the server-side scope
// gate. A client-side filter would let a viewer flip to a district the server never authorised.
//
// Two things changed on 2026-09-18, both out of the owner's "view yr scope" ask:
//
//   * It NAMES the scope. A board that only draws a ranking never says whose ranking it is, and
//     "the company" and "your team" are very different readings of the same twelve rows. A
//     District Manager with exactly one district used to get nothing here at all — the old
//     `districts.length <= 1 -> null` — so the viewer who most needed telling he was looking at
//     his OWN district was the one told nothing.
//   * Every chip carries the fortnight and the open rep FORWARD. These links used to write
//     `?district=…` alone, so switching district while reading August silently threw you back to
//     the live fortnight, with nothing on screen saying the question had changed.

export function EarlyBirdsDistrictSwitcher({
  districts,
  selectedHrIdKey,
  basePath,
  scopeLabel,
  periodKey,
  repHrId,
}: {
  districts: EarlyBirdsDistrict[];
  selectedHrIdKey: string;
  basePath: string;
  /** "the company" | "your line" | "your team" — straight off resolveEarlyBirdsScope. */
  scopeLabel?: string;
  /** Carried forward so switching district keeps the fortnight you were reading. */
  periodKey?: string | null;
  /** Carried forward so switching district keeps the rep panel open, if one is. */
  repHrId?: string | null;
}) {
  const selected = districts.find((district) => district.hrIdKey === selectedHrIdKey) ?? districts[0];
  if (!selected) return null;

  const single = districts.length <= 1;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2" role="navigation" aria-label="Scope">
      <span className="inline-flex shrink-0 items-center gap-1.5 text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400">
        <Users className="h-3 w-3 shrink-0" />
        Scope
      </span>

      {single ? (
        // One district: nothing to choose between, so state the answer rather than draw a control
        // that cannot be used. This is the Medical Rep's view and the District Manager's.
        <p className="min-w-0 break-words text-phx-xs font-bold text-slate-700" dir="auto">
          {selected.name}
          {scopeLabel ? <span className="font-semibold text-slate-400"> · {scopeLabel}</span> : null}
        </p>
      ) : (
        <>
          {scopeLabel ? (
            <span className="max-w-full break-words border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-500">
              {formatDistrictCountChip(scopeLabel, districts.length)}
            </span>
          ) : null}
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {districts.map((district) => {
              const active = district.hrIdKey === selected.hrIdKey;
              return (
                <Link
                  key={district.hrIdKey}
                  href={earlyBirdsHref(basePath, {
                    district: district.hrId,
                    period: periodKey,
                    rep: repHrId,
                  })}
                  aria-current={active ? "true" : undefined}
                  // A "district" here is its MANAGER'S full name, so these chips carry the same
                  // four- and five-part Egyptian names the rest of the board does — and a Super
                  // Admin sees one chip per district in the company. `max-w-full` + `break-words`
                  // keeps the longest of them inside the row it wrapped onto instead of running
                  // off the screen.
                  className={`max-w-full break-words border px-2 py-1 text-phx-xs font-bold ${
                    active
                      ? "border-orange-300 bg-orange-50 text-orange-700"
                      : "border-slate-200 bg-white text-slate-600 hover:border-orange-200 hover:text-orange-600"
                  }`}
                  dir="auto"
                >
                  {district.name}
                </Link>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
