import { normalizeHrId } from "@/lib/auth/permissions";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { getSupabaseAdmin } from "@/lib/supabase/server";

function cleanActorToken(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Resolve a workflow actor token to its canonical employee HR_ID before it is written to any
 * approver/decision column.
 *
 * The Approvals Hub history and every audit surface match on HR_ID, so a raw login token
 * (e.g. the shared "admin-HR" system login) must NEVER be persisted into a decision column —
 * doing so either hides the decision from the real approver's history or, worse, mis-attributes
 * it to a different identity.
 *
 * Resolution order (best-effort, never throws):
 *   1. Already a known employee HR_ID  → return the canonical-cased HR_ID from the directory.
 *   2. A login token mapped in app_auth_users (login_id → hr_id), e.g. "admin-HR" → "PHX-1".
 *   3. Fallback: the normalized form of the token (or the raw token if normalization is empty).
 *
 * This is the single source of truth used by every workflow write-path (resignations, probation,
 * contract renewals, …). Keep new decision write-paths funnelling through here.
 */
export async function resolveCanonicalActorHrId(actor: string): Promise<string> {
  const raw = cleanActorToken(actor);
  if (!raw) return raw;
  try {
    const { employees } = await getEmployeeDirectory();
    const match = employees.find((employee) => normalizeHrId(employee.hrId) === normalizeHrId(raw));
    if (match?.hrId) return match.hrId;

    const { data } = await getSupabaseAdmin()
      .from("app_auth_users")
      .select("hr_id")
      .ilike("login_id", raw)
      .maybeSingle();
    const mapped = cleanActorToken((data as { hr_id?: string | null } | null)?.hr_id);
    if (mapped) return mapped;
  } catch {
    // best-effort — fall through to the normalized token below
  }
  return normalizeHrId(raw) ?? raw;
}
