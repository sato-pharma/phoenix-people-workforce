import { formatCount, formatList, formatMoney, formatRowsAndMoney } from "@/lib/reconciliation/compare";
import {
  findApprovalPanelMismatches,
  findLineFormulaMismatches,
  findOrderValueMismatches,
  findRemainderMismatches,
  type DirectOrderAuditDeal,
  type DirectOrderAuditLine,
  type DirectOrderAuditOffset,
  type DirectOrderAuditOrder,
} from "@/lib/reconciliation/direct-order-totals";
import { retryOnceIfBreached } from "@/lib/reconciliation/retry";
import type { ReconciliationCheck, ReconciliationOutcome } from "@/lib/reconciliation/types";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * The nightly direct-order totals audit (owner, 2026-10-19). The comparisons and their account live
 * in direct-order-totals.ts; this file only reads the rows and words the verdict.
 *
 * Measured on production before it shipped, 19 Oct 2026: 242 orders, 252 lines, 103 orders with
 * money recorded. Checks 1, 2 and 4 held on every row; check 3 found 11 orders where the approval
 * panel printed line one's working (or a 3-decimal discount), and it holds since the panel prices
 * every line (the same day).
 *
 * Every order is read, whatever its status: a returned or rejected order's value is still the
 * figure its requester and approvers were shown, and there are a few hundred rows in all.
 */

const ORDER_COLUMNS =
  "id, status, product_name, deal_type, qty, bonus, discount_pct, public_price_snapshot, pharmacy_price_snapshot, sales_value, paid_amount, remaining_amount, created_at, pharmacy:direct_order_pharmacies(pharmacy_name)";
const LINE_COLUMNS =
  "id, request_id, line_no, product_name, deal_type, qty, discount_pct, public_price_snapshot, pharmacy_price_snapshot, sales_value";

type Row = Record<string, unknown>;

const num = (value: unknown): number => Number(value ?? 0) || 0;
const numOrNull = (value: unknown): number | null => (value == null || value === "" ? null : Number(value));
const deal = (value: unknown): DirectOrderAuditDeal => (String(value ?? "bonus") === "discount" ? "discount" : "bonus");

const cairoDate = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Africa/Cairo",
});

function pharmacyName(row: Row): string {
  // A many-to-one embed arrives as an object; typed clients sometimes hand it over as a one-row array.
  const embed = row.pharmacy as { pharmacy_name?: unknown } | Array<{ pharmacy_name?: unknown }> | null | undefined;
  const one = Array.isArray(embed) ? embed[0] : embed;
  return String(one?.pharmacy_name ?? "").trim() || "an unnamed pharmacy";
}

function describe(row: Row, products: readonly string[]): string {
  const created = row.created_at ? new Date(String(row.created_at)) : null;
  const raised = created && !Number.isNaN(created.getTime()) ? cairoDate.format(created) : "an unknown date";
  const status = String(row.status ?? "").replace(/_/g, " ") || "no status";
  const what = products.length > 0 ? products.join(" + ") : String(row.product_name ?? "").trim() || "no product";
  return `${pharmacyName(row)}: ${what}, raised ${raised} (${status})`;
}

type AuditRows = {
  orders: DirectOrderAuditOrder[];
  lines: DirectOrderAuditLine[];
  offsets: DirectOrderAuditOffset[];
};

async function loadAuditRows(options: { offsets: boolean }): Promise<AuditRows> {
  const supabase = getSupabaseAdmin();
  const [orderRows, lineRows, offsetRows] = await Promise.all([
    fetchAllRows<Row>(() => supabase.from("direct_order_requests").select(ORDER_COLUMNS), "id"),
    fetchAllRows<Row>(() => supabase.from("direct_order_request_items").select(LINE_COLUMNS), "id"),
    options.offsets
      ? fetchAllRows<Row>(() => supabase.from("direct_order_marketing_offsets").select("id, direct_order_id, amount"), "id")
      : Promise.resolve([] as Row[]),
  ]);

  const lines: DirectOrderAuditLine[] = lineRows.map((row) => ({
    requestId: String(row.request_id ?? ""),
    lineNo: num(row.line_no),
    productName: String(row.product_name ?? "").trim(),
    dealType: deal(row.deal_type),
    qty: num(row.qty),
    discountPct: numOrNull(row.discount_pct),
    publicPriceSnapshot: numOrNull(row.public_price_snapshot),
    pharmacyPriceSnapshot: numOrNull(row.pharmacy_price_snapshot),
    salesValue: num(row.sales_value),
  }));

  const productsByOrder = new Map<string, string[]>();
  for (const line of [...lines].sort((a, b) => a.lineNo - b.lineNo)) {
    const bucket = productsByOrder.get(line.requestId) ?? [];
    if (line.productName) bucket.push(line.productName);
    productsByOrder.set(line.requestId, bucket);
  }

  const orders: DirectOrderAuditOrder[] = orderRows.map((row) => ({
    id: String(row.id),
    label: describe(row, productsByOrder.get(String(row.id)) ?? []),
    dealType: deal(row.deal_type),
    qty: num(row.qty),
    bonus: num(row.bonus),
    discountPct: numOrNull(row.discount_pct),
    publicPriceSnapshot: numOrNull(row.public_price_snapshot),
    pharmacyPriceSnapshot: numOrNull(row.pharmacy_price_snapshot),
    salesValue: num(row.sales_value),
    paidAmount: numOrNull(row.paid_amount),
    remainingAmount: numOrNull(row.remaining_amount),
  }));

  const offsets: DirectOrderAuditOffset[] = offsetRows.map((row) => ({
    directOrderId: String(row.direct_order_id ?? ""),
    amount: num(row.amount),
  }));

  return { orders, lines, offsets };
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

/**
 * Check 1 — every order's stored value is the sum of its lines.
 *
 * `sales_value` on the order row is what every Direct Orders screen, the closing injection and the
 * collection remainder read; the lines are what the requester entered and the server priced. Retried
 * once on a breach: a returned order being corrected replaces its lines delete-then-insert, so a read
 * landing between the two halves sees an order with no lines for a moment.
 */
const orderValueIsTheSumOfItsLines: ReconciliationCheck = {
  id: "direct-orders-order-value-is-the-sum-of-its-lines",
  title: "Every direct order's value is the sum of its lines",
  domain: "direct-orders",
  severity: "critical",
  expectation: "holds",
  run: retryOnceIfBreached(async (): Promise<ReconciliationOutcome> => {
    const { orders, lines } = await loadAuditRows({ offsets: false });
    const mismatches = findOrderValueMismatches(orders, lines);
    const lineTotals = new Map<string, number>();
    for (const line of lines) lineTotals.set(line.requestId, (lineTotals.get(line.requestId) ?? 0) + line.salesValue);

    return {
      left: {
        source: "direct_order_requests.sales_value — the value the Direct Orders screens, the closing and the remainder read",
        value: formatRowsAndMoney(orders.length, sum(orders.map((order) => order.salesValue)), "order"),
      },
      right: {
        source: "direct_order_request_items.sales_value, summed per order and rounded once",
        value: formatRowsAndMoney(
          orders.length,
          sum(orders.map((order) => Math.round((lineTotals.get(order.id) ?? 0) * 100) / 100)),
          "order",
        ),
      },
      holds: mismatches.length === 0,
      detail:
        mismatches.length === 0
          ? `All ${formatCount(orders.length, "order")} equal the sum of their ${formatCount(lines.length, "line")}.`
          : formatList(
              mismatches.map((mismatch) =>
                mismatch.lineCount === 0
                  ? `${mismatch.order.label} reads ${formatMoney(mismatch.order.salesValue)} and has no lines at all`
                  : `${mismatch.order.label} reads ${formatMoney(mismatch.order.salesValue)}, its ${formatCount(mismatch.lineCount, "line")} add up to ${formatMoney(mismatch.linesTotal)}`,
              ),
            ),
    };
  }),
};

/**
 * Check 2 — every line is priced by the locked formula on its own price snapshot.
 *
 * Discount: qty × public price × (1 − discount%). Bonus: qty × pharmacy price, the bonus units never
 * counted, the factory price never used. A line is compared with itself, so there is no race to retry.
 */
const everyLineIsPricedByTheLockedFormula: ReconciliationCheck = {
  id: "direct-orders-every-line-is-priced-by-the-locked-formula",
  title: "Every direct-order line is valued by the locked pricing formula on its own prices",
  domain: "direct-orders",
  severity: "critical",
  expectation: "holds",
  run: async (): Promise<ReconciliationOutcome> => {
    const { orders, lines } = await loadAuditRows({ offsets: false });
    const mismatches = findLineFormulaMismatches(orders, lines);
    // A line the finder passed already carries the formula's value, so the formula side is the
    // stored total with each mismatched line swapped for what the formula gives it.
    const formulaByLine = new Map(mismatches.map((mismatch) => [mismatch.line, mismatch.formulaValue]));
    const formulaTotal = sum(lines.map((line) => formulaByLine.get(line) ?? line.salesValue));

    return {
      left: {
        source: "direct_order_request_items.sales_value — the money each line credits",
        value: formatRowsAndMoney(lines.length, sum(lines.map((line) => line.salesValue)), "line"),
      },
      right: {
        source: "priceBasketLine (computeDiscountSalesValue / computeDirectOrderSalesValue) on each line's own price snapshot",
        value: formatRowsAndMoney(lines.length, formulaTotal, "line"),
      },
      holds: mismatches.length === 0,
      detail:
        mismatches.length === 0
          ? `All ${formatCount(lines.length, "line")} are valued exactly as the locked formula prices them.`
          : formatList(
              mismatches.map((mismatch) => {
                const where = `${mismatch.order?.label ?? "an order that no longer exists"}, line ${mismatch.line.lineNo} (${mismatch.line.productName || "no product"})`;
                if (mismatch.basisPrice == null) {
                  const basis = mismatch.line.dealType === "discount" ? "public" : "pharmacy";
                  return `${where} has no ${basis} price, which the server refuses, yet carries ${formatMoney(mismatch.line.salesValue)}`;
                }
                return `${where} carries ${formatMoney(mismatch.line.salesValue)}, the formula on its own price gives ${formatMoney(mismatch.formulaValue)}`;
              }),
            ),
    };
  },
};

/**
 * Check 3 — the approval panel's Pricing working arrives at the order's value.
 *
 * The figure an approver decides on. Shipped known-open on 19 Oct 2026, when the panel priced the
 * order row (line one only, discount to 3 decimals) and 11 orders printed a working that did not
 * reach their value; tightened to "holds" the same day, when computeDirectOrderPricingBreakdown
 * began pricing every line. Retried once on a breach for the same reason as check 1: a returned
 * order's lines are replaced delete-then-insert, and a read between the halves sees them missing.
 */
const approvalPanelWorkingEqualsTheOrderValue: ReconciliationCheck = {
  id: "direct-orders-approval-panel-working-equals-the-order-value",
  title: "The direct-order approval panel's Pricing working arrives at the order's value",
  domain: "direct-orders",
  severity: "high",
  expectation: "holds",
  run: retryOnceIfBreached(async (): Promise<ReconciliationOutcome> => {
    const { orders, lines } = await loadAuditRows({ offsets: false });
    const mismatches = findApprovalPanelMismatches(orders, lines);
    const multiLine = mismatches.filter((mismatch) => mismatch.lineCount > 1).length;

    return {
      left: {
        source: "computeDirectOrderPricingBreakdown — the working the approval panel prints",
        value: formatCount(orders.length - mismatches.length, "order") + " whose working arrives at the value",
      },
      right: {
        source: "direct_order_requests.sales_value",
        value: formatCount(orders.length, "order"),
      },
      holds: mismatches.length === 0,
      detail:
        mismatches.length === 0
          ? `The approval panel's working arrives at the value on all ${formatCount(orders.length, "order")}.`
          : `${formatCount(mismatches.length, "order")} (${multiLine} with more than one product): ` +
            formatList(
              mismatches.map((mismatch) => {
                const shown =
                  mismatch.panelValue == null ? "no total (a line has no price)" : formatMoney(mismatch.panelValue);
                return `${mismatch.order.label} works out ${shown} across ${formatCount(mismatch.lineCount, "line")}, beside a value of ${formatMoney(mismatch.order.salesValue)}`;
              }),
            ),
    };
  }),
};

/**
 * Check 4 — what is still owed is the value less the cash collected less what was settled against
 * marketing requests. Retried once on a breach: the order and its offsets are separate reads, and
 * Finance recording a collection between them moves one side alone.
 */
const remainderIsValueLessCashLessOffsets: ReconciliationCheck = {
  id: "direct-orders-remainder-is-value-less-cash-less-offsets",
  title: "Every direct order's remaining amount is its value less cash collected less marketing settlements",
  domain: "direct-orders",
  severity: "critical",
  expectation: "holds",
  run: retryOnceIfBreached(async (): Promise<ReconciliationOutcome> => {
    const { orders, offsets } = await loadAuditRows({ offsets: true });
    const mismatches = findRemainderMismatches(orders, offsets);
    const withMoney = orders.filter((order) => order.paidAmount != null || order.remainingAmount != null);

    return {
      left: {
        source: "direct_order_requests.remaining_amount — the debt the Finance screens show",
        value: formatRowsAndMoney(withMoney.length, sum(withMoney.map((order) => order.remainingAmount ?? 0)), "order"),
      },
      right: {
        source: "sales_value − paid_amount − direct_order_marketing_offsets.amount, each to 2 decimals",
        value: `${formatCount(offsets.length, "marketing settlement")} across ${formatCount(orders.length, "order")}`,
      },
      holds: mismatches.length === 0,
      detail:
        mismatches.length === 0
          ? `Every remainder agrees: ${formatCount(withMoney.length, "order")} with money recorded, ${formatCount(offsets.length, "marketing settlement")}.`
          : formatList(
              mismatches.map((mismatch) => {
                const stored = mismatch.order.remainingAmount == null ? "nothing" : formatMoney(mismatch.order.remainingAmount);
                const expected =
                  mismatch.expected == null ? "nothing (no cash and no settlement recorded)" : formatMoney(mismatch.expected);
                return `${mismatch.order.label}: remaining reads ${stored}, it should read ${expected} (value ${formatMoney(mismatch.order.salesValue)}, cash ${formatMoney(mismatch.order.paidAmount ?? 0)}, settled against marketing ${formatMoney(mismatch.offsetTotal)})`;
              }),
            ),
    };
  }),
};

export const directOrdersReconciliationChecks: ReconciliationCheck[] = [
  orderValueIsTheSumOfItsLines,
  everyLineIsPricedByTheLockedFormula,
  approvalPanelWorkingEqualsTheOrderValue,
  remainderIsValueLessCashLessOffsets,
];
