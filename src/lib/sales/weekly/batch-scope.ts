// Pure cycle-month narrowing for the weekly-sales row fetch.
//
// loadWeeklyDashboard() picks a set of validated batches and then pages every row belonging to them.
// The month/week-of-month filters are applied in memory AFTER that fetch — deliberately, because the
// dashboard's option universes (availableMonths, availableWeekNumbers, availableRegions, …) are
// derived from the fetched rows, so filtering earlier would collapse the dropdowns to whatever is
// currently selected. The cost is that a caller wanting ONE month's aggregates still pays for the
// entire validated history.
//
// This narrows the batch set — and therefore the fetch — to whole cycle months.
//
// WHOLE months is the only safe unit, and it is safe: decumulateRows() buckets rows by
// (distributorCode, cycleMonth) and each bucket de-cumulates independently, with the first week of a
// cycle taken as-is. Dropping entire buckets can never split a telescoping chain, so every surviving
// month's numbers are bit-for-bit what they would have been. Narrowing by WEEK would not be safe —
// it would strip the earlier cumulative sheet each week is subtracted against.
//
// Pure + dependency-free so it can be unit-tested in isolation (see tests/weekly-batch-scope.test.ts).

/** The only shape this needs: a batch carrying its cycle month. */
export type CycleMonthBatch = { cycle_month?: string | null };

const normalizeCycleMonth = (value: string | null | undefined) => (value ?? "").trim();

/**
 * Keep only the batches whose cycle month is in `cycleMonths`.
 *
 * An empty / omitted `cycleMonths` means "no narrowing" and returns the input untouched, so callers
 * that do not opt in keep the previous full-history behaviour exactly.
 */
export function narrowBatchesToCycleMonths<T extends CycleMonthBatch>(
  batches: readonly T[],
  cycleMonths: readonly (string | null | undefined)[] | null | undefined,
): T[] {
  const wanted = new Set((cycleMonths ?? []).map(normalizeCycleMonth).filter(Boolean));
  if (wanted.size === 0) return [...batches];
  return batches.filter((batch) => wanted.has(normalizeCycleMonth(batch.cycle_month)));
}

/** A batch's period tags — the pair the dashboard's Month + Week-of-month filters address. */
export type PeriodTaggedBatch = { cycleMonth?: string | null; weekNumber?: number | null };

/**
 * The most recent (cycle month, week-of-month) anyone has uploaded.
 *
 * Used as the DEFAULT scope for the summarized report when the viewer has not picked a period. The
 * report is meant to answer "what did the sheet I just uploaded sell", so falling back to the whole
 * validated history — which is what an empty filter means to the loader — showed dates running back
 * to May and was the first thing the owner rejected.
 *
 * Deliberately (month, week) and not a raw week_start: distributors stamp slightly different dates
 * for the same operational week, and the week NUMBER is the tag they are all reconciled onto.
 */
export function latestUploadedPeriod<T extends PeriodTaggedBatch>(
  batches: readonly T[],
): { cycleMonth: string; weekNumber: number } | null {
  let best: { cycleMonth: string; weekNumber: number } | null = null;
  for (const batch of batches) {
    const cycleMonth = normalizeCycleMonth(batch.cycleMonth);
    const weekNumber = batch.weekNumber;
    if (!cycleMonth || weekNumber == null || !Number.isFinite(weekNumber)) continue;
    // cycle_month is a zero-padded YYYY-MM-DD, so lexical order is chronological order.
    if (!best || cycleMonth > best.cycleMonth || (cycleMonth === best.cycleMonth && weekNumber > best.weekNumber)) {
      best = { cycleMonth, weekNumber: Number(weekNumber) };
    }
  }
  return best;
}
