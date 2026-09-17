import { MapPin, Sunrise, Trophy } from "lucide-react";

import { SectionHead } from "@/components/employee-portal/portal-command-center";
import type { EarlyBirdsWinnerRecord } from "@/lib/early-birds/service";
import { formatDayShort, formatHireDate, formatStartClock, startTierClass, startTierLabel } from "./early-birds-format";

// The winner panel is the one surface in the module that is allowed to feel celebratory, and it is
// the only place SectionHead (the navy + orange-hairline header, the most premium header the repo
// owns) is used inside Early Birds. Using it here and nowhere else is what makes it read as the
// reward rather than as another section.

export type EarlyBirdsTimelineDay = {
  dateIso: string;
  startMinutes: number | null;
  expectedWeight: number;
  visits?: number;
  wonDay?: boolean;
};

function coerceTimeline(raw: unknown[]): EarlyBirdsTimelineDay[] {
  return raw
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry) => ({
      dateIso: String(entry.dateIso ?? ""),
      startMinutes:
        entry.startMinutes === null || entry.startMinutes === undefined ? null : Number(entry.startMinutes),
      expectedWeight: Number(entry.expectedWeight ?? 1),
      visits: entry.visits === undefined ? undefined : Number(entry.visits),
      wonDay: Boolean(entry.wonDay),
    }))
    .filter((entry) => entry.dateIso.length === 10);
}

/** A labelled fact under the winner's name. The VALUE is an area name or a date, so it wraps —
 *  "Kafr El-Sheikh 1" in a third of a 375px card has nowhere else to go. */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border border-slate-200 px-3 py-2">
      <p className="break-words text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-400">{label}</p>
      <p className="mt-0.5 break-words text-sm font-bold text-slate-900" dir="auto">
        {value}
      </p>
    </div>
  );
}

/** One cell per fortnight day. An empty day renders as a dash rather than being omitted — leaving
 * days out makes a 9-day run look like a full 15. */
function Timeline({ days }: { days: EarlyBirdsTimelineDay[] }) {
  if (days.length === 0) return null;
  return (
    <div className="border-t border-slate-200 px-4 py-3 sm:px-5">
      <p className="mb-2 text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">
        Every day of the fortnight
      </p>
      {/* Desktop: a strip of cells. Mobile: the same days as a list — a 15-cell strip is unreadable
          on a phone.
          The strip was `flex overflow-x-auto` over `min-w-[46px]` cells, which is the exact shape
          AGENTS.md §4 names as the bug rather than the fix: 15 cells floor at 690px, so between
          640px and 690px of panel the fortnight scrolled sideways. An auto-fit grid keeps the same
          46px floor and WRAPS to a second row instead — the permitted remedy. */}
      <div className="hidden gap-px [grid-template-columns:repeat(auto-fit,minmax(46px,1fr))] sm:grid">
        {days.map((day) => (
          <div
            key={day.dateIso}
            className="min-w-0 border border-slate-200"
            title={`${formatDayShort(day.dateIso)} — ${startTierLabel(day.startMinutes, day.expectedWeight)}`}
          >
            <div className={`h-[3px] ${startTierClass(day.startMinutes, day.expectedWeight)}`} />
            <div className="px-1 py-1.5 text-center">
              <p className="text-phx-2xs font-black text-slate-500">{Number(day.dateIso.slice(8, 10))}</p>
              <p className="whitespace-nowrap text-phx-2xs font-bold tabular-nums text-slate-900">
                {formatStartClock(day.startMinutes)}
              </p>
            </div>
          </div>
        ))}
      </div>
      <div className="divide-y divide-slate-100 sm:hidden">
        {days.map((day) => (
          <div key={day.dateIso} className="flex items-center gap-2 py-1.5">
            <span className={`h-3 w-1 shrink-0 ${startTierClass(day.startMinutes, day.expectedWeight)}`} />
            <span className="whitespace-nowrap text-phx-xs font-semibold text-slate-600">
              {formatDayShort(day.dateIso)}
            </span>
            <span className="ml-auto whitespace-nowrap text-phx-xs font-bold tabular-nums text-slate-900">
              {formatStartClock(day.startMinutes)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function EarlyBirdsWinnerPanel({
  winner,
  periodLabel,
}: {
  winner: EarlyBirdsWinnerRecord | null;
  periodLabel: string;
}) {
  if (!winner) return null;

  const days = coerceTimeline(winner.timeline);
  const stats = winner.headlineStats as Record<string, string | number | undefined>;

  return (
    <div className="overflow-hidden border border-slate-200 bg-white" role="region" aria-label="Early Bird of the fortnight">
      <SectionHead
        title={`Early Bird · ${periodLabel}`}
        right={
          <span className="inline-flex min-w-0 items-center gap-1.5 text-phx-2xs font-bold uppercase tracking-widest text-amber-300">
            <Trophy className="h-3.5 w-3.5 shrink-0" />
            {winner.isNational ? "National winner" : "District star"}
          </span>
        }
      />

      <div className="flex flex-col gap-4 px-4 py-5 sm:flex-row sm:items-start sm:gap-6 sm:px-5">
        <div className="mx-auto shrink-0 sm:mx-0">
          {/* Square, per the owner's square-edge golden rule (AGENTS.md §4) — this chip carried
              `rounded-md` from the day it shipped. */}
          <span className="flex h-7 w-7 items-center justify-center bg-amber-400 text-sm font-black text-slate-900 shadow">
            ★
          </span>
        </div>

        <div className="min-w-0 flex-1">
          {/* The largest type on the board, holding the longest string on it. At 375px
              "Hana Abdelaziz Samir Abdelaziz Ghoniem" is ~2.5 screens wide at 20px/900 — it wraps. */}
          <p className="break-words text-xl font-black leading-tight text-slate-900" dir="auto">
            {winner.employeeName}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-phx-xs font-semibold uppercase tracking-wider text-slate-400">
            <MapPin className="h-3 w-3 shrink-0" />
            <span className="min-w-0 break-words" dir="auto">
              {winner.areaName ?? "—"}
            </span>
          </p>

          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Field label="Area" value={winner.areaName ?? "—"} />
            <Field label="Joined" value={formatHireDate(winner.hireDate)} />
            <Field label="Fortnight" value={periodLabel} />
          </div>

          {Object.keys(stats).length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {Object.entries(stats).map(([label, value]) => (
                <span
                  key={label}
                  className="inline-flex max-w-full items-center gap-1.5 border border-emerald-200 bg-emerald-50 px-2 py-1 text-phx-xs font-semibold text-emerald-700"
                >
                  <Sunrise className="h-3 w-3 shrink-0" />
                  <span className="min-w-0 break-words font-black uppercase tracking-wide text-emerald-600">
                    {label}
                  </span>
                  <span className="min-w-0 break-words">{String(value ?? "—")}</span>
                </span>
              ))}
            </div>
          )}

          {winner.confirmationSource === "auto" && (
            // Say so plainly. A rep should never be told his manager chose him when nobody did.
            // A whole sentence, so it wraps — it carried `whitespace-nowrap` and ran ~60px past a
            // 375px screen inside this panel's own overflow-hidden, i.e. clipped, not scrolled.
            <p className="mt-3 text-phx-xs font-semibold text-slate-400">
              Confirmed automatically — no decision was recorded in time.
            </p>
          )}
        </div>
      </div>

      <Timeline days={days} />
    </div>
  );
}
