import { compactHrKey } from "@/lib/payroll/copilot/feeders.ts";
import { roundCurrency } from "@/lib/payroll/money";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type { PayrollPeriod } from "./types.ts";

/**
 * STANDING ADDITIONS — incentive or bonus an employee is owed on a cadence, or once.
 *
 * Owner request 2026-09-13: an employee owed 60,000 EGP every three months was paid it in February
 * and May 2026 because somebody typed it into the Additions step, and was not paid it in August
 * because nobody did. Additions was the one money step with no feeder, so nothing could notice.
 *
 * This is that feeder, and deliberately nothing more. It only supplies the Additions step's
 * RECOMMENDATION and its reason: HR still sees the figure and confirms the step, and a value HR has
 * already saved on the run's draft row always wins (recommend.ts `pick`). It never writes a draft
 * row and never pays anyone by itself.
 *
 * The due-date rule is pure so it can be tested directly; only `loadStandingAdditions` does I/O.
 */

export type StandingAdditionField = "incentive" | "bonus";

export type StandingAddition = {
  employeeHrIdCompact: string;
  field: StandingAdditionField;
  amount: number;
  /** null = one-off, due only in firstMonthKey. */
  everyMonths: number | null;
  /** "YYYY-MM" */
  firstMonthKey: string;
  /** "YYYY-MM", or null when open-ended. */
  lastMonthKey: string | null;
  reason: string;
  active: boolean;
};

/** What the Additions step recommends for one employee this month. */
export type StandingAdditionsForEmployee = {
  incentive: number;
  bonus: number;
  reason: string;
};

const TABLE = "automated_payroll_standing_additions";

function monthIndexFromKey(monthKey: string): number | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(monthKey);
  if (!match) return null;
  return Number(match[1]) * 12 + (Number(match[2]) - 1);
}

export function periodMonthKey(period: PayrollPeriod): string {
  return `${period.year}-${String(period.month).padStart(2, "0")}`;
}

/** True when the entry falls due in the given period. */
export function isStandingAdditionDue(entry: StandingAddition, period: PayrollPeriod): boolean {
  if (!entry.active || !(entry.amount > 0)) return false;
  const current = period.year * 12 + (period.month - 1);
  const first = monthIndexFromKey(entry.firstMonthKey);
  if (first === null || current < first) return false;
  if (entry.lastMonthKey) {
    const last = monthIndexFromKey(entry.lastMonthKey);
    if (last === null || current > last) return false;
  }
  if (entry.everyMonths === null) return current === first;
  if (!Number.isInteger(entry.everyMonths) || entry.everyMonths < 1) return false;
  return (current - first) % entry.everyMonths === 0;
}

/** Everything due this period, summed per employee, keyed by compact HR id. */
export function standingAdditionsByCompact(
  entries: StandingAddition[],
  period: PayrollPeriod,
): Map<string, StandingAdditionsForEmployee> {
  const byCompact = new Map<string, StandingAdditionsForEmployee>();
  for (const entry of entries) {
    if (!isStandingAdditionDue(entry, period)) continue;
    const current = byCompact.get(entry.employeeHrIdCompact) ?? { incentive: 0, bonus: 0, reason: "" };
    current[entry.field] = roundCurrency(current[entry.field] + entry.amount);
    const reason = entry.reason.trim();
    current.reason = current.reason ? `${current.reason}; ${reason}` : reason;
    byCompact.set(entry.employeeHrIdCompact, current);
  }
  return byCompact;
}

function isMissingTableError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const message = String((error as { message?: string } | null)?.message ?? error ?? "").toLowerCase();
  return code === "42P01" || code === "PGRST205" || (message.includes("relation") && message.includes("does not exist"));
}

function mapRow(row: Record<string, unknown>): StandingAddition {
  return {
    employeeHrIdCompact: String(row.employee_hr_id_compact ?? "") || compactHrKey(String(row.employee_hr_id ?? "")),
    field: row.field === "bonus" ? "bonus" : "incentive",
    amount: Number(row.amount ?? 0),
    everyMonths: row.every_months == null ? null : Number(row.every_months),
    firstMonthKey: String(row.first_month_key ?? ""),
    lastMonthKey: (row.last_month_key as string | null) ?? null,
    reason: String(row.reason ?? ""),
    active: row.active !== false,
  };
}

/**
 * The standing additions due this period.
 *
 * FAILS CLOSED on a read error: an addition that silently reads as zero is a person not paid money
 * they are owed, which is the exact failure this module exists to stop. Only a table not yet
 * migrated into the environment answers empty.
 */
export async function loadStandingAdditions(
  period: PayrollPeriod,
): Promise<Map<string, StandingAdditionsForEmployee>> {
  const { data, error } = await getSupabaseAdmin().from(TABLE).select("*").eq("active", true);
  if (error) {
    if (isMissingTableError(error)) return new Map();
    throw error;
  }
  return standingAdditionsByCompact(((data ?? []) as Array<Record<string, unknown>>).map(mapRow), period);
}
