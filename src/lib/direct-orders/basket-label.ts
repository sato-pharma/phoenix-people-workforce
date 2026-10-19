/**
 * How a multi-product order is LABELLED in a list.
 *
 * WHY THIS EXISTS. A direct order used to be one product, so `direct_order_requests.product_code`,
 * `product_name` and `qty` WERE the whole order. Baskets (a Lacto 1 + Lacto 2 order raised as one
 * request) made those columns line 1 only — but `sales_value` stayed the basket TOTAL, because
 * collection's `remaining_amount` derives from it and must never under-count. See the note on
 * `DirectOrderRequest.items` in types.ts.
 *
 * The consequence, reported by the owner on 2026-08-13 against a real approved order: a card reading
 * "Lacto Advanced 1 × 72" beside "25,344 EGP" is showing ONE product's name against TWO products'
 * money. The order was LA001 × 72 (19,008.00) + LA002 × 24 (6,336.00). Nothing was miscalculated —
 * the total is right — but a reader cannot see what the total is for, and on an approval screen that
 * means signing off money they cannot see.
 *
 * `getDirectOrderReport` already solved this for the report's own columns. This module is that same
 * rule, lifted out so there is ONE definition rather than a copy per surface — the report, the
 * approvals list, the Orders list, the Held Desk, the approval-exception desk, the returned desk and
 * Stuck Approvals all read it here.
 *
 * THE RULE:
 *   - one line  → the request's own columns, exactly as before baskets existed
 *   - a basket  → names and codes joined with " + ", and the units stay PER PRODUCT. A basket has
 *     no single quantity: units of different products or concentrations are NEVER added together —
 *     a unit total is valid for one product code only (owner rule,
 *     `units-of-different-products-are-never-added`). The first version summed them, so a
 *     Lacto Advanced 1 × 72 + Lacto Advanced 2 × 24 order read "Lacto Advanced 1 + Lacto Advanced 2
 *     × 96" on every list — 96 of nothing that exists.
 *   - prices and deal terms are NEVER composed: averaging two prices would invent a number, and a
 *     mixed-deal basket has no single discount. The order's own screen shows each line.
 */

export type DirectOrderBasketLine = {
  productCode: string;
  productName: string;
  qty: number;
};

export type DirectOrderBasketSummary = {
  /** Line 1's name for a single-product order; every name joined with " + " for a basket. */
  productName: string;
  /** Same composition as `productName`, for the code. */
  productCode: string;
  /**
   * The order's quantity when it is ONE product. NULL on a basket — never a sum: units of different
   * products are never added. A surface that wants the basket's units reads `lines`, or
   * `describeDirectOrderBasketUnits` for the one-line label.
   */
  qty: number | null;
  /**
   * One entry per product, ALWAYS populated — a single-product order returns its one line here, so
   * no caller has to branch on "is this a basket" before rendering. Mirrors the guarantee
   * `DirectOrderRequest.items` already makes.
   */
  lines: DirectOrderBasketLine[];
  /** True only when the order genuinely carries more than one product. */
  isBasket: boolean;
};

/**
 * Compose the label for one order.
 *
 * `head` is the request's own singular columns; `items` is its line rows. Items may be absent (a
 * caller that did not load them, or a request written before baskets existed) — that is treated as
 * a single-product order rather than as an error, because the singular columns are complete for it.
 */
export function summarizeDirectOrderBasket(
  head: { productCode: string; productName: string; qty: number },
  items: readonly DirectOrderBasketLine[] | null | undefined,
): DirectOrderBasketSummary {
  const lines = (items ?? []).map((item) => ({
    productCode: item.productCode,
    productName: item.productName,
    qty: item.qty,
  }));
  const isBasket = lines.length > 1;

  if (!isBasket) {
    // A one-product order reads its OWN columns, never the item row — even when an item row was
    // loaded and might differ. Two reasons, and both matter more than the tidiness of preferring
    // items uniformly:
    //
    //   1. It is what the report has always done, and the report's columns are positional twins
    //      consumed by the owner's Google Sheet every 60 seconds. This function exists to REMOVE a
    //      duplicated rule, not to change what any surface prints.
    //   2. They cannot disagree by construction: submitDirectOrder writes the singular columns from
    //      `lines[0]`, so line 1 IS the request's product.
    return {
      productName: head.productName,
      productCode: head.productCode,
      qty: head.qty,
      lines: [{ productCode: head.productCode, productName: head.productName, qty: head.qty }],
      isBasket: false,
    };
  }

  return {
    productName: lines.map((line) => line.productName).join(" + "),
    productCode: lines.map((line) => line.productCode).join(" + "),
    qty: null,
    lines,
    isBasket: true,
  };
}

/** Whole units, grouped the en-US way — the same rendering the approval window uses. */
function formatUnits(qty: number | null): string {
  if (qty === null) return "—";
  const n = Number(qty);
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—";
}

/**
 * One number per product, joined in line order: "72 + 24". The ONLY place a basket's units are put
 * side by side — never summed. Used for the report's Qty and Bonus cells, which keep their column
 * and become text on a basket (owner, 2026-10-19).
 */
export function joinDirectOrderBasketUnits(values: readonly (number | null)[]): string {
  return values.map(formatUnits).join(" + ");
}

/**
 * The lines a label speaks for: the item rows on a basket, otherwise the request's own columns —
 * the same "one product reads its own columns" choice `summarizeDirectOrderBasket` makes.
 */
function labelLines<T extends { qty: number | null }>(head: T, items?: readonly T[] | null): readonly T[] {
  return items && items.length > 1 ? items : [head];
}

/**
 * What the order is, in one line: every product with ITS OWN quantity.
 *
 *   one product → "Lacto Advanced 1 × 72"
 *   a basket    → "Lacto Advanced 1 × 72 + Lacto Advanced 2 × 24"
 *
 * The same shape the approval window's header prints, so a basket reads identically on a list and on
 * the order it opens. Takes the request's singular columns and its item rows rather than a summary,
 * so a client component holding a row with `items` can call it directly.
 */
export function describeDirectOrderBasketUnits(
  head: { productName: string; qty: number | null },
  items?: readonly { productName: string; qty: number }[] | null,
): string {
  return labelLines<{ productName: string; qty: number | null }>(head, items)
    .map((line) => `${line.productName} × ${formatUnits(line.qty)}`)
    .join(" + ");
}

/**
 * Just the units, per product, in the order the products are named: "72" or "72 + 24".
 *
 * For a column that sits beside a composed product name ("Lacto Advanced 1 + Lacto Advanced 2"),
 * where repeating every name would double the cell. Never a sum.
 */
export function describeDirectOrderBasketQuantities(
  head: { qty: number | null },
  items?: readonly { qty: number }[] | null,
): string {
  return joinDirectOrderBasketUnits(labelLines<{ qty: number | null }>(head, items).map((line) => line.qty));
}
