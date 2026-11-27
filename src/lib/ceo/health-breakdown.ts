/**
 * One bar of the Company Health Breakdown: the figure it PRINTS, and how far its bar is filled.
 *
 * The printed figure is the rate itself. The bar shows progress toward the rate's goal, and the colour
 * follows that progress. Until 27 Nov 2026 the bar printed the progress (rate ÷ goal) under the rate's
 * own label: sales achievement was 74.75% (EGP 58.30M sold against EGP 78.00M of target, the published
 * closing July to October) but read "83%" because its goal is 90%. The other three goals are 100%, so
 * only that bar was inflated.
 */
export type HealthBreakdownReading = {
  /** The rate as a whole percent, e.g. 75 for 0.7475. Null when nothing was measured. */
  printedPct: number | null;
  /** Progress toward the goal as a whole percent, capped at 100: the bar's fill and colour. */
  progressPct: number | null;
};

export function healthBreakdownReading(value: number | null, goal: number): HealthBreakdownReading {
  if (value === null || !Number.isFinite(value)) return { printedPct: null, progressPct: null };
  const progress = goal > 0 ? Math.min(1, Math.max(0, value / goal)) : 0;
  return { printedPct: Math.round(value * 100), progressPct: Math.round(progress * 100) };
}
