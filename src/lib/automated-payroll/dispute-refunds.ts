import { roundCurrency } from "@/lib/payroll/money";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { periodMonthKey } from "./standing-additions.ts";
import type { PayrollPeriod } from "./types.ts";

/**
 * DISPUTE REFUNDS — a deduction given back because a reopened dispute cancelled or reduced it after
 * its own month's payroll was already paid (owner, 2026-10-09: reopen, and refund the deduction next
 * month — "in additions, other").
 *
 * A feeder for the Additions step's Other additions cell and nothing more, built exactly like
 * standing-additions.ts: it supplies the RECOMMENDATION and its reason; HR sees it and confirms the
 * step, and a value HR already saved on the run's draft row always wins (recommend.ts `pick`). It
 * never writes a draft row and never pays anyone by itself. The rows are written by the Dispute
 * Center (src/lib/dispute-center/refunds.ts) with the month they fall due already chosen — the first
 * month after the deduction's own whose payroll was still open.
 *
 * The due rule is pure so it is tested directly; only `loadDisputeRefunds` does I/O.
 */

export type DisputeRefundRow = {
  employeeHrIdCompact: string;
  amount: number;
  targetMonthKey: string;
  sourceMonthKey: string;
  reason: string;
  status: "recommended" | "cancelled";
};

export type DisputeRefundsForEmployee = { amount: number; reason: string };

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function monthLabel(monthKey: string): string {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(monthKey);
  return match ? `${MONTH_NAMES[Number(match[2]) - 1]} ${match[1]}` : monthKey;
}

/** Everything due this period, summed per employee, keyed by compact HR id. A cancelled refund is never due. */
export function disputeRefundsByCompact(
  rows: DisputeRefundRow[],
  period: PayrollPeriod,
): Map<string, DisputeRefundsForEmployee> {
  const key = periodMonthKey(period);
  const byCompact = new Map<string, DisputeRefundsForEmployee>();
  for (const row of rows) {
    if (row.status !== "recommended" || row.targetMonthKey !== key || !(row.amount > 0) || !row.employeeHrIdCompact) continue;
    const current = byCompact.get(row.employeeHrIdCompact) ?? { amount: 0, reason: "" };
    current.amount = roundCurrency(current.amount + row.amount);
    const reason = `Refund of a ${monthLabel(row.sourceMonthKey)} deduction: ${row.reason.trim()}`;
    current.reason = current.reason ? `${current.reason}; ${reason}` : reason;
    byCompact.set(row.employeeHrIdCompact, current);
  }
  return byCompact;
}

function isMissingTableError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const message = String((error as { message?: string } | null)?.message ?? error ?? "").toLowerCase();
  return code === "42P01" || code === "PGRST205" || (message.includes("relation") && message.includes("does not exist"));
}

/**
 * The refunds due this period. FAILS CLOSED on a read error, like the standing additions: a refund
 * that silently reads as zero is money owed back that nobody pays. Only a table not yet migrated
 * answers empty.
 */
export async function loadDisputeRefunds(period: PayrollPeriod): Promise<Map<string, DisputeRefundsForEmployee>> {
  const { data, error } = await getSupabaseAdmin()
    .from("dispute_refunds")
    .select("employee_hr_id_compact, amount, target_month_key, source_month_key, reason, status")
    .eq("status", "recommended")
    .eq("target_month_key", periodMonthKey(period));
  if (error) {
    if (isMissingTableError(error)) return new Map();
    throw error;
  }
  const rows: DisputeRefundRow[] = ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    amount: Number(row.amount ?? 0),
    employeeHrIdCompact: String(row.employee_hr_id_compact ?? ""),
    reason: String(row.reason ?? ""),
    sourceMonthKey: String(row.source_month_key ?? ""),
    status: row.status === "cancelled" ? "cancelled" : "recommended",
    targetMonthKey: String(row.target_month_key ?? ""),
  }));
  return disputeRefundsByCompact(rows, period);
}
