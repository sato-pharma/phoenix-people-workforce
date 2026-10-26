/**
 * What the portal Business Review's cards and KPI notes COUNT — display only. Nothing here changes a
 * sales, target or achievement figure: every number is the live engine's, summed as the page always
 * summed it. This only says, in words, how the parts on screen relate to the totals above them.
 *
 * Why (National Sales Manager audit, 2026-10-26):
 *   1. The header read sales EGP 8,626,400 and the district cards added up to 8,547,338. The missing
 *      EGP 79,062 sat in "Others (vacant)", which carries no target in the window, so it drew no card —
 *      and nothing on the page said so. `districtCardsRemainder` names what the cards leave out.
 *   2. "Earners ≥ 90%: 4 of 36 graded areas" counted vacant areas in the 36, though a vacant area is
 *      never an earner — beside "Vacant areas 23" the two did not add up. `earnerTally` gives the
 *      earners over the STAFFED areas that carry a target, and says how many vacant ones were graded.
 */

type SliceLike = { sales: number; target: number; ach: number | null };
type DistrictLike = { dm: string; vacant: boolean; allProducts: SliceLike };
type AreaLike = { vacant: boolean; hasTarget: boolean; allProducts: SliceLike };

export type UndrawnDistrict = {
  name: string;
  sales: number;
  /** Why it has no card: no target in the window, or the "Exclude vacant" switch is on. */
  reason: "no target" | "vacant hidden";
};

export type DistrictCardsRemainder = {
  drawnSales: number;
  /** headerSales − drawnSales: what the cards do not reach. 0 when they reach the header. */
  remainderSales: number;
  undrawn: UndrawnDistrict[];
};

export function districtCardsRemainder<T extends DistrictLike>(
  allDistricts: readonly T[],
  drawnDistricts: readonly T[],
  headerSales: number,
): DistrictCardsRemainder {
  const drawn = new Set<T>(drawnDistricts);
  const drawnSales = drawnDistricts.reduce((sum, district) => sum + district.allProducts.sales, 0);
  const undrawn = allDistricts
    .filter((district) => !drawn.has(district) && district.allProducts.sales !== 0)
    .map((district) => ({
      name: district.dm,
      sales: district.allProducts.sales,
      reason: district.allProducts.target > 0 ? ("vacant hidden" as const) : ("no target" as const),
    }))
    .sort((left, right) => right.sales - left.sales);
  // A whole pound either way is float noise from summing many rows, never a real gap.
  const remainder = headerSales - drawnSales;
  return { drawnSales, remainderSales: Math.abs(remainder) < 1 ? 0 : remainder, undrawn };
}

/** The sentence under the district cards, or null when the cards reach the header's sales. */
export function districtCardsRemainderText(remainder: DistrictCardsRemainder, money: (value: number) => string): string | null {
  if (remainder.remainderSales === 0) return null;
  const named = remainder.undrawn.map((district) => {
    const why = district.reason === "no target" ? "no target in this window" : "hidden by Exclude vacant";
    return `${district.name} ${money(district.sales)} (${why})`;
  });
  const where = named.length > 0 ? ` It sits in ${named.join(", ")}, which draws no card.` : "";
  return `These cards add up to ${money(remainder.drawnSales)} of the sales above; the other ${money(remainder.remainderSales)} is in no card.${where}`;
}

export type EarnerTally = {
  earners: number;
  /** Staffed areas that carry a target and a grade — the only areas that can earn. */
  staffedGraded: number;
  /** Vacant areas that carry a target: graded for achievement, never an earner. */
  vacantGraded: number;
};

export function earnerTally<T extends AreaLike>(areas: readonly T[], earnsAt = 90): EarnerTally {
  const graded = areas.filter((area) => area.hasTarget && area.allProducts.ach != null);
  const staffed = graded.filter((area) => !area.vacant);
  return {
    earners: staffed.filter((area) => (area.allProducts.ach ?? 0) >= earnsAt).length,
    staffedGraded: staffed.length,
    vacantGraded: graded.length - staffed.length,
  };
}

/** The Earners card's note: what the denominator counts, in words. */
export function earnerTallyNote(tally: EarnerTally, count: (value: number) => string): string {
  const base = `of ${count(tally.staffedGraded)} staffed areas with a target`;
  return tally.vacantGraded > 0 ? `${base} · ${count(tally.vacantGraded)} vacant never earn` : base;
}
