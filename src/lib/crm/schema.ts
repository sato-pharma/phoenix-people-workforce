/**
 * Shared "is the CRM mirror schema present?" detection for the CRM module.
 *
 * Before the iReports360 migrations ship (or in a fresh environment), reads against the
 * mirror tables fail with a schema/relation-missing error. Every CRM read degrades to an
 * empty result rather than throwing, so callers render "not set up yet" instead of crashing.
 */

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { CRM_CHECKINS_TABLE, CRM_VISITS_TABLE } from "@/lib/crm/tables";

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

/** Cheap head-count probe: is the visits mirror queryable? */
export async function isCrmVisitsSchemaReady(): Promise<boolean> {
  const { error } = await getSupabaseAdmin()
    .from(CRM_VISITS_TABLE)
    .select("id", { count: "exact", head: true })
    .limit(1);
  return !isCrmSchemaMissingError(error);
}

/** Cheap head-count probe: is the check-ins mirror queryable? (CRM Integrity correlates
 * visits + check-ins, so it gates on the check-ins table specifically.) */
export async function isCrmCheckinsSchemaReady(): Promise<boolean> {
  const { error } = await getSupabaseAdmin()
    .from(CRM_CHECKINS_TABLE)
    .select("id", { count: "exact", head: true })
    .limit(1);
  return !isCrmSchemaMissingError(error);
}
