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

  const lastWorkingDateByHrId = new Map<string, string>();
  for (const employee of employees) {
    const lastWorkingDate = employee.lastWorkingDate?.slice(0, 10);
    if (lastWorkingDate) lastWorkingDateByHrId.set(employee.hrId, lastWorkingDate);
  }

  return { hrIdByCrmId, hrIdByCrmUsername, hrIdByManualOverride, lastWorkingDateByHrId };
}

/**
 * POST-EXIT ATTRIBUTION GUARD. Work dated after someone's last working day cannot be theirs.
 *
 * This is the recurrence prevention for a whole bug class. Whoever administers iReports360 reuses a
 * departing employee's CRM account for their replacement rather than creating a new one, but the
 * Phoenix roster keeps `employees.crm_id` pointing at the person who left. Tier 2 of the waterfall
 * therefore keeps stamping the REPLACEMENT's work with the LEAVER's hr id — and because the
 * departed-agent exclusion then hides anything belonging to a leaver, the new rep's work goes
 * invisible platform-wide. Nobody notices until an audit, or until the missing activity manufactures
 * a wrongful payroll deduction.
 *
 * Returning null is the honest answer and a strictly better failure: an unattributed visit surfaces
 * in the Unmapped Agents tab as an explicit decision to make, instead of being silently filed under
 * someone who had already left. Verified against production 2026-08-01: 203 visits across 5
 * employees are attributed past an exit date, and the two largest (163 + 27) are precisely the known
 * misattributions this guard exists to stop.
 *
 * Compares ISO `YYYY-MM-DD` strings directly — both sides are plain dates, so lexicographic order is
 * exact, and it deliberately avoids Date parsing (which would drag the vendor timezone convention
 * into a comparison that has nothing to do with clocks).
 */
export function isAttributableOn(
  hrId: string,
  visitDate: string | null | undefined,
  maps: CrmIdentityMaps,
): boolean {
  // No date to judge against (check-ins before this was threaded through, ad-hoc callers): fall back
  // to the previous behaviour rather than blocking on a value we don't have.
  if (!visitDate) return true;
  const lastWorkingDate = maps.lastWorkingDateByHrId.get(hrId);
  if (!lastWorkingDate) return true;
  return visitDate.slice(0, 10) <= lastWorkingDate;
}

/** The outcome of one attribution attempt. `blockedHrId` is set when a tier DID match but the
 * post-exit guard rejected it — the caller can count and report those instead of seeing a bare null
 * that looks identical to "this agent is simply unknown". */
export type CrmAttribution = { blockedHrId: string | null; hrId: string | null };

/**
 * Manual override first (an admin's explicit "map to this HR ID" decision from the Unmapped
 * Agents tab always wins); then crm_id; then falls back to matching the CRM's display name
 * (which IS the crm_username, e.g. "Rasha.Sabry ( P.M / F )" — confirmed from real captured
 * iReports360 data) against a unique crm_username on the roster.
 *
 * `visitDate` (the record's own date, YYYY-MM-DD) enables the post-exit guard on the two AUTOMATIC
 * tiers. The manual override is deliberately EXEMPT: it is an admin's explicit, hand-verified
 * decision about who owns a CRM slot, and it is the intended way to record "this slot belongs to
 * someone the roster doesn't link" — including for historical rows. Guarding it would let a stale
 * roster date silently veto a human decision, which inverts the waterfall's whole authority order.
 */
export function resolveEmployeeAttribution(
  crmId: number | string | null | undefined,
  name: string | null | undefined,
  maps: CrmIdentityMaps,
  visitDate?: string | null,
): CrmAttribution {
  if (crmId != null) {
    // Tier 1 — explicit admin decision. Not guarded (see the doc comment above).
    const overridden = maps.hrIdByManualOverride.get(String(crmId));
    if (overridden) return { blockedHrId: null, hrId: overridden };
    // Tier 2 — employees.crm_id. This is the tier that misattributes a reused CRM slot.
    const byId = maps.hrIdByCrmId.get(String(crmId));
    if (byId) {
      if (!isAttributableOn(byId, visitDate, maps)) return { blockedHrId: byId, hrId: null };
      return { blockedHrId: null, hrId: byId };
    }
  }
  const key = normalizeCrmName(name);
  if (!key) return { blockedHrId: null, hrId: null };
  // Tier 3 — unique crm_username. Guarded too: a stale display name outlives the person just as a
  // stale crm_id does.
  const byName = maps.hrIdByCrmUsername.get(key);
  if (!byName) return { blockedHrId: null, hrId: null };
  if (!isAttributableOn(byName, visitDate, maps)) return { blockedHrId: byName, hrId: null };
  return { blockedHrId: null, hrId: byName };
}

/** The waterfall's hr-id answer alone — the shape every existing caller expects. */
export function resolveEmployeeHrId(
  crmId: number | string | null | undefined,
  name: string | null | undefined,
  maps: CrmIdentityMaps,
  visitDate?: string | null,
): string | null {
  return resolveEmployeeAttribution(crmId, name, maps, visitDate).hrId;
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
