// Business Review — outstation expenses, live.
//
// TWO NUMBERS, DELIBERATELY, because there is no single honest one.
//
// Production, checked 2026-08-22: HR approval only started being recorded properly in July 2026.
// Of 361 rows, the payroll-grade gate (`hr_approved AND approved_at IS NOT NULL AND approved_by IS
// NOT NULL` — the exact predicate phx_import_approved_expenses_to_payroll pays on) matches 0 rows
// in February and March, 1 in April, 3 in May, 5 in June, and then 70 of July's 79. Reporting only
// approved spend would show Feb–Jun as ~4,272 EGP. Reporting everything-except-rejected — the rule
// the old workbook used — shows ~90,680 for the same months. Neither is wrong; they answer
// different questions, and picking one silently would mislead by a factor of twenty.
//
// So the review carries both columns and names them: CLAIMED (excluding rejected) is what the
// field force asked for, APPROVED is what HR has signed off. A manager reviewing a district needs
// the first; anyone reconciling against payroll needs the second.
//
// Amount always goes through `payableExpenseAmount`, so a claim HR adjusted downward is counted at
// the adjusted figure and a row written before the `approved_amount` column existed still counts
// exactly what it always counted. Status is read through `isRejectedStatus`, a SUBSTRING test —
// rejected rows have been written by more than one surface over the years and an equality check
// reads some of them back as pending.

import { markDegraded } from "@/lib/cache/serve-uncached";
import { isRejectedStatus } from "@/lib/outstation/approval-state";
import { payableExpenseAmount } from "@/lib/outstation/payable";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginated";

import type { ReviewWindow } from "../period";

export type OutstationFact = {
  period: string;
  hrId: string;
  /** Payable amount, counted unless the row is rejected. */
  claimed: number;
  /** Same amount, but only when HR has actually signed the row off. */
  approved: number;
  rejected: boolean;
  travel: number;
  meeting: number;
  allowance: number;
  other: number;
};

export type OutstationLoad = {
  facts: OutstationFact[];
  periodsWithData: string[];
  totalRows: number;
};

function money(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function loadOutstationFacts(window: ReviewWindow): Promise<OutstationLoad> {
  const supabase = getSupabaseAdmin();
  const fromYear = Number(window.from.slice(0, 4));
  const toYear = Number(window.to.slice(0, 4));

  let rows: Record<string, unknown>[] = [];
  try {
    rows = await fetchAllRows<Record<string, unknown>>(
      () =>
        supabase
          .from("outstation_expenses")
          .select(
            "id, hr_id, payout_year, payout_month, total, approved_amount, hr_approved, " +
              "approved_at, approved_by, status, travel_cost, meeting_amount, allowance, other_amount",
          )
          .gte("payout_year", fromYear)
          .lte("payout_year", toYear),
      "id",
    );
  } catch {
    // "No data" for this render, marked so the bundle cache never keeps it past this render.
    return markDegraded({ facts: [], periodsWithData: [], totalRows: 0 });
  }

  const facts: OutstationFact[] = [];
  const periods = new Set<string>();

  for (const row of rows) {
    const month = Number(row.payout_month ?? 0);
    const year = Number(row.payout_year ?? 0);
    if (!month || !year) continue;
    const period = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
    if (!window.periods.includes(period)) continue;
    periods.add(period);

    const hrId = String(row.hr_id ?? "").trim();

    const rejected = isRejectedStatus(row.status as string | null);
    const payable = payableExpenseAmount(
      row.approved_amount == null ? null : Number(row.approved_amount),
      money(row.total),
    );
    // The payroll gate, verbatim: all three columns must be set, not just the boolean.
    const signedOff =
      row.hr_approved === true && row.approved_at != null && row.approved_by != null;

    facts.push({
      period,
      hrId,
      claimed: rejected ? 0 : payable,
      approved: signedOff ? payable : 0,
      rejected,
      travel: rejected ? 0 : money(row.travel_cost),
      meeting: rejected ? 0 : money(row.meeting_amount),
      allowance: rejected ? 0 : money(row.allowance),
      other: rejected ? 0 : money(row.other_amount),
    });
  }

  return {
    facts,
    periodsWithData: [...periods].sort(),
    totalRows: facts.length,
  };
}

export const OUTSTATION_ORIGIN = "public.outstation_expenses, keyed on payout_year / payout_month";
export const OUTSTATION_RULE =
  "Claimed counts every row that is not rejected, at the amount HR approved where they adjusted " +
  "one. Approved counts only rows carrying hr_approved plus both approved_at and approved_by — " +
  "the same gate payroll pays on.";
