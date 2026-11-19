/**
 * Reads one employee's change history for the Employee Master's details panel. Server only: both
 * views are service-role only (`.claude/rules/employees.md`), so the route that calls this decides
 * who may ask, and `includeMoney` decides whether pay is read at all.
 */

import { isSalaryRedactedForViewer, type AccessContext } from "@/lib/auth/permissions";
import {
  buildChangeHistoryEntries,
  referenceIdsOf,
  type ChangeHistoryPayload,
  type RecordChangeRow,
  type ReferenceNames,
  type SalaryChangeRow,
} from "@/lib/employees/change-history";
import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { hrIdLookupKeys } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Pay follows the Employee Master's own rule for this person (`isSalaryRedactedForViewer`, the
 * function the directory redacts with). The retired HR Advisory seat also had a job-title rule
 * this does not repeat, so it gets no pay at all — closed, never wider.
 */
export function changeHistoryIncludesMoney(access: Pick<AccessContext, "role">, hrId: string): boolean {
  if (access.role === "HR Advisory") return false;
  return !isSalaryRedactedForViewer(access, hrId);
}

/** The newest changes per log. A record edited more often than this shows its newest and says so. */
export const CHANGE_HISTORY_LIMIT = 200;

const RECORD_COLUMNS =
  "id, changed_at, change_kind, actor_login_id, actor_hr_id, actor_name, actor_source, changed_fields, masked_fields, old_values, new_values, write_channel";

const SALARY_COLUMNS =
  "id, changed_at, actor_login_id, actor_hr_id, actor_name, actor_source, changed_fields, old_values, new_values, write_channel";

type Client = ReturnType<typeof getSupabaseAdmin>;

/** id → name for one reference table. A failed read names nothing; the panel says "Name not available". */
async function namesById(client: Client, table: string, column: string, ids: Set<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.size === 0) return out;
  const { data, error } = await client.from(table).select(`id, ${column}`).in("id", [...ids]);
  if (error || !Array.isArray(data)) return out;
  for (const row of data as Array<Record<string, unknown>>) {
    const id = row.id;
    const name = row[column];
    if (id !== null && id !== undefined && typeof name === "string" && name.trim()) out.set(String(id), name.trim());
  }
  return out;
}

/** login id → HR id, from app_auth_users. A failed read names nobody; the view's full name stands in. */
async function hrIdsByLogin(client: Client, logins: Set<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (logins.size === 0) return out;
  const { data, error } = await client.from("app_auth_users").select("login_id, hr_id").in("login_id", [...logins]);
  if (error || !Array.isArray(data)) return out;
  for (const row of data as Array<{ login_id?: string | null; hr_id?: string | null }>) {
    if (row.login_id && row.hr_id?.trim()) out.set(row.login_id, row.hr_id.trim());
  }
  return out;
}

export async function loadEmployeeChangeHistory(
  hrId: string,
  options: { includeMoney: boolean },
): Promise<ChangeHistoryPayload> {
  const client = getSupabaseAdmin();
  const keys = hrIdLookupKeys(hrId);
  if (keys.length === 0) return { entries: [], moneyIncluded: options.includeMoney, truncated: false };

  const recordRead = client
    .from("v_employee_change_log")
    .select(RECORD_COLUMNS)
    .in("employee_hr_id", keys)
    .order("changed_at", { ascending: false })
    .limit(CHANGE_HISTORY_LIMIT + 1);
  // Pay is never read for a viewer who may not see it — not read and then filtered.
  const salaryRead = options.includeMoney
    ? client
        .from("v_employee_salary_change_log")
        .select(SALARY_COLUMNS)
        .in("employee_hr_id", keys)
        .order("changed_at", { ascending: false })
        .limit(CHANGE_HISTORY_LIMIT + 1)
    : null;

  const [record, salary] = await Promise.all([recordRead, salaryRead]);
  if (record.error) throw new Error(`The employee change log could not be read: ${record.error.message}`);
  if (salary?.error) throw new Error(`The salary change log could not be read: ${salary.error.message}`);

  const recordRows = (record.data ?? []) as RecordChangeRow[];
  const salaryRows = (salary?.data ?? []) as SalaryChangeRow[];
  const truncated = recordRows.length > CHANGE_HISTORY_LIMIT || salaryRows.length > CHANGE_HISTORY_LIMIT;
  const keptRecord = recordRows.slice(0, CHANGE_HISTORY_LIMIT);
  const keptSalary = salaryRows.slice(0, CHANGE_HISTORY_LIMIT);

  const ids = referenceIdsOf(keptRecord, keptSalary);
  // A login-only actor is named the way the record view names one: through app_auth_users.
  const loginHrIds = await hrIdsByLogin(client, ids.logins);
  for (const hrId of loginHrIds.values()) ids.people.add(hrId);
  const [people, departments, lines, areas, positions, teams] = await Promise.all([
    namesByHrId(ids.people),
    namesById(client, "departments", "name", ids.department),
    namesById(client, "lines", "name", ids.line),
    namesById(client, "areas", "name", ids.area),
    namesById(client, "positions", "title", ids.position),
    namesById(client, "teams", "name", ids.team),
  ]);
  const names: ReferenceNames = {
    person: (value) => people.get(value),
    loginHrId: (value) => loginHrIds.get(value) ?? null,
    department: (value) => departments.get(value) ?? null,
    line: (value) => lines.get(value) ?? null,
    area: (value) => areas.get(value) ?? null,
    position: (value) => positions.get(value) ?? null,
    team: (value) => teams.get(value) ?? null,
  };

  return {
    entries: buildChangeHistoryEntries({
      recordRows: keptRecord,
      salaryRows: keptSalary,
      includeMoney: options.includeMoney,
      names,
    }),
    moneyIncluded: options.includeMoney,
    truncated,
  };
}
