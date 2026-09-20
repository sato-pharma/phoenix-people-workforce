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
 * It resolves to the RECORD name, not to `displayName`, because displayName is nickname-first by
 * design — resolving to it would put the nicknames straight back on the screens the 2026-09-21
 * repair aligned to the record names.
 *
 * A leaver still resolves: the directory selects every employee row, with no status filter.
 */

import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";

function text(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

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
 */
export function outstationRecordName(employee: {
  displayName?: string | null;
  fullName?: string | null;
  hrId: string;
}) {
  return text(employee.fullName) || text(employee.displayName) || employee.hrId;
}

/** HR id key -> the employee record's name, resolved exactly as a new row would stamp it. */
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
export async function loadLiveOutstationEmployeeNames(): Promise<LiveOutstationEmployeeNames> {
  try {
    const { employees } = await getEmployeeDirectory();
    const names = new Map<string, string>();
    for (const employee of employees) {
      const key = canonicalHrIdKey(employee.hrId);
      if (!key) continue;
      names.set(key, outstationRecordName(employee));
    }
    return names;
  } catch (error) {
    console.log("Outstation live employee names unavailable, showing the stored names", {
      level: "warning",
      tags: { component: "outstation", action: "loadLiveOutstationEmployeeNames" },
      extra: { message: error instanceof Error ? error.message : String(error) },
    });
    return NO_LIVE_NAMES;
  }
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
  if (!key) return storedName;
  const live = names.get(key);
  if (!live) return storedName;
  // The HR id resolved but the record has no usable name of its own, so outstationRecordName fell
  // back to the id itself. The stored name is the better thing to show.
  if (canonicalHrIdKey(live) === key) return storedName || live;
  return live;
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
