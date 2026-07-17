/**
 * CRM identity matching — the single definition of how an iReports360 agent/double-visitor
 * (a numeric `crm_id` + a display name) resolves to a Phoenix employee `hr_id`.
 *
 * Waterfall: manual override (an admin's explicit decision) → `employees.crm_id` →
 * unique, normalized `employees.crm_username` (display-name) match. An ambiguous username
 * (2+ employees) is dropped rather than guessed, and check-ins (which carry no name) only
 * ever use the first two tiers. Deduction-sensitive consumers (Field Workforce Compliance)
 * must never rely on the username tier — they read the already-stored `agent_hr_id`.
 *
 * Extracted verbatim from visits-report/service.ts so the sync engine and every read share
 * one resolver.
 */

import { getEmployeeDirectoryRows, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { CRM_IDENTITY_RESOLUTIONS_TABLE } from "@/lib/crm/tables";
import { isCrmSchemaMissingError } from "@/lib/crm/schema";
import type { CrmIdentityMaps, CrmResolutionAction, CrmResolutionRow } from "@/lib/crm/types";

export type { CrmIdentityMaps, CrmResolutionAction, CrmResolutionRow } from "@/lib/crm/types";

/**
 * Trims + lowercases + collapses internal whitespace runs to a single space. The CRM's own
 * display-name text has been observed with inconsistent spacing for the same person across
 * records (e.g. "Alex East / P" vs "Alex East  / P" — a stray double space), so a plain
 * trim+lowercase alone under-matches; this normalizes both sides of the comparison the same way.
 */
export function normalizeCrmName(name: string | null | undefined): string | null {
  const normalized = name?.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized ? normalized : null;
}

/**
 * The crm_username map only keeps values unique across the active+inactive roster — an
 * ambiguous (2+) match is excluded rather than guessing wrong, same safety rule as the
 * double-visit-analytics precedent.
 */
export function buildCrmIdentityMaps(
  employees: EmployeeDirectoryRow[],
  resolutions: CrmResolutionRow[] = [],
): CrmIdentityMaps {
  const hrIdByCrmId = new Map<string, string>();
  for (const employee of employees) {
    if (employee.crmId) hrIdByCrmId.set(employee.crmId, employee.hrId);
  }

  const usernameGroups = new Map<string, string[]>();
  for (const employee of employees) {
    const key = normalizeCrmName(employee.crmUsername);
    if (!key) continue;
    usernameGroups.set(key, [...(usernameGroups.get(key) ?? []), employee.hrId]);
  }
  const hrIdByCrmUsername = new Map<string, string>();
  for (const [key, hrIds] of usernameGroups) {
    if (hrIds.length === 1) hrIdByCrmUsername.set(key, hrIds[0]);
  }

  const hrIdByManualOverride = new Map<string, string>();
  for (const resolution of resolutions) {
    if (resolution.status === "mapped" && resolution.mappedHrId) {
      hrIdByManualOverride.set(String(resolution.crmId), resolution.mappedHrId);
    }
  }

  return { hrIdByCrmId, hrIdByCrmUsername, hrIdByManualOverride };
}

/**
 * Manual override first (an admin's explicit "map to this HR ID" decision from the Unmapped
 * Agents tab always wins); then crm_id; then falls back to matching the CRM's display name
 * (which IS the crm_username, e.g. "Rasha.Sabry ( P.M / F )" — confirmed from real captured
 * iReports360 data) against a unique crm_username on the roster.
 */
export function resolveEmployeeHrId(
  crmId: number | string | null | undefined,
  name: string | null | undefined,
  maps: CrmIdentityMaps,
): string | null {
  if (crmId != null) {
    const overridden = maps.hrIdByManualOverride.get(String(crmId));
    if (overridden) return overridden;
    const byId = maps.hrIdByCrmId.get(String(crmId));
    if (byId) return byId;
  }
  const key = normalizeCrmName(name);
  if (!key) return null;
  return maps.hrIdByCrmUsername.get(key) ?? null;
}

/** Every stored admin resolution decision — small table (bounded by distinct crm_id count),
 * no pagination needed. Returns [] before the migration ships so callers degrade gracefully. */
export async function getCrmIdentityResolutions(): Promise<CrmResolutionRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(CRM_IDENTITY_RESOLUTIONS_TABLE)
    .select("crm_id, status, mapped_hr_id");
  if (error) {
    if (isCrmSchemaMissingError(error)) return [];
    throw new Error(error.message);
  }
  return ((data ?? []) as Array<{ crm_id: number; mapped_hr_id: string | null; status: string }>).map((row) => ({
    crmId: row.crm_id,
    mappedHrId: row.mapped_hr_id,
    status: row.status as CrmResolutionAction,
  }));
}

/** Convenience: build the identity maps from live roster + stored resolutions in one call. */
export async function loadCrmIdentityMaps(): Promise<CrmIdentityMaps> {
  const [employees, resolutions] = await Promise.all([
    getEmployeeDirectoryRows({ includeInactive: true }),
    getCrmIdentityResolutions(),
  ]);
  return buildCrmIdentityMaps(employees, resolutions);
}
