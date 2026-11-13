// Daily Deductions module: the pure clip + aggregate. No DB, no I/O.
//
// A connector emits month-scoped DeductionsCandidateDraft[] (each carrying the
// specific days behind it). clipDraftToRange keeps only the in-range days and
// re-derives the day count and amount from the survivors, using the SAME
// scaleDeductionAmountToDays the month module uses to keep "days shown" and
// "money charged" in step. aggregateClippedLines then sums per employee×category
// into the running-tally lines a publication stores.

import { scaleDeductionAmountToKeptDates } from "@/lib/deductions/calculations.ts";
import { sumDetectedDeductionDayWeights } from "@/lib/field-workforce-compliance/weekend-policy.ts";
import { compactDeductionsHrId } from "@/lib/deductions/candidate-key.ts";
import type { DeductionsCandidateDraft } from "@/lib/deductions/types.ts";
import { clipDatesToRange } from "./range.ts";
import type { DailyDeductionCategory, DailyDeductionDayFigure, DailyDeductionTallyLine } from "./types.ts";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** One draft after clipping to the range — the per-finding contribution to the tally. */
export type ClippedDraftLine = {
  category: DailyDeductionCategory;
  employeeHrId: string;
  employeeHrIdCompact: string;
  employeeName: string | null;
  /** The draft's FULL-month detected day count (pre-clip) — evidence. */
  rawDaysCount: number;
  /** The clipped in-range day count — what is counted. */
  daysCount: number;
  amount: number;
  dates: string[];
  /** Each kept day priced alone; empty when the money is unknown or a day could not be priced. */
  days?: DailyDeductionDayFigure[];
  sourceSystem: string;
  reason: string | null;
  /** True when the connector could not compute an amount (usually a missing base salary). */
  amountUnknown: boolean;
};

/**
 * Clip one draft to [from, effectiveTo].
 *
 * Returns null when no day survives — the finding falls entirely outside the range (or was
 * only ever a future/today day the range already excludes).
 *
 * The day count and amount scale by the surviving fraction. When every day survives the
 * scale is an exact passthrough (scaleDeductionAmountToDays short-circuits appliedDays ===
 * rawValue), so a fully-contained finding is byte-identical to the connector's own figure;
 * only a finding straddling the `from` boundary is prorated, and prorating a same-rate day
 * count is exactly what the month module does for a boundary-spanning vacation request.
 */
export function clipDraftToRange(
  draft: DeductionsCandidateDraft,
  from: string,
  effectiveTo: string,
): ClippedDraftLine | null {
  const keptDates = clipDatesToRange(draft.dates, from, effectiveTo);
  if (keptDates.length === 0) return null;

  const priced = priceKeptDates(draft, keptDates);
  if (!priced) return null;
  const { daysCount, scaled } = priced;
  const amountUnknown = scaled == null;

  // Each kept day priced ALONE, by the same rule — so one day can be released without the others
  // (owner, 2026-11-13: "select day 9 and day 11 in November and release only their deductions").
  // Only where the split is EXACT: one date, or a draft that charges one day per date it lists (a CRM
  // Thursday still weighs half). A vacation request lists calendar days but charges a TOTAL of unpaid
  // days spread across them, so a day of it has no price of its own — it stays one deduction.
  const originalCount = Array.isArray(draft.dates) ? draft.dates.length : 0;
  const exactPerDay = originalCount === 1 || Number(draft.rawValue) === originalCount;
  const days: DailyDeductionDayFigure[] = [];
  if (!amountUnknown && exactPerDay) {
    for (const date of keptDates) {
      const day = priceKeptDates(draft, [date]);
      if (!day || day.scaled == null) {
        days.length = 0;
        break;
      }
      days.push({ amount: round2(day.scaled), date, daysCount: day.daysCount });
    }
  }

  const compact = compactDeductionsHrId(draft.employeeHrId) ?? "";

  return {
    category: draft.category as DailyDeductionCategory,
    employeeHrId: draft.employeeHrId,
    employeeHrIdCompact: compact,
    employeeName: draft.employeeName?.trim() || null,
    rawDaysCount: Number(draft.rawValue),
    daysCount,
    amount: amountUnknown ? 0 : round2(scaled as number),
    dates: keptDates,
    days,
    sourceSystem: draft.sourceSystem,
    reason: draft.reason ?? null,
    amountUnknown,
  };
}

/**
 * The day count and money a draft charges for the given kept days. A count-based CRM row is priced on
 * WEIGHTED days (a Thursday is half, owner rule 2026-08-02), so its kept day count and its money both
 * follow what the kept dates weigh — the table's own comment says `days_count` is "the clipped,
 * weighted day count". Every other draft keeps the surviving fraction.
 */
function priceKeptDates(
  draft: DeductionsCandidateDraft,
  keptDates: readonly string[],
): { daysCount: number; scaled: number | null } | null {
  const originalCount = Array.isArray(draft.dates) ? draft.dates.length : 0;
  const rawValue = Number(draft.rawValue);
  if (!Number.isFinite(rawValue) || rawValue <= 0 || originalCount <= 0) return null;

  const fraction = keptDates.length / originalCount;
  const weighted = draft.category === "crm" && rawValue === originalCount;
  const daysCount = weighted ? sumDetectedDeductionDayWeights([...keptDates]) : round2(rawValue * fraction);

  const scaled = scaleDeductionAmountToKeptDates({
    appliedDays: rawValue * fraction,
    category: draft.category,
    detectedDates: Array.isArray(draft.dates) ? draft.dates : [],
    estimatedAmount: draft.estimatedAmount ?? null,
    keptDates,
    rawValue,
  });
  return { daysCount, scaled };
}

/**
 * Sum clipped lines into one running-tally row per (category, employee).
 *
 * A person can contribute several drafts — different months of the range, or (for CRM) a
 * leaver draft plus a continuing draft — so the tally unions their days and sums their
 * days and money. Keyed by the compact HR id so two spellings of the same person collapse
 * to one row; a draft with no resolvable HR id is dropped and named in `warnings` rather
 * than silently folded into an empty key.
 */
export function aggregateClippedLines(lines: readonly ClippedDraftLine[]): {
  lines: DailyDeductionTallyLine[];
  amountUnknownEmployees: string[];
  droppedUnidentified: number;
} {
  const byKey = new Map<
    string,
    DailyDeductionTallyLine & { _dateSet: Set<string>; _days: Map<string, DailyDeductionDayFigure> | null }
  >();
  const amountUnknown = new Set<string>();
  let droppedUnidentified = 0;

  for (const line of lines) {
    if (!line.employeeHrIdCompact) {
      droppedUnidentified += 1;
      continue;
    }
    const key = `${line.category}|${line.employeeHrIdCompact}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.rawDaysCount = round2(existing.rawDaysCount + line.rawDaysCount);
      existing.daysCount = round2(existing.daysCount + line.daysCount);
      existing.amount = round2(existing.amount + line.amount);
      for (const date of line.dates) existing._dateSet.add(date);
      existing._days = mergeDayFigures(existing._days, line);
      if (!existing.employeeName && line.employeeName) existing.employeeName = line.employeeName;
      if (line.amountUnknown) existing.amountUnknown = true;
    } else {
      byKey.set(key, {
        category: line.category,
        employeeHrId: line.employeeHrId,
        employeeHrIdCompact: line.employeeHrIdCompact,
        employeeName: line.employeeName,
        unit: "days",
        rawDaysCount: line.rawDaysCount,
        daysCount: line.daysCount,
        amount: line.amount,
        dates: [],
        sourceSystem: line.sourceSystem,
        reason: line.reason,
        amountUnknown: line.amountUnknown,
        _dateSet: new Set<string>(line.dates),
        _days: mergeDayFigures(new Map(), line),
      });
    }
    if (line.amountUnknown) amountUnknown.add(line.employeeName || line.employeeHrId);
  }

  const out: DailyDeductionTallyLine[] = [];
  for (const row of byKey.values()) {
    const { _dateSet, _days, ...rest } = row;
    const dates = [..._dateSet].sort();
    // A per-day breakdown ships only when it covers every day of the line; otherwise the line can
    // still be released whole, never split on a guess.
    const days = _days && dates.every((date) => _days.has(date)) ? dates.map((date) => _days.get(date)!) : undefined;
    out.push({ ...rest, dates, ...(days ? { days } : {}) });
  }
  // Stable, name-first ordering (a person is shown by name, never a code).
  out.sort((a, b) => {
    const nameCompare = String(a.employeeName ?? "").localeCompare(String(b.employeeName ?? ""));
    if (nameCompare !== 0) return nameCompare;
    return a.category.localeCompare(b.category);
  });

  return { lines: out, amountUnknownEmployees: [...amountUnknown].sort(), droppedUnidentified };
}

/** Fold one clipped line's per-day figures into the running map; null once any day is unpriceable. */
function mergeDayFigures(
  into: Map<string, DailyDeductionDayFigure> | null,
  line: ClippedDraftLine,
): Map<string, DailyDeductionDayFigure> | null {
  if (!into) return null;
  if (line.amountUnknown || !Array.isArray(line.days) || line.days.length !== line.dates.length) return null;
  for (const day of line.days) {
    const existing = into.get(day.date);
    into.set(
      day.date,
      existing
        ? { amount: round2(existing.amount + day.amount), date: day.date, daysCount: round2(existing.daysCount + day.daysCount) }
        : { ...day },
    );
  }
  return into;
}
