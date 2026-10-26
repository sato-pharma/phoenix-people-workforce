import { pickDeliverableEmail } from "@/lib/email/email-safety";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type SuperAdminRecipient = {
  email: string | null;
  hrId: string;
};

type SuperAdminAuthRow = { auth_email: string | null; hr_id: string | null };

/**
 * One Super Admin row, as a recipient. The address goes through `pickDeliverableEmail`, the same
 * door `notifications/system.ts` and `notifications/policy.ts` use: a synthetic sign-in identity
 * (`…@phoenix.local`, a bare `.local` host, no dot in the domain) is answered null, so the mail
 * degrades to in-app only instead of being addressed to a mailbox that does not exist (audit
 * point 3, 2026-10-26). A row with no HR id is dropped: nothing in-app can reach it.
 */
export function superAdminRecipientFromRow(row: SuperAdminAuthRow): SuperAdminRecipient | null {
  if (!row.hr_id) return null;
  return { email: pickDeliverableEmail(row.auth_email), hrId: row.hr_id };
}

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
  return ((data ?? []) as SuperAdminAuthRow[])
    .map(superAdminRecipientFromRow)
    .filter((recipient): recipient is SuperAdminRecipient => recipient !== null);
}
