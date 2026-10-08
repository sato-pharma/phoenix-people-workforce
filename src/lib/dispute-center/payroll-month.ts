import { getSupabaseAdmin } from "@/lib/supabase/server";

// Is a payroll month's money already final? The one question that decides whether a dispute decision
// can still change that month's payslip, or has to give the money back in a LATER month instead
// (owner, 2026-10-09: reopen anyway, and refund the deduction next month — "in additions, other").
//
// Final means either of the two states deduction-resync.ts refuses to rewind:
//   - the month has a PUBLISHED run (payslips out), or
//   - its active run has Part 2 confirmed (the carry-forward ledger is settled; planDeductionResync
//     skips it with `part2_already_confirmed`).
// Anything else — no run yet, or a run still in Part 1 / Part 2 — still takes a decision change
// through the normal resync, so no refund is needed and none is made.

export type PayrollMonthState = "open" | "paid";

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** "2026-09" -> "2026-10"; "2026-12" -> "2027-01". */
export function nextMonthKey(monthKey: string): string {
  const match = MONTH_KEY.exec(monthKey.trim());
  if (!match) throw new Error(`Validation: "${monthKey}" is not a YYYY-MM month.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
}

/** Pure: given a month's runs, is its money final? Exported for the test. */
export function payrollMonthStateFromRuns(
  runs: Array<{ phase: string | null; part2_confirmed_at: string | null }>,
): PayrollMonthState {
  for (const run of runs) {
    if (run.phase === "published") return "paid";
    if (run.phase !== "cancelled" && run.part2_confirmed_at) return "paid";
  }
  return "open";
}

export async function payrollMonthState(monthKey: string): Promise<PayrollMonthState> {
  const match = MONTH_KEY.exec(monthKey.trim());
  if (!match) throw new Error(`Validation: "${monthKey}" is not a YYYY-MM month.`);
  const { data, error } = await getSupabaseAdmin()
    .from("automated_payroll_runs")
    .select("phase, part2_confirmed_at")
    .eq("year", Number(match[1]))
    .eq("month", Number(match[2]));
  if (error) throw error;
  return payrollMonthStateFromRuns((data ?? []) as Array<{ phase: string | null; part2_confirmed_at: string | null }>);
}

/**
 * The first month AFTER `monthKey` whose payroll is still open — where a refund is recommended. Looks
 * up to two years ahead; a run that far out does not exist, so the loop always ends on an open month.
 */
export async function nextOpenPayrollMonth(monthKey: string): Promise<string> {
  let candidate = nextMonthKey(monthKey);
  for (let step = 0; step < 24; step += 1) {
    if ((await payrollMonthState(candidate)) === "open") return candidate;
    candidate = nextMonthKey(candidate);
  }
  return candidate;
}

/** "2026-09" -> "September 2026". Date-only, never through a zone. */
export function monthKeyLabel(monthKey: string): string {
  const match = MONTH_KEY.exec(String(monthKey ?? "").trim());
  if (!match) return String(monthKey ?? "");
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${names[Number(match[2]) - 1]} ${match[1]}`;
}
