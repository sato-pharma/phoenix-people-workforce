/**
 * The rules for recording money collected against a direct order — pure, so they can be proven.
 *
 * Deliberately separate from service.ts: every guard here decides what happens to a real
 * receivable, and a rule that can only be exercised through Supabase is a rule that gets tested by
 * hoping. `todayCairo` is injected rather than read from the clock for the same reason — a
 * date-boundary guard you cannot pin to a date is not a guard you can trust.
 */

import { canonicalHrIdKey } from "@/lib/hr-id";
import type { AccessContext } from "@/lib/auth/permissions";

/**
 * The one person the owner named for Finance's direct-order duties (2026-08-03): Ahmed El Maraghy.
 * An HR_ID and not the "Finance Manager" ROLE, deliberately — these duties move money, and a second
 * Finance Manager hired later must not inherit them silently. service.ts re-exports this as
 * DIRECT_ORDER_SALES_MONTH_SETTER_HR_ID so the literal "B-185" exists in exactly one place.
 */
export const DIRECT_ORDER_FINANCE_HR_ID = "B-185";

/**
 * Who may record that money actually arrived.
 *
 * A SEPARATE predicate from canSetDirectOrderSalesMonth even though both resolve to the same person
 * today. They are different duties — booking a month decides which period the SALES count in,
 * recording a collection says what has been PAID — and the owner may split them once someone else
 * handles receivables. Lives here rather than in service.ts so it can be tested without a database.
 */
export function canRecordDirectOrderCollection(
  access: Pick<AccessContext, "scope" | "role" | "hrId">,
): boolean {
  if (access.scope === "system" || access.role === "Super Admin") return true;
  return canonicalHrIdKey(access.hrId) === canonicalHrIdKey(DIRECT_ORDER_FINANCE_HR_ID);
}

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
 */
export function deriveDirectOrderCollection(input: {
  status: string;
  salesValue: number;
  paidAmount: number | null | undefined;
  paymentDate: string | null | undefined;
  /** Today in Africa/Cairo as YYYY-MM-DD. Injected so the future-date guard is testable. */
  todayCairo: string;
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
    remainingAmount: round2(orderValue - paidRounded),
    paymentDate,
  };
}

/** Today in Cairo as YYYY-MM-DD. At 01:00 Cairo, UTC still reads yesterday. */
export function todayInCairo(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
}
