"use client";

import { useId } from "react";

import type { ManagerHalf } from "@/lib/phoenix-crm/manager-plan-rules";
import {
  managerGlanceAShare,
  managerGlanceCustomerLine,
  managerGlanceDayState,
  managerGlanceDistrictLine,
  managerGlanceGradeLine,
  managerGlanceKindBar,
  managerGlanceKindLabel,
  managerGlanceKindsLine,
  managerGlanceMissingHalfWords,
  managerGlanceNoFieldWords,
  managerGlanceOpenHalvesLine,
  managerGlanceOpenLine,
  managerGlancePeopleLine,
  managerGlancePlannedLine,
  managerGlanceRepeatedLine,
  managerGlanceScopeWords,
  managerWeekGlance,
  MANAGER_GLANCE_KIND_EDGE,
  type ManagerGlance,
  type ManagerGlanceCell,
  type ManagerGlanceDayRow,
  type ManagerGlanceScopeWords,
} from "@/lib/phoenix-crm/manager-week-glance";
import type { ManagerPlanBoardView } from "@/lib/phoenix-crm/view-types";

/**
 * A manager's own week at a glance, above the plan board's steps (premium pass, owner, 2026-11-09). Every figure comes
 * from `manager-week-glance.ts`; this file is markup only. Flat colour, square corners, no gradient, glow or shadow,
 * no ellipsis, and never a sideways scroll: a table from `lg` up, a card per day below that.
 *
 * It reads the SAVED week — a half-day typed and not saved yet is not counted, and the panel says so — and it is
 * shown on the Week, Day and Send steps, never over a half-day being edited.
 */

const TILE = "grid min-w-0 content-start gap-1 border border-slate-200 bg-white px-3 py-3";
const TILE_LABEL = "text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-500";
const TILE_VALUE = "text-xl font-black tabular-nums text-slate-900";
const TILE_NOTE = "break-words text-xs font-semibold leading-5 text-slate-600";
const SECTION_TITLE = "text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500";

function Tile({ label, note, value }: { label: string; note: string | null; value: string }) {
  return (
    <div className={TILE}>
      <p className={TILE_LABEL}>{label}</p>
      <p className={TILE_VALUE}>{value}</p>
      {note ? <p className={TILE_NOTE}>{note}</p> : null}
    </div>
  );
}

function KindBar({ glance, view }: { glance: ManagerGlance; view: ManagerPlanBoardView }) {
  const parts = managerGlanceKindBar(view, glance);
  if (parts.length === 0) return null;
  return (
    <div className="grid min-w-0 gap-2">
      <p className={SECTION_TITLE}>Planned half-days by kind</p>
      <div aria-hidden className="flex h-3 w-full min-w-0 bg-slate-100">
        {parts.map((part) => (
          <span className={part.swatch} key={part.kind} style={{ width: `${part.share}%` }} />
        ))}
      </div>
      <ul className="flex min-w-0 flex-wrap gap-x-4 gap-y-1">
        {parts.map((part) => (
          <li className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-slate-700" key={part.kind}>
            <span aria-hidden className={`h-2.5 w-2.5 shrink-0 ${part.swatch}`} />
            <span className="break-words">
              {part.label} · <span className="tabular-nums">{part.count}</span> · <span className="tabular-nums">{part.share}%</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CellBody({ cell, view }: { cell: ManagerGlanceCell; view: ManagerPlanBoardView }) {
  return (
    <>
      <span className="block text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-500">
        {cell.half}
        {cell.kind ? ` · ${managerGlanceKindLabel(view, cell.kind)}` : ""}
      </span>
      <span className={`block break-words text-xs font-semibold leading-5 ${cell.state === "planned" ? "text-slate-900" : cell.state === "open" ? "text-slate-500" : "text-slate-400"}`}>
        <bdi>{cell.text}</bdi>
      </span>
    </>
  );
}

function cellFrame(cell: ManagerGlanceCell): string {
  if (cell.state === "planned" && cell.kind) return `border border-slate-200 border-l-4 ${MANAGER_GLANCE_KIND_EDGE[cell.kind]} bg-white`;
  if (cell.state === "open") return "border border-dashed border-slate-300 bg-slate-50";
  return "border border-slate-100 bg-slate-50";
}

/** One half of the grid: a button that opens it while it can still be planned, plain text once it has passed. */
function Cell({
  canOpen,
  cell,
  date,
  onOpenHalf,
  passed,
  view,
}: {
  canOpen: boolean;
  cell: ManagerGlanceCell;
  date: string;
  onOpenHalf: (date: string, half: ManagerHalf) => void;
  passed: boolean;
  view: ManagerPlanBoardView;
}) {
  const frame = `min-w-0 px-2.5 py-2 text-left ${cellFrame(cell)}`;
  if (canOpen && !passed) {
    return (
      <button className={`${frame} w-full hover:border-orange-300`} onClick={() => onOpenHalf(date, cell.half)} type="button">
        <CellBody cell={cell} view={view} />
      </button>
    );
  }
  return (
    <div className={frame}>
      <CellBody cell={cell} view={view} />
    </div>
  );
}

function DayLabel({ row }: { row: ManagerGlanceDayRow }) {
  return (
    <>
      <span className="block text-sm font-black text-slate-900">{row.shortDay}</span>
      <span className="block break-words text-phx-3xs font-semibold text-slate-500">
        {managerGlanceDayState(row)}
      </span>
    </>
  );
}

function WeekGrid({ canOpen, glance, onOpenHalf, view }: { canOpen: boolean; glance: ManagerGlance; onOpenHalf: (date: string, half: ManagerHalf) => void; view: ManagerPlanBoardView }) {
  const halfOf = (row: ManagerGlanceDayRow, half: ManagerHalf) => row.cells.find((cell) => cell.half === half) ?? null;
  return (
    <div className="grid min-w-0 gap-2">
      <p className={SECTION_TITLE}>The week</p>
      <table className="hidden w-full table-fixed border-separate border-spacing-y-1.5 text-left lg:table">
        <colgroup>
          <col className="w-[14%]" />
          <col className="w-[43%]" />
          <col className="w-[43%]" />
        </colgroup>
        <thead>
          <tr className="text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-500">
            <th className="pb-1" scope="col">Day</th>
            <th className="px-1 pb-1" scope="col">Morning</th>
            <th className="px-1 pb-1" scope="col">Afternoon</th>
          </tr>
        </thead>
        <tbody>
          {glance.rows.map((row) => (
            <tr className="align-top" key={row.date}>
              <th className="pr-2 font-normal" scope="row">
                <DayLabel row={row} />
              </th>
              {row.fieldDay ? (
                (["AM", "PM"] as const).map((half) => {
                  const cell = halfOf(row, half);
                  return (
                    <td className="px-1" key={half}>
                      {cell ? (
                        <Cell canOpen={canOpen} cell={cell} date={row.date} onOpenHalf={onOpenHalf} passed={row.passed} view={view} />
                      ) : (
                        <div className="min-w-0 border border-slate-100 px-2.5 py-2 text-xs font-semibold text-slate-400">{managerGlanceMissingHalfWords(half)}</div>
                      )}
                    </td>
                  );
                })
              ) : (
                <td className="px-1" colSpan={2}>
                  <div className="min-w-0 border border-slate-100 bg-slate-50 px-2.5 py-2 text-xs font-semibold text-slate-500">
                    <bdi>{managerGlanceNoFieldWords(row)}</bdi>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="grid min-w-0 gap-2 lg:hidden">
        {glance.rows.map((row) => (
          <li className="grid min-w-0 gap-1.5 border-t border-slate-100 pt-2 first:border-t-0 first:pt-0" key={row.date}>
            <DayLabel row={row} />
            {row.fieldDay ? (
              <div className="grid min-w-0 gap-1.5 sm:grid-cols-2">
                {row.cells.map((cell) => (
                  <Cell canOpen={canOpen} cell={cell} date={row.date} key={cell.half} onOpenHalf={onOpenHalf} passed={row.passed} view={view} />
                ))}
              </div>
            ) : (
              <p className="break-words text-xs font-semibold text-slate-500">
                <bdi>{managerGlanceNoFieldWords(row)}</bdi>
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Districts({ glance, words }: { glance: ManagerGlance; words: ManagerGlanceScopeWords }) {
  if (glance.districts.length === 0 && glance.districtsNotIn.length === 0) return null;
  return (
    <div className="grid min-w-0 content-start gap-2">
      <p className={SECTION_TITLE}>{words.title}</p>
      {glance.districts.length > 0 ? (
        <ul className="grid min-w-0 gap-1.5">
          {glance.districts.map((district) => (
            <li className="grid min-w-0 gap-0.5 border-l-4 border-l-indigo-700 bg-white py-1 pl-2.5" key={district.key}>
              <span className="break-words text-sm font-black text-slate-900">
                <bdi>{district.name}</bdi>
              </span>
              <span className="break-words text-xs font-semibold tabular-nums text-slate-600">{managerGlanceDistrictLine(district)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs font-semibold text-slate-500">{words.none}</p>
      )}
      {glance.districtsNotIn.length > 0 ? (
        <p className="break-words text-xs font-semibold leading-5 text-slate-500">
          Not in the week: <bdi>{glance.districtsNotIn.join(" · ")}</bdi>
        </p>
      ) : glance.districts.length > 0 ? (
        <p className="text-xs font-semibold text-slate-500">{words.every}</p>
      ) : null}
    </div>
  );
}

function People({ glance }: { glance: ManagerGlance }) {
  const reps = managerGlancePeopleLine(glance.reps);
  const managers = managerGlancePeopleLine(glance.managers);
  if (!reps && !managers) return null;
  return (
    <div className="grid min-w-0 content-start gap-2">
      <p className={SECTION_TITLE}>Who the week goes with</p>
      {reps ? (
        <p className="break-words text-xs font-semibold leading-5 text-slate-700">
          <span className="font-black text-slate-900">Reps · </span>
          <bdi>{reps}</bdi>
        </p>
      ) : null}
      {managers ? (
        <p className="break-words text-xs font-semibold leading-5 text-slate-700">
          <span className="font-black text-slate-900">Managers · </span>
          <bdi>{managers}</bdi>
        </p>
      ) : null}
      <p className="text-phx-3xs font-semibold text-slate-500">Half-days with each, most first.</p>
    </div>
  );
}

function Customers({ glance }: { glance: ManagerGlance }) {
  const { customers } = glance;
  if (customers.ticked === 0) return null;
  const grades = managerGlanceGradeLine(customers);
  const share = managerGlanceAShare(customers);
  const repeated = managerGlanceRepeatedLine(customers);
  return (
    <div className="grid min-w-0 content-start gap-2">
      <p className={SECTION_TITLE}>Whom the week visits</p>
      <p className="break-words text-sm font-black tabular-nums text-slate-900">{managerGlanceCustomerLine(customers)}</p>
      {grades ? (
        <p className="break-words text-xs font-semibold tabular-nums text-slate-700">
          {grades}
          {share !== null ? ` · ${share}% of the graded are A` : ""}
        </p>
      ) : null}
      {customers.own > 0 ? <p className="text-xs font-semibold tabular-nums text-slate-600">{customers.own} from Manager&apos;s own list</p> : null}
      {repeated ? (
        <p className="break-words text-xs font-semibold leading-5 text-slate-600">
          <bdi>{repeated}</bdi>
        </p>
      ) : null}
      {customers.flagged.length > 0 ? (
        <ul className="grid min-w-0 gap-0.5">
          {customers.flagged.map((entry) => (
            <li className="break-words text-xs font-semibold leading-5 text-slate-500" key={`${entry.name}|${entry.flagLabel}`}>
              <bdi>{entry.name}</bdi> · {entry.flagLabel}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function OpenHalves({ canOpen, glance, onOpenHalf }: { canOpen: boolean; glance: ManagerGlance; onOpenHalf: (date: string, half: ManagerHalf) => void }) {
  if (glance.openHalves.length === 0) return null;
  if (!canOpen) {
    return <p className="break-words text-xs font-semibold leading-5 text-slate-600">{managerGlanceOpenHalvesLine(glance)}</p>;
  }
  return (
    <div className="grid min-w-0 gap-2">
      <p className={SECTION_TITLE}>Still to plan</p>
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {glance.openHalves.map((entry) => (
          <button
            className="inline-flex min-h-10 items-center border border-dashed border-slate-300 bg-white px-3 text-xs font-black text-slate-700 hover:border-orange-300 hover:bg-orange-50 md:min-h-9"
            key={`${entry.date}|${entry.half}`}
            onClick={() => onOpenHalf(entry.date, entry.half)}
            type="button"
          >
            {entry.name}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ManagerWeekGlancePanel({
  canOpen,
  exportHref,
  onOpenHalf,
  view,
}: {
  /** The viewer plans this week, so a half still ahead opens on the board. A reader's grid is text only. */
  canOpen: boolean;
  /** The week as Excel — the board's own door, or the Approvals Hub's (`?plan=`); null shows no link. */
  exportHref: string | null;
  /**
   * Opens a half on the board. Absent on the Approvals Hub's page, a server component that cannot hand a function to
   * this client one — and nothing there opens a half anyway.
   */
  onOpenHalf?: (date: string, half: ManagerHalf) => void;
  view: ManagerPlanBoardView;
}) {
  const headingId = useId();
  if (view.days.length === 0 || (view.mode === "pick" && !view.manager)) return null;
  const opens = canOpen && onOpenHalf !== undefined;
  const openHalf = onOpenHalf ?? (() => undefined);
  const glance = managerWeekGlance(view);
  const title = view.mode === "own" ? "Your week at a glance" : view.manager ? `${view.manager.name}'s week at a glance` : "The week at a glance";
  const offersDistricts = view.scopes.length > 0;
  const words = managerGlanceScopeWords(view);
  const holidays = glance.rows.filter((row) => row.holiday).length;
  return (
    <section aria-labelledby={headingId} className="min-w-0 border-t border-slate-100">
      <details className="group min-w-0" open>
        <summary className="flex min-w-0 cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-slate-50 sm:px-5 [&::-webkit-details-marker]:hidden">
          <span className="grid min-w-0 gap-0.5">
            <span className="text-sm font-black text-slate-900" id={headingId}>
              {view.mode === "own" ? title : <bdi>{title}</bdi>}
            </span>
            <span className="break-words text-xs font-semibold tabular-nums text-slate-500">
              {managerGlancePlannedLine(glance)} · {managerGlanceOpenLine(glance)}
            </span>
          </span>
          <span className="text-xs font-black text-orange-700">
            <span className="group-open:hidden">Show</span>
            <span className="hidden group-open:inline">Hide</span>
          </span>
        </summary>
        <div className="grid min-w-0 gap-4 px-4 pb-4 sm:px-5">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <p className="break-words text-xs font-semibold leading-5 text-slate-500">
              {opens ? "The saved week. A half-day typed and not saved yet is not counted here." : "The week as its planner saved it."}
            </p>
            {exportHref ? (
              <a
                className="inline-flex min-h-10 items-center border border-slate-200 bg-white px-3 text-xs font-black text-slate-700 hover:border-orange-300 hover:bg-orange-50 md:min-h-9"
                download
                href={exportHref}
              >
                Download Excel
              </a>
            ) : null}
          </div>
          <div className="grid min-w-0 grid-cols-2 gap-2 lg:grid-cols-4">
            <Tile label="Half-days planned" note={managerGlanceOpenLine(glance)} value={`${glance.planned} of ${glance.halves}`} />
            <Tile
              label="Days planned"
              note={holidays > 0 ? `${holidays} ${holidays === 1 ? "holiday" : "holidays"} left out` : managerGlanceKindsLine(view, glance)}
              value={`${glance.daysPlanned} of ${glance.fieldDays}`}
            />
            {offersDistricts ? (
              <Tile
                label={words.label}
                note={glance.districtsNotIn.length > 0 ? `${glance.districtsNotIn.length} not in the week` : glance.districts.length > 0 ? "Every one offered is in the week" : null}
                value={`${glance.districts.length} of ${view.scopes.length}`}
              />
            ) : (
              <Tile label="Reps gone with" note={managerGlancePeopleLine(glance.reps)} value={String(glance.reps.length)} />
            )}
            <Tile
              label="Customers ticked"
              note={managerGlanceGradeLine(glance.customers)}
              value={String(glance.customers.distinct)}
            />
          </div>
          <KindBar glance={glance} view={view} />
          <WeekGrid canOpen={opens} glance={glance} onOpenHalf={openHalf} view={view} />
          <OpenHalves canOpen={opens} glance={glance} onOpenHalf={openHalf} />
          <div className="grid min-w-0 gap-4 md:grid-cols-3">
            <Districts glance={glance} words={words} />
            <People glance={glance} />
            <Customers glance={glance} />
          </div>
        </div>
      </details>
    </section>
  );
}
