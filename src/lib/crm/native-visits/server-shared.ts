/**
 * Native visits and plans — the server helpers both services share (the pilot).
 *
 * Loading the pilot row, the employee directory, the rep's own management chain and the rep's own
 * doctor lists. No permission check lives here: every exported service function checks
 * crm_visit_entry itself before it calls one of these.
 */

import type { AccessContext } from "@/lib/auth/permissions";
import { getCrmCutoverSetting } from "@/lib/crm/cutover";
import {
  nativeVisitPilotForRep,
  type NativeEntryGate,
  type NativePilotRosterEntry,
  type NativeVisitShift,
} from "@/lib/crm/native-visits/rules";
import { CRM_NATIVE_PILOT_REPS_TABLE } from "@/lib/crm/native-visits/tables";
import type { NativeVisitContactOption, NativeVisitPartnerOption } from "@/lib/crm/native-visits/types";
import { CRM_CONTACT_ASSIGNMENTS_TABLE, CRM_CONTACT_MASTER_TABLE } from "@/lib/crm/tables";
import {
  getEmployeeDirectoryRows,
  isActiveDirectoryEmployee,
  type EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";
import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { forbiddenError } from "@/lib/http/api-errors";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** The management chain offered as partners: direct manager and up to three rungs above. */
const PARTNER_CHAIN_DEPTH = 4;
const IN_CHUNK = 300;
/** PostgREST returns at most 1,000 rows a request; a longer read pages. */
export const PAGE_SIZE = 1000;

type SupabaseError = { code?: string | null; message?: string | null } | null;

export function isMissingTable(error: SupabaseError): boolean {
  const code = String(error?.code ?? "");
  return code === "PGRST205" || code === "42P01";
}

export function isUniqueViolation(error: SupabaseError): boolean {
  return String(error?.code ?? "") === "23505";
}

export function chunk<T>(values: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

/**
 * The Phoenix CRM pilot roster: the reps the Super Admin placed on it and has not removed. The line
 * pilot rows (crm_native_visit_pilots) are no longer read — the owner picks reps, not lines.
 */
export async function loadPilotRoster(): Promise<NativePilotRosterEntry[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(CRM_NATIVE_PILOT_REPS_TABLE)
    .select("hr_id,starts_on")
    .is("removed_at", null);
  // Before the migration is applied there is simply no pilot — never an error page.
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    hrId: String(row.hr_id ?? ""),
    startsOn: String(row.starts_on ?? ""),
  }));
}

/**
 * What opens a day for this rep: their own place on the pilot roster and the CRM cutover date. THROWS
 * when the cutover setting cannot be read, so a save never guesses which days are open.
 */
export async function loadEntryGate(
  rep: { hrId: string | null | undefined; lineName: string | null | undefined },
  roster: readonly NativePilotRosterEntry[],
): Promise<NativeEntryGate> {
  const setting = await getCrmCutoverSetting();
  return { pilot: nativeVisitPilotForRep(rep, roster), cutoverDate: setting.cutoverDate };
}

export type Directory = { rows: EmployeeDirectoryRow[]; byKey: Map<string, EmployeeDirectoryRow> };

export async function loadDirectory(): Promise<Directory> {
  const rows = await getEmployeeDirectoryRows({ includeInactive: true });
  const byKey = new Map<string, EmployeeDirectoryRow>();
  for (const row of rows) {
    const key = canonicalHrIdKey(row.hrId);
    if (key) byKey.set(key, row);
  }
  return { rows, byKey };
}

export function employeeName(row: EmployeeDirectoryRow | null | undefined): string {
  return row?.displayName || row?.fullName || "Unknown employee";
}

export function requireActiveSelf(access: AccessContext, directory: Directory): EmployeeDirectoryRow {
  const key = canonicalHrIdKey(access.hrId);
  const row = key ? directory.byKey.get(key) : undefined;
  if (!row || !isActiveDirectoryEmployee(row)) {
    throw forbiddenError("Forbidden: visit entry needs an active employee record.");
  }
  return row;
}

/** The rep's management chain, nearest first, active people only. */
export function managementChain(rep: EmployeeDirectoryRow, directory: Directory): NativeVisitPartnerOption[] {
  const out: NativeVisitPartnerOption[] = [];
  const seen = new Set<string>([canonicalHrIdKey(rep.hrId) ?? ""]);
  let current: EmployeeDirectoryRow | undefined = rep;
  for (let depth = 0; depth < PARTNER_CHAIN_DEPTH && current; depth += 1) {
    const managerKey = canonicalHrIdKey(current.managerHrId);
    if (!managerKey || seen.has(managerKey)) break;
    seen.add(managerKey);
    const manager = directory.byKey.get(managerKey);
    if (!manager) break;
    if (isActiveDirectoryEmployee(manager)) {
      out.push({
        hrId: manager.hrId,
        name: employeeName(manager),
        jobTitle: manager.jobTitle,
        isDirectManager: depth === 0,
      });
    }
    current = manager;
  }
  return out;
}

export async function loadRepContacts(rep: EmployeeDirectoryRow): Promise<NativeVisitContactOption[]> {
  return loadListContacts(hrIdLookupKeys(rep.hrId));
}

/** The active people whose direct manager is this manager: a district manager's reps. */
export function directReports(manager: EmployeeDirectoryRow, directory: Directory): EmployeeDirectoryRow[] {
  const managerKey = canonicalHrIdKey(manager.hrId);
  if (!managerKey) return [];
  return directory.rows.filter(
    (row) =>
      canonicalHrIdKey(row.managerHrId) === managerKey &&
      canonicalHrIdKey(row.hrId) !== managerKey &&
      isActiveDirectoryEmployee(row),
  );
}

/**
 * The doctors a district manager may visit alone: the union of his reps' open AM and PM lists. A
 * doctor on two reps' lists appears once, carrying every list that holds him.
 */
export async function loadTeamContacts(manager: EmployeeDirectoryRow, directory: Directory): Promise<NativeVisitContactOption[]> {
  const keys = directReports(manager, directory).flatMap((rep) => hrIdLookupKeys(rep.hrId));
  if (keys.length === 0) return [];
  return loadListContacts(Array.from(new Set(keys)));
}

/**
 * Each rep's open AM and PM list, by rep: contact, the lists holding it and its grade. No names — the
 * Phoenix CRM KPIs count doctors, they never show one. A pharmacy is not a contact; 100000 is no doctor.
 */
export async function loadListAssignmentsByRep(
  reps: readonly EmployeeDirectoryRow[],
): Promise<Map<string, Array<{ contactCrmId: number; lists: NativeVisitShift[]; grade: string | null }>>> {
  const repByLookupKey = new Map<string, string>();
  for (const rep of reps) {
    const repKey = canonicalHrIdKey(rep.hrId);
    if (!repKey) continue;
    for (const key of hrIdLookupKeys(rep.hrId)) repByLookupKey.set(key, repKey);
  }
  const byRep = new Map<string, Map<number, { lists: Set<NativeVisitShift>; grade: string | null }>>();
  const supabase = getSupabaseAdmin();
  for (const keys of chunk(Array.from(repByLookupKey.keys()))) {
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await supabase
        .from(CRM_CONTACT_ASSIGNMENTS_TABLE)
        .select("agent_hr_id,contact_crm_id,list_type,grade")
        .is("effective_to", null)
        .in("agent_hr_id", keys)
        .in("list_type", ["AM", "PM"])
        .order("id", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) {
        if (isMissingTable(error)) return new Map();
        throw error;
      }
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const repKey = repByLookupKey.get(String(row.agent_hr_id ?? "")) ?? canonicalHrIdKey(String(row.agent_hr_id ?? ""));
        const contactCrmId = Number(row.contact_crm_id);
        const list = row.list_type === "AM" ? "AM" : row.list_type === "PM" ? "PM" : null;
        if (!repKey || !list || !Number.isInteger(contactCrmId) || contactCrmId <= 0 || contactCrmId === 100000) continue;
        const contacts = byRep.get(repKey) ?? new Map<number, { lists: Set<NativeVisitShift>; grade: string | null }>();
        const entry = contacts.get(contactCrmId) ?? { lists: new Set<NativeVisitShift>(), grade: null };
        entry.lists.add(list);
        if (!entry.grade && row.grade) entry.grade = String(row.grade);
        contacts.set(contactCrmId, entry);
        byRep.set(repKey, contacts);
      }
      if (rows.length < PAGE_SIZE) break;
    }
  }
  return new Map(
    Array.from(byRep.entries()).map(([repKey, contacts]) => [
      repKey,
      Array.from(contacts.entries()).map(([contactCrmId, entry]) => ({
        contactCrmId,
        lists: (["AM", "PM"] as const).filter((list) => entry.lists.has(list)),
        grade: entry.grade,
      })),
    ]),
  );
}

async function loadListContacts(agentHrIds: string[]): Promise<NativeVisitContactOption[]> {
  const supabase = getSupabaseAdmin();
  const rows: Array<Record<string, unknown>> = [];
  for (const keys of chunk(agentHrIds)) {
    const { data, error } = await supabase
      .from(CRM_CONTACT_ASSIGNMENTS_TABLE)
      .select("contact_crm_id,list_type,grade")
      .is("effective_to", null)
      .in("agent_hr_id", keys)
      // A pharmacy is not a contact: PM and AM lists only.
      .in("list_type", ["AM", "PM"]);
    if (error) {
      if (isMissingTable(error)) return [];
      throw error;
    }
    rows.push(...((data ?? []) as Array<Record<string, unknown>>));
  }

  const byContact = new Map<number, { lists: Set<NativeVisitShift>; grade: string | null }>();
  for (const row of rows) {
    const contactCrmId = Number(row.contact_crm_id);
    if (!Number.isInteger(contactCrmId) || contactCrmId <= 0 || contactCrmId === 100000) continue;
    const list = row.list_type === "AM" ? "AM" : row.list_type === "PM" ? "PM" : null;
    if (!list) continue;
    const entry = byContact.get(contactCrmId) ?? { lists: new Set<NativeVisitShift>(), grade: null };
    entry.lists.add(list);
    if (!entry.grade && row.grade) entry.grade = String(row.grade);
    byContact.set(contactCrmId, entry);
  }
  if (byContact.size === 0) return [];

  const details = new Map<number, { name: string; speciality: string | null }>();
  for (const ids of chunk(Array.from(byContact.keys()))) {
    const { data: contacts, error: contactError } = await supabase
      .from(CRM_CONTACT_MASTER_TABLE)
      .select("contact_crm_id,name,speciality")
      .in("contact_crm_id", ids);
    if (contactError) throw contactError;
    for (const row of (contacts ?? []) as Array<Record<string, unknown>>) {
      details.set(Number(row.contact_crm_id), {
        name: String(row.name ?? "").trim(),
        speciality: row.speciality ? String(row.speciality) : null,
      });
    }
  }

  return Array.from(byContact.entries())
    .map(([contactCrmId, entry]) => ({
      contactCrmId,
      name: details.get(contactCrmId)?.name || "Unnamed doctor",
      speciality: details.get(contactCrmId)?.speciality ?? null,
      grade: entry.grade,
      lists: (["AM", "PM"] as const).filter((list) => entry.lists.has(list)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
