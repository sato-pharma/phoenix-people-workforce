import { conflictError } from "@/lib/http/api-errors";

// ─────────────────────────────────────────────────────────────────────────────
// Booking a direct order into a sales month — the LOCKED-period guard.
//
// OWNER GOLDEN RULE, 2026-09-05: "whenever the finance manager choose a month for a direct order,
// this direct order must be calculated to this brick or area in the same month he added". The month
// and the sales are one decision, and nothing may separate them.
//
// `setDirectOrderSalesMonth` moves them in TWO steps that are not one transaction: it writes
// `direct_order_requests.sales_month`, then calls `phx_rebuild_direct_order_sos_batch` for every
// period the move touched. Every sales rollup carries `trg_lock_guard_ins/upd/del` ->
// `phx_reject_write_to_locked_closing`, which refuses ANY row belonging to a (line, period) that
// holds an open row in `monthly_closing_locks`. So booking into — or out of — a frozen month used
// to leave the month COMMITTED and the injection rejected: the order was in the month for Finance,
// and absent from the closing, from the export and from the rep's achievement, with no retry and no
// cron to notice. This module is what refuses that booking up front instead.
//
// BOTH periods are checked, not just the destination. Moving a booking OUT of a frozen month means
// deleting its rows from that month, which the same trigger refuses.
//
// Pure on purpose: the caller reads the locks, this decides. That keeps the rule testable without a
// database, and keeps it in one place rather than in whichever screen remembers to ask.
// ─────────────────────────────────────────────────────────────────────────────

export type SalesMonthLockOutcome =
  | { ok: true }
  | { ok: false; lockedPeriods: string[]; message: string };

/**
 * The periods a sales-month change touches: the one it leaves and the one it enters.
 *
 * De-duplicated, blanks dropped — setting a month for the first time touches exactly one period,
 * and clearing one also touches exactly one.
 */
export function periodsTouchedBySalesMonthChange(
  previousMonth: string | null | undefined,
  nextMonth: string | null | undefined,
): string[] {
  const cleaned = [previousMonth, nextMonth]
    .map((month) => String(month ?? "").trim())
    .filter((month) => month !== "");
  return [...new Set(cleaned)];
}

/**
 * Refuse a booking that a locked closing would only half-apply.
 *
 * `lockedPeriods` is what the caller found frozen for THIS ORDER'S LINE — a lock is per (line,
 * period), so another line's frozen August is none of this order's business.
 */
export function deriveSalesMonthLockRefusal(input: {
  line?: string | null;
  lockedPeriods: readonly string[];
  nextMonth: string | null;
  previousMonth: string | null;
}): SalesMonthLockOutcome {
  const touched = periodsTouchedBySalesMonthChange(input.previousMonth, input.nextMonth);
  const frozen = new Set(
    input.lockedPeriods.map((period) => String(period ?? "").trim()).filter((period) => period !== ""),
  );
  const hits = touched.filter((period) => frozen.has(period));
  if (hits.length === 0) return { ok: true };

  const line = String(input.line ?? "").trim();
  const subject = hits.length === 1 ? `The ${line ? `${line} ` : ""}Monthly Closing for ${hits[0]} is locked`
    : `The ${line ? `${line} ` : ""}Monthly Closings for ${hits.join(" and ")} are locked`;
  const leaving = input.previousMonth && hits.includes(String(input.previousMonth).trim());
  const detail = leaving
    ? "Moving this order would have to remove its sales from a frozen month."
    : "Booking this order would have to add its sales to a frozen month.";
  return {
    ok: false,
    lockedPeriods: hits,
    message:
      `${subject}. ${detail} The month was not saved, because saving it without its sales would ` +
      `leave the order booked for Finance and missing from the closing, the export and the rep's ` +
      `achievement. Unlock ${hits.join(" and ")} on the Monthly Closing screen, set the month, then lock it again.`,
  };
}

/** The same refusal as a thrown 409 — the shape the API route already renders. */
export function assertSalesMonthClosingsOpen(input: {
  line?: string | null;
  lockedPeriods: readonly string[];
  nextMonth: string | null;
  previousMonth: string | null;
}): void {
  const outcome = deriveSalesMonthLockRefusal(input);
  if (!outcome.ok) throw conflictError(outcome.message, "closing_locked");
}
