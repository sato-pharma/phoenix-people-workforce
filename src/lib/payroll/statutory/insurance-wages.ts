import { logError } from "@/lib/observability/log";
import { compactHrKey } from "@/lib/payroll/copilot/feeders.ts";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { computeSocialInsurance } from "./calculator.ts";
import type { StatutoryConfig } from "./types.ts";

/**
 * The ONE reader of `employees.social_insurance_wage`.
 *
 * WHY THIS EXISTS. That column alone decides the statutory filing — the status column beside it is
 * display-only, and NEITHER statutory figure reduces anybody's take-home pay (the company absorbs
 * both). Until now only the Payroll Copilot read the wage; the Automated Payroll engine copied the
 * raw `employees.social_insurance` figure straight onto the row instead, and the Statutory Summary
 * export worked BACKWARDS from that figure, dividing it by 11% to reconstruct a wage.
 *
 * Measured on production, August 2026, 100 published records:
 *
 *   - 94 carried exactly the raw employee column;
 *   - 0 carried 11% of that person's clamped insurance wage;
 *   - the reconstructed insured payroll came out at 2,626,960.36 against a true 1,214,513.00;
 *   - and 90 of the 100 reconstructed wages sat ABOVE the 16,700 legal ceiling, which the
 *     insurance office does not accept.
 *
 * A reconstruction cannot notice any of that: dividing by the rate always yields a number, and a
 * number always looks like an answer. Reading the wage cannot produce a figure over the ceiling at
 * all, because `clampInsuranceWage` is applied on the way in.
 *
 * The loader is deliberately defensive — a missing column or a transient failure returns an empty
 * map rather than throwing, because a statutory figure must never be the thing that stops payroll
 * running. An empty map means every caller falls back to what it carried, and each caller says so
 * in its own way rather than presenting the fallback as a computed answer.
 */

/** Compact HR id -> that person's stored insurance wage, or null when none is on file. */
export type InsuranceWageMap = Map<string, number | null>;

/**
 * Read every employee's insurance wage, keyed by compact HR id.
 *
 * HR ids in this database are mixed case AND inconsistently hyphenated, so the key goes through
 * `compactHrKey` — the same key every other payroll map is built on. A raw match silently
 * under-returns, and a person whose wage does not resolve reads as "no wage on file", which is
 * the one failure this map must not invent.
 */
export async function loadInsuranceWages(): Promise<InsuranceWageMap> {
  const map: InsuranceWageMap = new Map();
  try {
    const supabase = getSupabaseAdmin();
    // The WHOLE roster, page by page: a person cut off by a response ceiling would read as "no wage
    // on file" and fall back to the raw figure. A failed page falls to the catch below, which logs
    // it and hands back the (empty) map as before.
    const rows = await fetchAllRows<Record<string, unknown>>(
      () => supabase.from("employees").select("hr_id,social_insurance_wage"),
      "hr_id",
    );
    for (const row of rows) {
      const key = compactHrKey(String(row.hr_id ?? ""));
      if (!key) continue;
      const wage = row.social_insurance_wage;
      map.set(key, wage === null || wage === undefined ? null : Number(wage));
    }
  } catch (error) {
    logError("Employee social-insurance wage data load threw an exception", {
      labels: { event: "insurance_wage_load_threw" },
      error,
    });
  }
  return map;
}

/** A usable wage, or null — rejects the non-numbers a hand-edited column can hold. */
export function usableInsuranceWage(wage: number | null | undefined): number | null {
  if (wage === null || wage === undefined) return null;
  if (!Number.isFinite(wage) || wage <= 0) return null;
  return wage;
}

/**
 * What this person's statutory filing says, from their own wage.
 *
 * Returns null when no wage is on file, so a caller has to decide what to do about that in the
 * open. Every figure is derived from the CLAMPED subject wage, never from the deduction — so the
 * employer share can never be scaled off a wrong employee share, which is how the summary export
 * turned one wrong figure into three.
 */
export function statutoryFromInsuranceWage(
  wage: number | null | undefined,
  config: StatutoryConfig,
): { subjectWage: number; employee: number; employer: number } | null {
  const usable = usableInsuranceWage(wage);
  if (usable === null) return null;
  // computeSocialInsurance clamps the wage to the statutory floor and ceiling before it does
  // anything else, so the subject wage it hands back can never exceed the ceiling.
  const { subjectWage, employee, employer } = computeSocialInsurance(usable, config);
  return { subjectWage, employee, employer };
}
