import { computeDirectOrderPricingBreakdown } from "@/lib/direct-orders/approval-fields";
import { priceBasketLine } from "@/lib/direct-orders/basket-value";
import { moneyMatches } from "@/lib/reconciliation/compare";

/**
 * The nightly direct-order totals audit (owner, 2026-10-19: "build the nightly direct-order and
 * approval-panel totals audit") — the comparisons, pure, so they can be proven without a database.
 *
 * Two defects in this module were reported by users before anything noticed them. On 18 Oct 2026 a
 * requester who added Lacto Advanced 2 to an order watched the total stay at line one's 24,750 EGP
 * (fixed in #6085), and the read-only audit that followed found the approver's Pricing row printing
 * only line one's working beside the full total. These four comparisons are what that audit checked
 * by hand, run every night instead:
 *
 *   1. an order's stored value is the sum of its lines            (what every screen, the closing
 *                                                                   and the collection remainder read)
 *   2. every line's value is the locked formula on its own prices  (the money a rep is credited)
 *   3. the approval panel's working equals the order's value       (the figure an approver decides on)
 *   4. the remainder is the value less cash less offsets           (the debt Finance chases)
 *
 * NO FORMULA IS RE-WRITTEN HERE. Line values go through `priceBasketLine`, the same two locked
 * functions and the same normalisation the server prices with; the panel's working goes through
 * `computeDirectOrderPricingBreakdown`, the function the panel itself prints. A second copy of
 * either would agree with whatever it was copied from and prove nothing.
 */

export type DirectOrderAuditDeal = "bonus" | "discount";

/** One `direct_order_requests` row, as every Direct Orders screen reads it. */
export type DirectOrderAuditOrder = {
  id: string;
  /** Who and what, in words: "<pharmacy> — <products>, raised <Cairo date>". Never the id alone. */
  label: string;
  dealType: DirectOrderAuditDeal;
  qty: number;
  bonus: number;
  discountPct: number | null;
  publicPriceSnapshot: number | null;
  pharmacyPriceSnapshot: number | null;
  salesValue: number;
  paidAmount: number | null;
  remainingAmount: number | null;
};

/** One `direct_order_request_items` row. */
export type DirectOrderAuditLine = {
  requestId: string;
  lineNo: number;
  productName: string;
  dealType: DirectOrderAuditDeal;
  qty: number;
  discountPct: number | null;
  publicPriceSnapshot: number | null;
  pharmacyPriceSnapshot: number | null;
  salesValue: number;
};

/** One `direct_order_marketing_offsets` row — a marketing request settled against the order's debt. */
export type DirectOrderAuditOffset = { directOrderId: string; amount: number };

const round2 = (value: number): number => Math.round(value * 100) / 100;

function linesByOrder(lines: readonly DirectOrderAuditLine[]): Map<string, DirectOrderAuditLine[]> {
  const byOrder = new Map<string, DirectOrderAuditLine[]>();
  for (const line of lines) {
    const bucket = byOrder.get(line.requestId) ?? [];
    bucket.push(line);
    byOrder.set(line.requestId, bucket);
  }
  for (const bucket of byOrder.values()) bucket.sort((a, b) => a.lineNo - b.lineNo);
  return byOrder;
}

// ── 1. The order's value is the sum of its lines ─────────────────────────────────────────────────

export type OrderValueMismatch = {
  order: DirectOrderAuditOrder;
  lineCount: number;
  /** The lines summed and rounded once, as resolveDirectOrderBasket stores the total. */
  linesTotal: number;
};

/**
 * Every order whose stored value is not the sum of its lines — or that has no lines at all, which
 * no order written since the items migration may have (loadDirectOrderItems treats it as broken).
 */
export function findOrderValueMismatches(
  orders: readonly DirectOrderAuditOrder[],
  lines: readonly DirectOrderAuditLine[],
): OrderValueMismatch[] {
  const byOrder = linesByOrder(lines);
  const mismatches: OrderValueMismatch[] = [];
  for (const order of orders) {
    const own = byOrder.get(order.id) ?? [];
    const linesTotal = round2(own.reduce((sum, line) => sum + line.salesValue, 0));
    if (own.length === 0 || !moneyMatches(order.salesValue, linesTotal)) {
      mismatches.push({ order, lineCount: own.length, linesTotal });
    }
  }
  return mismatches;
}

// ── 2. Every line is priced by the locked formula ─────────────────────────────────────────────────

export type LineFormulaMismatch = {
  order: DirectOrderAuditOrder | null;
  line: DirectOrderAuditLine;
  /** What the locked formula gives on the line's own price snapshot. */
  formulaValue: number;
  /** The price the deal is valued on — public for a discount, pharmacy for a bonus. Null = missing. */
  basisPrice: number | null;
};

export function findLineFormulaMismatches(
  orders: readonly DirectOrderAuditOrder[],
  lines: readonly DirectOrderAuditLine[],
): LineFormulaMismatch[] {
  const orderById = new Map(orders.map((order) => [order.id, order]));
  const mismatches: LineFormulaMismatch[] = [];
  for (const line of lines) {
    const priced = priceBasketLine({
      productCode: "",
      productName: line.productName,
      dealType: line.dealType,
      qty: line.qty,
      discountPct: line.discountPct ?? 0,
      publicPrice: line.publicPriceSnapshot,
      pharmacyPrice: line.pharmacyPriceSnapshot,
    });
    // A line with no basis price is refused by the server outright, so one that exists at all is a
    // finding however its stored value happens to read.
    if (priced.basisPrice == null || !moneyMatches(line.salesValue, priced.salesValue)) {
      mismatches.push({
        order: orderById.get(line.requestId) ?? null,
        line,
        formulaValue: priced.salesValue,
        basisPrice: priced.basisPrice,
      });
    }
  }
  return mismatches;
}

// ── 3. The approval panel's working equals the order's value ─────────────────────────────────────

export type ApprovalPanelMismatch = {
  order: DirectOrderAuditOrder;
  lineCount: number;
  /** The total the panel's Pricing row arrives at, exactly as it prints it. Null = a line "not set". */
  panelValue: number | null;
};

/**
 * Every order whose approval-panel working does not arrive at the order's value. The panel's own
 * function is called with the same lines the panel passes it, so this reads what an approver reads.
 *
 * Until 19 Oct 2026 the panel priced the order ROW, which holds line one only and keeps the discount
 * to 3 decimals where the line keeps 4 — 11 orders on the day this check shipped. It now prices every
 * line, so a gap here means the working and the stored value have parted again.
 *
 * The tolerance is the harness's one piastre, the same as every other money comparison here.
 */
export function findApprovalPanelMismatches(
  orders: readonly DirectOrderAuditOrder[],
  lines: readonly DirectOrderAuditLine[],
): ApprovalPanelMismatch[] {
  const byOrder = linesByOrder(lines);
  const mismatches: ApprovalPanelMismatch[] = [];
  for (const order of orders) {
    const own = byOrder.get(order.id) ?? [];
    const breakdown = computeDirectOrderPricingBreakdown(
      {
        dealType: order.dealType,
        qty: order.qty,
        bonus: order.bonus,
        pharmacyPriceSnapshot: order.pharmacyPriceSnapshot,
        publicPriceSnapshot: order.publicPriceSnapshot,
        discountPct: order.discountPct,
        salesValue: order.salesValue,
      },
      own,
    );
    const panelValue = breakdown.computedValue;
    if (panelValue == null || !moneyMatches(panelValue, order.salesValue)) {
      mismatches.push({ order, lineCount: own.length, panelValue });
    }
  }
  return mismatches;
}

// ── 4. The remainder is the value less cash less offsets ─────────────────────────────────────────

export type RemainderMismatch = {
  order: DirectOrderAuditOrder;
  offsetTotal: number;
  /** What remaining_amount must hold. Null = nothing recorded at all, exactly as an untouched order. */
  expected: number | null;
};

/**
 * What `remaining_amount` must hold, by the rule every writer follows (deriveDirectOrderCollection,
 * deriveRemainingWhenCollectionCleared, phx_record_direct_order_offset and its remove twin): null
 * when no cash and no offset was ever recorded, otherwise value − cash − offsets, each to 2 decimals.
 */
export function expectedRemainder(input: {
  salesValue: number;
  paidAmount: number | null;
  offsetTotal: number;
}): number | null {
  const offsets = round2(Number(input.offsetTotal) || 0);
  if (input.paidAmount == null && offsets <= 0) return null;
  return round2(round2(input.salesValue) - round2(input.paidAmount ?? 0) - offsets);
}

export function findRemainderMismatches(
  orders: readonly DirectOrderAuditOrder[],
  offsets: readonly DirectOrderAuditOffset[],
): RemainderMismatch[] {
  const offsetByOrder = new Map<string, number>();
  for (const offset of offsets) {
    offsetByOrder.set(offset.directOrderId, (offsetByOrder.get(offset.directOrderId) ?? 0) + Number(offset.amount || 0));
  }
  const mismatches: RemainderMismatch[] = [];
  for (const order of orders) {
    const offsetTotal = round2(offsetByOrder.get(order.id) ?? 0);
    const expected = expectedRemainder({ salesValue: order.salesValue, paidAmount: order.paidAmount, offsetTotal });
    const stored = order.remainingAmount;
    const agrees = expected === null ? stored === null : stored !== null && moneyMatches(stored, expected);
    // A negative debt reads on a Finance screen as a credit nobody agreed, whatever the arithmetic.
    if (!agrees || (stored !== null && stored < 0)) mismatches.push({ order, offsetTotal, expected });
  }
  return mismatches;
}
