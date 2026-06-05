// Probation provisioning — auto-create the initial probation window when a
// recruitment hire is converted to an employee.
//
// Kept in its own module (NOT the probation service) so the recruitment hire path
// can compose it without touching the tested security-definer hire RPC, and so it
// stays out of files under concurrent edit. Writes the employee_probation row and
// mirrors the window onto employees.probation_end_date.

import { getSupabaseAdmin } from "@/lib/supabase/server";

const DEFAULT_PROBATION_MONTHS = 3;

// Pure: add `months` whole months to a YYYY-MM-DD date, clamping the day to the
// end of the target month (e.g. 2026-01-31 + 1 month -> 2026-02-28).
export function addMonths(dateStr: string, months: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr).trim());
  if (!match) return dateStr;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1; // 0-11
  const day = Number(match[3]);
  const shifted = monthIndex + months;
  const targetYear = year + Math.floor(shifted / 12);
  const targetMonth = ((shifted % 12) + 12) % 12; // 0-11
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDay);
  return `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Idempotently create the initial probation window for a freshly hired employee.
// Skips if a probation row already exists for the employee (re-hire / re-approval safe).
export async function createInitialProbationRecord(input: {
  employeeHrId: string;
  startDate?: string | null;
  probationMonths?: number | null;
}): Promise<{ created: boolean }> {
  const employeeHrId = String(input.employeeHrId ?? "").trim();
  if (!employeeHrId) return { created: false };

  const supabase = getSupabaseAdmin();
  const { data: existing, error: existingError } = await supabase
    .from("employee_probation")
    .select("id")
    .eq("employee_hr_id", employeeHrId)
    .limit(1);
  if (existingError) throw existingError;
  if (existing && existing.length > 0) return { created: false };

  const startDate = (input.startDate && input.startDate.trim()) || todayIso();
  const months =
    typeof input.probationMonths === "number" && Number.isFinite(input.probationMonths) && input.probationMonths > 0
      ? input.probationMonths
      : DEFAULT_PROBATION_MONTHS;
  const endDate = addMonths(startDate, months);

  const { error: insertError } = await supabase.from("employee_probation").insert({
    employee_hr_id: employeeHrId,
    probation_start_date: startDate,
    probation_end_date: endDate,
    status: "active",
  });
  if (insertError) throw insertError;

  // Mirror the window onto the employee row (used by lifecycle-risk + payroll eligibility).
  await supabase.from("employees").update({ probation_end_date: endDate }).eq("hr_id", employeeHrId);

  return { created: true };
}
