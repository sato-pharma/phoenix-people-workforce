// Business Review — what a point of achievement cost.
//
// The district rows have carried marketing spend, outstation spend and achievement side by side
// since the module was built, and nothing ever divided them. "Who is buying their achievement" is
// the question a review exists to ask, and until now it could only be answered by reading three
// columns and doing the arithmetic in your head.
//
// LOWER IS BETTER. This is a cost, not a score: a district on 98% for 4,000 EGP spent 41 EGP per
// point; one on 68% for the same 4,000 spent 59. Never colour it like an achievement.
//
// Pure, and deliberately in its own leaf module so the client components can render it without
// pulling the sales domain into the browser bundle.

/** Marketing plus outstation — the two spends a district review actually controls. */
export type ReviewSpend = {
  marketingCost: number;
  outstationCost: number;
};

/**
 * EGP of spend per point of achievement, or null when the question has no answer.
 *
 * Null — rendered as an em dash, NEVER as 0 — in the three cases where a number would lie:
 *
 *   - no achievement at all (`null`): the district is ungradeable, so there are no points to
 *     divide by and any figure would be invented;
 *   - achievement at or below zero: the same, and a negative divisor would flip the sign of a
 *     cost, printing a district that spent money as if it had been paid;
 *   - a non-finite spend or achievement, which is how a corrupted upstream number arrives.
 *
 * A spend of zero IS an answer and returns 0: a district that reached 90% having claimed nothing
 * is the most efficient row on the page, and blanking it would hide exactly the row worth seeing.
 */
export function spendPerPoint(spend: ReviewSpend, achievement: number | null): number | null {
  if (achievement == null || !Number.isFinite(achievement) || achievement <= 0) return null;
  const total = spend.marketingCost + spend.outstationCost;
  if (!Number.isFinite(total) || total < 0) return null;
  return total / achievement;
}

/**
 * The same figure as a string, in the house register: whole EGP, thousands separated, em dash when
 * there is no answer. No ellipsis, and no "N/A" — the page says "—" everywhere else it cannot
 * answer, and a second vocabulary for the same idea is how a reader learns to distrust both.
 */
export function formatSpendPerPoint(spend: ReviewSpend, achievement: number | null): string {
  const value = spendPerPoint(spend, achievement);
  if (value == null) return "—";
  return Math.round(value).toLocaleString("en-US");
}
