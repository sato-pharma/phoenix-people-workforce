/**
 * The rules for recording money collected against a direct order — pure, so they can be proven.
 *
 * Deliberately separate from service.ts: every guard here decides what happens to a real
 * receivable, and a rule that can only be exercised through Supabase is a rule that gets tested by
 * hoping. `todayCairo` is injected rather than read from the clock for the same reason — a
 * date-boundary guard you cannot pin to a date is not a guard you can trust.
 */

/**
 * WHO may record a collection now lives in `finance-authority.ts` — the single boundary for every
 * "may this person do Finance's job" question (second-review finding 6, 2026-08-11). Re-exported
 * here so the many existing importers of this module keep working unchanged; the restriction
 * itself is byte-for-byte what it was.
 */
export {
  DIRECT_ORDER_FINANCE_HR_ID,
  canRecordDirectOrderCollection,
} from "@/lib/direct-orders/finance-authority";

export type DirectOrderCollectionOutcome =
  | { ok: true; paidAmount: number; remainingAmount: number; paymentDate: string }
  | { ok: false; message: string };

const round2 = (value: number): number => Math.round(value * 100) / 100;

const egp = (value: number): string =>
  `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EGP`;

/**
 * Validate a collection and derive what is still outstanding.
 *
 * The remainder is DERIVED here and never taken from the caller: two independent sources of truth
 * for the same money drift the moment someone edits one of them.
 *
 * `paidAmount` IS THE RUNNING TOTAL, NOT A PAYMENT. The caller sends what has been collected in
 * total to date, and it replaces whatever was stored. A second instalment is entered as the sum of
 * both. Everything below reads correctly once that is understood and confusingly if it is not, so
 * it is stated here rather than left to be inferred from `paidRounded > orderValue`.
 *
 * DO NOT MAKE THIS ACCUMULATE. A review proposed adding the input to the stored figure instead;
 * that was withdrawn, and must stay withdrawn — it would store 700 the moment Finance corrected a
 * typo from 200 to 500. The control pre-fills with the current total precisely so that editing is
 * the normal case.
 *
 * The model's full shape and its limits — no instalment ledger, no per-payment proof, no refunds,
 * no overpayment, and the pharmacy-probation signal that rides on `payment_date` — are documented
 * in docs/specs/direct-orders.md under "The collection model". This module is deliberately not the
 * place to grow them: it validates one total, and that is all it claims to do.
 */
export function deriveDirectOrderCollection(input: {
  status: string;
  salesValue: number;
  paidAmount: number | null | undefined;
  paymentDate: string | null | undefined;
  /** Today in Africa/Cairo as YYYY-MM-DD. Injected so the future-date guard is testable. */
  todayCairo: string;
  /**
   * Marketing requests already settled against this order (offset-rules.ts). They are debt that
   * has been paid off without any cash arriving, so cash plus offsets may never pass the order's
   * value, and the stored remainder is net of them. Absent means none.
   */
  offsetTotal?: number | null;
}): DirectOrderCollectionOutcome {
  // A draft, rejected, held or reversed order has no agreed debt, so money recorded against one
  // would be a receivable for stock the company never committed to supply.
  if (input.status !== "approved") {
    return { ok: false, message: "Only an approved direct order can have a collection recorded against it." };
  }

  const paid = Number(input.paidAmount);
  if (input.paidAmount == null || !Number.isFinite(paid) || paid <= 0) {
    return { ok: false, message: "Enter the amount collected as a number greater than zero." };
  }

  const orderValue = round2(Number(input.salesValue));
  if (!Number.isFinite(orderValue) || orderValue <= 0) {
    return { ok: false, message: "This order has no value to collect against." };
  }

  // Round BEFORE comparing, not after: 1000.005 against a 1000.00 order must be refused, not
  // quietly stored as 1000.01 — which would leave a negative remainder.
  const paidRounded = round2(paid);
  if (paidRounded > orderValue) {
    return { ok: false, message: `Collected cannot exceed the order value of ${egp(orderValue)}.` };
  }
  const offsetTotal = round2(Number(input.offsetTotal) || 0);
  if (offsetTotal > 0 && round2(paidRounded + offsetTotal) > orderValue) {
    return {
      ok: false,
      message:
        `Collected cannot exceed ${egp(round2(orderValue - offsetTotal))}: ${egp(offsetTotal)} of this order ` +
        "is already settled against marketing requests.",
    };
  }

  const paymentDate = String(input.paymentDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) {
    return { ok: false, message: "Enter the date the money was collected (YYYY-MM-DD)." };
  }
  // String comparison is safe and correct for ISO dates, and avoids re-introducing a timezone at
  // the exact point this guard exists to keep timezone-free.
  if (paymentDate > input.todayCairo) {
    return { ok: false, message: "The collection date cannot be in the future — record it once the money has arrived." };
  }

  return {
    ok: true,
    paidAmount: paidRounded,
    remainingAmount: round2(orderValue - paidRounded - offsetTotal),
    paymentDate,
  };
}

/** Today in Cairo as YYYY-MM-DD. At 01:00 Cairo, UTC still reads yesterday. */
export { todayInCairo } from "@/lib/date-only";

/**
 * The exception text `phx_record_direct_order_collection` raises, as the error a caller acts on.
 *
 * The database function re-checks the money arithmetic under the order's row lock, after the rules
 * above have already passed in TypeScript — so reaching one of these means the order changed between
 * the read and the write (an offset recorded, a second Finance save). `conflict` is the
 * compare-and-set loss: the caller's figures were stale, and the answer is to refresh. Every other
 * code is the same refusal `deriveDirectOrderCollection` gives, in the same words.
 *
 * Checked in this order so no code is matched inside a longer one.
 */
const COLLECTION_DB_ERRORS: ReadonlyArray<{ code: string; kind: "conflict" | "validation"; message: string }> = [
  {
    code: "direct_order_collection_conflict",
    kind: "conflict",
    message: "Conflict: this order's collection was changed by someone else a moment ago; refresh and try again.",
  },
  { code: "direct_order_collection_order_not_found", kind: "validation", message: "Direct order request not found." },
  {
    code: "direct_order_collection_not_approved",
    kind: "validation",
    message: "Only an approved direct order can have a collection recorded against it.",
  },
  {
    code: "direct_order_collection_amount_invalid",
    kind: "validation",
    message: "Enter the amount collected as a number greater than zero.",
  },
  { code: "direct_order_collection_no_value", kind: "validation", message: "This order has no value to collect against." },
  {
    code: "direct_order_collection_exceeds_net_value",
    kind: "validation",
    message:
      "Collected cannot exceed what is still owed on this order once its marketing settlements are deducted — " +
      "a settlement was recorded on it a moment ago; refresh and try again.",
  },
  {
    code: "direct_order_collection_exceeds_value",
    kind: "validation",
    message: "Collected cannot exceed the order value.",
  },
  {
    code: "direct_order_collection_date_required",
    kind: "validation",
    message: "Enter the date the money was collected (YYYY-MM-DD).",
  },
];

/** Maps a `phx_record_direct_order_collection` error to its kind and words; null when it is not one of ours. */
export function directOrderCollectionDbError(
  error: unknown,
): { code: string; kind: "conflict" | "validation"; message: string } | null {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error && "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : String(error ?? "");
  return COLLECTION_DB_ERRORS.find((entry) => text.includes(entry.code)) ?? null;
}
