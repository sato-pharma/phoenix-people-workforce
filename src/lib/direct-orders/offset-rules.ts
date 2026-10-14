/**
 * The rules for settling a marketing request against a direct order's debt — pure, so they can be
 * proven without a database. `phx_record_direct_order_offset` (migration 20261015012551) enforces
 * the same rules under row locks; this file is the readable copy the screen and the tests use, and
 * the one place the error codes the function raises are turned into words.
 *
 * THE SITUATION IT EXISTS FOR (Zamzam Hospital, October 2026). A hospital paid a direct order net
 * of EGP 25,000: the fee of a service the company owes the hospital's own doctor. The hospital
 * kept that sum out of its payment, so the company must neither collect it nor pay it a second
 * time. The order's debt falls by the 25,000 and the marketing request is settled by it — and no
 * cash moves in either direction.
 *
 * `paid_amount` on the order keeps meaning CASH THAT ARRIVED. An offset is not a collection, which
 * is why it lives in its own table and never writes `paid_amount` or `payment_date` (the phantom-
 * pharmacy check reads `payment_date` as proof money arrived — an offset is not that proof).
 */

const round2 = (value: number): number => Math.round(value * 100) / 100;

const egp = (value: number): string =>
  `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EGP`;

/** The statuses a request may be in when it is settled — the same money-bearing set the Finance command centre counts. */
export const OFFSET_ELIGIBLE_REQUEST_STATUSES = ["approved", "active", "roi_tracking", "finance_hold"] as const;

/**
 * What is still owed on an order: value, less cash collected, less every offset.
 *
 * Never negative in practice (both writers refuse to overshoot), but clamped at the derivation
 * rather than trusted, because a negative debt on a Finance screen reads as a credit nobody agreed.
 */
export function deriveOutstandingAmount(input: {
  salesValue: number;
  paidAmount: number | null | undefined;
  offsetTotal: number | null | undefined;
}): number {
  const value = round2(Number(input.salesValue) || 0);
  const paid = round2(Number(input.paidAmount) || 0);
  const offsets = round2(Number(input.offsetTotal) || 0);
  return Math.max(0, round2(value - paid - offsets));
}

/**
 * The remaining_amount to STORE after a collection is cleared. Nothing recorded at all reads as
 * null (exactly as an untouched order does); an order that still carries offsets has a real debt.
 */
export function deriveRemainingWhenCollectionCleared(input: {
  salesValue: number;
  offsetTotal: number | null | undefined;
}): number | null {
  const offsets = round2(Number(input.offsetTotal) || 0);
  if (offsets <= 0) return null;
  return deriveOutstandingAmount({ salesValue: input.salesValue, paidAmount: 0, offsetTotal: offsets });
}

export type OffsetOutcome = { ok: true; amount: number } | { ok: false; message: string };

/** May this offset be recorded, given the order and the request as they stand? */
export function validateOffset(input: {
  orderStatus: string;
  requestStatus: string;
  requestCost: number;
  amount: number | null | undefined;
  outstanding: number;
  requestAlreadySettled: boolean;
}): OffsetOutcome {
  if (String(input.orderStatus ?? "").toLowerCase() !== "approved") {
    return { ok: false, message: "Only an approved direct order can be settled against." };
  }
  if (!(OFFSET_ELIGIBLE_REQUEST_STATUSES as readonly string[]).includes(String(input.requestStatus ?? "").toLowerCase())) {
    return { ok: false, message: "The request has not been approved yet, so there is nothing to settle." };
  }
  if (input.requestAlreadySettled) {
    return { ok: false, message: "This request is already settled against a direct order. Remove that first to change it." };
  }
  const amount = Number(input.amount);
  if (input.amount == null || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: "Enter the amount as a number greater than zero." };
  }
  const rounded = round2(amount);
  const cost = round2(Number(input.requestCost) || 0);
  if (rounded > cost) {
    return { ok: false, message: `The amount cannot exceed the request's value of ${egp(cost)}.` };
  }
  const outstanding = round2(Number(input.outstanding) || 0);
  if (rounded > outstanding) {
    return { ok: false, message: `The order only has ${egp(outstanding)} still outstanding.` };
  }
  return { ok: true, amount: rounded };
}

/** The exception text `phx_record_direct_order_offset` / `phx_remove_direct_order_offset` raise, in words. */
const OFFSET_ERROR_MESSAGES: Record<string, string> = {
  offset_actor_required: "Sign in again — the action could not be attributed to anyone.",
  offset_amount_invalid: "Enter the amount as a number greater than zero.",
  offset_order_not_found: "That direct order was not found.",
  offset_request_not_found: "That marketing request was not found.",
  offset_order_not_approved: "Only an approved direct order can be settled against.",
  offset_request_not_approved: "The request has not been approved yet, so there is nothing to settle.",
  offset_request_already_settled: "This request is already settled against a direct order. Remove that first to change it.",
  offset_exceeds_request_cost: "The amount cannot exceed the request's value.",
  offset_exceeds_outstanding: "The order does not have that much still outstanding.",
  offset_not_found: "This request is not settled against any direct order.",
};

/** Maps a database error to a message a Finance user can act on; null when it is not one of ours. */
export function offsetErrorMessage(error: unknown): string | null {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error && "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : String(error ?? "");
  for (const [code, message] of Object.entries(OFFSET_ERROR_MESSAGES)) {
    if (text.includes(code)) return message;
  }
  return null;
}

/**
 * A missing table answers PGRST205 through PostgREST (not 42P01). The marketing workspace reads
 * offsets on every load, and a deploy applies NO migrations — so until the table exists the read
 * must degrade to "no offsets" instead of taking the whole Approved tab down.
 */
export function isMissingOffsetTableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  const text = String(message ?? "");
  return (
    code === "PGRST205" ||
    code === "42P01" ||
    (text.includes("direct_order_marketing_offsets") && (text.includes("schema cache") || text.includes("does not exist")))
  );
}
