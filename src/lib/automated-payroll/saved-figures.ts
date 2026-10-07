/**
 * A SAVE ON A DEDUCTION STEP WRITES ONLY THE FIGURES SOMEBODY CHANGED.
 *
 * WHY THIS EXISTS (the live September 2026 run, 2026-10-07). The grid sends EVERY row it shows
 * (recommendation-step.tsx `toEdits`), and `saveStep` wrote each one onto the draft. The Part 2 "Any
 * more deductions?" step was saved as a whole grid of 103 rows on 2026-10-06 while the module still
 * proposed 0.00 for every line not yet pushed, so it wrote 0.00 for everybody — and 8,405.17 EGP later
 * approved for two employees stayed behind a 0.00 nobody typed, because `pick` in recommend.ts prefers
 * a saved figure over the module's.
 *
 * deduction-resync.ts now releases a saved figure on an unconfirmed step unless the cell history says a
 * PERSON saved it (`isTypedByHand`, write_reason `step_saved`). That test is only as good as what a save
 * writes: the history trigger records every cell a save CHANGES, so a whole-grid save writing 0.00 into
 * 103 empty cells would record 103 "person saved it" entries, and the next approval would be kept out of
 * all 103 rows exactly as in September. So a save must not write a figure nobody chose.
 *
 * `writeIsUntouched` is the test, and it is asked of each FIGURE GROUP on its own (`figureGroups`): a day
 * count with the money it drives, or a lone figure. A group is untouched when every figure is exactly
 * what the draft already holds, what the step shows for it right now (a module figure swapped in for a
 * stale confirmed one, a CRM value re-derived from stored days), or — for a cell that held nothing — the
 * proposal the person's SCREEN showed (`StepEditInput.recommended`). The screen's proposal, not the
 * server's newer one: a grid left open while a deduction was approved still shows the old proposal, and
 * judging its untouched figure against the new one would turn that stale figure into an override nobody
 * typed. An untouched group is not written at all, so it keeps following the module and the history
 * records nothing. Per group, not per row: "Other Part 1 deductions" carries a loan pair and an "other"
 * pair on one row, and typing the loan must not stamp the other pair's 0.00 as typed.
 *
 * Known edge, accepted: typing into an EMPTY cell the very figure the screen proposed is not written
 * either, so that cell keeps following the module. It cannot be told apart from an untouched cell, and
 * it held the module's figure at the moment it was typed.
 */

import { stepDefinition } from "./step-definitions.ts";
import type { StepKey } from "./types.ts";

/** One employee's figures on one save, keyed by draft field (a DraftRow key). */
export type FigureWrite = {
  compact: string;
  /** What the save puts in each field. null = the save clears it. */
  written: Record<string, number | null>;
  /** What the screen proposed for each field. Absent = it proposed nothing for it. */
  proposed: Record<string, number>;
  /** What the draft held in each field immediately before the save. */
  before: Record<string, number | null | undefined>;
  /** What the step shows for each field right now, as the server reads it. Absent = nothing shown. */
  shown?: Record<string, number>;
};

function isFigure(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Money is stored to the piastre, so two figures within half of one are the same figure. */
function sameFigure(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.005;
}

/**
 * True when a save would change nothing a person chose in these figures — each one is exactly what the
 * draft already holds, what the step shows now, or the screen's own proposal for a cell that held
 * nothing. Judged as a group, so a day count and its money are written together or not at all.
 */
export function writeIsUntouched(write: FigureWrite): boolean {
  return Object.keys(write.written).every((field) => {
    const value = write.written[field];
    const before = write.before[field];
    // A clear is a change only when there was a figure to clear.
    if (!isFigure(value)) return !isFigure(before);
    if (isFigure(before) && sameFigure(before, value)) return true;
    // The figure the step shows now. It differs from the draft only where the server put a figure
    // nobody typed in front of a stale one, so sending it back is no change by a person.
    const shown = write.shown?.[field];
    if (isFigure(shown) && sameFigure(shown, value)) return true;
    if (isFigure(before)) return false;
    const proposed = write.proposed[field];
    return isFigure(proposed) && sameFigure(proposed, value);
  });
}

/**
 * The step's figures in the groups a save judges together: each day count with the money it drives
 * (`autoCalcMoneyKey`), every other figure on its own. Only fields in `fields` are returned.
 *
 * On "Unpaid Vacation" a leaver's figure lands on `unpaidVacations` and the column it replaces is cleared
 * beside it (run-service.ts `stepEditToPatch`), so both columns belong to the one vacation figure.
 */
export function figureGroups(stepKey: StepKey, fields: readonly string[]): string[][] {
  const groupOf = new Map<string, string>();
  for (const spec of stepDefinition(stepKey).fields) {
    if (spec.autoCalcMoneyKey && !spec.notPersisted) groupOf.set(spec.key, spec.autoCalcMoneyKey);
  }
  if (stepKey === "p1_unpaid_vacation") groupOf.set("unpaidVacations", "p1odVacationValue");
  const groups = new Map<string, string[]>();
  for (const field of fields) {
    const id = groupOf.get(field) ?? field;
    groups.set(id, [...(groups.get(id) ?? []), field]);
  }
  return [...groups.values()];
}

function pickFields<T>(record: Record<string, T> | undefined, fields: readonly string[]): Record<string, T> {
  const picked: Record<string, T> = {};
  if (!record) return picked;
  for (const field of fields) if (field in record) picked[field] = record[field];
  return picked;
}

/** The fields of every group nobody changed — the ones a save leaves out. */
export function untouchedFigureFields(write: FigureWrite, groups: readonly (readonly string[])[]): string[] {
  const untouched: string[] = [];
  for (const group of groups) {
    const part: FigureWrite = {
      compact: write.compact,
      written: pickFields(write.written, group),
      proposed: pickFields(write.proposed, group),
      before: pickFields(write.before, group),
      shown: pickFields(write.shown, group),
    };
    if (writeIsUntouched(part)) untouched.push(...group);
  }
  return untouched;
}
