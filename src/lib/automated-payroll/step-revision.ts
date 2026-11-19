/**
 * A STEP SAVE CHECKS EVERY FIGURE IT WRITES, NOT ONLY THE STEP (F-PAY-017, 19 Nov 2026).
 *
 * A step's revision is its state row's `updated_at` (payroll audit 2026-11-14, finding 1): a stale screen or an
 * older step file is refused when the STEP moved since it was loaded. But a draft row can change without the step
 * moving — a Deductions or expense decision landing on a step nobody confirmed clears its figure and writes no
 * step state (deduction-resync.ts, expense-resync.ts) — and the screen then saved the figure it was still showing
 * straight back over the cleared one. The draft rows carry no version of their own.
 *
 * Every write to a draft-row figure already leaves a numbered line in `automated_payroll_draft_cell_history`
 * (a trigger, so no writer can skip it), and the numbers only rise. So the revision the screen and the step file
 * carry now also names the highest line the run had when the step was read — its CELL WATERMARK — and a save is
 * refused when any figure it is about to write has a newer line: exactly the figures that changed underneath the
 * screen, never a figure of another step or another person, so two people saving different steps never refuse
 * each other. Writers are serialised by the run's hold, so a line numbered below the watermark was committed
 * before it was read.
 *
 * Format: `<step updated_at | "none">|cells:<watermark>`. A revision with no `|cells:` part (an older screen, or a
 * file built before this) is judged on the step alone, as before. Pure on purpose: tests import it.
 */

const CELLS_MARK = "|cells:";
const NO_STEP_STATE = "none";

/** The revision a screen or a step file carries: the step's own, plus the run's cell watermark when known. */
export function encodeStepRevision(stepUpdatedAt: string | null, cellWatermark: number | null): string | null {
  if (cellWatermark === null || !Number.isFinite(cellWatermark)) return stepUpdatedAt;
  return `${stepUpdatedAt ?? NO_STEP_STATE}${CELLS_MARK}${Math.max(0, Math.trunc(cellWatermark))}`;
}

/**
 * What a carried revision says. `step` is the step's `updated_at` (null: the step had never been saved;
 * undefined: nothing was carried at all). `watermark` is null when the revision names none.
 */
export function parseStepRevision(value: string | null | undefined): {
  step: string | null | undefined;
  watermark: number | null;
} {
  if (value === undefined) return { step: undefined, watermark: null };
  if (value === null) return { step: null, watermark: null };
  const at = value.indexOf(CELLS_MARK);
  if (at < 0) return { step: value, watermark: null };
  const stepPart = value.slice(0, at);
  const watermark = Number(value.slice(at + CELLS_MARK.length));
  return {
    step: stepPart === NO_STEP_STATE || stepPart === "" ? null : stepPart,
    watermark: Number.isFinite(watermark) && watermark >= 0 ? Math.trunc(watermark) : null,
  };
}

/** One recorded change to a draft-row figure: whose row, which column, and the line's number. */
export type CellWrite = { id: number; compact: string; column: string; changedBy: string | null; writeReason: string | null };

/**
 * The figures a save would write over a change it never saw: every recorded change numbered above the watermark
 * to a (person, column) the save writes. `writes` maps a lower-cased compact HR id to the database columns the
 * save's patch for that person carries.
 */
export function cellsChangedSince(
  changes: readonly CellWrite[],
  watermark: number,
  writes: ReadonlyMap<string, ReadonlySet<string>>,
): CellWrite[] {
  return changes.filter((change) => change.id > watermark && (writes.get(change.compact.toLowerCase())?.has(change.column) ?? false));
}

/** The refusal's list of who changed underneath the screen, by HR id, each once, in the order first seen. */
export function describeCellConflicts(conflicts: readonly CellWrite[], hrIdOf: (compact: string) => string): string {
  const people: string[] = [];
  for (const conflict of conflicts) {
    const name = hrIdOf(conflict.compact);
    if (!people.includes(name)) people.push(name);
  }
  const shown = people.slice(0, 6).join(", ");
  return people.length > 6 ? `${shown} and ${people.length - 6} more` : shown;
}
