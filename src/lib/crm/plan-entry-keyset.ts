import { quotePostgrestValue } from "@/lib/supabase/search-filter";

/**
 * The keyset cursor every paged read of `crm_plan_entries_unified` walks.
 *
 * 🔴 `crm_plan_entry_id` ALONE DOES NOT NAME A ROW OF THE VIEW. Its Phoenix branch derives the id from
 * the plan ITEM, and repeats that item once for every rep who sat on its territory that day, so two
 * reps whose spells on one seat overlap share every id of that day. Measured on production
 * 28 Oct 2026: (plan_date, crm_plan_entry_id) has 103 more Phoenix rows than distinct pairs, and 27 Oct
 * alone carried 779 rows under 767 ids. (plan_date, crm_plan_entry_id, agent_hr_id) is unique across
 * the whole view — 193,136 iReports360 rows and 10,065 Phoenix rows, 0 left over.
 *
 * So a cursor on the id alone could step over the second rep's row at a page boundary (`gt id`), and
 * an OFFSET page ordered by the id alone could return one tied row twice and the other never, because
 * the order of tied rows is not fixed between two requests. The cursor is therefore the whole tuple,
 * in the order `plan_date, crm_plan_entry_id, agent_hr_id NULLS LAST` — the order every caller must
 * ask for with it.
 *
 * `byDate: false` is for a read with no date range to walk: a single day (`plan_date = d`, the tuple
 * loses nothing) and the month window, whose monthly plans carry no `plan_date` at all.
 */
export type PlanEntryKey = {
  agent_hr_id?: string | null;
  crm_plan_entry_id?: number | string | null;
  plan_date?: string | null;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const INTEGER = /^-?\d+$/;

/**
 * The argument for PostgREST's `.or(…)` that keeps only the rows strictly AFTER `last` in the order
 * above. A null `agent_hr_id` sorts last, so nothing follows it within its (day, id); a non-null one is
 * followed by a greater hr id OR a null one — a plain `gt` would never match the null.
 *
 * Throws on a key it cannot write safely. The values come from the database, never from a person, but
 * a date or id that is not what the view returns would be a silently wrong filter, not a loud one.
 */
export function planEntryKeysetAfter(last: PlanEntryKey, options: { byDate: boolean }): string {
  const id = String(last.crm_plan_entry_id ?? "");
  if (!INTEGER.test(id)) throw new Error(`A plan entry cursor needs an integer crm_plan_entry_id, got "${id}".`);
  const hr = last.agent_hr_id ?? null;
  const idClauses = [`crm_plan_entry_id.gt.${id}`];
  if (hr !== null) {
    idClauses.push(`and(crm_plan_entry_id.eq.${id},or(agent_hr_id.gt.${quotePostgrestValue(hr)},agent_hr_id.is.null))`);
  }
  if (!options.byDate) return idClauses.join(",");

  const date = String(last.plan_date ?? "");
  if (!ISO_DATE.test(date)) throw new Error(`A plan entry cursor needs a YYYY-MM-DD plan_date, got "${date}".`);
  return [`plan_date.gt.${date}`, ...idClauses.map((clause) => `and(plan_date.eq.${date},${clause})`)].join(",");
}

/** The row's whole key as one string — what a union of two passes deduplicates on. A null hr id and
 * an empty one stay two different keys. */
export function planEntryKeyOf(row: PlanEntryKey): string {
  return JSON.stringify([row.plan_date ?? null, row.crm_plan_entry_id ?? null, row.agent_hr_id ?? null]);
}
