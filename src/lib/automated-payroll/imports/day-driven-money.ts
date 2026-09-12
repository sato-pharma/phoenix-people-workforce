import { dayDrivenMoney, stepDefinition } from "../step-definitions.ts";
import type { StepEditInput, StepKey, StepRow } from "../types.ts";

/**
 * A corrected day count in a re-uploaded sheet moves the money it drives, as it does on screen
 * (audit finding 32).
 *
 * Typing a day count into the grid re-prices the money beside it through the field's own day-rate.
 * The same correction made in the downloaded template did not: the parser copies numbers across, the
 * template pre-fills the money columns with the OLD figures, and a saved money figure always wins
 * over the day-share (`pick` in recommend.ts). So a leaver corrected from 12 days to 4.5 in the sheet
 * was settled for 12, while the Resignations CRM tab, which reads the stored day count, used 4.5.
 *
 * Only a money figure the sheet left UNTOUCHED moves. One HR changed alongside the days is their
 * decision and stands, exactly as a typed amount does on screen.
 *
 * Two steps are different:
 *   - Resignations: the money is not re-priced here at all. It is CLEARED, so the settlement rule
 *     re-derives it from the saved day count. That rule knows what a flat day-rate cannot: a leaver
 *     whose last day is after the 25th is paid in full, a dismissal is not a resignation, and a
 *     same-month joiner is paid from the hire date.
 *   - Unpaid Vacation, for a leaver: nothing moves. Their figure is a balance-aware settlement, not a
 *     day-rate, and the server has never let a day count drive it (see stepEditToPatch).
 *
 * Pure: priced against the rows as they stood BEFORE the upload, so preview and commit move the same
 * money.
 */
export type DayDrivenMoneyResult = {
  edits: StepEditInput[];
  /** Money keys to clear so the settlement rule recalculates them, keyed by lower-cased HR id. */
  recalculated: Map<string, string[]>;
};

const cents = (value: number) => Math.round(value * 100);

export function applyDayDrivenMoney(input: {
  stepKey: StepKey;
  edits: StepEditInput[];
  current: StepRow[];
  /**
   * The run's own month length — the one divisor for pay and for deductions (owner ruling
   * 2026-09-12, audit finding 37). Required, so that a re-uploaded sheet and the grid price a
   * corrected day count identically; see dayDrivenMoney's own note on why there is no fallback.
   */
  monthDays: number;
}): DayDrivenMoneyResult {
  const definition = stepDefinition(input.stepKey);
  const recalculated = new Map<string, string[]>();
  const dayFields = definition.isHoldStep
    ? []
    : definition.fields.filter((field) => field.kind === "days" && field.autoCalcMoneyKey && !field.notPersisted);
  if (dayFields.length === 0) return { edits: input.edits, recalculated };

  const currentByHr = new Map(input.current.map((row) => [row.hrId.toLowerCase(), row]));
  const edits = input.edits.map((edit) => {
    const key = String(edit.hrId ?? "").toLowerCase();
    const current = currentByHr.get(key);
    if (!current || current.readOnly || !edit.values) return edit;
    if (input.stepKey === "p1_unpaid_vacation" && current.lifecycle === "leaver") return edit;

    const values = { ...edit.values };
    for (const field of dayFields) {
      const days = values[field.key];
      if (days === undefined) continue;
      if (cents(days) === cents(current.values[field.key] ?? 0)) continue;

      const moneyKeys = [
        field.autoCalcMoneyKey as string,
        ...(field.autoCalcCompanionMoneyKeys ?? []).map((companion) => companion.key),
      ];
      const untouched = moneyKeys.filter(
        (moneyKey) =>
          values[moneyKey] === undefined || cents(values[moneyKey]) === cents(current.values[moneyKey] ?? 0),
      );
      if (untouched.length === 0) continue;

      if (input.stepKey === "p1_resignations") {
        for (const moneyKey of untouched) delete values[moneyKey];
        recalculated.set(key, [...(recalculated.get(key) ?? []), ...untouched]);
        continue;
      }
      const derived = dayDrivenMoney(field, current.context, days, input.monthDays);
      for (const moneyKey of untouched) {
        if (derived[moneyKey] !== undefined) values[moneyKey] = derived[moneyKey];
      }
    }
    return { ...edit, values };
  });
  return { edits, recalculated };
}
