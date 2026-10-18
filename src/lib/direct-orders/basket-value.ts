import { computeDirectOrderSalesValue, computeDiscountSalesValue } from "@/lib/direct-orders/approval-flow";
import type { DirectOrderDealType } from "@/lib/direct-orders/types";

// ─────────────────────────────────────────────────────────────────────────────
// What a requester sees as the order's sales value BEFORE submitting.
//
// A direct order may carry several concentrations of one family (product-family.ts), each with its
// own quantity and deal. The server prices every line and stores the SUM as the request's value
// (resolveDirectOrderBasket in service.ts). The preview on the submit form priced only the main
// line, so a requester who added Lacto Advanced 2 saw the number not move at all — and could not
// tell whether the second line was counted.
//
// This module changes no formula. Each line goes through the same two functions the server uses,
// and a line the server would refuse for a missing price previews as 0 and says so.
// ─────────────────────────────────────────────────────────────────────────────

export type BasketValueLineInput = {
  productCode: string;
  productName: string;
  dealType: DirectOrderDealType;
  qty: number;
  discountPct: number;
  publicPrice: number | null;
  pharmacyPrice: number | null;
};

export type BasketValueLine = BasketValueLineInput & {
  /**
   * The unit price this line is valued on — the public price for a discount deal, the pharmacy
   * price for a bonus deal. Null when that price is missing, which the server refuses outright.
   */
  basisPrice: number | null;
  salesValue: number;
};

/** One line, valued exactly as resolveDirectOrderPricing values it. */
export function priceBasketLine(line: BasketValueLineInput): BasketValueLine {
  // The same normalisation the server applies: whole units, a discount held between 0 and 100.
  const qty = Math.max(0, Math.floor(Number(line.qty) || 0));
  const discountPct = Math.max(0, Math.min(100, Number(line.discountPct) || 0));

  const rawPrice = line.dealType === "discount" ? line.publicPrice : line.pharmacyPrice;
  const basisPrice = rawPrice != null && Number(rawPrice) > 0 ? Number(rawPrice) : null;

  let salesValue = 0;
  if (basisPrice != null) {
    salesValue =
      line.dealType === "discount"
        ? computeDiscountSalesValue({ qty, publicPrice: basisPrice, discountPct })
        : computeDirectOrderSalesValue({ qty, pharmacyPrice: basisPrice });
  }

  return { ...line, qty, discountPct, basisPrice, salesValue };
}

/**
 * The whole order: every line priced, and the total.
 *
 * The total is rounded once at the end, as the server does — summing pre-rounded lines and rounding
 * again is what would let a half-piastre differ between this screen and the stored value.
 */
export function previewBasketValue(lines: readonly BasketValueLineInput[]): {
  lines: BasketValueLine[];
  total: number;
} {
  const priced = lines.map(priceBasketLine);
  return {
    lines: priced,
    total: Math.round(priced.reduce((sum, line) => sum + line.salesValue, 0) * 100) / 100,
  };
}
