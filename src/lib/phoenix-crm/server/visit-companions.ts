/**
 * Phoenix CRM — everyone on a visit besides the rep, read from `phoenix_crm_visit_companions`.
 *
 * Owner, 2026-10-27: "Everything is applicable" — a visit carries any mix of the managers above the
 * territory and the line's product side, so the three fixed places on `phoenix_crm_visits` hold only the
 * first of each. This table holds them all, in the order the visit lists them. A visit saved before
 * 2026-10-27 has no rows here, and its fixed places are the whole answer — every reader falls back to them.
 *
 * Server-only; service role, exactly as `phoenix_crm_visits` is read.
 */

import { personKey } from "@/lib/phoenix-crm/scope";
import { chunk, throwIfError } from "@/lib/phoenix-crm/server/db";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** Visit ids per read — well under PostgREST's URL limit with uuids. */
const CHUNK = 200;

type CompanionRow = { visit_id: string | null; manager_visit_id: string | null; hr_id: string; position: number };

async function readCompanions(column: "visit_id" | "manager_visit_id", ids: ReadonlyArray<string>): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const distinct = [...new Set(ids.filter(Boolean))];
  for (let start = 0; start < distinct.length; start += CHUNK) {
    const slice = distinct.slice(start, start + CHUNK);
    const { data, error } = await getSupabaseAdmin()
      .from("phoenix_crm_visit_companions")
      .select("visit_id, manager_visit_id, hr_id, position")
      .in(column, slice)
      .order("position", { ascending: true });
    throwIfError(error);
    for (const row of (data ?? []) as CompanionRow[]) {
      const key = String(row[column]);
      const list = out.get(key) ?? [];
      list.push(String(row.hr_id));
      out.set(key, list);
    }
  }
  return out;
}

/** Everyone on each rep visit besides the rep, in order; a visit with no rows is absent from the map. */
export function loadVisitCompanionIds(visitIds: ReadonlyArray<string>): Promise<Map<string, string[]>> {
  return readCompanions("visit_id", visitIds);
}

/**
 * Every rep visit these people went on as a companion — the reverse read, for a manager's own day, week
 * and calendar. The table stores each id upper-cased, so the people are asked by `personKey`.
 */
export async function loadVisitIdsWithCompanions(hrIds: ReadonlyArray<string>): Promise<string[]> {
  const asked = [...new Set(hrIds.map((hrId) => personKey(hrId)).filter((key): key is string => Boolean(key)))];
  const parts = await Promise.all(
    chunk(asked, 100).map((part) =>
      fetchAllRowsKeyset<{ id: string; visit_id: string | null }>(
        () => getSupabaseAdmin().from("phoenix_crm_visit_companions").select("id, visit_id").in("hr_id", part).not("visit_id", "is", null),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      ),
    ),
  );
  return [...new Set(parts.flat().map((row) => String(row.visit_id ?? "")).filter(Boolean))];
}

/** Everyone who went with a manager on each of his own visits, in order. */
export function loadManagerVisitCompanionIds(managerVisitIds: ReadonlyArray<string>): Promise<Map<string, string[]>> {
  return readCompanions("manager_visit_id", managerVisitIds);
}
