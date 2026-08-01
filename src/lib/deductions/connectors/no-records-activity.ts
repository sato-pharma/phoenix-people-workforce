// Unified Deductions module: No Records Activity category connector.
//
// Company-wide, HR-adjudicated per day (never automatic — unlike CRM). Reuses
// the existing Private Calendar "No Activity Recorded" engine, which already
// covers every active employee (not just field-force) and already excludes
// pre-hire days, holidays, and non-working days via derivePrivateCalendarExceptions'
// isExpectedWorkday gate. One candidate per (employee, day) — matching the
// granularity the retired No Activity Days clarification UX decided at. This
// connector is that module's successor surface, which is why
// getCompanyNoActivityDays survived its removal — do not delete that engine.
//
// Excludes the ENTIRE field workforce: `crm` is the sole deduction authority for
// that population, and this connector covers everyone it does not reach (Head
// Office, admin, support). Both engines measure the same thing — absence of CRM
// activity — so running both over the same person double-books every absence day.
//
// Measured on July 2026 production, running both produced 142 employee-days
// across 50 employees claimed by `crm` AND `no_records_activity`, with ZERO
// field-force days that `crm` had not already found. The overlap was never
// silently charged (publishMonth hard-blocks on day collisions), but it put 142
// manual clearances in front of every month's close for no added signal.
//
// Overlap was not the only cost. Scoping by title rather than by crm_id mapping
// also closes two guards this connector was quietly defeating:
//
//   1. THE ZERO-CRM-SIGNAL GUARD. `crm.ts`'s loadZeroCrmSignalHrIdKeys excludes a
//      field employee whose crm_id logged nothing all month — a data-mapping gap,
//      not 20+ real findings. This connector then re-flagged the same people:
//      Sara Samir (District Sales Manager) 24 days and Hossam AboElftouh
//      (Marketing Manager) 1 day in July 2026, both excluded by `crm` on purpose.
//   2. THE SFE MANAGER EXCLUSION. `isSfeManagerTitle` exists because an SFE
//      Manager "must never generate a payroll-deduction recommendation", but it
//      was only ever wired into the FWC engine behind `crm`. July 2026 carried a
//      live no_records_activity candidate for the SFE Manager. Excluding every
//      eligible title covers it, since "sfe manager" is in ELIGIBLE_TITLES.
//
// The previous rule tested `crm_id IS NULL`, so it caught only the unmapped
// field employee and let every mapped one through.

import { systemAccessContext } from "@/lib/auth/permissions.ts";
import { getCompanyNoActivityDays } from "@/lib/private-calendar/service.ts";
import { isFieldWorkforceComplianceEligibleTitle } from "@/lib/field-workforce-compliance/eligibility.ts";
import { canonicalHrIdKey } from "@/lib/hr-id.ts";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getBaseSalaryMap } from "@/lib/payroll/copilot/feeders.ts";
import { assertBaseSalaryMapLoaded } from "./health.ts";
import { calculateDeductionAmountFromBaseSalary } from "../calculations.ts";
import { compactDeductionsHrId } from "../candidate-key.ts";
import type { DeductionsCandidateDraft } from "../types.ts";

function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * Every employee `crm` owns. Title-scoped, NOT crm_id-scoped: a mapped field
 * employee is still the crm connector's to judge, so this one must stay out of
 * their way entirely. See the module header for the two guards the old
 * crm_id-only test was defeating.
 */
export function selectFieldWorkforceHrIdKeys(
  rows: ReadonlyArray<{ hr_id: string; job_title: string | null }>,
): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    if (!isFieldWorkforceComplianceEligibleTitle(row.job_title)) continue;
    const key = canonicalHrIdKey(row.hr_id);
    if (key) keys.add(key);
  }
  return keys;
}

async function loadFieldWorkforceHrIdKeys(): Promise<Set<string>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("employees").select("hr_id,job_title");
  if (error) {
    // Defensive: if this check itself fails, don't block candidate generation
    // on it — proceed with no exclusion rather than throwing.
    return new Set();
  }
  return selectFieldWorkforceHrIdKeys((data ?? []) as Array<{ hr_id: string; job_title: string | null }>);
}

export async function collectNoRecordsActivityCandidates(input: {
  month: number;
  year: number;
}): Promise<DeductionsCandidateDraft[]> {
  const monthKey = `${input.year}-${String(input.month).padStart(2, "0")}`;
  const start = `${monthKey}-01`;
  const end = `${monthKey}-${String(lastDayOfMonth(input.year, input.month)).padStart(2, "0")}`;

  const [days, fieldWorkforceKeys, baseSalaryByCompact] = await Promise.all([
    getCompanyNoActivityDays({ access: systemAccessContext, start, end }),
    loadFieldWorkforceHrIdKeys(),
    getBaseSalaryMap(),
  ]);
  // Fail closed — without salaries every candidate's amount is null, which the
  // old publish path turned into a silent 0.00 EGP line.
  assertBaseSalaryMapLoaded("No Records Activity connector", baseSalaryByCompact);

  return days
    .filter((day) => {
      // The field workforce belongs to `crm`. Letting them through here books the
      // same absence day twice and re-flags people `crm` deliberately excluded.
      const key = canonicalHrIdKey(day.employeeHrId);
      return !(key && fieldWorkforceKeys.has(key));
    })
    .map((day) => {
      // Compute the money here, not at publish time. This connector previously
      // emitted no estimatedAmount at all, and publish's old `?? 0` fallback
      // turned that into a 0.00 EGP line — so the entire category could publish
      // looking successful while deducting nothing. getBaseSalaryMap is keyed by
      // the COMPACT hr-id (hyphens stripped), not the canonical one; using
      // canonicalHrIdKey here would silently miss every lookup (a real bug already
      // hit once in the CRM connector).
      const compactKey = compactDeductionsHrId(day.employeeHrId);
      const baseSalary = compactKey ? (baseSalaryByCompact.get(compactKey) ?? null) : null;
      const estimatedAmount = calculateDeductionAmountFromBaseSalary({
        baseSalary,
        deductionDays: 1,
        month: input.month,
        year: input.year,
      });
      return {
        category: "no_records_activity",
        sourceSystem: "no_activity_engine",
        sourceRecordId: `${day.employeeHrId}:${day.date}`,
        employeeHrId: day.employeeHrId,
        employeeName: day.employeeName,
        monthKey,
        month: input.month,
        year: input.year,
        unit: "days",
        rawValue: 1,
        estimatedAmount,
        // Still requires_review when the amount is unknown — publish now refuses
        // such a candidate outright rather than silently zeroing it.
        calculationStatus: estimatedAmount != null ? "calculated" : "requires_review",
        reason: day.description || "No activity recorded (Private Calendar)",
        evidence: { description: day.description },
        dates: [day.date],
      } satisfies DeductionsCandidateDraft;
    });
}
