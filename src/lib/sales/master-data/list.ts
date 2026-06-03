import { getSupabaseAdmin } from "@/lib/supabase/server";

import { MASTER_DEFINITIONS, type MasterKey, type MasterRowRecord } from "./definitions";

export type { MasterRowRecord };

/** Lists every row of a master table (service-role read), ordered by key. */
export async function listMasterRows(master: MasterKey): Promise<MasterRowRecord[]> {
  const definition = MASTER_DEFINITIONS[master];
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(definition.table)
    .select("*")
    .order(definition.keyColumn, { ascending: true });

  if (error) throw error;
  return (data ?? []) as MasterRowRecord[];
}
