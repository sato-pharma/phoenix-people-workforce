/**
 * Phoenix CRM — who among these people has left by a day, read from the employee record. The rule itself is
 * `hasLeftBy` (departure-rules.ts); this is the one read behind it.
 *
 * Keys are `personKey` (upper case, trimmed). A failed read throws: each caller decides what an unread answer
 * means for it (a notice is still sent, a visit save fails and is retried).
 */

import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import { hasLeftBy } from "@/lib/phoenix-crm/departure-rules";
import { personKey } from "@/lib/phoenix-crm/scope";
import { chunk } from "@/lib/phoenix-crm/server/db";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export async function departedBy(hrIds: ReadonlyArray<string | null | undefined>, day: string): Promise<Set<string>> {
  const keys = [...new Set(hrIds.map((hrId) => personKey(hrId ?? null)).filter((key): key is string => Boolean(key)))];
  const departed = new Set<string>();
  // A test account is nobody's employee record: it never leaves.
  const real = keys.filter((key) => !key.startsWith("TEST-"));
  for (const part of chunk(real, 200)) {
    const { data, error } = await getSupabaseAdmin().from("employees").select("hr_id, employment_status, last_working_date").in("hr_id", part);
    if (error) throw new Error(`Could not read whether these people still work here: ${error.message}`);
    for (const row of (data ?? []) as Array<{ hr_id: string | null; employment_status: string | null; last_working_date: string | null }>) {
      const key = personKey(row.hr_id);
      if (key && hasLeftBy({ statusEnded: isTerminalEmploymentStatus(row.employment_status), lastWorkingDate: row.last_working_date }, day)) departed.add(key);
    }
  }
  return departed;
}
