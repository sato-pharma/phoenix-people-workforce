/**
 * The employee name an outstation row is WRITTEN with, and the name it is READ back with.
 *
 * Two different questions, deliberately answered in one place:
 *
 *   - `outstationRecordName` decides what a new request row stamps. That is a persisted workflow
 *     record, so it takes the employee RECORD's full name (see getEmployeeIdentity in service.ts).
 *   - `liveOutstationEmployeeName` decides what a reader SHOWS for a row already written. The
 *     stored column is a point-in-time snapshot: renaming an employee record does not travel
 *     backwards into rows written before the rename, so a screen that renders the stored string
 *     shows a name the employee master no longer holds — which is exactly how 432 live claim rows
 *     across 29 people came to display login handles and short forms (repaired by hand 2026-09-21).
 *
 * The persisted column itself stays raw. Nothing here writes: the stored value remains the audit
 * trail of what was true at submit time, and the resolution happens at render.
 *
 * A reader shows the DISPLAY name (owner, 2026-11-03: every screen and email shows a person by their
 * display name, reversing the 2026-09-21 alignment to the record name). A row stamped from a request
 * this module has re-named must therefore take `employeeRecordName`, never `employeeName` — that is
 * what `loadLiveOutstationRecordNames` is for: the payroll ledger's `specialist` keeps the full name.
 *
 * A leaver still resolves: the directory selects every employee row, with no status filter.
 */

import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import {
  employeeRecordName,
  employeeShownName,
  resolveEmployeeRecordName,
  type EmployeeRecordNameSource,
} from "@/lib/employees/record-name";
import { canonicalHrIdKey } from "@/lib/hr-id";

/**
 * The employee name written onto an outstation request row.
 *
 * The employee RECORD's `full_name`, never `displayName` — see the note in getEmployeeIdentity.
 * Falls back to `displayName` and then the HR id only so a record with a blank full name still
 * writes something a human can read; it never writes an empty string.
 *
 * Every path that inserts into `outstation_expense_requests` goes through this, so the three of
 * them cannot drift apart again: the wizard, the medical-rep manual form and the admin manual
 * entry all stamp the same name for the same person.
 *
 * The rule itself now lives in `@/lib/employees/record-name`: it is an employee-master fact, not
 * an outstation one, and the approvals hub renders the same kind of snapshot. This stays as the
 * outstation-facing spelling of it so the write paths read exactly as they did.
 */
export const outstationRecordName = employeeRecordName;

/** HR id key -> one name for that person: what a reader shows, or what a new row would stamp. */
export type LiveOutstationEmployeeNames = ReadonlyMap<string, string>;

const NO_LIVE_NAMES: LiveOutstationEmployeeNames = new Map();

/**
 * One directory read for a whole list.
 *
 * `getEmployeeDirectory` is cached in-process and de-duplicates concurrent loads, so calling this
 * per list costs nothing extra when several readers run together on one request.
 *
 * BEST-EFFORT BY DESIGN: a directory that cannot be read returns an empty map, and every caller
 * then falls back to the stored name. A rename failing to propagate is a cosmetic miss; an
 * approvals queue that will not render because the directory blinked is an outage.
 */
async function loadLiveNames(
  nameOf: (employee: EmployeeRecordNameSource) => string,
): Promise<LiveOutstationEmployeeNames> {
  try {
    const { employees } = await getEmployeeDirectory();
    const names = new Map<string, string>();
    for (const employee of employees) {
      const key = canonicalHrIdKey(employee.hrId);
      if (!key) continue;
      names.set(key, nameOf(employee));
    }
    return names;
  } catch (error) {
    console.log("Outstation live employee names unavailable, showing the stored names", {
      level: "warning",
      tags: { component: "outstation", action: "loadLiveNames" },
      extra: { message: error instanceof Error ? error.message : String(error) },
    });
    return NO_LIVE_NAMES;
  }
}

/** READ SIDE: what a screen or an email prints for each person — the display name. */
export async function loadLiveOutstationEmployeeNames(): Promise<LiveOutstationEmployeeNames> {
  return loadLiveNames(employeeShownName);
}

/**
 * WRITE SIDE: the record's full name for each person, for a request that will stamp the payroll
 * ledger (`employeeRecordName` on OutstationExpenseRequest). Never printed.
 */
export async function loadLiveOutstationRecordNames(): Promise<LiveOutstationEmployeeNames> {
  return loadLiveNames(outstationRecordName);
}

/**
 * The name to SHOW for one already-written row.
 *
 * Falls back to the stored name whenever the row carries no HR id, or its HR id is not in the
 * directory at all — a row imported from the outside source with only a name on it keeps that
 * name rather than blanking.
 */
export function liveOutstationEmployeeName(
  names: LiveOutstationEmployeeNames,
  hrId: string | null | undefined,
  storedName: string,
): string {
  const key = canonicalHrIdKey(hrId);
  // Every fallback — no id, an id the directory does not hold, a record with no usable name of its
  // own — lands on the stored name. resolveEmployeeRecordName is where all three live.
  return resolveEmployeeRecordName(key ? names.get(key) : null, hrId, storedName);
}

/**
 * Re-name a list of already-written rows against an ALREADY-LOADED directory map.
 *
 * Pure and synchronous, so the rule can be tested without reaching the employee master at all.
 * Rows are copied, never mutated in place, and a row whose name does not change is passed through
 * by reference rather than cloned.
 *
 * `read` says where the HR id and the stored name live on a row; `write` returns the row with the
 * resolved name on it.
 */
export function applyLiveOutstationEmployeeNames<T>(
  names: LiveOutstationEmployeeNames,
  rows: readonly T[],
  read: (row: T) => { hrId: string | null | undefined; storedName: string },
  write: (row: T, name: string) => T,
): T[] {
  if (names.size === 0) return [...rows];
  return rows.map((row) => {
    const { hrId, storedName } = read(row);
    const live = liveOutstationEmployeeName(names, hrId, storedName);
    return live === storedName ? row : write(row, live);
  });
}

/** The same thing, loading the directory once for the whole list. */
export async function withLiveOutstationEmployeeNames<T>(
  rows: readonly T[],
  read: (row: T) => { hrId: string | null | undefined; storedName: string },
  write: (row: T, name: string) => T,
): Promise<T[]> {
  if (rows.length === 0) return [...rows];
  return applyLiveOutstationEmployeeNames(await loadLiveOutstationEmployeeNames(), rows, read, write);
}
