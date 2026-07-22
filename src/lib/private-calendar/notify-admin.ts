import { getSupabaseAdmin } from "@/lib/supabase/server";

export type SuperAdminRecipient = {
  email: string | null;
  hrId: string;
};

/**
 * Active Super Admin HR ids (+ login email, for CC on raw email sends) to
 * notify for a new Private Calendar dispute or no-activity clarification.
 * Mirrors the same inline app_auth_users query pattern used elsewhere
 * (vacation/service.ts, support-requests/service.ts, weekly-planning/service.ts)
 * rather than a shared cross-domain helper.
 */
export async function resolveSuperAdminRecipients(): Promise<SuperAdminRecipient[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("hr_id,auth_email")
    .eq("role", "Super Admin")
    .eq("is_active", true);
  if (error) throw error;
  return ((data ?? []) as Array<{ auth_email: string | null; hr_id: string | null }>)
    .filter((row): row is { auth_email: string | null; hr_id: string } => Boolean(row.hr_id))
    .map((row) => ({ email: row.auth_email, hrId: row.hr_id }));
}
