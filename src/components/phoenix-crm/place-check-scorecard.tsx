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

import { useState, type ReactNode } from "react";

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

/**
 * The desktop table's columns. Nine counts at 9% each split CONFIRMED and TIMETABLE mid-word at laptop
 * widths (the shell sets every header in 0.78rem capitals), so the table MERGES: the three photo problems
 * share one cell, the two not-yet-settled counts another, and the place count sits under the rep's name.
 * Every count is still on the line — merged, never dropped — and the phone cards keep all nine apart.
 */
type Group = { label: string; width: string; keys: ReadonlyArray<Column["key"]> };

const TABLE_GROUPS: ReadonlyArray<Group> = [
  { label: "Confirmed", width: "15%", keys: ["confirmed"] },
  { label: "Photo problems", width: "20%", keys: ["notReadable", "wrongPhoto", "anotherName"] },
  { label: "Still open", width: "17%", keys: ["notRead", "waiting"] },
  { label: "Sent back", width: "13%", keys: ["sentBack"] },
  { label: "Timetable names them", width: "17%", keys: ["timetable"] },
];

function valueOf(score: RepScore, column: Column): string {
  if (column.key === "timetable") return score.seated === 0 ? "None seated" : `${score.seatedOnTimetable} of ${score.seated}`;
  return String(score[column.key]);
}

function isProblem(score: RepScore, column: Column): boolean {
  if (column.key === "timetable") return score.seated > 0 && score.seatedOnTimetable < score.seated;
  return column.problem && score[column.key] > 0;
}

/**
 * The counts that open their own rows when tapped — every one but the place count and Confirmed (owner,
 * 2026-10-17: "don't put for me non-readable … make me see what is the unreadable. The photos, I must be
 * able to see the photos"). A number that says "9 not readable" and goes nowhere tells him nothing; the
 * board answers each target with the tab, the rep and the narrowing that hold exactly those places.
 */
export type ScoreTarget = "notReadable" | "wrongPhoto" | "anotherName" | "notRead" | "waiting" | "sentBack" | "timetable";

type Opener = (rep: string, target: ScoreTarget) => void;

/** What a count opens, or nothing when there is nothing behind it to see. */
function targetOf(score: RepScore, column: Column): ScoreTarget | null {
  switch (column.key) {
    case "notReadable":
    case "wrongPhoto":
    case "anotherName":
    case "notRead":
    case "waiting":
    case "sentBack":
      return score[column.key] > 0 ? column.key : null;
    case "timetable":
      return score.seated > 0 ? "timetable" : null;
    default:
      return null;
  }
}

/** A count, as a button onto its own rows when it has any. `rep` is "" on the Every rep line. */
function Count({ children, column, onOpen, rep, score }: { children: ReactNode; column: Column; onOpen: Opener; rep: string; score: RepScore }) {
  const target = targetOf(score, column);
  if (!target) return <>{children}</>;
  return (
    <button
      aria-label={`Show the photos: ${valueOf(score, column)} ${column.label.toLowerCase()}, ${rep || "every rep"}`}
      className="min-w-0 break-words text-left underline decoration-dotted underline-offset-2 hover:decoration-solid"
      onClick={() => onOpen(rep, target)}
      type="button"
    >
      {children}
    </button>
  );
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

function placesText(places: number): string {
  return `${places} ${places === 1 ? "place" : "places"}`;
}

/** A phone card's counts: all nine, apart, each one tappable onto its photos. */
function ScoreFacts({ columns, onOpen, rep, score }: { columns: Column[]; onOpen: Opener; rep: string; score: RepScore }) {
  return (
    <dl className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-1">
      {columns.map((column) => (
        <div key={column.key} className="flex min-w-0 items-baseline justify-between gap-2 border-b border-slate-100 py-0.5">
          <dt className="min-w-0 break-words text-xs text-slate-500">{column.label}</dt>
          <dd className={cn("shrink-0 text-sm font-black tabular-nums", isProblem(score, column) ? "text-rose-700" : "text-slate-900")}>
            <Count column={column} onOpen={onOpen} rep={rep} score={score}>
              {valueOf(score, column)}
            </Count>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** One desktop cell: a single count as it is, a merged group as one line per count, each named and tappable. */
function GroupCell({
  columns,
  group,
  onOpen,
  rep,
  score,
  total = false,
}: {
  columns: Column[];
  group: Group;
  onOpen: Opener;
  rep: string;
  score: RepScore;
  total?: boolean;
}) {
  const members = columns.filter((column) => group.keys.includes(column.key));
  const tone = (column: Column) => (total ? "font-black text-slate-900" : isProblem(score, column) ? "font-black text-rose-700" : null);
  const [only] = members;
  return (
    <td className={cn(crmTdClassName, "tabular-nums", members.length === 1 && only ? tone(only) : null)}>
      {members.length === 1 && only ? (
        <Count column={only} onOpen={onOpen} rep={rep} score={score}>
          {valueOf(score, only)}
        </Count>
      ) : (
        members.map((column) => (
          <span key={column.key} className={cn("block", tone(column))}>
            <Count column={column} onOpen={onOpen} rep={rep} score={score}>
              {valueOf(score, column)} {column.label.toLowerCase()}
            </Count>
          </span>
        ))
      )}
    </td>
  );
}

export function PlaceCheckScorecard({
  mode,
  onOpen,
  onPickRep,
  pickedRep,
  reps,
  total,
}: {
  mode: PlaceCheckNotesMode;
  /** Opens the rows behind a count — that rep's ("" for every rep), on the tab that holds them. */
  onOpen: Opener;
  /** Narrows the whole board to one rep; an empty string clears it. */
  onPickRep: (rep: string) => void;
  pickedRep: string;
  reps: RepScore[];
  total: RepScore;
}) {
  const [showAll, setShowAll] = useState(false);
  const columns = columnsFor(mode);
  const shown = showAll ? reps : reps.slice(0, FIRST_REPS);
  const widths = ["18%", ...TABLE_GROUPS.map((group) => group.width)];

  if (reps.length === 0) return null;

  return (
    <section aria-labelledby="place-check-scorecard" className="min-w-0 border border-slate-200 bg-white">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <h2 className="break-words text-sm font-black uppercase tracking-[0.12em] text-slate-500" id="place-check-scorecard">
          Each rep&apos;s captures
        </h2>
        <p className="break-words text-xs font-semibold text-slate-500">
          {total.places} {total.places === 1 ? "place" : "places"} · {problemsOf(total)} with a photo problem · worst first · tap a name to see only that rep, a count to see its photos
        </p>
      </div>

      <CrmCardsOnPhone>
        {shown.map((score) => (
          <div key={score.repName} className="space-y-2 px-4 py-3">
            <RepName onPick={onPickRep} picked={pickedRep === score.repName} score={score} />
            <ScoreFacts columns={columns} onOpen={onOpen} rep={score.repName} score={score} />
          </div>
        ))}
        {/* The table's "Every rep" line, on a phone too: the same rows, never fewer facts. */}
        <div className="space-y-2 bg-slate-50 px-4 py-3">
          <p className="break-words text-sm font-black text-slate-900">{total.repName}</p>
          <ScoreFacts columns={columns} onOpen={onOpen} rep="" score={total} />
        </div>
      </CrmCardsOnPhone>

      <CrmTable columns={widths}>
        <thead>
          <tr>
            {["Rep", ...TABLE_GROUPS.map((group) => group.label)].map((label) => (
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
                <span className="block text-xs font-semibold text-slate-500">{placesText(score.places)}</span>
              </td>
              {TABLE_GROUPS.map((group) => (
                <GroupCell key={group.label} columns={columns} group={group} onOpen={onOpen} rep={score.repName} score={score} />
              ))}
            </tr>
          ))}
          <tr className="bg-slate-50">
            <td className={cn(crmTdClassName, "font-black text-slate-900")}>
              {total.repName}
              <span className="block text-xs font-semibold text-slate-500">{placesText(total.places)}</span>
            </td>
            {TABLE_GROUPS.map((group) => (
              <GroupCell key={group.label} columns={columns} group={group} onOpen={onOpen} rep="" score={total} total />
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
