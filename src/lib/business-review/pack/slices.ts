// The Sales Review pack — the one rule for totalling achievement slices.
//
// Its own module so that every section builder (model.ts and link-sections.ts) reads the SAME rule
// without the two importing each other. model.ts re-exports it, so existing callers are unchanged.

import type { Slice } from "../types";

const num = (value: number) => (Number.isFinite(value) ? value : 0);

/**
 * Total any set of slices by the review's own rule: sum(sales), sum(target), and achievement as the
 * GRADED actual over the target, as a percentage, null when there is no target.
 *
 * It is `totalAreas` in canonical.ts restated for slices that are not whole areas — one product
 * across areas, one month across areas. canonical.ts reaches the database, so it cannot be imported
 * here; a test pins this against it instead, because a second rule would be a second opinion about
 * achievement.
 */
export function sumSlices(slices: readonly (Slice | null | undefined)[]): Slice {
  let sales = 0;
  let target = 0;
  let graded = 0;
  for (const slice of slices) {
    if (!slice) continue;
    sales += num(slice.sales);
    target += num(slice.target);
    graded += num(slice.graded);
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    ach: target !== 0 ? round2((graded / target) * 100) : null,
    graded: round2(graded),
    sales: round2(sales),
    target: round2(target),
  };
}
