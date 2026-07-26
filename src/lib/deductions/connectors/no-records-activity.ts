// Unified Deductions module: No Records Activity category connector.
//
// Company-wide, HR-adjudicated per day (never automatic — unlike CRM). Reuses
// the existing Private Calendar "No Activity Recorded" engine, which already
// covers every active employee (not just field-force) and already excludes
// pre-hire days, holidays, and non-working days via derivePrivateCalendarExceptions'
// isExpectedWorkday gate. One candidate per (employee, day) — matching the
// granularity the existing clarification UX (no-activity-clarifications.ts)
// already decides at.
//
// Excludes field-eligible-title employees with no crm_id mapping at all —
// mirrors the existing FWC Tier-0 guard (generatedRecommendations skips
// crmIdentity.confidence === "unresolved" for the same reason). Verified via
// Phase 3 reconciliation against real June 2026 data: an employee with zero
// possible positive signal (field role, no CRM account, no device punches by
// design) gets flagged nearly every single workday — not a useful finding,
// just noise from a data-mapping gap that needs fixing once, not 20+
// individual "day without record" candidates a month.

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

async function loadCrmIdentityUnresolvedHrIdKeys(): Promise<Set<string>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("employees").select("hr_id,job_title,crm_id");
  if (error) {
    // Defensive: if this check itself fails, don't block candidate generation
    // on it — proceed with no exclusion rather than throwing.
    return new Set();
  }
  const keys = new Set<string>();
  for (const row of (data ?? []) as Array<{ hr_id: string; job_title: string | null; crm_id: string | null }>) {
    if (row.crm_id != null && String(row.crm_id).trim() !== "") continue;
    if (!isFieldWorkforceComplianceEligibleTitle(row.job_title)) continue;
    const key = canonicalHrIdKey(row.hr_id);
    if (key) keys.add(key);
  }
  return keys;
}

export async function collectNoRecordsActivityCandidates(input: {
  month: number;
  year: number;
}): Promise<DeductionsCandidateDraft[]> {
  const monthKey = `${input.year}-${String(input.month).padStart(2, "0")}`;
  const start = `${monthKey}-01`;
  const end = `${monthKey}-${String(lastDayOfMonth(input.year, input.month)).padStart(2, "0")}`;

  const [days, unresolvedCrmIdentityKeys, baseSalaryByCompact] = await Promise.all([
    getCompanyNoActivityDays({ access: systemAccessContext, start, end }),
    loadCrmIdentityUnresolvedHrIdKeys(),
    getBaseSalaryMap(),
  ]);
  // Fail closed — without salaries every candidate's amount is null, which the
  // old publish path turned into a silent 0.00 EGP line.
  assertBaseSalaryMapLoaded("No Records Activity connector", baseSalaryByCompact);

  return days
    .filter((day) => {
      const key = canonicalHrIdKey(day.employeeHrId);
      return !(key && unresolvedCrmIdentityKeys.has(key));
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
