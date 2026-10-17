"use client";

/**
 * Phoenix CRM — Place checks, the rep scorecard at the top of the board (owner, 2026-10-17: "is this a
 * report that really shows me data? or it's a bunch of chaos"). One line per rep, worst first, built by
 * the pure `place-check-scorecard.ts` from the rows the page already holds. Tapping a rep narrows every
 * tab to that rep through the board's own Rep filter — the scorecard keeps no filter of its own.
 *
 * Desktop draws the module's `CrmTable` (`table-fixed` with a colgroup); a phone draws the same lines as
 * cards, BEFORE the table. Square corners, no ellipsis, nothing scrolls sideways.
 */

import { useState } from "react";

import { CrmButton, CrmCardsOnPhone, CrmTable, crmTdClassName, crmThClassName } from "@/components/phoenix-crm/ui";
import type { PlaceCheckNotesMode } from "@/components/phoenix-crm/place-check-notes";
import { problemsOf, type RepScore } from "@/lib/phoenix-crm/place-check-scorecard";
import { cn } from "@/lib/utils";

/** How many reps show before "Show every rep". */
const FIRST_REPS = 10;

type Column = {
  key: Exclude<keyof RepScore, "repName" | "seated" | "seatedOnTimetable"> | "timetable";
  label: string;
  /** A count that means something went wrong with the photograph: drawn in rose when it is not zero. */
  problem: boolean;
};

function columnsFor(mode: PlaceCheckNotesMode): Column[] {
  return [
    { key: "places", label: "Places", problem: false },
    { key: "confirmed", label: "Confirmed", problem: false },
    { key: "notReadable", label: "Not readable", problem: true },
    { key: "wrongPhoto", label: "No sign or timetable", problem: true },
    { key: "anotherName", label: "Another name", problem: true },
    { key: "notRead", label: "Not read yet", problem: false },
    // A manager's screen never says a decision is waiting on anybody (owner, 2026-10-13).
    { key: "waiting", label: mode === "team" ? "Being checked" : "Waiting for you", problem: false },
    { key: "sentBack", label: "Sent back", problem: true },
    { key: "timetable", label: "Timetable names them", problem: false },
  ];
}

function valueOf(score: RepScore, column: Column): string {
  if (column.key === "timetable") return score.seated === 0 ? "None seated" : `${score.seatedOnTimetable} of ${score.seated}`;
  return String(score[column.key]);
}

function isProblem(score: RepScore, column: Column): boolean {
  if (column.key === "timetable") return score.seated > 0 && score.seatedOnTimetable < score.seated;
  return column.problem && score[column.key] > 0;
}

function RepName({ onPick, picked, score }: { onPick: (rep: string) => void; picked: boolean; score: RepScore }) {
  return (
    <button
      aria-pressed={picked}
      className={cn(
        "min-w-0 break-words text-left text-sm font-black underline-offset-2 hover:underline",
        picked ? "text-orange-700" : "text-slate-900",
      )}
      onClick={() => onPick(picked ? "" : score.repName)}
      type="button"
    >
      {score.repName}
    </button>
  );
}

export function PlaceCheckScorecard({
  mode,
  onPickRep,
  pickedRep,
  reps,
  total,
}: {
  mode: PlaceCheckNotesMode;
  /** Narrows the whole board to one rep; an empty string clears it. */
  onPickRep: (rep: string) => void;
  pickedRep: string;
  reps: RepScore[];
  total: RepScore;
}) {
  const [showAll, setShowAll] = useState(false);
  const columns = columnsFor(mode);
  const shown = showAll ? reps : reps.slice(0, FIRST_REPS);
  const widths = ["19%", ...columns.map(() => "9%")];

  if (reps.length === 0) return null;

  return (
    <section aria-labelledby="place-check-scorecard" className="min-w-0 border border-slate-200 bg-white">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <h2 className="break-words text-sm font-black uppercase tracking-[0.12em] text-slate-500" id="place-check-scorecard">
          Each rep&apos;s captures
        </h2>
        <p className="break-words text-xs font-semibold text-slate-500">
          {total.places} {total.places === 1 ? "place" : "places"} · {problemsOf(total)} with a photo problem · worst first · tap a name to see only that rep
        </p>
      </div>

      <CrmCardsOnPhone>
        {shown.map((score) => (
          <div key={score.repName} className="space-y-2 px-4 py-3">
            <RepName onPick={onPickRep} picked={pickedRep === score.repName} score={score} />
            <dl className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-1">
              {columns.map((column) => (
                <div key={column.key} className="flex min-w-0 items-baseline justify-between gap-2 border-b border-slate-100 py-0.5">
                  <dt className="min-w-0 break-words text-xs text-slate-500">{column.label}</dt>
                  <dd className={cn("shrink-0 text-sm font-black tabular-nums", isProblem(score, column) ? "text-rose-700" : "text-slate-900")}>
                    {valueOf(score, column)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </CrmCardsOnPhone>

      <CrmTable columns={widths}>
        <thead>
          <tr>
            {["Rep", ...columns.map((column) => column.label)].map((label) => (
              <th key={label} className={cn(crmThClassName, "break-words")}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((score) => (
            <tr key={score.repName} className={pickedRep === score.repName ? "bg-orange-50/60" : undefined}>
              <td className={crmTdClassName}>
                <RepName onPick={onPickRep} picked={pickedRep === score.repName} score={score} />
              </td>
              {columns.map((column) => (
                <td key={column.key} className={cn(crmTdClassName, "tabular-nums", isProblem(score, column) ? "font-black text-rose-700" : null)}>
                  {valueOf(score, column)}
                </td>
              ))}
            </tr>
          ))}
          <tr className="bg-slate-50">
            <td className={cn(crmTdClassName, "font-black text-slate-900")}>{total.repName}</td>
            {columns.map((column) => (
              <td key={column.key} className={cn(crmTdClassName, "font-black tabular-nums text-slate-900")}>
                {valueOf(total, column)}
              </td>
            ))}
          </tr>
        </tbody>
      </CrmTable>

      {reps.length > FIRST_REPS ? (
        <div className="border-t border-slate-200 px-4 py-2">
          <CrmButton onClick={() => setShowAll((current) => !current)} size="sm" variant="ghost">
            {showAll ? `Show the first ${FIRST_REPS} only` : `Show every rep (${reps.length})`}
          </CrmButton>
        </div>
      ) : null}
    </section>
  );
}
