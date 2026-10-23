/**
 * THE INCENTIVE CLIFF, ONCE — the achievement at which the 2026 scheme starts paying.
 *
 * `scheme-2026.ts` is owner-locked, so the curve itself (0% below 90, 50% at exactly 90) stays where
 * it is and is never edited from here. This is the one number the performance screens badge people
 * with — "Incentive Eligible", the 90–99% zone, the reference line on the chart — which used to be a
 * bare `90` copied into six pages (technical audit 23 Oct 2026, S-APP-03). They agree today; this
 * keeps them agreeing, and `tests/app-layer-audit.test.ts` checks it against the locked curve.
 */
export const INCENTIVE_ELIGIBILITY_THRESHOLD_PERCENT = 90;

/** True when an achievement earns any incentive under the 2026 scheme. */
export function isIncentiveEligible(achievementPercent: number): boolean {
  return achievementPercent >= INCENTIVE_ELIGIBILITY_THRESHOLD_PERCENT;
}
