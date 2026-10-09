// The EPDA-BULK contribution allocation — the owner's rule of 2026-10-09, from the September 2026
// closing on.
//
// The bulk sector (`EP-BK`, "ساتو قطاع الجملة") invoices wholesalers who supply the whole country,
// so the area on its invoice says where the warehouse is and nothing about where the medicine was
// sold. From September its Pedia units are therefore spread across the line's areas by each area's
// share of the OTHER distributors' sales value — his words: "the total sales contribution of the
// other distributors over the total sales … and based on this distribute the same contribution from
// EPDA bulk", and "distributed and calculated exactly as office".
//
// ─────────────────────────────────────────────────────────────────────────────
// IT IS A NET MOVEMENT, NOT A REWRITE — WHICH IS WHY IT RIDES THE CITY SPLIT'S RAILS
//
// The closing screen folds its matrix from `phx_closing_distributor_product`, the workbook rebuilds
// it from invoice rows, and `au.f_monthly_attribution` — achievement, incentives, the keycard, the
// Business Review — reads `source_of_sales_fact_rollup`. All three carry the INVOICED area. The city
// split already faces exactly that problem and solves it in one shape: a net per area × product,
// summing to zero per product, applied to the matrix (store-split-matrix.ts) and materialised for
// attribution (au.monthly_store_split_net). This rule produces the same shape, so every surface
// moves together and the grand total cannot change.
//
// The alternative — re-stamping the rows' area at upload, the way the Office channel is BORN
// allocated — was rejected deliberately. Office is uploaded last by convention, so its weights see
// the finished month; the bulk file is one distributor sheet among nineteen and lands whenever it
// lands. An upload-time spread would freeze whatever happened to be in the period that hour and
// nothing downstream would ever report it. Measured on CNS August 2026, the Office channel's own
// upload-time shares are already stale: seven batches were re-touched on 13–14 September, after the
// 10 September Office upload, and 3.39% of its units (~3,700) now sit in a different area from the
// one the current data would give them. A net recomputed on every read cannot go stale that way.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE SHARES ARE RECOMPUTED HERE AND NOT IMPORTED FROM THE LOCKED OFFICE RULE
//
// `buildOfficeAreaWeights` in office-allocation.ts is the locked GOLDEN RULE implementation of
// "an area's share of the line's sales value", and importing it would be the obvious move. It
// cannot be imported: office-allocation.ts imports monthly-distributor-import.ts, which imports
// attribution-store-split-refresh.ts → attribution-store-split-net.ts, which imports THIS module.
// That is a cycle through the 4,000-line matrix module, and the same cycle the headers of
// office-distributor.ts and store-split-matrix.ts already exist to avoid.
//
// 🔴 SO THE EQUIVALENCE IS PINNED BY A TEST INSTEAD OF BY AN IMPORT. The shares below are
// Σ salesValue per area ÷ Σ salesValue, which is identical to the locked rule's
// Σ (effectiveUnits × factory price) because that product IS the closing's `salesValue` for a
// distributor row. tests/closing-bulk-allocation.test.ts feeds one row set to both this module and
// buildOfficeAreaWeights and asserts the area shares match to 1e-9, so a change to the locked
// formula turns the required `validate` job red here instead of drifting silently.

import {
  isBulkAllocationActive,
  isBulkAllocationLine,
  isBulkDistributorCode,
} from "@/lib/sales/bulk-allocation-channel";
import {
  netStoreSplitByAreaProduct,
  type StoreSplitAreaMovement,
  type StoreSplitRow,
} from "@/lib/sales/store-sales-city-split";

/**
 * A closing detail row, narrowed to what this rule reads.
 *
 * `effectiveUnits` and `isConfidential` are optional so the arithmetic can be exercised with
 * hand-built rows: absent, the row's own `qty` is its effective units and the row is not
 * confidential, which is what every ordinary row is.
 */
export type BulkAllocationRow = StoreSplitRow & {
  effectiveUnits?: number;
  isConfidential?: boolean;
};

/** Per area × product, what the allocation moved. `net` is keyed by `areaProductKey`. */
export type BulkAllocation = {
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
  /** Each area's share of the OTHER distributors' sales value. Reported so a test can read it. */
  areaShare: Map<string, number>;
  /** Units the rule moved (the bulk book's own invoice units on the allocated line). */
  movedQty: number;
};

/** Nothing to move — a month before the rule, a line it never touches, or no bulk rows at all. */
function emptyAllocation(): BulkAllocation {
  return { movements: [], effectiveMovements: [], net: new Map(), areaShare: new Map(), movedQty: 0 };
}

/** Six decimal places, the same grain the locked Office reconciliation rounds to. */
function round6(value: number): number {
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
function spreadByShares(total: number, areaShare: ReadonlyMap<string, number>): Map<string, number> {
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

/** The row's effective units — the base the closing prices. Falls back to its invoice units. */
function effectiveUnitsOf(row: BulkAllocationRow): number {
  const effective = Number(row.effectiveUnits);
  return Number.isFinite(effective) ? effective : Number(row.qty) || 0;
}

/** A movement leg accumulator, keyed area|product, carrying both measures at once. */
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
 * The allocation for ONE line and period, computed over the WHOLE month's rows.
 *
 * `rows` must be the whole month, never a filtered or access-scoped slice: a share is a fraction of
 * the line's national sales, so a regional manager's four areas would otherwise divide the bulk book
 * among themselves and each take several times what the closing credits. Same rule, and the same
 * reason, as the Main Stores view in monthly-closing-details.ts.
 *
 * Returns an EMPTY allocation — not a throw — whenever the rule does not apply or cannot be
 * computed: a period before September 2026, a line that is not Pedia, a month with no bulk rows,
 * or (the one that matters) a month whose other distributors have no sales value to weight on at
 * all. In that last case the bulk rows keep their invoiced area, which is the state the closing was
 * in before this rule and the only honest answer when there is no contribution to copy.
 *
 * PURE: no database, no clock, no cache. Every caller hands it the rows it already has.
 */
export function buildBulkAllocation(
  rows: readonly BulkAllocationRow[],
  period: string | null | undefined,
  line?: string | null,
): BulkAllocation {
  if (!isBulkAllocationActive(period)) return emptyAllocation();
  // A caller that names the line gets an early exit; one that does not is answered per row below,
  // so a cross-line row set (the export's, before narrowing) still only moves Pedia's bulk.
  if (line !== undefined && line !== null && !isBulkAllocationLine(line)) return emptyAllocation();

  const base: BulkAllocationRow[] = [];
  const bulk: BulkAllocationRow[] = [];
  for (const row of rows) {
    // The population is the DISTRIBUTOR half of the closing, exactly as the matrix defines it:
    // direct orders carry no area at all, and an excluded row is not in the number being shared.
    if (row.isDirect) continue;
    if (!row.includedInClosing) continue;
    if (row.isConfidential === true) continue;
    if (!isBulkAllocationLine(row.officialLine)) continue;
    if (isBulkDistributorCode(row.distributorCode)) bulk.push(row);
    else base.push(row);
  }
  if (bulk.length === 0) return emptyAllocation();

  // ── The weights: each area's share of the OTHER distributors' sales value ──────────────────
  // VALUE, not units — his rule, and the Office rule it copies. Units cannot be added across
  // products at all (a pack of one product is not a pack of another), so a unit-weighted share
  // would be meaningless the moment a line carries more than one price.
  const areaValue = new Map<string, number>();
  for (const row of base) {
    const areaCode = String(row.areaCode ?? "").trim().toUpperCase();
    if (!areaCode) continue;
    const value = Number(row.salesValue);
    if (!Number.isFinite(value) || value <= 0) continue;
    areaValue.set(areaCode, (areaValue.get(areaCode) ?? 0) + value);
  }
  const totalValue = [...areaValue.values()].reduce((acc, value) => acc + value, 0);
  if (!(totalValue > 0)) return emptyAllocation();
  const areaShare = new Map<string, number>();
  for (const [areaCode, value] of areaValue) if (value > 0) areaShare.set(areaCode, value / totalValue);

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

  // OUT: every bulk row leaves the area it was invoiced to, measured exactly as the row carries it.
  // Taking the out legs from the rows themselves rather than re-deriving them is what makes the net
  // sum to zero whatever the row's own value basis was.
  for (const row of bulk) {
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
    const qtySlices = spreadByShares(totals.qty, areaShare);
    const effectiveSlices = spreadByShares(totals.effective, areaShare);
    const valueSlices = spreadByShares(totals.value, areaShare);
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
  // `city` is blank: this rule knows nothing about cities, and a blank city is already the shape the
  // frozen path writes (synthesizeFrozenMovements), so every consumer of a movement list tolerates
  // it. `line` carries the allocated line so the attribution payload can key on it.
  const movements: StoreSplitAreaMovement[] = [];
  const effectiveMovements: StoreSplitAreaMovement[] = [];
  const lineName = String(line ?? "").trim() || firstAllocatedLine(bulk);
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

/** The line the bulk rows are on, for a caller that did not name one. */
function firstAllocatedLine(bulk: readonly BulkAllocationRow[]): string {
  for (const row of bulk) {
    const line = String(row.officialLine ?? "").trim();
    if (line) return line;
  }
  return "";
}

/**
 * The city split's own result shape (`ClosingStoreSplit`), spelled structurally rather than
 * imported: closing-store-split-net.ts imports THIS module, and a type import back the other way
 * would be a cycle that only TypeScript's eraser hides.
 */
export type BulkMergeableSplit = {
  exemptStoreValueByBrick: ReadonlyMap<string, number>;
  movements: StoreSplitAreaMovement[];
  net: Map<string, { qty: number; value: number }>;
};

/**
 * Fold a bulk allocation into a city-split result, so the Closing Matrix, the workbook's Channel
 * Breakdown and the Total sheet's reconciliation all read ONE net and ONE movement list.
 *
 * Kept here rather than written out at each call site because there are three — the screen's cached
 * loader, the export's live fallback and the attribution payload — and two of them exist precisely
 * because a second derivation of one rule had drifted from the first.
 *
 * The two nets are ADDED, never replaced: an area can legitimately take a share of a wholesaler's
 * city AND a share of the bulk book, and both are zero-sum per product, so the sum is too.
 */
export function mergeBulkAllocationIntoSplit(
  split: BulkMergeableSplit,
  bulk: BulkAllocation,
): BulkMergeableSplit {
  if (bulk.movements.length === 0) return split;
  const net = new Map(split.net);
  for (const [key, cell] of bulk.net) {
    const existing = net.get(key);
    if (existing) net.set(key, { qty: existing.qty + cell.qty, value: existing.value + cell.value });
    else net.set(key, { ...cell });
  }
  return {
    exemptStoreValueByBrick: split.exemptStoreValueByBrick,
    movements: [...split.movements, ...bulk.movements],
    net,
  };
}
