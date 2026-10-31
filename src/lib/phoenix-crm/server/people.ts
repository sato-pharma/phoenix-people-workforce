/**
 * Phoenix CRM — people's names for the screens (names, never HR codes).
 *
 * A light read of `employees` (hr id, full name, nickname) rather than the employee directory, which
 * carries salary columns this module never needs. Names follow the company's display rule
 * (resolveEmployeeDisplayName: the nickname when there is one).
 */

import { getOrLoadShared, sharedReadKey } from "@/lib/cache/shared-read";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { hrIdLookupKeys } from "@/lib/hr-id";
import { chunk, throwIfError } from "@/lib/phoenix-crm/server/db";
import { personKey } from "@/lib/phoenix-crm/scope";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type PeopleNames = ReadonlyMap<string, string>;

/** The shared copy `loadPeopleNames` serves: the name rows of the exact set of people asked about. */
const PEOPLE_NAMES_SHARED = "phoenix-crm-people-names";
const PEOPLE_NAMES_SHARED_LIMITS = { maxEntries: 500, maxRowsTotal: 50_000 };

type NameRow = Record<string, unknown>;

/** Display names keyed by upper-case HR id. A person with no employee row is left out. */
export async function loadPeopleNames(hrIds: Iterable<string | null | undefined>): Promise<PeopleNames> {
  const wanted = new Set<string>();
  for (const hrId of hrIds) {
    const key = personKey(hrId);
    if (key) wanted.add(key);
  }
  const names = new Map<string, string>();
  if (wanted.size === 0) return names;

  // NAMES, SHARED FOR A MINUTE (31 Oct 2026). Every Phoenix CRM screen names the rep and the manager
  // above him, and each loader on it asked for the same two names again: on Wednesday 28 Oct this read
  // was 2,239 requests in the two busiest hours, 1,582 of them the very same request made within the
  // minute before. Keyed by the exact set of people, so a caller only ever receives the names it asked
  // about; a copy is at most `SHARED_READ_TTL_MS` old, the window the owner chose for shared reads. A
  // name is display only — nothing approves, pays or picks a recipient from it (the notices that carry
  // one decide who is told elsewhere). A failed read is never stored, and throws exactly as before.
  const people = [...wanted].sort();
  const { rows } = await getOrLoadShared(PEOPLE_NAMES_SHARED, sharedReadKey({ people }), () => readNameRows(people), PEOPLE_NAMES_SHARED_LIMITS);
  for (const row of rows ?? []) {
    const key = personKey(typeof row.hr_id === "string" ? row.hr_id : null);
    if (!key || !wanted.has(key) || names.has(key)) continue;
    const fullName = typeof row.full_name === "string" ? row.full_name.trim() : "";
    names.set(key, resolveEmployeeDisplayName(fullName || "Unnamed employee", typeof row.nickname === "string" ? row.nickname : null, key));
  }
  return names;
}

/** The live read behind `loadPeopleNames`: every spelling of each person's HR id, 200 at a time. */
async function readNameRows(people: readonly string[]): Promise<NameRow[]> {
  const lookup = [...new Set(people.flatMap((key) => hrIdLookupKeys(key)))];
  const supabase = getSupabaseAdmin();
  // A national scope's names are several batches; they are read four at a time and walked back in
  // batch order, so "the first row wins" picks the same row it always did.
  const batches = await mapWithConcurrency(chunk(lookup, 200), 4, async (part) => {
    const { data, error } = await supabase.from("employees").select("hr_id, full_name, nickname").in("hr_id", part);
    throwIfError(error);
    return (data ?? []) as NameRow[];
  });
  return batches.flat();
}

export function nameOf(names: PeopleNames, hrId: string | null | undefined, fallback = "Unknown person"): string {
  const key = personKey(hrId);
  return (key && names.get(key)) || fallback;
}
