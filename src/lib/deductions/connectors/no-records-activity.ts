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

/**
 * 🔴 THIS CATEGORY NO LONGER HAS A POPULATION. It returns nothing, on purpose.
 *
 * "No Activity Recorded" measures absence of CRM activity. Two owner decisions removed
 * everyone it could honestly apply to:
 *
 *   1. The FIELD WORKFORCE moved to the `crm` connector, which is the sole deduction
 *      authority for them (see this module's header). Running both double-booked every
 *      absence day — 142 employee-days in July 2026.
 *   2. HEAD OFFICE has no CRM obligation at all. Whoever remained after (1) was office
 *      staff being charged for not making field visits: in July 2026 the CEO (20 days),
 *      an R&D Manager (20), a Financial Advisor (20), the HR Manager (9), an Office
 *      Coordinator (14), a QPPV (4), two Admin Assistants (6) and a recruiter (1).
 *      None of them has a contact list. NONE had a fingerprint punch on any charged day
 *      either, so there was no corroborating signal in any direction — just an engine
 *      pointed at the wrong people. 22,161.32 EGP.
 *
 * Field workforce + Head Office is everybody, so the honest result is an empty set rather
 * than a scan that quietly finds someone new when a title changes.
 *
 * The engine behind it (`getCompanyNoActivityDays`) is NOT dead — it powers the Private
 * Calendar UI and survived the No Activity Days module's retirement for that reason. Only
 * the DEDUCTION use of it ends here. Retiring the category from DEDUCTION_COLLECTORS and
 * the workspace is a follow-up, kept separate so this change is reviewable on its own.
 */
export async function collectNoRecordsActivityCandidates(_input: {
  month: number;
  year: number;
}): Promise<DeductionsCandidateDraft[]> {
  return [];
}

/** Retained for the follow-up that retires the category; see the note above. */
export async function collectNoRecordsActivityCandidatesLegacy(input: {
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
    .flatMap((day) => {
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

      // NO SALARY BASIS ⇒ NO SALARY-BASED DEDUCTION.
      //
      // A day-rate deduction is Base Salary ÷ days in month. With no base salary
      // recorded there is nothing to take a fraction OF, so the honest result is
      // "not deductible", not "deductible, amount unknown". Emitting the latter
      // produced a NULL-amount candidate, and publishMonth refuses any month that
      // contains one — so people who are not on the salaried payroll at all were
      // silently blocking payday for everyone else.
      //
      // July 2026: 60 of the month's 62 publish-blocking NULLs were three people
      // with no base_salary on record (the CEO, an R&D Manager, a Financial
      // Advisor), plus one leaver at 0. All four are "no salary basis", not
      // "amount to be determined".
      //
      // Safe because the SYSTEMIC case is already guarded: assertBaseSalaryMapLoaded
      // above throws if the feeder returns an empty map, so reaching here means the
      // map loaded and THIS employee genuinely is not in it.
      if (estimatedAmount == null) return [];

      return [{
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
        // Always "calculated" now: the null-amount case returned early above, so a
        // draft reaching here has a real number behind it.
        calculationStatus: "calculated" as const,
        reason: day.description || "No activity recorded (Private Calendar)",
        evidence: { description: day.description },
        dates: [day.date],
      } satisfies DeductionsCandidateDraft];
    });
}
