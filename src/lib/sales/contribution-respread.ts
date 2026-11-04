// THE CONTRIBUTION RESPREAD ENGINE — "take these rows off their invoiced areas and put the same
// totals back by each area's share of the line's other sales value."
//
// It is the owner's Office value-share rule expressed as a NET MOVEMENT instead of as a rewrite, and
// it is now the arithmetic behind two rules that are the same rule applied to different rows:
//
//   • `closing-bulk-allocation.ts` — the EPDA-BULK sector on Pedia, from the September 2026 closing
//     (owner, 2026-10-09: "distributed and calculated exactly as office").
//   • `closing-office-respread.ts` — the Office channel on CNS, from the October 2026 closing
//     (owner, 2026-10-09: "fix the Office allocation to read-time shares"), which moves the Office
//     units OFF the areas the upload stamped on them and back onto today's shares.
//
// 🔴 IT LIVES IN ONE PLACE BECAUSE THE SECOND COPY IS THE DEFECT. The spread is a largest-remainder
// reconciliation with the residual on the slice of largest MAGNITUDE, run separately on three
// measures (invoice units, effective units, value) so each lands on exactly the total that left. Two
// hand-written copies of that would agree on the test data and disagree on a return. The repo's own
// rule: never hand-roll a rule the repo already implements.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A NET AND NOT A REWRITE
//
// The closing screen folds its matrix from `phx_closing_distributor_product`, the workbook rebuilds
// it from invoice rows, and `au.f_monthly_attribution` — achievement, incentives, the keycard, the
// Business Review — reads `source_of_sales_fact_rollup`. All three carry the stored area. The city
// split already faces exactly that problem and solves it in one shape: a net per area × product,
// summing to zero per product, applied to the matrix (store-split-matrix.ts) and materialised for
// attribution (au.monthly_store_split_net). Both rules above produce that same shape, so every
// surface moves together and no grand total can change.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE SHARES ARE RECOMPUTED HERE AND NOT IMPORTED FROM THE LOCKED OFFICE RULE
//
// `buildOfficeAreaWeights` in office-allocation.ts is the locked GOLDEN RULE implementation of "an
// area's share of the line's sales value", and importing it would be the obvious move. It cannot be
// imported: office-allocation.ts imports monthly-distributor-import.ts, which imports
// attribution-store-split-refresh.ts → attribution-store-split-net.ts, which imports the rules that
// import THIS module. That is a cycle through the 4,000-line matrix module, and the same cycle the
// headers of office-distributor.ts and store-split-matrix.ts already exist to avoid.
//
// 🔴 SO THE EQUIVALENCE IS PINNED BY A TEST INSTEAD OF BY AN IMPORT. `areaValueShares` below is
// Σ salesValue per area ÷ Σ salesValue, which is identical to the locked rule's
// Σ (effectiveUnits × factory price) because that product IS the closing's `salesValue` for a
// distributor row. tests/closing-bulk-allocation.test.ts and tests/closing-office-respread.test.ts
// each feed one row set to this engine and to buildOfficeAreaWeights and assert the area shares
// match to 1e-9, so a change to the locked formula turns the required `validate` job red here
// instead of drifting silently.

import {
  netStoreSplitByAreaProduct,
  type StoreSplitAreaMovement,
  type StoreSplitRow,
} from "@/lib/sales/store-sales-city-split";

/**
 * A closing detail row, narrowed to what a respread reads.
 *
 * `effectiveUnits` and `isConfidential` are optional so the arithmetic can be exercised with
 * hand-built rows: absent, the row's own `qty` is its effective units and the row is not
 * confidential, which is what every ordinary row is.
 */
export type RespreadRow = StoreSplitRow & {
  effectiveUnits?: number;
  isConfidential?: boolean;
};

/** Per area × product, what a respread moved. `net` is keyed by `areaProductKey`. */
export type ContributionRespread = {
  /** Movements measured in invoice units (`qty`) and value — what the Closing Matrix applies. */
  movements: StoreSplitAreaMovement[];
  /**
   * The SAME movements measured in `effectiveUnits` instead of `qty`, and nothing else changed.
   *
   * `au.monthly_store_split_net` stores both measures because attribution uses both — `total_qty`
   * becomes sales_units and `effective_units` is what gets priced — so the net has to carry each.
   * Same reason attribution-store-split-net.ts runs the city split twice.
   */
  effectiveMovements: StoreSplitAreaMovement[];
  /** Per area × product, the delta the matrix write-back applies. Sums to zero per product. */
  net: Map<string, { qty: number; value: number }>;
  /** Each area's share of the BASE rows' sales value. Reported so a test can read it. */
  areaShare: Map<string, number>;
  /** Units the rule moved (the moved rows' own invoice units). */
  movedQty: number;
};

/** Nothing to move — a month before the rule, a line it never touches, or no movable rows at all. */
export function emptyContributionRespread(): ContributionRespread {
  return { movements: [], effectiveMovements: [], net: new Map(), areaShare: new Map(), movedQty: 0 };
}

/** Six decimal places, the same grain the locked Office reconciliation rounds to. */
export function round6(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 1_000_000) / 1_000_000;
}

/**
 * Spread one total across the areas by their shares, so that Σ slices === total EXACTLY.
 *
 * Largest-remainder, with the residual pushed onto the slice of largest MAGNITUDE — deliberately
 * the same reconciliation the locked Office rule uses, including the magnitude test, so a return
 * (a negative total) lands its residual on the slice best able to absorb it instead of on the one
 * closest to zero.
 */
export function spreadByShares(
  total: number,
  areaShare: ReadonlyMap<string, number>,
): Map<string, number> {
  const slices = new Map<string, number>();
  if (!Number.isFinite(total) || total === 0 || areaShare.size === 0) return slices;
  for (const [areaCode, share] of areaShare) {
    const slice = round6(total * share);
    if (slice !== 0) slices.set(areaCode, slice);
  }
  if (slices.size === 0) return slices;
  const sum = round6([...slices.values()].reduce((acc, value) => acc + value, 0));
  const residual = round6(total - sum);
  if (residual !== 0) {
    let largestArea = "";
    let largest = -Infinity;
    for (const [areaCode, value] of slices) {
      if (Math.abs(value) > largest) {
        largest = Math.abs(value);
        largestArea = areaCode;
      }
    }
    slices.set(largestArea, round6((slices.get(largestArea) ?? 0) + residual));
  }
  return slices;
}

/**
 * `spreadByShares` in whole units, for a total that must stay a whole number in every area.
 *
 * Largest remainder, with the area code settling a tie so every read lands the same. The sign is
 * taken off first, so a net return spreads the same way as a net sale.
 */
export function spreadWholeUnitsByShares(
  total: number,
  areaShare: ReadonlyMap<string, number>,
): Map<string, number> {
  const slices = new Map<string, number>();
  const whole = Math.abs(Math.round(Number.isFinite(total) ? total : 0));
  if (whole === 0 || areaShare.size === 0) return slices;
  const sign = Math.sign(total);
  const shares = [...areaShare].map(([areaCode, share]) => {
    const ideal = whole * share;
    const units = Math.floor(ideal);
    return { areaCode, remainder: ideal - units, units };
  });
  let left = whole - shares.reduce((sum, share) => sum + share.units, 0);
  shares.sort((a, b) => b.remainder - a.remainder || a.areaCode.localeCompare(b.areaCode));
  for (const share of shares) {
    if (left <= 0) break;
    share.units += 1;
    left -= 1;
  }
  for (const { areaCode, units } of shares) if (units !== 0) slices.set(areaCode, sign * units);
  return slices;
}

/**
 * Each area's share of these rows' sales value — the weights both rules spread on.
 *
 * VALUE, not units — the owner's rule, and the locked Office rule it copies. Units cannot be added
 * across products at all (a pack of one product is not a pack of another), so a unit-weighted share
 * would be meaningless the moment a line carries more than one price.
 *
 * An area with no positive value takes no share: it is absent from the map rather than present at
 * zero, so `spreadByShares` never has to decide what a zero-weight slice means.
 */
export function areaValueShares(base: readonly RespreadRow[]): Map<string, number> {
  const areaValue = new Map<string, number>();
  for (const row of base) {
    const areaCode = String(row.areaCode ?? "").trim().toUpperCase();
    if (!areaCode) continue;
    const value = Number(row.salesValue);
    if (!Number.isFinite(value) || value <= 0) continue;
    areaValue.set(areaCode, (areaValue.get(areaCode) ?? 0) + value);
  }
  const totalValue = [...areaValue.values()].reduce((acc, value) => acc + value, 0);
  const areaShare = new Map<string, number>();
  if (!(totalValue > 0)) return areaShare;
  for (const [areaCode, value] of areaValue) if (value > 0) areaShare.set(areaCode, value / totalValue);
  return areaShare;
}

/**
 * Each area's share of these rows' UNITS — the weights of EPDA's rule 2 (owner, 2026-11-04: "the
 * same product's units"). Only ever handed the rows of ONE product, which is what makes adding the
 * units meaningful. An area whose units net to nothing or less takes no share, as in the value rule.
 */
export function areaUnitShares(base: readonly RespreadRow[]): Map<string, number> {
  const areaUnits = new Map<string, number>();
  for (const row of base) {
    const areaCode = String(row.areaCode ?? "").trim().toUpperCase();
    if (!areaCode) continue;
    const units = Number(row.qty);
    if (!Number.isFinite(units) || units === 0) continue;
    areaUnits.set(areaCode, (areaUnits.get(areaCode) ?? 0) + units);
  }
  const positive = [...areaUnits].filter(([, units]) => units > 0);
  const totalUnits = positive.reduce((acc, [, units]) => acc + units, 0);
  const areaShare = new Map<string, number>();
  if (!(totalUnits > 0)) return areaShare;
  for (const [areaCode, units] of positive) areaShare.set(areaCode, units / totalUnits);
  return areaShare;
}

/** The row's effective units — the base the closing prices. Falls back to its invoice units. */
function effectiveUnitsOf(row: RespreadRow): number {
  const effective = Number(row.effectiveUnits);
  return Number.isFinite(effective) ? effective : Number(row.qty) || 0;
}

/** A movement leg accumulator, keyed area|product, carrying all three measures at once. */
type Leg = {
  areaCode: string;
  productCode: string;
  inQty: number;
  inEffective: number;
  inValue: number;
  outQty: number;
  outEffective: number;
  outValue: number;
};

/**
 * Move `moved`'s totals off their stored areas and back on by `base`'s value shares.
 *
 * `moved` and `base` must both be drawn from the WHOLE month, never a filtered or access-scoped
 * slice: a share is a fraction of the line's national sales, so a regional manager's four areas
 * would otherwise divide the moved rows among themselves and each take several times what the
 * closing credits. Same rule, and the same reason, as the Main Stores view in
 * monthly-closing-details.ts.
 *
 * Returns an EMPTY respread — not a throw — whenever there is nothing to move or nothing to weight
 * on: no moved rows at all, or (the one that matters) a month whose base rows have no sales value.
 * In that last case the moved rows keep their stored area, which is the state the closing was in
 * before the rule and the only honest answer when there is no contribution to copy.
 *
 * PURE: no database, no clock, no cache. Every caller hands it the rows it already has.
 */
export function buildContributionRespread(input: {
  moved: readonly RespreadRow[];
  base: readonly RespreadRow[];
  line: string;
  /** Spread whole units, with the value following them. The Office channel never asks for this. */
  wholeUnits?: boolean;
  /** The weights: the line's sales value (the default, the Office rule) or one product's units. */
  shareBy?: "units" | "value";
}): ContributionRespread {
  const { moved, base } = input;
  if (moved.length === 0) return emptyContributionRespread();

  const areaShare = input.shareBy === "units" ? areaUnitShares(base) : areaValueShares(base);
  if (areaShare.size === 0) return emptyContributionRespread();

  // ── The spread, PER PRODUCT, on ONE blended set of weights ─────────────────────────────────
  // One share for every product on the line is the rule, not a shortcut — it is what "the same
  // contribution" means, and it is how the locked Office rule applies its own weights.
  const legs = new Map<string, Leg>();
  const legFor = (areaCode: string, productCode: string): Leg => {
    const key = `${areaCode}|${productCode}`;
    const existing = legs.get(key);
    if (existing) return existing;
    const created: Leg = {
      areaCode,
      productCode,
      inQty: 0,
      inEffective: 0,
      inValue: 0,
      outQty: 0,
      outEffective: 0,
      outValue: 0,
    };
    legs.set(key, created);
    return created;
  };

  type ProductTotals = { qty: number; effective: number; value: number };
  const byProduct = new Map<string, ProductTotals>();
  let movedQty = 0;

  // OUT: every moved row leaves the area it was stored on, measured exactly as the row carries it.
  // Taking the out legs from the rows themselves rather than re-deriving them is what makes the net
  // sum to zero whatever the row's own value basis was.
  for (const row of moved) {
    const areaCode = String(row.areaCode ?? "").trim().toUpperCase();
    const productCode = String(row.productCode ?? "").trim().toUpperCase();
    if (!areaCode || !productCode) continue;
    const qty = Number(row.qty) || 0;
    const effective = effectiveUnitsOf(row);
    const value = Number(row.salesValue) || 0;
    if (qty === 0 && effective === 0 && value === 0) continue;
    const leg = legFor(areaCode, productCode);
    leg.outQty = round6(leg.outQty + qty);
    leg.outEffective = round6(leg.outEffective + effective);
    leg.outValue = round6(leg.outValue + value);
    const totals = byProduct.get(productCode) ?? { qty: 0, effective: 0, value: 0 };
    totals.qty = round6(totals.qty + qty);
    totals.effective = round6(totals.effective + effective);
    totals.value = round6(totals.value + value);
    byProduct.set(productCode, totals);
    movedQty = round6(movedQty + qty);
  }

  // IN: the same product totals, spread by the weights. Each measure is reconciled on its own, so
  // units, effective units and value each land on exactly the total that left.
  for (const [productCode, totals] of byProduct) {
    const qtySlices = input.wholeUnits ? spreadWholeUnitsByShares(totals.qty, areaShare) : spreadByShares(totals.qty, areaShare);
    const effectiveSlices = input.wholeUnits
      ? spreadWholeUnitsByShares(totals.effective, areaShare)
      : spreadByShares(totals.effective, areaShare);
    // A whole-unit area's value is its units at the book's price, not a fraction of the money. Units
    // that net to nothing have no slices to follow, so that value keeps the plain shares.
    const valueShare: ReadonlyMap<string, number> =
      input.wholeUnits && qtySlices.size > 0
        ? new Map([...qtySlices].map(([areaCode, qty]): [string, number] => [areaCode, qty / totals.qty]))
        : areaShare;
    const valueSlices = spreadByShares(totals.value, valueShare);
    for (const areaCode of areaShare.keys()) {
      const qty = qtySlices.get(areaCode) ?? 0;
      const effective = effectiveSlices.get(areaCode) ?? 0;
      const value = valueSlices.get(areaCode) ?? 0;
      if (qty === 0 && effective === 0 && value === 0) continue;
      const leg = legFor(areaCode, productCode);
      leg.inQty = round6(leg.inQty + qty);
      leg.inEffective = round6(leg.inEffective + effective);
      leg.inValue = round6(leg.inValue + value);
    }
  }

  // ── The two movement lists ─────────────────────────────────────────────────────────────────
  // `city` is blank: neither rule knows anything about cities, and a blank city is already the shape
  // the frozen path writes (synthesizeFrozenMovements), so every consumer of a movement list
  // tolerates it. `line` carries the respread line so the attribution payload can key on it.
  const movements: StoreSplitAreaMovement[] = [];
  const effectiveMovements: StoreSplitAreaMovement[] = [];
  const lineName = String(input.line ?? "").trim() || firstLineOf(moved);
  for (const leg of legs.values()) {
    const sameCell = {
      areaCode: leg.areaCode,
      city: "",
      line: lineName,
      productCode: leg.productCode,
    };
    if (leg.inQty !== 0 || leg.outQty !== 0 || leg.inValue !== 0 || leg.outValue !== 0) {
      movements.push({
        ...sameCell,
        inQty: leg.inQty,
        inValue: leg.inValue,
        outQty: leg.outQty,
        outValue: leg.outValue,
      });
    }
    if (leg.inEffective !== 0 || leg.outEffective !== 0) {
      effectiveMovements.push({
        ...sameCell,
        inQty: leg.inEffective,
        inValue: leg.inValue,
        outQty: leg.outEffective,
        outValue: leg.outValue,
      });
    }
  }

  return {
    movements,
    effectiveMovements,
    net: netStoreSplitByAreaProduct(movements),
    areaShare,
    movedQty,
  };
}

/**
 * Several respreads as one, for a rule run once per product (EPDA's rule 2). Their legs never meet —
 * each product is its own respread — so the lists simply join and the nets add. `areaShare` is left
 * empty: there is no one share across products, and nothing reads it but the tests of one product.
 */
export function combineContributionRespreads(parts: readonly ContributionRespread[]): ContributionRespread {
  const moving = parts.filter((part) => part.movements.length > 0 || part.effectiveMovements.length > 0);
  if (moving.length === 0) return emptyContributionRespread();
  if (moving.length === 1) return moving[0];
  const movements = moving.flatMap((part) => part.movements);
  return {
    movements,
    effectiveMovements: moving.flatMap((part) => part.effectiveMovements),
    net: netStoreSplitByAreaProduct(movements),
    areaShare: new Map(),
    movedQty: round6(moving.reduce((sum, part) => sum + part.movedQty, 0)),
  };
}

/** The line the moved rows are on, for a caller that did not name one. */
function firstLineOf(moved: readonly RespreadRow[]): string {
  for (const row of moved) {
    const line = String(row.officialLine ?? "").trim();
    if (line) return line;
  }
  return "";
}

/**
 * The city split's own result shape (`ClosingStoreSplit`), spelled structurally rather than
 * imported: closing-store-split-net.ts imports the rules that import THIS module, and a type import
 * back the other way would be a cycle that only TypeScript's eraser hides.
 */
export type RespreadMergeableSplit = {
  exemptStoreValueByBrick: ReadonlyMap<string, number>;
  movements: StoreSplitAreaMovement[];
  net: Map<string, { qty: number; value: number }>;
};

/**
 * Fold a respread into a city-split result, so the Closing Matrix, the workbook's Channel Breakdown
 * and the Total sheet's reconciliation all read ONE net and ONE movement list.
 *
 * Kept here rather than written out at each call site because there are three per rule — the
 * screen's cached loader, the export's live fallback and the attribution payload — and two of them
 * exist precisely because a second derivation of one rule had drifted from the first.
 *
 * The nets are ADDED, never replaced: an area can legitimately take a share of a wholesaler's city,
 * a share of the bulk book AND a share of the Office channel, and each is zero-sum per product, so
 * the sum is too.
 */
export function mergeRespreadIntoSplit(
  split: RespreadMergeableSplit,
  respread: ContributionRespread,
): RespreadMergeableSplit {
  if (respread.movements.length === 0) return split;
  const net = new Map(split.net);
  for (const [key, cell] of respread.net) {
    const existing = net.get(key);
    if (existing) net.set(key, { qty: existing.qty + cell.qty, value: existing.value + cell.value });
    else net.set(key, { ...cell });
  }
  return {
    exemptStoreValueByBrick: split.exemptStoreValueByBrick,
    movements: [...split.movements, ...respread.movements],
    net,
  };
}
