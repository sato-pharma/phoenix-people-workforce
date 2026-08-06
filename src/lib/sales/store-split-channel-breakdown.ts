// Applying the store city split to the Channel Breakdown grids.
//
// THE BUG THIS EXISTS TO CLOSE. The Closing Matrix and the Total sheet have the store split applied
// to them (store-split-matrix.ts, called by the export route). The Channel Breakdown's Area, Rep and
// Brick grids read straight from phx_closing_channel_breakdown, whose SQL contains no split at all.
// So ONE workbook published two different numbers for the same area: on Anti Infective 2026-07 the
// Matrix halves D15 (Gharbia) across D14 and D15 while the Area x Channel grid kept all 51,570.00 on
// D15, and the rep grid credited a wholesaler's entire sell-in to the single rep whose area the shop
// stands in — the exact behaviour the owner's store-split rule was written to stop.
//
// THE RULE ITSELF STAYS IN store-sales-city-split.ts. This module imports `CITY_AREAS`,
// `cityOfArea`, `isSplitEligibleLine` and `evenShares` from it and adds no rule of its own, exactly
// as store-split-matrix.ts does for the matrix. There is one store split in this codebase.
//
// THE AREA MOVEMENT IS THE MATRIX'S OWN, NOT A SECOND DERIVATION OF IT. `netByArea` is folded from
// exactly the movements applyStoreSplitToMatrix is handed, so the Area × Channel grid and the
// Closing Matrix agree area for area BY CONSTRUCTION rather than by two computations happening to
// land together.
//
// That is not a stylistic preference — it was measured. An earlier version of this module derived
// the movement from the breakdown grid's own `store` column, which looks equivalent and is not: the
// RPC classifies a customer from the name on source_of_sales_customer_directory_rollup, while the
// export's invoice rows carry the name the distributor put on the line, and the two disagree about
// which customers are wholesalers often enough to matter. On Anti Infective 2026-07 that left six
// areas disagreeing with the Matrix (CA4 by 10,580.00, D16 by 33,456.00) and eleven on Pedia. Two
// sheets in one workbook disagreeing about one area is the defect, whichever of them is right — so
// there is one source for the area movement and it is the one the Matrix already uses.
//
// THE BRICK SIDE IS READ OFF THE GRID INSTEAD, and deliberately. Bricks have no counterpart in the
// Matrix to agree with, so the property worth protecting there is the grid's own total: whatever is
// taken off a brick is what the shared row receives. Taking it from the grid's own `brick_area`
// figures means the subtraction cannot be a fraction of the number it subtracts from, and no key
// has to match across two sources.
//
// TOTAL IS PRESERVED IN ALL FOUR GRIDS. Money leaves an area and arrives in areas of the same city,
// so the area and rep grids net to zero. The brick grid is the one that cannot receive: the shares
// arrive in AREAS, and no brick in a neighbouring area sold them. So a brick's store money leaves it
// for a single named row — "Store sales shared across the city", the honest answer to "which brick is
// this in" being "none of them any more". The PRODUCT grid is untouched, correctly: the split moves
// money between areas of one city and never between products.

import {
  BREAKDOWN_BUCKET_PREFIX,
  type ChannelBreakdown,
  type ChannelBreakdownRow,
  emptyBreakdownRow,
} from "@/lib/sales/monthly-closing-channel-comparison";
import {
  isSplitEligibleLine,
  type StoreSplitAreaMovement,
} from "@/lib/sales/store-sales-city-split";

/** The brick grid's row for store money the city split took off its brick. */
export const STORE_SPLIT_BRICK_KEY = "__STORE_SPLIT__";

/** The rep key the breakdown RPC uses for an area that is not on the seat model. */
const NO_SEAT_KEY = "__NO_SEAT__";

export type ChannelBreakdownStoreSplit = {
  /** Per area, what the split moves IN (negative means the area is a net giver). Uppercase codes. */
  netByArea: ReadonlyMap<string, number>;
  /** Per brick, the store money the split takes off it. Never negative. Uppercase keys. */
  outByBrick: ReadonlyMap<string, number>;
  /**
   * The whole pool that moved — the sum of every area's outgoing store money. Equal to the sum of
   * `outByBrick` when the grids agree with each other, which is what the sheet states and what a
   * test asserts.
   */
  movedValue: number;
};

export function emptyChannelBreakdownStoreSplit(): ChannelBreakdownStoreSplit {
  return { movedValue: 0, netByArea: new Map(), outByBrick: new Map() };
}

function bump(map: Map<string, number>, key: string, delta: number): void {
  map.set(key, (map.get(key) ?? 0) + delta);
}

function upper(value: string): string {
  return value.trim().toUpperCase();
}

/** 6dp, matching every other money figure in the closing modules. */
function round(value: number): number {
  return Number(value.toFixed(6));
}

/**
 * What the split moves.
 *
 * `movements` MUST be the ones applyStoreSplitToMatrix was given for the same month — the export
 * route computes them once, in prepareClosingStoreSplit, and hands the same object to both. That
 * shared origin is the whole reason the two sheets agree; see the module header for what happened
 * when this function derived its own.
 *
 * Returns an empty movement — leaving the grids untouched — for a line the split does not cover
 * (Head Office), and for a month where no wholesaler sold in a city of more than one area.
 */
export function planChannelBreakdownStoreSplit(
  breakdown: ChannelBreakdown,
  movements: readonly StoreSplitAreaMovement[],
): ChannelBreakdownStoreSplit {
  if (!isSplitEligibleLine(breakdown.line) || movements.length === 0) {
    return emptyChannelBreakdownStoreSplit();
  }

  // Folded over products: the Matrix is an area × product grid and needs the movement at that
  // grain, these grids do not. Summing the per-product nets of an area gives that area's net, which
  // is exactly the number the Matrix's area row moved by.
  const netByArea = new Map<string, number>();
  const outByArea = new Map<string, number>();
  for (const movement of movements) {
    const area = upper(movement.areaCode);
    bump(netByArea, area, movement.inValue - movement.outValue);
    if (movement.outValue !== 0) bump(outByArea, area, movement.outValue);
  }

  // The brick side, read off the grid's own figures rather than off the rows — see the header. Only
  // bricks whose store money sits in an area that actually gave money up move; a brick in a
  // single-area city keeps everything, because nothing left that area.
  const outByBrick = new Map<string, number>();
  for (const entry of breakdown.brickArea) {
    if (entry.store === 0) continue;
    const area = upper(entry.areaKey);
    if (area.startsWith(BREAKDOWN_BUCKET_PREFIX)) continue;
    if (!outByArea.has(area)) continue;
    bump(outByBrick, upper(entry.brickKey), entry.store);
  }

  return {
    movedValue: round([...outByArea.values()].reduce((sum, value) => sum + value, 0)),
    netByArea,
    outByBrick,
  };
}

/** Add a delta to a grid, matching rows case-insensitively and creating one when the key is new. */
function applyDeltas(
  rows: readonly ChannelBreakdownRow[],
  deltas: ReadonlyMap<string, number>,
  labelFor: (key: string) => string,
): ChannelBreakdownRow[] {
  const out = rows.map((row) => ({ ...row }));
  const indexByKey = new Map(out.map((row, index) => [upper(row.key), index]));
  for (const [key, delta] of deltas) {
    if (delta === 0) continue;
    const found = indexByKey.get(key);
    if (found === undefined) {
      // An area that sold nothing of its own still RECEIVES its share of its city's store pool.
      // It has no row yet, so it gets one — dropping the share instead would lose the money and
      // is the failure this whole module exists to prevent.
      out.push({ ...emptyBreakdownRow(key, labelFor(key)), store: round(delta), total: round(delta) });
      indexByKey.set(key, out.length - 1);
      continue;
    }
    out[found] = {
      ...out[found],
      store: round(out[found].store + delta),
      total: round(out[found].total + delta),
    };
  }
  return out;
}

/**
 * Move the store money, and say how much moved.
 *
 * Area and Rep receive the net (in minus out) so both agree with the Closing Matrix area for area.
 * Brick loses its store money to one named row, because the shares arrive in areas and no brick
 * sold them. Product is returned untouched.
 */
export function applyStoreSplitToChannelBreakdown(
  breakdown: ChannelBreakdown,
  split: ChannelBreakdownStoreSplit,
): ChannelBreakdown {
  // `applied` records that the SPLIT RAN, not that it moved something — a month where no wholesaler
  // sold in a multi-area city is correctly split and moves nothing. The distinction matters because
  // the sheet prints a warning when the split never reached it, and "nothing to move" must not read
  // as "nobody ran this".
  if (split.movedValue === 0 && split.netByArea.size === 0) {
    return { ...breakdown, storeSplit: { applied: true, movedFromBricks: 0, movedValue: 0 } };
  }

  // The rep grid moves with the areas, through the seat map the RPC supplies. An area that is not
  // on the seat model lands on the same __NO_SEAT__ row the RPC already uses, so the split cannot
  // invent a rep and cannot lose the money either.
  const netByRep = new Map<string, number>();
  for (const [area, net] of split.netByArea) {
    if (net === 0) continue;
    bump(netByRep, breakdown.areaRep.get(area)?.key ?? NO_SEAT_KEY, net);
  }

  // Bricks: take the store money off each brick, but never more than the brick actually shows.
  // The clamp is what keeps the grid's total EXACTLY preserved — only what is really taken off a
  // brick is handed to the shared row, so the two sides cannot disagree even if the two maps do.
  const brick = breakdown.byDimension.brick.map((row) => ({ ...row }));
  const brickIndex = new Map(brick.map((row, index) => [upper(row.key), index]));
  let movedOffBricks = 0;
  for (const [key, out] of split.outByBrick) {
    const found = brickIndex.get(key);
    if (found === undefined) continue;
    const take = Math.min(out, brick[found].store);
    if (take <= 0) continue;
    brick[found] = {
      ...brick[found],
      store: round(brick[found].store - take),
      total: round(brick[found].total - take),
    };
    movedOffBricks += take;
  }
  if (movedOffBricks > 0) {
    brick.push({
      ...emptyBreakdownRow(STORE_SPLIT_BRICK_KEY, ""),
      store: round(movedOffBricks),
      total: round(movedOffBricks),
    });
  }

  return {
    ...breakdown,
    byDimension: {
      area: applyDeltas(breakdown.byDimension.area, split.netByArea, (key) => key),
      brick,
      product: breakdown.byDimension.product,
      rep: applyDeltas(
        breakdown.byDimension.rep,
        netByRep,
        (key) => [...breakdown.areaRep.values()].find((seat) => seat.key === key)?.label ?? "",
      ),
    },
    storeSplit: {
      applied: true,
      movedFromBricks: round(movedOffBricks),
      movedValue: split.movedValue,
    },
  };
}
