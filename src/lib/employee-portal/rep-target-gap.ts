/**
 * A rep's distance from his own target, as the leaderboard's Gap column shows it.
 *
 * "Achieved" means the TARGET is met — sales at or above target. It is never the incentive
 * threshold: the 2026 scheme starts paying at 90% (`INCENTIVE_ELIGIBILITY_THRESHOLD_PERCENT`), and
 * reusing that number here hid a real 1,461 EGP gap behind "Achieved" for a rep at 98.7% (August
 * 2026, National Sales Manager's Medical Reps Performance). Eligibility has its own badge.
 *
 * Read from the money, not from the rounded percentage, so 99.96% shown as "100.0%" still shows
 * its gap. A rep with no target has nothing to achieve and is never "Achieved".
 */
export type RepTargetGap = { achieved: boolean; gap: number };

export function repTargetGap(totalSales: number, totalTarget: number): RepTargetGap {
  const sales = Number.isFinite(totalSales) ? totalSales : 0;
  const target = Number.isFinite(totalTarget) ? totalTarget : 0;
  const achieved = target > 0 && sales >= target;
  return { achieved, gap: achieved ? 0 : Math.max(0, target - sales) };
}

/** "1 medical rep", "12 medical reps". */
export function medicalRepCountLabel(count: number): string {
  return `${count} medical ${count === 1 ? "rep" : "reps"}`;
}
