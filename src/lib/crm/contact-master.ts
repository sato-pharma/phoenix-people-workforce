/**
 * The CRM contact master: Phoenix's own record of every CRM contact, and a DATED record of whose
 * list each one is on.
 *
 * `ireports360_contacts` is each rep's list as it stands today and forgets a doctor the moment he is
 * removed. Native visits and native rep plans both need a contact id that outlives a list change,
 * and a history that says who held a doctor on a given date. The master is that record; the mirror
 * stays read-only (owner decision 19) and the master is rebuilt from it.
 *
 * THE BUILD LIVES IN SQL, in `public.crm_contact_master_refresh` (migration
 * 20260913150000_crm_contact_master.sql), because it is set arithmetic over ~300k mirror rows and a
 * row-by-row copy through PostgREST would be slower than the 30-second scheduler cap. This module is
 * only the door to it, plus the one decision the SQL cannot make: how often to run the expensive
 * activity pass.
 *
 * WHAT A READER STILL DOES ITSELF: classify `speciality` with `contact-taxonomy.ts`. The master has
 * no `kind` column on purpose — a second copy of that list is the defect the taxonomy module exists
 * to prevent.
 */

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { CRM_CONTACT_MASTER_INPUTS_STAMP_RPC, CRM_CONTACT_MASTER_REFRESH_RPC } from "@/lib/crm/tables";

export type ContactMasterRefreshResult = {
  activityContactsAdded: number;
  activityContactsUpdated: number;
  assignmentsClosed: number;
  /** Open periods that began today and stopped matching the same day — dropped, not closed. */
  assignmentsDiscarded: number;
  assignmentsOpened: number;
  assignmentsTouched: number;
  bricksChanged: number;
  contactsTotal: number;
  includeActivity: boolean;
  listContactsChanged: number;
  /** Milliseconds per step (`list`, `activity`, `bricks`, `assignments`). PostgREST cuts a request
   * at 8 s on production; this is how the audit row shows a step growing toward that. */
  ms: Record<string, number>;
  openAssignments: number;
  /** Contacts given a region id from their region NAME because no visit supplied one. */
  regionsFromName: number;
};

export type ContactMasterRefreshOutcome =
  | { status: "refreshed"; result: ContactMasterRefreshResult }
  /** The migration has not reached this environment yet. Expected between a deploy and the apply. */
  | { status: "not_provisioned" }
  | { status: "failed"; error: string };

/**
 * Whether this cron tick should also run the visit and plan pass.
 *
 * The list half is cheap and runs on every slice, so an assignment opens or closes within five
 * minutes of the mirror changing. The activity half reads every visit and plan row — measured 2.5 s
 * on production 2026-09-13 — and visits do not arrive through this job at all, so once per daily
 * sweep is enough: on the LAST slice of the hour, after every agent's list has been refreshed, and
 * on a by-hand `?all=1` run, which is one slice of one.
 */
export function contactMasterRefreshIncludesActivity(input: { slice: number; sliceOf: number }): boolean {
  if (input.sliceOf <= 1) return true;
  return input.slice === input.sliceOf - 1;
}

/**
 * Only a missing FUNCTION reads as "not provisioned". Anything else — a timeout, a constraint, a
 * lock — is a real failure and is reported as one, never folded into the benign answer.
 */
export function isContactMasterMissingError(error: { code?: string | null; message?: string | null }): boolean {
  if (error.code === "PGRST202" || error.code === "42883") return true;
  return /could not find the function public\.crm_contact_master_refresh/i.test(error.message ?? "");
}

/**
 * The text a failed refresh is logged with. PostgREST puts the part that names the cause in `details` —
 * for a unique violation that is `Key (contact_crm_id, agent_crm_id, list_type)=(…) already exists` — and
 * keeping only `message` logged "duplicate key value violates unique constraint" every five minutes for a
 * day with nothing to say WHICH doctor. Production, 2026-10-12.
 */
export function describeContactMasterError(error: {
  code?: string | null;
  details?: string | null;
  hint?: string | null;
  message?: string | null;
}): string {
  const parts = [error.message?.trim() || "unknown error"];
  if (error.code) parts.push(`[code ${error.code}]`);
  if (error.details?.trim()) parts.push(error.details.trim());
  if (error.hint?.trim()) parts.push(`hint: ${error.hint.trim()}`);
  return parts.join(" ");
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The function answers jsonb; a field it did not send reads as zero rather than as undefined. */
export function parseContactMasterRefreshResult(data: unknown): ContactMasterRefreshResult {
  const row = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  return {
    activityContactsAdded: count(row.activityContactsAdded),
    activityContactsUpdated: count(row.activityContactsUpdated),
    assignmentsClosed: count(row.assignmentsClosed),
    assignmentsDiscarded: count(row.assignmentsDiscarded),
    assignmentsOpened: count(row.assignmentsOpened),
    assignmentsTouched: count(row.assignmentsTouched),
    bricksChanged: count(row.bricksChanged),
    contactsTotal: count(row.contactsTotal),
    includeActivity: row.includeActivity === true,
    listContactsChanged: count(row.listContactsChanged),
    ms: Object.fromEntries(
      Object.entries(row.ms && typeof row.ms === "object" ? (row.ms as Record<string, unknown>) : {}).map(
        ([step, value]) => [step, count(value)],
      ),
    ),
    openAssignments: count(row.openAssignments),
    regionsFromName: count(row.regionsFromName),
  };
}

/**
 * Rebuild the master from the mirrors. Never throws: the caller is the contact-list cron, whose
 * rows are already written by the time this runs, and a master refresh failing must not turn a
 * successful sync into a 500. The outcome is returned for the audit row instead.
 */
export async function refreshCrmContactMaster(input: { includeActivity: boolean }): Promise<ContactMasterRefreshOutcome> {
  try {
    const { data, error } = await getSupabaseAdmin().rpc(CRM_CONTACT_MASTER_REFRESH_RPC, {
      p_include_activity: input.includeActivity,
    });
    if (error) {
      if (isContactMasterMissingError(error)) return { status: "not_provisioned" };
      return { error: describeContactMasterError(error), status: "failed" };
    }
    return { result: parseContactMasterRefreshResult(data), status: "refreshed" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), status: "failed" };
  }
}

/**
 * The fingerprint of everything the refresh reads (`crm_contact_master_inputs_stamp`, under 1 ms). Never
 * throws: null when it cannot be read — a missing function included — and the caller then refreshes as
 * it always did, so a stamp that cannot be trusted can only cost a refresh, never skip one.
 */
export async function readCrmContactMasterInputsStamp(): Promise<string | null> {
  try {
    const { data, error } = await getSupabaseAdmin().rpc(CRM_CONTACT_MASTER_INPUTS_STAMP_RPC);
    if (error) return null;
    return typeof data === "string" && data.length > 0 ? data : null;
  } catch {
    return null;
  }
}
