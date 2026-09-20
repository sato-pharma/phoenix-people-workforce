// Award cheque generator - who the payee picker offers.
//
// Every ACTIVE employee, whatever their department: a bonus can go to anyone, and unlike the Spotlight
// ranking this list is not limited to the sales organogram. It is a convenience only - the payee field
// on the form accepts any typed name, so someone who is not on this list (a former employee, a guest, a
// team) can still be paid to the order of.

import { isActiveLifecycleStatus } from "@/lib/employees/employee-directory";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type ChequePayee = { name: string; position: string };

const PAGE = 1000;

export async function loadChequePayees(): Promise<ChequePayee[]> {
  const supabase = getSupabaseAdmin();
  const payees: ChequePayee[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("employees")
      .select("hr_id, full_name, job_title, employment_status")
      .order("hr_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`employees: ${error.message}`);
    const rows = (data ?? []) as Array<{
      full_name: string | null;
      job_title: string | null;
      employment_status: string | null;
    }>;
    for (const row of rows) {
      const name = row.full_name?.replace(/\s+/g, " ").trim();
      if (!name || !isActiveLifecycleStatus(row.employment_status)) continue;
      payees.push({ name, position: row.job_title?.replace(/\s+/g, " ").trim() ?? "" });
    }
    if (rows.length < PAGE) break;
  }
  return payees.sort((a, b) => a.name.localeCompare(b.name));
}
