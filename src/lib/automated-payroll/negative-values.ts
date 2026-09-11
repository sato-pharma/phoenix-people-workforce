import type { StepDefinition, StepEditInput, StepRow } from "./types.ts";

/**
 * Nothing typed onto a payroll step may be negative (audit finding 42).
 *
 * No layer refused a negative figure: not the input box, not the route, not `saveStep`, and not the
 * pre-flight validator, whose negative checks covered only base, net, gross and the deductions
 * TOTAL. A negative bonus is therefore a deduction travelling through the additions side, where no
 * deduction guard can see it, and a negative deduction is an addition nobody approved. During Part 2
 * it could surface as an overpaid row, which is a partial catch at best.
 *
 * Refused rather than clamped to zero: a silent clamp changes a figure HR typed and leaves no trace
 * of what they meant, which is the same failure in a quieter form. Day counts are included, because
 * a negative day count drives a negative amount through the step's own day-rate.
 *
 * Checked in `saveStep`, the one door both the inline grid and a re-uploaded xlsx come through.
 */
export type NegativeStepValue = { hrId: string; fullName: string | null; field: string; value: number };

export function findNegativeStepValues(
  definition: StepDefinition,
  edits: StepEditInput[],
  currentRows: StepRow[],
): NegativeStepValue[] {
  const labels = new Map(definition.fields.map((field) => [field.key, field.label]));
  const names = new Map(currentRows.map((row) => [row.hrId.toLowerCase(), row.fullName]));
  const found: NegativeStepValue[] = [];
  for (const edit of edits) {
    const hrId = String(edit.hrId ?? "");
    for (const [key, raw] of Object.entries(edit.values ?? {})) {
      const value = Number(raw);
      if (Number.isFinite(value) && value < 0) {
        found.push({ hrId, fullName: names.get(hrId.toLowerCase()) ?? null, field: labels.get(key) ?? key, value });
      }
    }
  }
  return found;
}

export function assertNoNegativeStepValues(
  definition: StepDefinition,
  edits: StepEditInput[],
  currentRows: StepRow[],
): void {
  const found = findNegativeStepValues(definition, edits, currentRows);
  if (found.length === 0) return;
  const shown = found.slice(0, 6).map((entry) => `${entry.fullName ?? entry.hrId}: ${entry.field} ${entry.value}`);
  const more = found.length > shown.length ? ` and ${found.length - shown.length} more` : "";
  throw new Error(
    `Validation: nothing on the ${definition.title} step can be negative. A negative addition is a deduction ` +
      `no deduction check can see, and a negative deduction is an addition nobody approved. ` +
      `Correct ${shown.join("; ")}${more}.`,
  );
}
