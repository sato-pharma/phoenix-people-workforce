import type { PhoenixRole } from "@/lib/auth/permissions";
import { canonicalHrIdForDisplay } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** Every HR_ID currently holding the CEO role on `app_auth_users`. */
export async function ceoHrIds(): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("app_auth_users").select("hr_id").eq("role", "CEO");
  if (error) return [];
  return ((data ?? []) as Array<{ hr_id: string | null }>)
    .map((row) => canonicalHrIdForDisplay(row.hr_id))
    .filter((id): id is string => Boolean(id));
}

/** One active sign-in holding an app role: its own login id, the HR record it belongs to, and the role. */
export type RoleSignIn = { loginId: string; hrId: string; role: PhoenixRole };

/**
 * Every ACTIVE sign-in holding one of these app roles, with its own login id — which is what a person's
 * scope overrides are keyed on (src/lib/auth/scope-visibility.ts) — and the HR record it belongs to.
 *
 * The role is the APP role on `app_auth_users`, the one every permission reads — never the HR job
 * title, which job-function.ts forbids for anything that grants or routes access.
 *
 * A test account is never one: it has no HR id of its own and carries `is_test_persona`
 * (src/lib/auth/test-persona.ts), and either is enough to leave it out. Throws on a read error, so a
 * caller can tell "nobody holds the role" from "the list could not be read".
 */
export async function activeRoleSignIns(roles: readonly PhoenixRole[]): Promise<RoleSignIn[]> {
  if (roles.length === 0) return [];
  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("login_id, hr_id, role, is_test_persona")
    .in("role", [...roles])
    .eq("is_active", true);
  if (error) throw error;
  const wanted = new Set<string>(roles);
  const signIns: RoleSignIn[] = [];
  for (const row of (data ?? []) as Array<{ login_id?: string | null; hr_id?: string | null; role?: string | null; is_test_persona?: boolean | null }>) {
    const loginId = String(row.login_id ?? "").trim();
    const hrId = String(row.hr_id ?? "").trim().toUpperCase();
    const role = String(row.role ?? "").trim();
    if (!loginId || !hrId || hrId.startsWith("TEST-") || row.is_test_persona === true || !wanted.has(role)) continue;
    signIns.push({ loginId, hrId, role: role as PhoenixRole });
  }
  return signIns;
}
