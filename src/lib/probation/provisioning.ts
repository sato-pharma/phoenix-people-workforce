// Probation provisioning — auto-create the initial probation window when a
// recruitment hire is converted to an employee.
//
// Kept in its own module (NOT the probation service) so the recruitment hire path
// can compose it without touching the tested security-definer hire RPC, and so it
// stays out of files under concurrent edit. Writes the employee_probation row and
// mirrors the window onto employees.probation_end_date.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { probationEndDate } from "@/lib/probation/date";
import { ensureProbationCase } from "@/lib/probation/intelligence/cases";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// App-layer provisioning of the new central Probation Case on the primary hire path.
// This is DEFENSE-IN-DEPTH: the DB AFTER INSERT trigger (20260713131000) already provisions a
// case for every hire path, so on the recruitment/offer path the case usually exists by the time
// this runs (ensureProbationCase then no-ops). The explicit call still matters when the trigger is
// absent in an environment, and it surfaces provisioning failures at the app layer instead of
// silently. It NEVER throws — a Case failure must not block a hire (the caller already treats
// probation provisioning as non-blocking).
async function ensureProbationCaseSafely(employeeHrId: string, startDate: string): Promise<boolean> {
  try {
    const result = await ensureProbationCase({
      employeeHrId,
      hireDate: startDate,
      source: "hire_provisioning",
    });
    if (result.skippedReason) {
      await recordProvisioningFailure(employeeHrId, `case_skipped:${result.skippedReason}`);
    }
    return result.created;
  } catch (error) {
    await recordProvisioningFailure(employeeHrId, String((error as { message?: unknown })?.message ?? error));
    return false;
  }
}

async function recordProvisioningFailure(employeeHrId: string, message: string): Promise<void> {
  try {
    await getSupabaseAdmin()
      .from("probation_provisioning_failures")
      .insert({ employee_hr_id: employeeHrId, source: "hire_provisioning", error_message: message });
  } catch {
    // Monitoring sink is best-effort; never let it break the hire path.
  }
}

/**
 * Count unresolved provisioning failures so the monitoring sink is actually SEEN (surfaced on the
 * probation dashboard). Best-effort: returns 0 if the table is absent/unreadable — a monitoring read
 * must never throw into the caller.
 */
export async function countUnresolvedProvisioningFailures(): Promise<number> {
  try {
    const { count, error } = await getSupabaseAdmin()
      .from("probation_provisioning_failures")
      .select("id", { count: "exact", head: true })
      .is("resolved_at", null);
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}

// Idempotently create the initial probation window for a freshly hired employee.
// Skips if a probation row already exists for the employee (re-hire / re-approval safe).
//
// NOTE: `probationMonths` is retained on the input for backward compatibility with existing
// callers (recruitment offer path), but is intentionally NOT used to derive the end date.
// The owner-locked canonical rule is a FIXED 90-day window (probationEndDate), not a
// configurable month count — see src/lib/probation/date.ts.
export async function createInitialProbationRecord(input: {
  employeeHrId: string;
  startDate?: string | null;
  probationMonths?: number | null;
}): Promise<{ created: boolean; caseCreated: boolean }> {
  const employeeHrId = String(input.employeeHrId ?? "").trim();
  if (!employeeHrId) return { created: false, caseCreated: false };

  const startDate = (input.startDate && input.startDate.trim()) || todayIso();

  const supabase = getSupabaseAdmin();
  const { data: existing, error: existingError } = await supabase
    .from("employee_probation")
    .select("id")
    .eq("employee_hr_id", employeeHrId)
    .limit(1);
  if (existingError) throw existingError;
  if (existing && existing.length > 0) {
    // Legacy window already exists, but still ensure the new central Case is provisioned
    // (covers rows created before the Case model / trigger existed).
    const caseCreated = await ensureProbationCaseSafely(employeeHrId, startDate);
    return { created: false, caseCreated };
  }

  const endDate = probationEndDate(startDate) ?? startDate;

  const { error: insertError } = await supabase.from("employee_probation").insert({
    employee_hr_id: employeeHrId,
    probation_start_date: startDate,
    probation_end_date: endDate,
    status: "active",
  });
  if (insertError) throw insertError;

  // Mirror the window onto the employee row (used by lifecycle-risk + payroll eligibility).
  await supabase.from("employees").update({ probation_end_date: endDate }).eq("hr_id", employeeHrId);

  // Provision the new central Probation Case (defense-in-depth alongside the DB hire trigger).
  const caseCreated = await ensureProbationCaseSafely(employeeHrId, startDate);

  return { created: true, caseCreated };
}
