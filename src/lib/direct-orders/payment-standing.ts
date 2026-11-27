import { todayInCairo } from "@/lib/date-only";
import { listLateReceiptsForRequester, type LateReceiptOrder } from "@/lib/direct-orders/receipt-books";
import { validationError } from "@/lib/http/api-errors";
import { logError } from "@/lib/observability/log";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// What a pharmacy still owes, and what that means for its next order (owner, 27 Nov 2026).
//
// His words: «اى اوردر لاى عميل لم يسدد قيمه الاوردر الاول لا يتم خروج اوردر تانى له من نفس الصنف … او نفس
// العميل بعت اوردر ايفيرونك او جواموسين مثلا ممكن تنفيذه … لو عميل غير ملتزم بمواعيد التسديد المسجله … لازم
// السبستم يوضح لنا ان العميل ده مش ملتزم وبالتالى لازم ساعتها موافقه». His choices on the questions put to him:
//   • an earlier approved order of the SAME product (product code — Lacto Advanced 1, not its family) with
//     NOTHING collected refuses the new order outright;
//   • the same product PART-paid lets it climb, but only Dr Anwar's own approval finishes it;
//   • a pharmacy with any order still owing money after its recorded collection date is "not committed":
//     its new order is flagged and, again, only Dr Anwar's own approval finishes it;
//   • another product (Ivyronc, Guamusin) is untouched by the same-product rule.
// And the receipt rule beside it: a manager with a delivery receipt past its 7 days raises no new order.
//
// "Owed" is the stored `remaining_amount` — value less cash collected less marketing settlements, written
// by every collection and settlement — or the whole value when nothing was ever recorded (it is null then).
// Under one pound counts as paid: Finance has left orders a few piastres short (docs/specs/direct-orders.md).
// ─────────────────────────────────────────────────────────────────────────────

/** Less than this still owed counts as paid — a few piastres left by rounding are not a debt. */
export const PAID_TOLERANCE_EGP = 1;

export type PaymentStandingOrder = {
  requestId: string;
  salesValue: number;
  /** Stored remainder; null when no collection or settlement was ever recorded. */
  remainingAmount: number | null;
  /** The money-collection date written on the order (YYYY-MM-DD). */
  collectionDate: string | null;
  decidedAt: string | null;
  productCodes: string[];
  productNames: string[];
};

export type PaymentStandingEntry = PaymentStandingOrder & { owed: number };

export type PharmacyPaymentStanding = {
  /** Earlier orders of a product in the new order with nothing collected at all — the new order is refused. */
  unpaidSameProduct: PaymentStandingEntry[];
  /** Earlier orders of a product in the new order, part-paid — Dr Anwar's own approval is needed. */
  partPaidSameProduct: PaymentStandingEntry[];
  /** Orders still owing money after their collection date — the pharmacy is not committed. */
  overdue: PaymentStandingEntry[];
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

function productKey(code: string | null | undefined): string {
  return String(code ?? "").trim().toUpperCase();
}

/** What is still owed on one order. */
export function owedOn(order: Pick<PaymentStandingOrder, "salesValue" | "remainingAmount">): number {
  const value = round2(Number(order.salesValue) || 0);
  const owed = order.remainingAmount === null || order.remainingAmount === undefined ? value : round2(Number(order.remainingAmount) || 0);
  return Math.max(0, owed);
}

/**
 * Sort a pharmacy's earlier approved orders against a new order's products. Pure: `todayCairo` is
 * injected so the date edge is testable.
 */
export function classifyPharmacyPaymentStanding(input: {
  orders: readonly PaymentStandingOrder[];
  productCodes: readonly string[];
  todayCairo: string;
}): PharmacyPaymentStanding {
  const wanted = new Set(input.productCodes.map(productKey).filter(Boolean));
  const standing: PharmacyPaymentStanding = { unpaidSameProduct: [], partPaidSameProduct: [], overdue: [] };
  for (const order of input.orders) {
    const owed = owedOn(order);
    if (owed < PAID_TOLERANCE_EGP) continue;
    const entry: PaymentStandingEntry = { ...order, owed };
    if (order.collectionDate && order.collectionDate < input.todayCairo) standing.overdue.push(entry);
    if (!order.productCodes.some((code) => wanted.has(productKey(code)))) continue;
    const nothingCollected = owed >= round2(Number(order.salesValue) || 0) - 0.005;
    (nothingCollected ? standing.unpaidSameProduct : standing.partPaidSameProduct).push(entry);
  }
  return standing;
}

export type PaymentStandingVerdict =
  | { kind: "clear" }
  | { kind: "refused"; message: string }
  | { kind: "ceo_only"; message: string };

const egp = (value: number): string => `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} EGP`;

function productList(entries: readonly PaymentStandingEntry[], wanted: readonly string[]): string {
  const keys = new Set(wanted.map(productKey));
  const names = new Set<string>();
  for (const entry of entries) {
    entry.productCodes.forEach((code, index) => {
      if (keys.has(productKey(code))) names.add(entry.productNames[index] || code);
    });
  }
  return [...names].join(", ");
}

/** What the standing means for the new order: refused, Dr Anwar's own approval, or clear. */
export function paymentStandingVerdict(standing: PharmacyPaymentStanding, productCodes: readonly string[]): PaymentStandingVerdict {
  if (standing.unpaidSameProduct.length > 0) {
    const owed = standing.unpaidSameProduct.reduce((sum, entry) => sum + entry.owed, 0);
    return {
      kind: "refused",
      message:
        `This pharmacy has not paid anything on its earlier order of ${productList(standing.unpaidSameProduct, productCodes)} ` +
        `(${egp(round2(owed))} still owed), so a new order of the same product cannot go out. An order of another product can.`,
    };
  }
  const reasons: string[] = [];
  if (standing.partPaidSameProduct.length > 0) {
    const owed = standing.partPaidSameProduct.reduce((sum, entry) => sum + entry.owed, 0);
    reasons.push(`its earlier order of ${productList(standing.partPaidSameProduct, productCodes)} is only part-paid (${egp(round2(owed))} still owed)`);
  }
  if (standing.overdue.length > 0) {
    const owed = standing.overdue.reduce((sum, entry) => sum + entry.owed, 0);
    reasons.push(
      `it is not keeping to its payment dates: ${standing.overdue.length} order${standing.overdue.length === 1 ? " still owes" : "s still owe"} ${egp(round2(owed))} after the date written on ${standing.overdue.length === 1 ? "it" : "them"}`,
    );
  }
  if (reasons.length === 0) return { kind: "clear" };
  return { kind: "ceo_only", message: `Only Dr Anwar's own approval can finish this order: ${reasons.join("; and ")}.` };
}

type OrderRow = {
  id: string;
  product_code: string | null;
  product_name: string | null;
  sales_value: number | null;
  remaining_amount: number | null;
  collection_date: string | null;
  decided_at: string | null;
};

/**
 * A pharmacy's approved orders that still owe money, with their products. `excludeRequestId` leaves out
 * the order being decided, so it never counts against itself.
 */
export async function loadPharmacyOwingOrders(pharmacyId: string, options: { excludeRequestId?: string | null } = {}): Promise<PaymentStandingOrder[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("direct_order_requests")
    .select("id,product_code,product_name,sales_value,remaining_amount,collection_date,decided_at")
    .eq("pharmacy_id", pharmacyId)
    .eq("status", "approved")
    .is("reversal_of_request_id", null)
    .order("decided_at");
  if (error) throw error;
  const rows = ((data ?? []) as OrderRow[])
    .filter((row) => row.id !== options.excludeRequestId)
    .filter((row) => owedOn({ salesValue: Number(row.sales_value ?? 0), remainingAmount: row.remaining_amount }) >= PAID_TOLERANCE_EGP);
  if (rows.length === 0) return [];
  // Batches of 100 ids: about four hundred in one .in() overflow the request URL and read back EMPTY
  // with no error, which would leave every order with no product (see loadDirectOrderItemsForRequests).
  const items: { request_id: string; product_code: string | null; product_name: string | null }[] = [];
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100).map((row) => row.id);
    items.push(
      ...(await fetchAllRows<{ request_id: string; product_code: string | null; product_name: string | null }>(
        () => supabase.from("direct_order_request_items").select("id,request_id,product_code,product_name").in("request_id", batch),
        "id",
      )),
    );
  }
  const lines = new Map<string, { codes: string[]; names: string[] }>();
  for (const item of items) {
    const entry = lines.get(item.request_id) ?? { codes: [], names: [] };
    entry.codes.push(String(item.product_code ?? ""));
    entry.names.push(String(item.product_name ?? ""));
    lines.set(item.request_id, entry);
  }
  return rows.map((row) => ({
    requestId: row.id,
    salesValue: Number(row.sales_value ?? 0),
    remainingAmount: row.remaining_amount === null ? null : Number(row.remaining_amount),
    collectionDate: row.collection_date,
    decidedAt: row.decided_at,
    // An order with no item rows is the single product on its own row — as decideDirectOrder reads it.
    productCodes: lines.get(row.id)?.codes ?? (row.product_code ? [String(row.product_code)] : []),
    productNames: lines.get(row.id)?.names ?? (row.product_code ? [String(row.product_name ?? "")] : []),
  }));
}

/** The pharmacy's standing against one order's products, read now. */
export async function loadPharmacyPaymentStanding(input: {
  pharmacyId: string;
  productCodes: readonly string[];
  excludeRequestId?: string | null;
  now?: Date;
}): Promise<PharmacyPaymentStanding> {
  const orders = await loadPharmacyOwingOrders(input.pharmacyId, { excludeRequestId: input.excludeRequestId });
  return classifyPharmacyPaymentStanding({ orders, productCodes: input.productCodes, todayCairo: todayInCairo(input.now) });
}

/**
 * The refusal a late receipt gives, or null — to the manager raising an order, or to the approver
 * finishing one that manager raised.
 */
export function lateReceiptRefusal(late: readonly LateReceiptOrder[], audience: "requester" | "approver" = "requester"): string | null {
  if (late.length === 0) return null;
  const oldest = late.reduce((a, b) => (b.days > a.days ? b : a));
  const detail =
    `had no delivery receipt entered for more than 7 days (the oldest ${oldest.days} days, ${oldest.pharmacyName})`;
  if (audience === "approver") {
    return (
      `The manager who raised this order has ${late.length} approved order${late.length === 1 ? " that has" : "s that have"} ${detail}. ` +
      `This order cannot be approved until ${late.length === 1 ? "that receipt is" : "those receipts are"} entered.`
    );
  }
  return (
    `${late.length} of your approved orders ${late.length === 1 ? "has" : "have"} ${detail}. ` +
    `Enter ${late.length === 1 ? "it" : "them"} first; no new order can be raised until then.`
  );
}

/**
 * At the last approval: an order whose manager now has a delivery receipt past its 7 days is not
 * finished (owner, 27 Nov 2026: «ولا ينفذ له اوردارات اخرى»). This covers an order already climbing when
 * the receipt went late, and one revived from hold.
 */
export async function assertRequesterHasNoLateReceipts(requesterHrId: string, now?: Date): Promise<void> {
  const refusal = lateReceiptRefusal(await listLateReceiptsForRequester(requesterHrId, now), "approver");
  if (refusal) throw validationError(refusal);
}

/**
 * Refuse a new order before anything is written (owner, 27 Nov 2026): the requester has a delivery
 * receipt past its 7 days, or the pharmacy has not paid anything on an earlier order of the same
 * product. Everything else — a part-paid product, a late payer — climbs, and is stopped at the CEO's
 * step instead (`assertPaymentStandingAllowsFinalApproval`).
 */
export async function assertDirectOrderMayBeRaised(input: {
  requesterHrId: string;
  pharmacyId: string;
  productCodes: readonly string[];
  now?: Date;
}): Promise<void> {
  const [late, standing] = await Promise.all([
    listLateReceiptsForRequester(input.requesterHrId, input.now),
    loadPharmacyPaymentStanding({ pharmacyId: input.pharmacyId, productCodes: input.productCodes, now: input.now }),
  ]);
  const receiptRefusal = lateReceiptRefusal(late);
  if (receiptRefusal) throw validationError(receiptRefusal);
  const verdict = paymentStandingVerdict(standing, input.productCodes);
  if (verdict.kind === "refused") throw validationError(verdict.message);
}

/**
 * At the CEO's step, on approve: an order of a still-unpaid product is refused outright, and a flagged
 * one (part-paid product, a late payer) is finished only by the CEO himself — never the Super Admin
 * answering for him (owner, 27 Nov 2026: Dr Anwar decides).
 */
export async function assertPaymentStandingAllowsFinalApproval(input: {
  actorRole: string;
  requestId: string;
  pharmacyId: string;
  productCodes: readonly string[];
  now?: Date;
}): Promise<void> {
  const standing = await loadPharmacyPaymentStanding({
    pharmacyId: input.pharmacyId,
    productCodes: input.productCodes,
    excludeRequestId: input.requestId,
    now: input.now,
  });
  const verdict = paymentStandingVerdict(standing, input.productCodes);
  if (verdict.kind === "refused") throw validationError(verdict.message);
  if (verdict.kind === "ceo_only" && input.actorRole !== "CEO") throw validationError(verdict.message);
}

// ─── The notice on an order still being decided ──────────────────────────────

export type PaymentStandingNoticeLine = {
  requestId: string;
  products: string;
  owed: number;
  collectionDate: string | null;
  /** Owing after its collection date. */
  late: boolean;
  /** Nothing collected / part-paid, for an order of a product in this one; null for another product. */
  sameProduct: "unpaid" | "part_paid" | null;
};

export type PaymentStandingNotice =
  | { unavailable: true }
  | { unavailable?: false; verdict: Exclude<PaymentStandingVerdict, { kind: "clear" }>; lines: PaymentStandingNoticeLine[] };

/** Every order the notice lists, once, oldest first: same-product debts and late payments together. */
export function paymentStandingNoticeLines(standing: PharmacyPaymentStanding, todayCairo: string): PaymentStandingNoticeLine[] {
  const lines = new Map<string, PaymentStandingNoticeLine>();
  const add = (entry: PaymentStandingEntry, sameProduct: PaymentStandingNoticeLine["sameProduct"]) => {
    const existing = lines.get(entry.requestId);
    if (existing) {
      if (sameProduct) existing.sameProduct = sameProduct;
      return;
    }
    lines.set(entry.requestId, {
      requestId: entry.requestId,
      products: [...new Set(entry.productNames.filter(Boolean))].join(", ") || "Products not on file",
      owed: entry.owed,
      collectionDate: entry.collectionDate,
      late: Boolean(entry.collectionDate && entry.collectionDate < todayCairo),
      sameProduct,
    });
  };
  standing.unpaidSameProduct.forEach((entry) => add(entry, "unpaid"));
  standing.partPaidSameProduct.forEach((entry) => add(entry, "part_paid"));
  standing.overdue.forEach((entry) => add(entry, null));
  return [...lines.values()].sort((a, b) => String(a.collectionDate ?? "").localeCompare(String(b.collectionDate ?? "")));
}

/**
 * The payment notice for an order still climbing (pending or held): null when the pharmacy is clear or
 * the order is past deciding. A failed read is said, never shown as a clear pharmacy.
 */
export async function loadDirectOrderPaymentStandingNotice(input: {
  requestId: string;
  status: string;
  pharmacyId: string | null;
  productCodes: readonly string[];
  /** A reversal undoes an order; what the pharmacy owes never holds it. */
  isReversal?: boolean;
  now?: Date;
}): Promise<PaymentStandingNotice | null> {
  if (input.isReversal || !input.pharmacyId || (input.status !== "pending_approval" && input.status !== "held")) return null;
  try {
    const now = input.now ?? new Date();
    const standing = await loadPharmacyPaymentStanding({
      pharmacyId: input.pharmacyId,
      productCodes: input.productCodes,
      excludeRequestId: input.requestId,
      now,
    });
    const verdict = paymentStandingVerdict(standing, input.productCodes);
    if (verdict.kind === "clear") return null;
    return { verdict, lines: paymentStandingNoticeLines(standing, todayInCairo(now)) };
  } catch (error) {
    logError("Direct-order payment standing could not be read", { labels: { event: "direct_order_payment_standing_failed", requestId: input.requestId }, error });
    return { unavailable: true };
  }
}
