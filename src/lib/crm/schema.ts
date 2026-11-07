/**
 * Shared "is the CRM mirror schema present?" detection for the CRM module.
 *
 * Before the iReports360 migrations ship (or in a fresh environment), reads against the
 * mirror tables fail with a schema/relation-missing error. Every CRM read degrades to an
 * empty result rather than throwing, so callers render "not set up yet" instead of crashing.
 */

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { CRM_VISITS_UNIFIED_VIEW } from "@/lib/crm/tables";

/** True when an error is really "the iReports360 mirror tables don't exist yet". */
export function isCrmSchemaMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : JSON.stringify(error);
  // A missing COLUMN (Postgres 42703 "column … does not exist" / PostgREST PGRST204 "Could not find
  // the … column … in the schema cache") is a code or projection bug — it must surface as a REAL
  // error, not be misread as "the mirror isn't provisioned" and silently degrade to an empty result.
  // Only genuine relation/schema-missing signals below count as schema-missing.
  if (/42703|column .* does not exist|Could not find the .* column/i.test(message)) return false;
  return /ireports360_(visits|checkins|crm_identity_resolutions)|schema cache|does not exist|PGRST205|42P01/i.test(
    message,
  );
}

/** Cheap head probe: is the visits door queryable?
 *
 * THE DOOR, NOT THE VENDOR TABLE (7 Nov 2026): iReports360 was retired on 6 Nov and every visits read goes
 * through `crm_visits_unified` — the iReports360 archive before each team's start, Phoenix CRM after it. So
 * the probe asks the door the readers actually read (one HEAD row, about 1 ms on production), not the
 * vendor's own table, which answers "ready" even when the door is gone.
 *
 * NO COUNT (2026-10-01, "slow to transfer between page and page"): it used to ask `count: "exact"`,
 * which made every probe a COUNT(*) of the whole mirror — and nothing here reads the number, only
 * whether the request errored. A one-row HEAD errors, or does not, exactly as the counted one did. */
export async function isCrmVisitsSchemaReady(): Promise<boolean> {
  const { error } = await getSupabaseAdmin()
    .from(CRM_VISITS_UNIFIED_VIEW)
    .select("id", { head: true })
    .limit(1);
  return !isCrmSchemaMissingError(error);
}

/**
 * Does the unified visits view answer at all? Null when it does, else the error it gave.
 *
 * Every visits read in reads.ts turns a missing view into `[]`, so "nobody visited" and "the view is
 * gone" read the same — lead R6 of the System Audit. The visit-lifecycle detector asks this ONCE a
 * run, before it reads the door, and reports the door as unread instead of every visit as lost. One
 * HEAD row, no count, like the probes above.
 */
export async function probeCrmVisitsUnifiedView(): Promise<string | null> {
  const { error } = await getSupabaseAdmin()
    .from(CRM_VISITS_UNIFIED_VIEW)
    .select("id", { head: true })
    .limit(1);
  if (!error) return null;
  return error.message || error.code || "the view gave an error with no message";
}
