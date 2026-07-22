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
