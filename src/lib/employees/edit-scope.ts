import { canSeeEmployee, type AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * An EDIT of an existing employee record reaches only a person the editor can see in the directory —
 * the same rule the photo route applies before it changes someone's picture. `employees:update` says
 * the editor may change records at all; this says which records.
 *
 * The seats that hold `employees:update` today (Super Admin, HR Operations, HR Administration) see
 * the whole company, so `canSeeEmployee` answers them without a read and nobody who could save a
 * record before is refused. The row is read only for a narrower seat, to learn the person's manager.
 */
export async function assertCanEditEmployeeRecord(access: AccessContext, originalHrId: string) {
  const hrId = originalHrId.trim();
  if (!hrId) return;
  if (canSeeEmployee(access, { hrId, managerHrId: null })) return;

  const { data, error } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id, manager_hr_id")
    .eq("hr_id", hrId.toUpperCase())
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("Forbidden: the employee record could not be checked for access.");
  const row = data as { hr_id: string | null; manager_hr_id: string | null } | null;
  if (!row || !canSeeEmployee(access, { hrId: row.hr_id ?? hrId, managerHrId: row.manager_hr_id })) {
    throw new Error("Forbidden: you do not have access to this employee.");
  }
}
