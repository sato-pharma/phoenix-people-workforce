import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * HR ids → display names, for any screen that holds ids and owes the reader names.
 *
 * WHY THIS IS SHARED. Three modules had written this same loop by hand — the production planner's
 * grant list, the recruiter's vacancy stand-ins, and the CV shelf's filer column — and they had
 * already drifted: two chunked the query and one did not, two keyed the result by the caller's own
 * strings and one by the canonical key. The drift is invisible in review because every version
 * LOOKS right; what separates them is the failure they survive.
 *
 * 🔴 THE MIXED-CASE TRAP. Production stores `hr_id` mixed-case — `hrIdForStorage` writes upper, and
 * roughly 37,000 lower-cased actor ids sit across 52 columns from before it existed — and PostgREST
 * matches case-sensitively. So `.in("hr_id", ["b-10"])` matches nobody AND RETURNS NO ERROR: a
 * silently empty name list that reads exactly like "this person has no name on file", while the
 * employee sits right there in the table. `hrIdLookupKeys` yields every spelling and
 * `canonicalHrIdKey` folds the row back; both live in `src/lib/hr-id.ts`.
 *
 * 🔴 CHUNKED AT 50 KEYS, and that is the same class of fault one layer up: a long enough `in`
 * filter makes PostgREST return zero rows and no error either. Each id becomes two or three
 * spellings, so the key list outgrows the id list before anyone notices — the recruiter's copy was
 * written for at most five ids and then grew to every manager named on an open vacancy, 16 distinct
 * people across 45 seats in production on 2026-08-31. The planner's copy did not chunk at all; it
 * holds one row per granted person, which is small today and is exactly how this fault arrives, as
 * a list that grew.
 *
 * 🔴 A FAILED CHUNK COSTS THE NAMES IN IT AND NOTHING ELSE. The remaining chunks still run and the
 * caller falls back to whatever it showed before this lookup existed — an id, or nothing. Under-
 * reporting a name beats inventing one, and a read that throws would take a whole screen down for a
 * column.
 *
 * The display name goes through `resolveEmployeeDisplayName`, so a person reads the same on every
 * screen: the nickname the company uses, and the shared-identity name where one applies.
 */
export const HR_ID_LOOKUP_CHUNK = 50;

const NAME_COLUMNS = "hr_id,full_name,nickname";

type EmployeeNameRow = { hr_id?: string | null; full_name?: string | null; nickname?: string | null };

/**
 * The slice of a Supabase client this read needs. Structural on purpose: it lets a test drive the
 * real function against `tests/fixtures/fake-supabase-table.ts`, which is the only way the chunk
 * boundary and the failed-chunk fallback can be shown to hold — this repo's suite runs with
 * PRODUCTION credentials, so a test must never reach the real `employees` table.
 */
export type EmployeeNameLookupClient = {
  from(table: string): {
    select(columns: string): {
      in(column: string, values: string[]): PromiseLike<{ data: unknown; error: unknown }>;
    };
  };
};

/**
 * Names, read by HR id in whatever spelling the caller holds.
 *
 * `get` canonicalises its argument, which is the point of returning an accessor rather than a Map:
 * every hand-written copy of this had call sites reading `names.get(canonicalHrIdKey(id) ?? "")`,
 * where the `?? ""` quietly looks up the empty key instead of saying "no id".
 */
export type EmployeeNameIndex = {
  get(hrId: string | null | undefined): string | null;
  /** How many distinct people were resolved — not how many ids were asked for. */
  readonly size: number;
};

const EMPTY_INDEX: EmployeeNameIndex = { get: () => null, size: 0 };

function indexOf(byCanonical: Map<string, string>): EmployeeNameIndex {
  return {
    get(hrId) {
      const key = canonicalHrIdKey(hrId);
      return key ? byCanonical.get(key) ?? null : null;
    },
    get size() {
      return byCanonical.size;
    },
  };
}

export async function namesByHrId(
  hrIds: Iterable<string | null | undefined>,
  client?: EmployeeNameLookupClient,
): Promise<EmployeeNameIndex> {
  const keys = [...new Set([...hrIds].flatMap((hrId) => hrIdLookupKeys(hrId)))];
  if (keys.length === 0) return EMPTY_INDEX;

  const db = client ?? (getSupabaseAdmin() as unknown as EmployeeNameLookupClient);
  const byCanonical = new Map<string, string>();

  for (let start = 0; start < keys.length; start += HR_ID_LOOKUP_CHUNK) {
    const { data, error } = await db
      .from("employees")
      .select(NAME_COLUMNS)
      .in("hr_id", keys.slice(start, start + HR_ID_LOOKUP_CHUNK));
    if (error || !data) continue;

    for (const row of data as EmployeeNameRow[]) {
      const key = canonicalHrIdKey(row.hr_id);
      const fullName = String(row.full_name ?? "").trim();
      if (!key || !fullName) continue;
      byCanonical.set(key, resolveEmployeeDisplayName(fullName, row.nickname ?? null, row.hr_id ?? null));
    }
  }

  return indexOf(byCanonical);
}
