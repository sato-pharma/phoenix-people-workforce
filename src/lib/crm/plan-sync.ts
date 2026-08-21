/**
 * Pulls the iReports360 weekly PLAN into Phoenix's mirror.
 *
 * The plan is the rep's ASSIGNED doctor list. Phoenix has always mirrored the other half — what a
 * rep actually did (`ireports360_visits`) — so until this existed there was no way to ask "which
 * doctors is this rep supposed to see", and a doctor on the list who was never visited had no row
 * anywhere in the system to be counted.
 *
 * Deliberately a SEPARATE module from sync.ts rather than another branch inside it. The visits
 * sync is the platform's most load-bearing scheduled job (cron, dead-man's switch, live poller,
 * wide reconciliation, geocode backfill); a plan pull is an on-demand admin refresh with none of
 * that machinery, and folding it in would put a new failure mode inside the job that feeds payroll
 * attendance.
 *
 * VENDOR TIMESTAMP INVARIANT (same as sync.ts — do not "helpfully" convert): `date` arrives as a
 * zone-less string that is ALREADY Africa/Cairo wall-clock ("2026-08-18T00:00:00"). Only its
 * leading 10 characters are stored, into a `date` column, so no zone math ever touches it.
 */

import { CRM_PLAN_ENTRIES_TABLE } from "@/lib/crm/tables";
import { getIReports360Config } from "@/lib/crm/config";
import {
  iReports360GetWeeklyPlans,
  iReports360Login,
  type IReports360PlanEntry,
} from "@/lib/crm/client";
import { loadCrmIdentityMaps, resolveEmployeeHrId } from "@/lib/crm/identity";
import { dedupeByKey, isValidIsoDate, normalizeAmpm, normalizeContactGrade } from "@/lib/crm/sync";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { CrmIdentityMaps } from "@/lib/crm/types";

/** Rows per upsert request. Matches the visits sync — the vendor sends ~16k rows for three weeks
 * and a single statement that size times out against Frankfurt from Amsterdam. */
const UPSERT_BATCH_SIZE = 500;

/** Hard ceiling on the window a single sync may request, in days. The vendor answers a three-week
 * range in one call today, but an unbounded range is how an admin refresh becomes a 30s timeout
 * that commits half its work (see the Supabase client's own 15s behaviour). A caller wanting more
 * history calls this once per month rather than asking for a year at once. */
export const MAX_PLAN_SYNC_DAYS = 62;

export class PlanSyncRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanSyncRangeError";
  }
}

/** Inclusive day count between two ISO dates. */
export function daysBetweenIso(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  return Math.floor((end - start) / 86_400_000) + 1;
}

/** Validates a sync window and throws a message an admin can act on. Pure, so the route and the
 * service share one rule and a bad range never reaches the vendor. */
export function assertPlanSyncRange(startDate: string, endDate: string): void {
  if (!isValidIsoDate(startDate) || !isValidIsoDate(endDate)) {
    throw new PlanSyncRangeError("Give both dates as YYYY-MM-DD.");
  }
  if (endDate < startDate) {
    throw new PlanSyncRangeError("The end date is before the start date.");
  }
  const days = daysBetweenIso(startDate, endDate);
  if (days > MAX_PLAN_SYNC_DAYS) {
    throw new PlanSyncRangeError(
      `That range is ${days} days. Sync at most ${MAX_PLAN_SYNC_DAYS} days at a time — run it once per month for older history.`,
    );
  }
}

/**
 * One mirror row from one vendor plan entry.
 *
 * `agent_hr_id` is resolved crm-id-first because a plan entry carries no agent name at all — the
 * same position a check-in is in, and the same call shape it uses. The entry's own date drives the
 * post-exit attribution guard, so a CRM slot reused for a departing rep's replacement does not
 * stamp the leaver's hr id onto the new rep's list.
 */
export function rowFromPlanEntry(entry: IReports360PlanEntry, maps: CrmIdentityMaps) {
  const planDay = (entry.date ?? "").slice(0, 10) || null;
  const now = new Date().toISOString();
  return {
    agent_crm_id: entry.agentID,
    agent_hr_id: resolveEmployeeHrId(entry.agentID, null, maps, planDay),
    ampm: normalizeAmpm(entry.appm),
    contact_crm_id: entry.contactID,
    contact_grade: normalizeContactGrade(entry.grade),
    contact_name: entry.contactName,
    crm_plan_entry_id: entry.id,
    crm_plan_id: entry.planID,
    crm_region_name: entry.region,
    plan_date: planDay,
    plan_kind: "weekly" as const,
    plan_status: entry.planStatus,
    raw_payload: entry as unknown as Record<string, unknown>,
    speciality: entry.speciality,
    start_am: entry.startAM,
    start_pm: entry.startPM,
    synced_at: now,
    updated_at: now,
  };
}

export type PlanDraftRow = ReturnType<typeof rowFromPlanEntry>;

export type PlanSyncResult = {
  agents: number;
  contacts: number;
  endDate: string;
  /** Entries the vendor sent that carry no usable plan date — counted, never silently dropped. */
  skippedUndated: number;
  startDate: string;
  /** Rows written (fetched minus duplicates minus skipped). */
  upserted: number;
  /** Rows the vendor returned, before de-duplication. */
  vendorRows: number;
};

/**
 * Fetches one window of weekly plans and upserts them.
 *
 * Upsert, not delete-then-insert: a plan entry the vendor stops sending (a call the rep removed
 * from the plan) leaves a stale row behind, and that is the deliberate trade. Deleting anything the
 * current response omits would mean one flaky vendor page silently erasing a rep's whole doctor
 * list, which is far worse than a stale entry — and the board reads a date window, so a removed
 * entry stops mattering as soon as its week passes.
 */
export async function syncIReports360WeeklyPlans(input: {
  startDate: string;
  endDate: string;
  agentId?: number;
}): Promise<PlanSyncResult> {
  assertPlanSyncRange(input.startDate, input.endDate);

  const config = getIReports360Config();
  const token = await iReports360Login(config);
  const entries = await iReports360GetWeeklyPlans(config, token, input.startDate, input.endDate, input.agentId);

  const maps = await loadCrmIdentityMaps();
  // The vendor's `id` is unique per planned call, but a repeated id inside one response would make
  // the upsert fail on "cannot affect row a second time" — the same guard the visits sync applies.
  const unique = dedupeByKey(entries, (entry) => entry.id);

  const rows: PlanDraftRow[] = [];
  let skippedUndated = 0;
  for (const entry of unique) {
    const row = rowFromPlanEntry(entry, maps);
    // A weekly entry with no date cannot be placed in any window, so it would be invisible to every
    // reader while still occupying a row. Counted and reported rather than dropped in silence.
    if (!row.plan_date) {
      skippedUndated += 1;
      continue;
    }
    rows.push(row);
  }

  const supabase = getSupabaseAdmin();
  for (let index = 0; index < rows.length; index += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(index, index + UPSERT_BATCH_SIZE);
    const { error } = await supabase
      .from(CRM_PLAN_ENTRIES_TABLE)
      .upsert(batch, { onConflict: "crm_plan_entry_id" });
    if (error) throw new Error(error.message);
  }

  return {
    agents: new Set(rows.map((row) => row.agent_crm_id)).size,
    contacts: new Set(rows.map((row) => row.contact_crm_id).filter((id): id is number => Boolean(id))).size,
    endDate: input.endDate,
    skippedUndated,
    startDate: input.startDate,
    upserted: rows.length,
    vendorRows: entries.length,
  };
}
