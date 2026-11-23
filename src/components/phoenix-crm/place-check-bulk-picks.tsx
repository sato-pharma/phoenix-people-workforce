"use client";

/**
 * Ticking several Place checks rows — the bulk answers' types, the ticks, the run that holds the board and
 * the pick line. Moved out of `place-check-bulk.tsx` unchanged on 23 Nov 2026, so no file of Place checks
 * is over 400 lines; that file re-exports everything here, so import from it.
 */

import { createContext, useMemo, useState, useSyncExternalStore } from "react";
import type { PlaceCheckOutcome } from "@/components/phoenix-crm/place-check-done";
import { CrmCheck } from "@/components/phoenix-crm/ui";
import type { ValidationRefusalReason } from "@/lib/phoenix-crm/validation-feedback";

/** What a bulk action is given for each row it runs on. The reason and the note are typed once. */
export type BulkAnswer = { note: string; reason: ValidationRefusalReason | "" };

export type BulkAction<Row> = {
  /** Stable key, so a run can say which action is in flight. */
  key: string;
  /** The button, which carries the count it will act on: "Reject (4)". */
  label: string;
  busyLabel: string;
  variant: "primary" | "danger";
  /** Whether the closed pick-list must be answered before this one may run. */
  needsReason: boolean;
  /** What it costs, said before it runs. A destructive action arms on the first press. */
  warning?: (count: number) => string;
  /** Which of the ticked rows this action can actually answer. */
  takes: (row: Row) => boolean;
  /**
   * The ONE row request the page already makes. It answers `unknown` because that is what `crmPost`
   * hands back (`body[key]`, the value); `outcomeOf` reads it.
   */
  run: (row: Row, answer: BulkAnswer) => Promise<unknown>;
  /**
   * What the server's answer says was done, in the row control's own words — `approvalOutcome` for an
   * approval, so a customer behind a building still being checked reads "Approved, waits for the
   * building" here too, never a plain "Approved" (owner, 14 Nov 2026).
   */
  outcomeOf: (answer: unknown, row: Row) => PlaceCheckOutcome;
};

/** What one section's tick boxes hand its bar. Written out, so the bar takes it as a plain prop. */
export type RowPicks<Row> = {
  /** Every ticked row still on screen — the set every action is filtered from. */
  picked: readonly Row[];
  /** How many rows could be ticked at all, for the "Pick all" line. */
  selectable: number;
  isPicked: (row: Row) => boolean;
  toggle: (row: Row, next: boolean) => void;
  pickAll: () => void;
  /** Tick exactly the rows on screen that pass `test` — what the system's recommendation picks. */
  pickWhere: (test: (row: Row) => boolean) => void;
  /** The rows on screen that could be ticked, for counting what `pickWhere` would take. */
  rows: readonly Row[];
  clear: () => void;
};

/**
 * What is ticked, intersected with what is on screen.
 *
 * The ids live in state and the rows are the authority: `picked` is derived at every render, so a row
 * the filters removed is simply not in it and no action can reach it.
 */
export function useRowPicks<Row>(
  rows: readonly Row[],
  idOf: (row: Row) => string,
  selectable: (row: Row) => boolean = () => true,
): RowPicks<Row> {
  const [ticked, setTicked] = useState<readonly string[]>([]);
  const onScreen = useMemo(() => {
    const map = new Map<string, Row>();
    for (const row of rows) if (selectable(row)) map.set(idOf(row), row);
    return map;
  }, [idOf, rows, selectable]);
  const picked = useMemo(() => ticked.map((id) => onScreen.get(id)).filter((row): row is Row => row !== undefined), [onScreen, ticked]);

  return {
    picked,
    selectable: onScreen.size,
    isPicked: (row: Row) => ticked.includes(idOf(row)),
    toggle: (row: Row, next: boolean) => {
      const id = idOf(row);
      setTicked((current) => (next ? [...current.filter((each) => each !== id), id] : current.filter((each) => each !== id)));
    },
    pickAll: () => setTicked([...onScreen.keys()]),
    pickWhere: (test) => setTicked([...onScreen.entries()].filter(([, row]) => test(row)).map(([id]) => id)),
    rows: [...onScreen.values()],
    clear: () => setTicked([]),
  };
}

/**
 * 🔴 A BULK RUN HOLDS THE BOARD STILL UNTIL IT ENDS (17 Nov 2026, the audit's background runs). Each
 * section's bar is remounted by a tab, a filter or a tapped count, so a run started on twelve rows and
 * followed by a tab change went on answering out of sight: its "Saved" line and every row that would not
 * answer were drawn into a bar no longer on the screen. While a run is going the board's tabs, filters and
 * counts wait (`useBulkRunGoing`), and so does every other bar, so two runs never overlap.
 */
let bulkRunGoing = false;
const bulkRunListeners = new Set<() => void>();

export function setBulkRunGoing(next: boolean) {
  if (bulkRunGoing === next) return;
  bulkRunGoing = next;
  for (const listener of bulkRunListeners) listener();
}

function subscribeBulkRun(listener: () => void): () => void {
  bulkRunListeners.add(listener);
  return () => {
    bulkRunListeners.delete(listener);
  };
}

/**
 * The same lock for a run that is not a tick-box bar: the Ready lane's one press (the rebuild, 23 Nov
 * 2026). It holds the board exactly as a bar's run does, and the function it returns lets go. A second
 * run while one is going is refused with null, so two runs never overlap.
 */
export function holdBoardForBulkRun(): (() => void) | null {
  if (bulkRunGoing) return null;
  setBulkRunGoing(true);
  return () => setBulkRunGoing(false);
}

/** Whether a bulk run is going anywhere on the page — the board locks its tabs, filters and counts on it. */
export function useBulkRunGoing(): boolean {
  return useSyncExternalStore(subscribeBulkRun, () => bulkRunGoing, () => false);
}

/**
 * 🔴 ON THE BOARD WITH LANES THE BAR'S FIRST LINE STANDS IN ITS SECTION'S TITLE ROW (owner, 23 Nov 2026:
 * "Add Pick rows to 707"). The line ("Pick rows to answer together", Pick all, the two quick picks, Clear)
 * was a 61 px box of its own between the section's title and its first waiting place. A section hands its
 * title row's slot down here and the bar draws the line into it; the reason, the note and the action
 * buttons still open in the box under the title, where they always did.
 *
 * It is the SAME line with the same state, drawn in another place: never a second copy, never a second way
 * to pick. `undefined` is a section with no slot (every board and panel but the lanes) and the bar is whole,
 * as before. `null` is a slot not on the page yet: nothing is drawn for that one render, so the line never
 * stands in the old place first and then jumps.
 *
 * 🔴 NO WIDTH CAP ON THE SLOT. Set on the live page's own elements (23 Nov 2026, nothing pressed): with no
 * cap the line gives back 61 px on his own screen with none, one or two quick picks, 37 px in a 1,126 px
 * column (9 px there with two quick picks) and 9 px under the title in a 900 or 700 px column: never a
 * loss. A 576 or 672 px cap wrapped the buttons beside the title, gave back 41 px on his screen and COST
 * 35 px in a 900 px column with one quick pick.
 */
export const BulkPickLineSlot = createContext<HTMLElement | null | undefined>(undefined);

/** The tick box on one row — the same control in the cards and in the table. */
export function BulkPick<Row>({ picks, row }: { picks: RowPicks<Row>; row: Row }) {
  return (
    <CrmCheck checked={picks.isPicked(row)} onChange={(next) => picks.toggle(row, next)}>
      <span className="text-xs font-black uppercase tracking-[0.12em] text-slate-500">Pick</span>
    </CrmCheck>
  );
}
