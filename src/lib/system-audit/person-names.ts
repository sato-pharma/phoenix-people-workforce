/**
 * System Error & Data Integrity Audit — the name a screen prints for a person the ledger recorded.
 *
 * `system_audit_occurrences.employee_name` is a snapshot taken when the occurrence was written, and
 * it stays that way: nothing here writes to the ledger. A reader gets the person's CURRENT display
 * name, looked up by the row's `hr_key`, so one person reads the same here as everywhere else and a
 * nickname set later reaches the rows already on file.
 *
 * A person the employee master does not hold keeps the snapshot, which is the only name left for a
 * leaver whose record is gone. A failed lookup costs the overlay and nothing else: this ledger is
 * where an outage is investigated, so a names read must never take the page down with it.
 */

import {
  namesByHrId,
  type EmployeeNameIndex,
  type EmployeeNameLookupClient,
} from "@/lib/employees/names-by-hr-id";
import type { getSupabaseAdmin } from "@/lib/supabase/server";

type Client = ReturnType<typeof getSupabaseAdmin>;

const NO_NAMES: EmployeeNameIndex = { get: () => null, size: 0 };

export async function currentPersonNames(
  hrKeys: Iterable<string | null | undefined>,
  client: Client,
): Promise<EmployeeNameIndex> {
  try {
    return await namesByHrId(hrKeys, client as unknown as EmployeeNameLookupClient);
  } catch {
    return NO_NAMES;
  }
}

/** The same rows, each printing the person's current display name where the master holds one. */
export async function withCurrentPersonNames<Row extends { hrKey: string | null; employeeName: string | null }>(
  rows: Row[],
  client: Client,
): Promise<Row[]> {
  const names = await currentPersonNames(rows.map((row) => row.hrKey), client);
  if (names.size === 0) return rows;
  return rows.map((row) => {
    const name = names.get(row.hrKey);
    return name ? { ...row, employeeName: name } : row;
  });
}
