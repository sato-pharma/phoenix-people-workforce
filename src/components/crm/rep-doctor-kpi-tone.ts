/**
 * Colour bands for the two Rep Doctor List KPIs, in ONE place.
 *
 * Shared by the month tables and the trend panel. A trend cell that calls 60% green while the table
 * beside it calls the same 60% amber is the kind of disagreement nobody reports and everybody
 * stops trusting the board over.
 *
 * Return types are ANNOTATED rather than `as const` on the ternary — TS1355, which has already cost
 * this module a red CI run.
 */

/** COVERAGE — did the rep touch the doctor at all? 80/50, the bands the board shipped with. */
export const coverageAccent = (pct: number): "amber" | "emerald" | "rose" =>
  pct >= 80 ? "emerald" : pct >= 50 ? "amber" : "rose";

export const coverageText = (pct: number): string =>
  pct >= 80 ? "text-emerald-700" : pct >= 50 ? "text-amber-700" : "text-rose-700";

export const coverageBar = (pct: number): string =>
  pct >= 80 ? "bg-emerald-500" : pct >= 50 ? "bg-amber-400" : "bg-rose-400";

/**
 * FREQUENCY — did the call COUNT match the plan exactly? Lower bands than coverage, deliberately.
 *
 * Hitting a doctor's planned call count exactly is a far harder target than reaching him once.
 * Measured against production for August 2026: the company sits at 39% frequency against 68%
 * coverage, and the strongest rep in the field reaches 80%. Reusing the 80/50 coverage bands here
 * would paint almost the entire field force red, and a colour that is always red carries no
 * information at all.
 */
export const frequencyAccent = (pct: number): "amber" | "emerald" | "rose" =>
  pct >= 60 ? "emerald" : pct >= 35 ? "amber" : "rose";

export const frequencyText = (pct: number): string =>
  pct >= 60 ? "text-emerald-700" : pct >= 35 ? "text-amber-700" : "text-rose-700";

export const frequencyBar = (pct: number): string =>
  pct >= 60 ? "bg-emerald-500" : pct >= 35 ? "bg-amber-400" : "bg-rose-400";
