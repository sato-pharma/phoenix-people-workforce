/**
 * Native visits and plans — the server helpers both services share (the pilot).
 *
 * Loading the pilot row, the employee directory, the rep's own management chain and the rep's own
 * doctor lists. No permission check lives here: every exported service function checks
 * crm_visit_entry itself before it calls one of these.
 */

import type { AccessContext } from "@/lib/auth/permissions";
import type { NativeVisitPilot, NativeVisitShift } from "@/lib/crm/native-visits/rules";
import { CRM_NATIVE_VISIT_PILOTS_TABLE } from "@/lib/crm/native-visits/tables";
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

export async function loadPilots(): Promise<NativeVisitPilot[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(CRM_NATIVE_VISIT_PILOTS_TABLE)
    .select("line_name,starts_on,ends_on,is_active");
  // Before the migration is applied there is simply no pilot — never an error page.
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    lineName: String(row.line_name ?? ""),
    startsOn: String(row.starts_on ?? ""),
    endsOn: String(row.ends_on ?? ""),
    isActive: row.is_active === true,
  }));
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
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(CRM_CONTACT_ASSIGNMENTS_TABLE)
    .select("contact_crm_id,list_type,grade")
    .is("effective_to", null)
    .in("agent_hr_id", hrIdLookupKeys(rep.hrId))
    // A pharmacy is not a contact: PM and AM lists only.
    .in("list_type", ["AM", "PM"]);
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }

  const byContact = new Map<number, { lists: Set<NativeVisitShift>; grade: string | null }>();
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
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
