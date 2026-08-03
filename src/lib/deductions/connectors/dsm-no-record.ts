// Unified Deductions module: district-sales-manager CRM no-record days.
//
// WHY THIS IS A SEPARATE CONNECTOR AND NOT A WIDENING OF THE REP PIPELINE.
//
// `field-workforce-compliance/eligibility.ts` deliberately restricts CRM
// no-activity deductions to medical representatives, and carries a red-flag
// warning against putting managers back in scope. That warning was earned: 16
// managers/PMs once carried 131,741.94 EGP — 77% of the whole CRM category —
// and on 35 of those charged days the person had clocked in on the fingerprint
// device. Editing `logsOwnCrmVisitsTitle` would silently re-widen every consumer
// of that predicate and risk repeating exactly that.
//
// The owner's instruction (2026-08-03) narrows rather than reverses it, and the
// production data supports the distinction:
//
//   - A DSM's job IS the daily double visit. When a rep submits a DV the manager
//     is tagged, so a DSM's participation is recorded by design — unlike a
//     Product Manager or National Sales Manager, who appear only if someone
//     happens to tag them. The harm documented in eligibility.ts names a PM and
//     an NSM; it names no DSM.
//   - Measured on July 2026: every working DSM shows BOTH double-visit days
//     (8-20 of them) and their own agent days (8-20). The tagging mechanism is
//     demonstrably reliable for this role, so a gap is signal rather than noise.
//
// So: medical reps stay with the existing engine, DSMs are handled here, and
// every other manager title remains out of scope. Deleting this one file removes
// the DSM rule completely.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { scanVisitsForRange } from "@/lib/crm/reads";
import { getBaseSalaryMap } from "@/lib/payroll/copilot/feeders.ts";
import { getConfirmedNationalHolidays } from "@/lib/vacation/national-holidays";

import { calculateDeductionAmountFromBaseSalary } from "../calculations.ts";
import { compactDeductionsHrId } from "../candidate-key.ts";
import { isFieldForceWorkingDay } from "../holiday-bridge.ts";
import { assertBaseSalaryMapLoaded } from "./health.ts";
import type { DeductionsCandidateDraft } from "../types.ts";

/** District sales managers only — never a broader manager title. */
const DSM_TITLE = /district\s+(sales\s+)?manager/i;

function monthDays(monthKey: string): string[] {
  const [year, month] = monthKey.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  const days: string[] = [];
  for (let day = 1; day <= lastDay; day += 1) {
    days.push(`${monthKey}-${String(day).padStart(2, "0")}`);
  }
  return days;
}

/**
 * National-holiday dates touching the month. Charging a DSM for a public
 * holiday would be indefensible, and the raw data invites it: 12 of 18 managers
 * had "no record" on 2 July and 11 on 23 July, purely because those were
 * holidays and nobody worked.
 */
async function holidayDates(monthKey: string): Promise<Set<string>> {
  const [year, month] = monthKey.split("-").map(Number);
  const dates = new Set<string>();
  const result = await getConfirmedNationalHolidays({ month: month!, year: year! });
  if (!result.calendarReachable) {
    throw new Error(
      "The Egypt national-holiday calendar could not be read. Refusing to charge no-record days rather than risk deducting a public holiday.",
    );
  }
  for (const holiday of result.holidays) {
    const end = holiday.endDate ?? holiday.startDate;
    let cursor = holiday.startDate;
    for (let guard = 0; guard < 40 && cursor <= end; guard += 1) {
      dates.add(cursor);
      const next = new Date(`${cursor}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      cursor = next.toISOString().slice(0, 10);
    }
  }
  return dates;
}

export async function collectDsmNoRecordCandidates(input: {
  month: number;
  year: number;
  createdBy: string;
}): Promise<DeductionsCandidateDraft[]> {
  const monthKey = `${input.year}-${String(input.month).padStart(2, "0")}`;
  const holidays = await holidayDates(monthKey);

  // Friday off, and never a public holiday.
  const workingDays = monthDays(monthKey).filter((day) => isFieldForceWorkingDay(day) && !holidays.has(day));
  if (workingDays.length === 0) return [];

  const supabase = getSupabaseAdmin();
  const [{ data: employees, error }, baseSalaryByCompact] = await Promise.all([
    supabase.from("employees").select("hr_id, full_name, job_title, hire_date").eq("employment_status", "active"),
    getBaseSalaryMap(),
  ]);
  if (error) throw new Error(`Failed to load the DSM roster: ${error.message}`);
  assertBaseSalaryMapLoaded("DSM no-record connector", baseSalaryByCompact);

  const roster = new Map<string, { hrId: string; name: string | null; hireDate: string | null }>();
  for (const row of (employees ?? []) as Array<Record<string, unknown>>) {
    if (!DSM_TITLE.test(String(row.job_title ?? ""))) continue;
    const hrId = String(row.hr_id ?? "").trim();
    const compact = compactDeductionsHrId(hrId);
    if (!compact) continue;
    roster.set(compact, {
      hrId,
      name: (row.full_name as string | null) ?? null,
      hireDate: (row.hire_date as string | null) ?? null,
    });
  }
  if (roster.size === 0) return [];

  // Activity = either side of a visit. A DSM is normally the DOUBLE on a rep's
  // visit; counting only the agent side reads every manager as absent.
  const rows = await scanVisitsForRange<{
    agent_hr_id: string | null;
    double_hr_id: string | null;
    visit_date: string | null;
  }>({
    dateFrom: workingDays[0]!,
    dateTo: workingDays[workingDays.length - 1]!,
    columns: "agent_hr_id, double_hr_id, visit_date",
  });
  const activity = new Set<string>();
  const anySignal = new Set<string>();
  for (const row of rows) {
    const date = String(row.visit_date ?? "").slice(0, 10);
    if (!date) continue;
    for (const raw of [row.agent_hr_id, row.double_hr_id]) {
      const compact = compactDeductionsHrId(String(raw ?? ""));
      if (!compact) continue;
      activity.add(`${compact}:${date}`);
      anySignal.add(compact);
    }
  }

  // Employee-days another category already charges. The owner's rule: never the
  // same day twice. Enforced here rather than at publish, where a collision
  // refuses the whole month instead of preventing the double charge.
  const claimed = new Set<string>();
  const { data: existing, error: existingError } = await supabase
    .from("deductions_candidates")
    .select("employee_hr_id_compact, dates")
    .eq("month_key", monthKey)
    .is("superseded_at", null);
  if (existingError) throw new Error(`Failed to load already-deducted days: ${existingError.message}`);
  for (const row of (existing ?? []) as Array<{ employee_hr_id_compact: string; dates: unknown }>) {
    if (!Array.isArray(row.dates)) continue;
    for (const date of row.dates as unknown[]) {
      if (typeof date === "string") claimed.add(`${String(row.employee_hr_id_compact)}:${date}`);
    }
  }

  const drafts: DeductionsCandidateDraft[] = [];
  for (const [compact, manager] of roster) {
    // Zero CRM signal for the WHOLE month is a mapping or onboarding gap, not a
    // month of absence. Three DSMs hit this in July 2026: two were hired mid- or
    // post-month, and one had reps assigned who never tagged her — a problem to
    // investigate, not to charge.
    if (!anySignal.has(compact)) continue;

    const baseSalary = baseSalaryByCompact.get(compact) ?? null;

    const missing = workingDays.filter((day) => {
      // Never charge a day before the person was hired.
      if (manager.hireDate && day < manager.hireDate) return false;
      if (activity.has(`${compact}:${day}`)) return false;
      if (claimed.has(`${compact}:${day}`)) return false;
      return true;
    });
    if (missing.length === 0) continue;

    const estimatedAmount = calculateDeductionAmountFromBaseSalary({
      baseSalary,
      deductionDays: missing.length,
      month: input.month,
      year: input.year,
    });
    // An unpriceable row blocks the entire month's publish — skip rather than
    // emit a requires_review candidate with no amount.
    if (estimatedAmount == null) continue;

    drafts.push({
      // CRM, on the owner's instruction (2026-08-03) — these belong beside the
      // reps' no-activity days, which is where a reviewer looks for them.
      //
      // 🔴 CRM is MANDATORY-UNLESS-CLEARED: requiresApproval is false, so these
      // publish with NO approval step. A rep's no-activity day works that way by
      // long-standing rule; this connector is new, so its first months publish
      // themselves unless somebody explicitly marks a row "Do Not Take Action".
      // Filing them under `other` would have required an approval per row. The
      // owner chose the CRM tab knowing that.
      category: "crm",
      sourceSystem: "dsm_no_record",
      sourceRecordId: `dsm-no-record:${compact}:${monthKey}`,
      employeeHrId: manager.hrId,
      employeeName: manager.name,
      monthKey,
      month: input.month,
      year: input.year,
      unit: "days",
      rawValue: missing.length,
      estimatedAmount,
      calculationStatus: "calculated",
      severity: "High",
      reason: `No CRM record on ${missing.length} working day(s) — a district manager's double visits are logged when the rep submits`,
      evidence: {
        rule: "District sales managers are recorded on CRM through the rep's double visit; a working day with neither a DV tag nor an own-agent visit is a no-record day.",
        workingDaysConsidered: workingDays.length,
        holidaysExcluded: [...holidays],
        missingDays: missing,
      },
      dates: missing,
    });
  }

  return drafts;
}
