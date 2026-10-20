"use client";

// Recruitment workspace — the candidates as a bordered table (owner, 20 Oct 2026: "put the data in a
// polished premium table with borders, neat and tidy and comfortable to my eye").
//
// THE LOOK is the module's own bordered grid, the Interview Calendar week table: `table-fixed` with a
// colgroup, the shared dark band for the head, every cell ruled, zebra rows, the status as a 3px edge
// on the first cell, the opened row warm. Values are reading size, wrap, and are never cut short.
//
// THE COLUMNS are the same on every tab: the tick, the candidate (name, status, source and when the CV
// arrived, and every flag under it), the owner's six — Applying for · Graduated in · Years of
// experience · Expected monthly net salary · When could you start · Age — then Region · Area and every
// other answer. A question the person's role is never asked reads "Not asked"; one they were asked and
// did not answer is the amber "Missing · add", edited in place.
//
// IT FITS ITS OWN WIDTH, NOT THE WINDOW'S. With a CV open the table is half the page, so it switches on
// its container (`@container`), never on a viewport breakpoint: from 1180px of its own width the ten
// columns; under that the six fold into two stacked columns and Region · Area into the candidate cell.
// Below `md` (a phone) the rows are the two-line cards, `CandidateRow`.
//
// ONE COLGROUP SERVES BOTH. It always declares the wide layout's columns; each <col> carries both of
// its widths (`--ws-wide`, `--ws-compact`) and the container query picks one. The compact layout's
// cells fill the first columns, so the columns past them are 0% there. Nothing depends on a browser
// honouring a hidden <colgroup>, and a full-width row spans the same count in both layouts.
//
// A ROW CAN CARRY A DETAIL ROW under it (`detailFor`) — the "Place this candidate" form on Needs
// placing, so he reads the CV whole on the right while he answers on the left.
//
// THE HEAD STAYS PINNED while the rows scroll (owner, 20 Oct 2026: "these headers, pin them, fixed
// while scrolling"): every head cell is sticky at `--ws-head-top`, which the workspace sets to just
// under its own pinned tabs and filters. The frame round the table is `!overflow-visible` for it —
// `globals.css` gives every `:has(> table)` box `overflow-x: auto`, which makes it a scroll box of its
// own, and a sticky cell inside a box that never scrolls never moves. This table is `table-fixed`
// across its width, so it has nothing to scroll sideways anyway.

import { ChevronDown } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";

import { adminPanelDepthClassName, adminPanelHeaderClassName } from "@/components/admin/admin-design-tokens";
import { phxCheckInputClassName } from "@/components/ui/form-tokens";
import { AnswerChip, type AnswerOption } from "@/components/recruitment/workspace/answer-chip";
import { CandidateRow, RowFlags } from "@/components/recruitment/workspace/candidate-row";
import { cairoStamp, chipToneClassName, statusEdgeClassName, statusTone } from "@/components/recruitment/workspace/workspace-format";
import { candidateStatusLabels } from "@/lib/recruitment/candidate-status";
import type { WorkspaceAnswerChip, WorkspaceRow } from "@/lib/recruitment/workspace/types";
import { candidateSourceLabels } from "@/lib/recruitment/workspace/vocabulary";
import {
  COMPACT_COLUMNS,
  TABLE_LEAD_KEYS,
  TABLE_LEAD_LABELS,
  TABLE_PLACE_KEYS,
  WIDE_COLUMNS,
  columnsFor,
} from "@/components/recruitment/workspace/candidate-table-columns";
import { cn } from "@/lib/utils";

const FIRST_STACK = ["role", "background", "experience"] as const;
const SECOND_STACK = ["salary", "oc_start_date", "field_age_band"] as const;

// The literal 1180px is `TABLE_WIDE_MIN_PX` (pinned equal by the test): Tailwind reads class names
// from the source, so the breakpoint cannot be built from the constant.
const WIDE_ONLY = "hidden @min-[1180px]:table-cell";
const COMPACT_ONLY = "@min-[1180px]:hidden";
const COL_WIDTH = "w-[var(--ws-compact)] @min-[1180px]:w-[var(--ws-wide)]";
// The rightmost column in view carries no rule of its own — the frame draws that edge.
const LAST_WIDE = "@min-[1180px]:border-r-0";
const LAST_COMPACT = "border-r-0";
const headCell =
  "sticky top-[var(--ws-head-top,0px)] z-20 border-r border-white/10 px-3 py-2.5 text-left align-bottom text-phx-xs font-black uppercase tracking-[0.1em] text-slate-100";
const bodyCell = "border-r border-slate-200 px-3 py-2.5 align-top";

function ignoreChange() {
  // The tick is handled on click (Shift-click ticks a run); a controlled input still needs this.
}

/** Where the person sits for this tab: the placement's region and area, else what they told the bot. */
function placeText(row: WorkspaceRow, viewingTab: string | null): string | null {
  const placement = row.placements.find((item) => item.tab === viewingTab) ?? null;
  if (placement && (placement.regionName || placement.areaName)) return [placement.regionName, placement.areaName].filter(Boolean).join(" · ");
  const told = TABLE_PLACE_KEYS.map((key) => row.answers.find((chip) => chip.key === key)?.value).filter((value): value is string => Boolean(value));
  return told.length > 0 ? told.join(" · ") : null;
}

function NotAsked() {
  return <span className="text-xs font-semibold text-slate-400">Not asked</span>;
}

export function CandidateTable({
  answerOptions,
  canEdit,
  canSelect,
  detailFor,
  onSaveAnswer,
  onSelect,
  onToggle,
  openedId,
  rows,
  selected,
  showEveryPlacement,
  today,
  viewingTab,
}: {
  answerOptions?: Readonly<Record<string, readonly AnswerOption[]>>;
  canEdit: boolean;
  canSelect: boolean;
  /** A full-width row under the OPENED row (the placing form on Needs placing), or null. */
  detailFor?: (row: WorkspaceRow) => ReactNode | null;
  onSaveAnswer?: (row: WorkspaceRow, chip: WorkspaceAnswerChip, value: string | null) => Promise<void>;
  onSelect?: (id: string, checked: boolean, withShift: boolean) => void;
  onToggle: (id: string) => void;
  openedId: string | null;
  rows: readonly WorkspaceRow[];
  selected: ReadonlySet<string>;
  showEveryPlacement: boolean;
  today: string;
  viewingTab: string | null;
}) {
  const ticks = canSelect && Boolean(onSelect);
  // The pinned head's own height, so a row stepped into view (j/k, the arrows) stops below it too.
  const headRef = useRef<HTMLTableSectionElement | null>(null);
  const [headHeight, setHeadHeight] = useState(0);
  useEffect(() => {
    const head = headRef.current;
    if (!head) return;
    const observer = new ResizeObserver(() => setHeadHeight(head.offsetHeight));
    observer.observe(head);
    setHeadHeight(head.offsetHeight);
    return () => observer.disconnect();
  }, []);
  const wideColumns = columnsFor(WIDE_COLUMNS, ticks);
  const compactColumns = columnsFor(COMPACT_COLUMNS, ticks);
  const tick = (row: WorkspaceRow) =>
    ticks && onSelect ? (
      <td className={cn(bodyCell, "relative px-0 text-center")}>
        <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px]", statusEdgeClassName[row.status])} />
        <input
          aria-label={`Tick ${row.name}`}
          checked={selected.has(row.id)}
          className={cn(phxCheckInputClassName, "mt-0.5")}
          onChange={ignoreChange}
          onClick={(event) => onSelect(row.id, event.currentTarget.checked, event.shiftKey)}
          type="checkbox"
        />
      </td>
    ) : null;

  const answer = (row: WorkspaceRow, key: string) => {
    const chip = row.answers.find((item) => item.key === key);
    if (!chip) return <NotAsked />;
    return (
      <AnswerChip
        canEdit={canEdit}
        chip={chip}
        onSave={onSaveAnswer ? (target, value) => onSaveAnswer(row, target, value) : undefined}
        options={answerOptions?.[chip.key]}
        today={today}
        variant="cell"
      />
    );
  };

  const stack = (row: WorkspaceRow, keys: readonly (typeof TABLE_LEAD_KEYS)[number][]) => (
    <dl className="space-y-2">
      {keys.map((key) => (
        <div key={key}>
          <dt className="text-phx-xs font-black uppercase tracking-wide text-slate-500">{TABLE_LEAD_LABELS[key]}</dt>
          <dd className="mt-0.5">{answer(row, key)}</dd>
        </div>
      ))}
    </dl>
  );

  const others = (row: WorkspaceRow) => {
    const rest = row.answers.filter((chip) => !(TABLE_LEAD_KEYS as readonly string[]).includes(chip.key) && !TABLE_PLACE_KEYS.includes(chip.key));
    if (rest.length === 0) return <span className="text-xs font-semibold text-slate-400">None</span>;
    return (
      <dl className="space-y-1.5">
        {rest.map((chip) => (
          <div key={chip.key}>
            <dt className="break-words text-phx-xs font-black uppercase tracking-wide text-slate-500" dir="auto">
              {chip.label}
            </dt>
            <dd className="mt-0.5">{answer(row, chip.key)}</dd>
          </div>
        ))}
      </dl>
    );
  };

  const openRow = (event: MouseEvent<HTMLTableRowElement>, id: string) => {
    // A press on a control in the row is that control's; anywhere else on the row opens the CV.
    if ((event.target as HTMLElement).closest("button, a, input, select, textarea, label, [role='dialog']")) return;
    onToggle(id);
  };

  return (
    <div className="@container !overflow-visible" style={{ "--ws-head-h": `${headHeight}px` } as CSSProperties}>
      <table aria-label="Candidates" className="hidden w-full table-fixed border-collapse md:table" data-portal-desktop-table>
        <colgroup>
          {wideColumns.map((column, index) => (
            <col
              className={COL_WIDTH}
              key={column.key}
              style={{ "--ws-compact": `${compactColumns[index]?.percent ?? 0}%`, "--ws-wide": `${column.percent}%` } as CSSProperties}
            />
          ))}
        </colgroup>
        <thead ref={headRef}>
          <tr className={`${adminPanelHeaderClassName} text-white`}>
            {ticks ? (
              <th className={cn(headCell, "px-0 text-center")} scope="col">
                <span className="sr-only">Tick</span>
              </th>
            ) : null}
            <th className={headCell} scope="col">
              Candidate
            </th>
            {TABLE_LEAD_KEYS.map((key) => (
              <th className={cn(headCell, WIDE_ONLY)} key={key} scope="col">
                {TABLE_LEAD_LABELS[key]}
              </th>
            ))}
            <th className={cn(headCell, WIDE_ONLY)} scope="col">
              Region · Area
            </th>
            <th className={cn(headCell, WIDE_ONLY, LAST_WIDE)} scope="col">
              Other answers
            </th>
            <th className={cn(headCell, COMPACT_ONLY)} scope="col">
              Applying for · Graduated · Experience
            </th>
            <th className={cn(headCell, COMPACT_ONLY, LAST_COMPACT)} scope="col">
              Salary · Start · Age
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const opened = row.id === openedId;
            const detail = opened && detailFor ? detailFor(row) : null;
            const place = placeText(row, viewingTab);
            return (
              <Fragment key={row.id}>
                <tr
                  className={cn(
                    // A row scrolled into view stops under the pinned header and the table's pinned head.
                    "cursor-pointer scroll-mt-[calc(var(--ws-row-margin,0px)+var(--ws-head-h,0px))] border-t border-slate-200 transition-colors",
                    opened ? "bg-orange-50/80" : selected.has(row.id) ? "bg-sky-50/60" : index % 2 === 1 ? "bg-slate-50/70" : "bg-white",
                    !opened ? "hover:bg-orange-50/40" : null,
                    row.archivedAt ? "opacity-80" : null,
                  )}
                  data-candidate-row={row.id}
                  data-opened={opened ? "true" : undefined}
                  id={`ws-row-${row.id}`}
                  onClick={(event) => openRow(event, row.id)}
                >
                  {tick(row)}
                  <td className={cn(bodyCell, "relative")}>
                    {!ticks ? <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px]", statusEdgeClassName[row.status])} /> : null}
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <button
                        aria-controls="ws-opened-cv"
                        aria-expanded={opened}
                        className="group inline-flex max-w-full items-center gap-1 text-left text-[15px] font-black leading-5 tracking-tight text-slate-950 transition hover:text-orange-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
                        onClick={() => onToggle(row.id)}
                        type="button"
                      >
                        <span className="break-words" dir="auto">
                          {row.name}
                        </span>
                        <ChevronDown
                          aria-hidden
                          className={cn("h-4 w-4 shrink-0 text-slate-400 transition group-hover:text-orange-600", opened ? "-rotate-90 text-orange-600" : null)}
                        />
                      </button>
                      <span className={cn("inline-flex items-center border px-1.5 py-px text-phx-xs font-black uppercase tracking-[0.06em]", chipToneClassName[statusTone[row.status]])}>
                        {candidateStatusLabels[row.status]}
                      </span>
                    </div>
                    <p className="mt-1 text-xs font-semibold text-slate-600">
                      {candidateSourceLabels[row.source] ?? row.source}
                      <span aria-hidden className="px-1.5 text-slate-300">
                        ·
                      </span>
                      <time className="tabular-nums" dateTime={row.receivedAt}>
                        {cairoStamp(row.receivedAt, today)}
                      </time>
                    </p>
                    {place ? (
                      <p className={cn("mt-1 break-words text-xs font-bold text-slate-800", COMPACT_ONLY)} dir="auto">
                        {place}
                      </p>
                    ) : null}
                    <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1">
                      <RowFlags row={row} showEveryPlacement={showEveryPlacement} today={today} viewingTab={viewingTab} />
                    </div>
                  </td>
                  {TABLE_LEAD_KEYS.map((key) => (
                    <td className={cn(bodyCell, WIDE_ONLY)} key={key}>
                      {answer(row, key)}
                    </td>
                  ))}
                  <td className={cn(bodyCell, WIDE_ONLY)}>
                    {place ? (
                      <span className="break-words text-sm font-semibold text-slate-900" dir="auto">
                        {place}
                      </span>
                    ) : (
                      <span className="text-xs font-semibold text-slate-400">Not said</span>
                    )}
                  </td>
                  <td className={cn(bodyCell, WIDE_ONLY, LAST_WIDE)}>{others(row)}</td>
                  <td className={cn(bodyCell, COMPACT_ONLY)}>{stack(row, FIRST_STACK)}</td>
                  <td className={cn(bodyCell, COMPACT_ONLY, LAST_COMPACT)}>
                    {stack(row, SECOND_STACK)}
                    <div className="mt-2 border-t border-slate-200 pt-2">{others(row)}</div>
                  </td>
                </tr>
                {detail ? (
                  <tr className="border-t border-orange-200 bg-orange-50/40">
                    {/* The colgroup declares the wide count in both layouts, so this spans the row in either. */}
                    <td className="p-3" colSpan={wideColumns.length}>
                      {detail}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>

      {/* A phone: the two-line cards, the same flags and the same editing. */}
      <div className="md:hidden" role="list">
        {rows.map((row) => (
          <div key={row.id} role="listitem">
            <CandidateRow
              anchorId={`ws-card-${row.id}`}
              answerOptions={answerOptions}
              canEdit={canEdit}
              onSaveAnswer={onSaveAnswer}
              onSelect={ticks ? onSelect : undefined}
              onToggle={onToggle}
              opened={row.id === openedId}
              row={row}
              selected={selected.has(row.id)}
              showEveryPlacement={showEveryPlacement}
              today={today}
              viewingTab={viewingTab}
            />
            {row.id === openedId && detailFor ? <div className="border-b border-orange-200 bg-orange-50/40 p-3">{detailFor(row)}</div> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The wrapper's depth, for the caller that frames the table. */
export const candidateTableFrameClassName = `min-w-0 border border-slate-200 bg-white ${adminPanelDepthClassName}`;
