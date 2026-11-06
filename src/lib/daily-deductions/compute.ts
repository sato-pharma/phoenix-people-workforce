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
import type { DailyDeductionCategory, DailyDeductionTallyLine } from "./types.ts";

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

  const originalCount = Array.isArray(draft.dates) ? draft.dates.length : 0;
  const rawValue = Number(draft.rawValue);
  if (!Number.isFinite(rawValue) || rawValue <= 0 || originalCount <= 0) return null;

  const fraction = keptDates.length / originalCount;
  // A count-based CRM row is priced on WEIGHTED days (a Thursday is half, owner rule 2026-08-02), so
  // its kept day count and its money both follow what the kept dates weigh — the table's own comment
  // says `days_count` is "the clipped, weighted day count". Every other draft keeps the fraction.
  const weighted = draft.category === "crm" && rawValue === originalCount;
  const daysCount = weighted ? sumDetectedDeductionDayWeights(keptDates) : round2(rawValue * fraction);

  const estimatedAmount = draft.estimatedAmount ?? null;
  const scaled = scaleDeductionAmountToKeptDates({
    appliedDays: rawValue * fraction,
    category: draft.category,
    detectedDates: Array.isArray(draft.dates) ? draft.dates : [],
    estimatedAmount,
    keptDates,
    rawValue,
  });
  const amountUnknown = scaled == null;

  const compact = compactDeductionsHrId(draft.employeeHrId) ?? "";

  return {
    category: draft.category as DailyDeductionCategory,
    employeeHrId: draft.employeeHrId,
    employeeHrIdCompact: compact,
    employeeName: draft.employeeName?.trim() || null,
    rawDaysCount: rawValue,
    daysCount,
    amount: amountUnknown ? 0 : round2(scaled as number),
    dates: keptDates,
    sourceSystem: draft.sourceSystem,
    reason: draft.reason ?? null,
    amountUnknown,
  };
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
    DailyDeductionTallyLine & { _dateSet: Set<string> }
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
      });
    }
    if (line.amountUnknown) amountUnknown.add(line.employeeName || line.employeeHrId);
  }

  const out: DailyDeductionTallyLine[] = [];
  for (const row of byKey.values()) {
    const { _dateSet, ...rest } = row;
    out.push({ ...rest, dates: [..._dateSet].sort() });
  }
  // Stable, name-first ordering (a person is shown by name, never a code).
  out.sort((a, b) => {
    const nameCompare = String(a.employeeName ?? "").localeCompare(String(b.employeeName ?? ""));
    if (nameCompare !== 0) return nameCompare;
    return a.category.localeCompare(b.category);
  });

  return { lines: out, amountUnknownEmployees: [...amountUnknown].sort(), droppedUnidentified };
}
