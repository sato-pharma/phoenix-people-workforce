const fridayOnlyTitlePatterns = [
  /\bmedical\s+rep(?:resentative)?\b/i,
  /\bmedical\s+representative\b/i,
  /\bdistrict\s+(?:sales\s+)?manager\b/i,
];

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function isFieldWorkforceFridayOnlyTitle(title: string | null | undefined) {
  const normalized = String(title ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return fridayOnlyTitlePatterns.some((pattern) => pattern.test(normalized));
}

export function isFieldWorkforceFriday(dateIso: string) {
  if (!isIsoDate(dateIso)) return false;
  return new Date(`${dateIso}T00:00:00Z`).getUTCDay() === 5;
}

export function isFieldWorkforceSaturday(dateIso: string) {
  if (!isIsoDate(dateIso)) return false;
  return new Date(`${dateIso}T00:00:00Z`).getUTCDay() === 6;
}

export function isFieldWorkforceWeeklyOff(input: {
  dateIso: string;
  title?: string | null;
}) {
  if (isFieldWorkforceFriday(input.dateIso)) return true;
  if (!isFieldWorkforceSaturday(input.dateIso)) return false;
  return !isFieldWorkforceFridayOnlyTitle(input.title);
}

export function isFieldWorkforceThursday(dateIso: string) {
  if (!isIsoDate(dateIso)) return false;
  return new Date(`${dateIso}T00:00:00Z`).getUTCDay() === 4;
}

/**
 * THURSDAY IS A HALF DAY for the field workforce (owner rule, 2026-08-02):
 * "medical reps working days are from sat to wednesday AM and PM, thursday am or meeting or
 * health day only". The week is Saturday-Wednesday full days, Thursday morning only, Friday off.
 *
 * Nothing here encoded that until now — Thursday was an ordinary full working day to every engine
 * that imports this file, so a rep with no CRM visit on a Thursday was measured against a FULL
 * day's expectation and deducted a FULL day. Measured on July 2026 production, Thursday produced
 * 89 of the 306 flagged employee-days (29.1%, 43 employees, 81,950 EGP) — more than any genuine
 * full working day, which is the signature of a rule error rather than of behaviour.
 *
 * It is a HALF day rather than a day off because Thursday morning IS worked. A meeting or a health
 * day is also work (Health Day maps to CP, not leave) and does not always leave a customer-visit
 * row behind, which is why the morning cannot be held to a full day's evidence.
 */
export function isFieldWorkforceHalfDay(input: { dateIso: string; title?: string | null }) {
  if (isFieldWorkforceWeeklyOff(input)) return false;
  return isFieldWorkforceThursday(input.dateIso);
}

/**
 * What ONE no-activity day is worth, as a fraction of a full day: 0 on a weekly off, 0.5 on a
 * Thursday, 1 otherwise.
 *
 * Every path that turns no-activity DATES into MONEY must go through here. The deduction rules in
 * this area have been half-implemented before — one surface corrected while the others kept paying
 * the old number — so the weight gets exactly one home.
 */
export function fieldWorkforceDeductionDayWeight(input: { dateIso: string; title?: string | null }) {
  if (isFieldWorkforceWeeklyOff(input)) return 0;
  return isFieldWorkforceHalfDay(input) ? 0.5 : 1;
}

/** Weighted day-count for a set of no-activity dates — what `deductionDays` must be given. */
export function sumFieldWorkforceDeductionDayWeights(
  dates: readonly string[],
  title?: string | null,
) {
  let total = 0;
  for (const dateIso of dates) total += fieldWorkforceDeductionDayWeight({ dateIso, title });
  // Half-days only ever produce .0 or .5, so two decimals is exact — this just clears any
  // floating-point dust before the figure is multiplied by a salary.
  return Math.round(total * 100) / 100;
}

/**
 * One date's share expressed in HALF-DAY UNITS (Thursday 1, full day 2, weekly off 0).
 *
 * Lets a breakdown panel split an amount in proportion to each date's weight while reusing the
 * existing even-split helper unchanged: distributing across units and regrouping preserves the
 * exact-sum guarantee that per-date proportional rounding would lose.
 */
export function fieldWorkforceDeductionUnits(dateIso: string, title?: string | null) {
  return Math.round(fieldWorkforceDeductionDayWeight({ dateIso, title }) * 2);
}
