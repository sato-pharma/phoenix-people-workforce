import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// People resolution for the Verified Captures gallery — names never codes (owner rule).
//
// Both modules store an HR id where a person belongs, and this screen must show the person: the
// rep who made the capture, and the district manager over them. The one wrinkle is that
// `requested_by_hr_id` on a direct-order validation is written canonically only from 2026-09-05 and
// lower-cased before that (see pharmacy-validation.ts), so every lookup goes through
// `hrIdLookupKeys` to find the row whatever case it is stored in, and every map is keyed on the
// canonical form so a caller reads it back with `canonicalHrIdKey`.
// ─────────────────────────────────────────────────────────────────────────────

export type EmployeeRecord = {
  hrId: string;
  fullName: string | null;
  /** The name the screen prints: the nickname the company uses, else the full name. */
  displayName: string | null;
  /** The person's real job title, e.g. "Medical Rep" / "National Sales Manager". */
  jobTitle: string | null;
  managerHrId: string | null;
};

/** Widen an id set to every case variant, so the query finds the row whatever case it is stored in. */
function queryKeys(hrIds: readonly (string | null | undefined)[]): string[] {
  return [...new Set(hrIds.flatMap((hrId) => hrIdLookupKeys(hrId ?? "")).filter(Boolean))];
}

/**
 * Look up the name, `job_title` and `manager_hr_id` for a set of HR ids, keyed by canonical id.
 *
 * Chunked at 100: a PostgREST `.in()` puts every id in the URL and past a few hundred comes back
 * empty with no error, which here would blank every name on the screen rather than raise. At this
 * screen's volume (tens of captures) one chunk is the norm, but the guard costs nothing.
 */
export async function loadEmployeeRecords(
  hrIds: readonly (string | null | undefined)[],
  supabase = getSupabaseAdmin(),
): Promise<Map<string, EmployeeRecord>> {
  const byKey = new Map<string, EmployeeRecord>();
  const keys = queryKeys(hrIds);
  if (keys.length === 0) return byKey;

  for (let index = 0; index < keys.length; index += 100) {
    const { data, error } = await supabase
      .from("employees")
      .select("hr_id, full_name, nickname, job_title, manager_hr_id")
      .in("hr_id", keys.slice(index, index + 100));
    if (error) throw error;
    for (const row of (data ?? []) as Array<{
      hr_id: string;
      full_name: string | null;
      nickname?: string | null;
      job_title: string | null;
      manager_hr_id: string | null;
    }>) {
      const key = canonicalHrIdKey(row.hr_id);
      if (!key) continue;
      byKey.set(key, {
        hrId: row.hr_id,
        fullName: row.full_name ?? null,
        displayName: row.full_name ? resolveEmployeeDisplayName(row.full_name, row.nickname, row.hr_id) : null,
        jobTitle: row.job_title ?? null,
        managerHrId: row.manager_hr_id ?? null,
      });
    }
  }
  return byKey;
}

/** The person's display name, or null when they are not on file. */
export function employeeName(
  directory: Map<string, EmployeeRecord>,
  hrId: string | null | undefined,
): string | null {
  const key = canonicalHrIdKey(hrId);
  return key ? directory.get(key)?.displayName ?? null : null;
}

/** The person's real job title, or null when they are not on file. Never a code. */
export function employeeTitle(
  directory: Map<string, EmployeeRecord>,
  hrId: string | null | undefined,
): string | null {
  const key = canonicalHrIdKey(hrId);
  return key ? directory.get(key)?.jobTitle ?? null : null;
}

/**
 * Resolve a set of people AND their managers in two round trips: one for the people, a second for
 * the manager ids the first turned up. Returns a directory covering both, so a caller can read a
 * rep's name, their manager's id, and that manager's name from one map.
 */
export async function loadEmployeesWithManagers(
  hrIds: readonly (string | null | undefined)[],
  supabase = getSupabaseAdmin(),
): Promise<Map<string, EmployeeRecord>> {
  const directory = await loadEmployeeRecords(hrIds, supabase);
  const managerIds = [...directory.values()].map((record) => record.managerHrId).filter(Boolean);
  if (managerIds.length === 0) return directory;

  const managers = await loadEmployeeRecords(managerIds, supabase);
  for (const [key, record] of managers) {
    if (!directory.has(key)) directory.set(key, record);
  }
  return directory;
}

/**
 * The manager OVER a person, from a directory loaded with {@link loadEmployeesWithManagers}.
 *
 * Returns the manager's id, name and real job title; all null when the person, their manager, or the
 * manager's record is not on file. Names never codes — an id that resolves to no name yields a null
 * name, never the id. The title is the manager's OWN title (often not "district manager").
 */
export function resolveManager(
  directory: Map<string, EmployeeRecord>,
  hrId: string | null | undefined,
): { hrId: string | null; name: string | null; title: string | null } {
  const key = canonicalHrIdKey(hrId);
  const managerHrId = key ? directory.get(key)?.managerHrId ?? null : null;
  return {
    hrId: managerHrId,
    name: employeeName(directory, managerHrId),
    title: employeeTitle(directory, managerHrId),
  };
}
