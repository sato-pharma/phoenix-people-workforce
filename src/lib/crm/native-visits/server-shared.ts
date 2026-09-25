/**
 * Native visits and plans — the server helpers the CRM contact-list service and the vacation-day-work
 * service share.
 *
 * Loading the employee directory, a rep's own management chain and paging a Supabase query. No
 * permission check lives here: every caller checks its own permission before it calls one of these.
 */

import type { AccessContext } from "@/lib/auth/permissions";
import type { NativeVisitPartnerOption } from "@/lib/crm/native-visits/types";
import {
  getEmployeeDirectoryRows,
  isActiveDirectoryEmployee,
  type EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { forbiddenError } from "@/lib/http/api-errors";

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

