"use client";

import { formatNumberValue } from "@/lib/i18n/format";
import { agreementLine } from "@/lib/outstation/approvals/agreement";
import { deskTopLine } from "@/lib/outstation/approvals/desk-view";
import { TRIP_STANDINGS, TRIP_STANDING_LABEL, TRIP_STANDING_MEANING, type TripStanding } from "@/lib/outstation/approvals/standing";
import type { DeskQueue } from "@/lib/outstation/approvals/types";
import { cn } from "@/lib/utils";

import { egp } from "./desk-parts";

const TILE_RULE: Record<TripStanding, string> = {
  approved_held: "border-t-amber-500",
  approved_queued: "border-t-emerald-500",
  in_payroll: "border-t-sky-500",
  rejected: "border-t-rose-500",
  waiting: "border-t-orange-500",
};

/**
 * The top of the page: ONE line saying how many decisions wait, then five true tiles.
 *
 * Every figure here is read from `queue.tiles`, which the server counts with the one function that
 * says where a trip stands (`standing.ts`) — so "Approved" can no longer hold a trip a payroll
 * already took, and a held trip says held. The line and the Waiting tile are the same number by
 * construction (`deskTopLine`), and the two waiting lanes add up to it.
 *
 * Under the tiles, the desk's own meter: how often the system's lane matched the answer he gave over
 * the last 30 days. It starts empty — only decisions made on this page are counted.
 */
export function DeskTopLine({ onToggleOld, overOnly, queue }: { onToggleOld: () => void; overOnly: boolean; queue: DeskQueue }) {
  const top = deskTopLine(queue);
  return (
    <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-base font-black text-slate-950" data-desk-top-line>
      <span data-desk-waiting={top.count}>
        {top.count === 0 ? "Nothing waits for you" : `${formatNumberValue(top.count)} ${top.count === 1 ? "decision waits" : "decisions wait"}`}
      </span>
      {top.count > 0 ? <span className="font-bold tabular-nums text-slate-500">· {egp(top.value)}</span> : null}
      {top.overSevenDays > 0 || overOnly ? (
        <button
          aria-pressed={overOnly}
          className={cn(
            "inline-flex min-h-8 items-center border px-2 py-0.5 text-xs font-black transition",
            overOnly ? "border-orange-600 bg-orange-600 text-white" : "border-orange-300 bg-orange-50 text-orange-800 hover:border-orange-500",
          )}
          data-over-seven={top.overSevenDays}
          onClick={onToggleOld}
          type="button"
        >
          {formatNumberValue(top.overSevenDays)} over 7 days
        </button>
      ) : null}
    </p>
  );
}

export function DeskTiles({ onOpen, queue }: { onOpen: (standing: TripStanding) => void; queue: DeskQueue }) {
  return (
    <div className="min-w-0" data-desk-tiles>
      <div className="grid min-w-0 grid-cols-2 border border-slate-200 bg-white sm:grid-cols-3 xl:grid-cols-5">
        {TRIP_STANDINGS.map((standing) => {
          const tile = queue.tiles[standing];
          return (
            <button
              aria-label={`${TRIP_STANDING_LABEL[standing]}: ${tile.count}. ${TRIP_STANDING_MEANING[standing]}`}
              className={cn(
                "min-w-0 border-b border-r border-slate-100 border-t-[3px] px-3 py-2 text-left transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-orange-500",
                TILE_RULE[standing],
              )}
              data-tile={standing}
              key={standing}
              onClick={() => onOpen(standing)}
              title={TRIP_STANDING_MEANING[standing]}
              type="button"
            >
              <span className="block break-words text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">{TRIP_STANDING_LABEL[standing]}</span>
              <span className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-1.5 tabular-nums">
                <span className="text-lg font-black leading-tight text-slate-950" data-tile-count>
                  {formatNumberValue(tile.count)}
                </span>
                {standing !== "rejected" && tile.count > 0 ? <span className="min-w-0 break-words text-xs font-semibold text-slate-500">{egp(tile.value)}</span> : null}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 min-w-0 break-words text-xs font-semibold text-slate-500" data-desk-agreement>
        Last {queue.agreement.windowDays} days, decided on this page — Ready approved in full: <span className="font-black text-slate-700">{agreementLine(queue.agreement.ready)}</span> · Your call approved:{" "}
        <span className="font-black text-slate-700">{agreementLine(queue.agreement.yourCall)}</span>
      </p>
    </div>
  );
}
