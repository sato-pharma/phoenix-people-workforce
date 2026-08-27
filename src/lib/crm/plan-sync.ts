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

/** Mirror rows read per page while collecting the ids a prune will compare against. An unbounded
 * PostgREST select stops at 1000 rows with no error and no marker — the array simply ends — and a
 * short read here would look exactly like "these entries were removed from the CRM". */
const PRUNE_SCAN_PAGE_SIZE = 1000;

/** Ids per delete request. The filter travels in the URL, so a long `.in()` list comes back
 * `{ data: [], error: null }` — a silent no-op that would report a successful prune having deleted
 * nothing. Kept small deliberately; a healthy prune removes a handful of rows, and a large one is
 * refused by `decidePlanPrune` before it reaches here. */
const PRUNE_DELETE_CHUNK = 50;

/** A prune is refused when it would remove more than this share of the window's mirror rows. The
 * vendor answers a window in ONE unpaginated call and a broken shape already throws in
 * `iReports360GetWeeklyPlans`, so the remaining danger is a well-formed but truncated response —
 * this is the guard against it. Real list edits move a few rows; nothing legitimate empties half a
 * month of plans at once. */
export const PLAN_PRUNE_MAX_SHARE = 0.4;

/** Below this many mirror rows the share guard is meaningless (removing 1 of 2 rows is 50%), so a
 * small window is allowed to prune freely. */
export const PLAN_PRUNE_MIN_MIRROR_ROWS = 20;

export type PlanPruneDecision = {
  /** Ids that are in the mirror for this window but absent from the vendor's answer. Reported even
   * when the prune is refused, so a refusal is legible rather than silent. */
  staleIds: number[];
  prune: boolean;
  /** Why a prune was refused. Null when it proceeded. */
  refusedReason: string | null;
};

/**
 * Whether the rows missing from the vendor's answer may be deleted — pure, so every guard is
 * testable without a vendor or a database.
 *
 * The original design deliberately never deleted, on the grounds that "one flaky vendor page
 * silently erasing a rep's whole doctor list is far worse than a stale entry". That reasoning was
 * right and the guards below are the answer to it, not a dismissal of it:
 *
 *   1. The vendor call is UNPAGINATED — one request returns the whole window — so a partial page
 *      cannot exist. `iReports360GetWeeklyPlans` already throws on a missing or non-array `data`
 *      rather than coercing it to empty, so a shape change or a rejected request never reaches here.
 *   2. An EMPTY answer never prunes. A window that legitimately holds no plans also holds no mirror
 *      rows to remove, so this costs nothing real and blocks the one shape that would wipe a month.
 *   3. A prune that would remove most of the window is refused outright.
 */
export function decidePlanPrune(input: {
  mirrorIds: readonly number[];
  vendorIds: ReadonlySet<number>;
  vendorRowCount: number;
}): PlanPruneDecision {
  const staleIds = input.mirrorIds.filter((id) => !input.vendorIds.has(id));
  if (staleIds.length === 0) return { prune: false, refusedReason: null, staleIds };

  if (input.vendorRowCount === 0) {
    return {
      prune: false,
      refusedReason: `the CRM returned no plan entries for this window while the mirror holds ${input.mirrorIds.length} — treated as an unwell vendor, not as an emptied list`,
      staleIds,
    };
  }

  const share = staleIds.length / Math.max(input.mirrorIds.length, 1);
  if (input.mirrorIds.length >= PLAN_PRUNE_MIN_MIRROR_ROWS && share > PLAN_PRUNE_MAX_SHARE) {
    return {
      prune: false,
      refusedReason: `removing ${staleIds.length} of ${input.mirrorIds.length} mirrored entries is ${Math.round(share * 100)}% of the window, over the ${Math.round(PLAN_PRUNE_MAX_SHARE * 100)}% ceiling — refused as a suspected truncated response`,
      staleIds,
    };
  }

  return { prune: true, refusedReason: null, staleIds };
}

/**
 * The window a scheduled sync pulls: the current Cairo month, start to end.
 *
 * Pure and injectable, because the whole point is what it refuses to touch. The owner's ruling of
 * 2026-08-27 is that a doctor removed from a rep's list takes effect for the CURRENT month onward
 * and never rewrites a month that has already closed — so a coverage figure he read in July still
 * reads the same in December. That ruling is enforced by the WINDOW rather than by a condition
 * inside the prune: a closed month is simply never fetched, so it can never be pruned, and no
 * future edit to the prune logic can quietly reach back into one.
 *
 * The month end rather than today, because a weekly plan is written ahead — a rep's remaining weeks
 * are already in the CRM, and syncing only up to today would keep re-adding rows that were removed
 * from a future week.
 */
export function resolvePlanSyncWindow(cairoToday: string): { startDate: string; endDate: string } {
  const monthKey = cairoToday.slice(0, 7);
  const [year, month] = monthKey.split("-").map((part) => Number(part));
  // Day 0 of the next month is the last day of this one, and Date.UTC normalises December.
  const lastDay = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  return { endDate: `${monthKey}-${String(lastDay).padStart(2, "0")}`, startDate: `${monthKey}-01` };
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
  /** Mirror rows deleted because the CRM no longer lists them — doctors taken off a rep's list. */
  pruned: number;
  /** Set when a prune was withheld by a guard, carrying the reason for the log and the admin UI. A
   * refusal is not an error: the sync's additions still applied. */
  pruneRefusedReason: string | null;
  /** Entries the vendor sent that carry no usable plan date — counted, never silently dropped. */
  skippedUndated: number;
  startDate: string;
  /** Rows written (fetched minus duplicates minus skipped). */
  upserted: number;
  /** Rows the vendor returned, before de-duplication. */
  vendorRows: number;
};

/**
 * When the mirror rows inside a window were last written, in epoch ms, or null when the window
 * holds none.
 *
 * Read at startup by the scheduled runner. A Railway deploy restarts the app process, and this repo
 * merges to `main` around 30 times a day — without a durable marker every one of those restarts
 * would re-pull and re-upsert the whole month within seconds of booting.
 */
export async function latestPlanSyncAtMs(input: { startDate: string; endDate: string }): Promise<number | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(CRM_PLAN_ENTRIES_TABLE)
    .select("synced_at")
    .gte("plan_date", input.startDate)
    .lte("plan_date", input.endDate)
    .order("synced_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const syncedAt = ((data ?? [])[0] as { synced_at: string | null } | undefined)?.synced_at;
  if (!syncedAt) return null;
  const ms = new Date(syncedAt).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Every mirrored plan-entry id inside a window, paged so a long month cannot be silently cut at
 * PostgREST's 1000-row default. Scoped to one agent when the caller synced one agent, because a
 * single-agent pull only ever knows the truth about that agent — pruning company-wide from it would
 * delete every other rep's list. Scoped to weekly rows because that is all this module fetches: the
 * table's CHECK also admits 'monthly', and nothing writes those today, but a weekly answer says
 * nothing about a monthly row and must never be read as licence to delete one. */
async function mirroredPlanEntryIds(input: {
  startDate: string;
  endDate: string;
  agentId?: number;
}): Promise<number[]> {
  const supabase = getSupabaseAdmin();
  const ids: number[] = [];
  let offset = 0;
  for (;;) {
    let query = supabase
      .from(CRM_PLAN_ENTRIES_TABLE)
      .select("crm_plan_entry_id")
      .eq("plan_kind", "weekly")
      .gte("plan_date", input.startDate)
      .lte("plan_date", input.endDate);
    if (input.agentId) query = query.eq("agent_crm_id", input.agentId);
    const { data, error } = await query
      .order("crm_plan_entry_id", { ascending: true })
      .range(offset, offset + PRUNE_SCAN_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as unknown as Array<{ crm_plan_entry_id: number }>;
    for (const row of page) ids.push(row.crm_plan_entry_id);
    if (page.length < PRUNE_SCAN_PAGE_SIZE) break;
    offset += PRUNE_SCAN_PAGE_SIZE;
  }
  return ids;
}

/**
 * Fetches one window of weekly plans, upserts them, and removes the ones the CRM no longer lists.
 *
 * UNTIL 2026-08-27 THIS ONLY EVER ADDED. A doctor taken off a rep's list in the CRM kept his mirror
 * row forever, so the rep's assigned list only ever grew: his denominator stayed too big and his
 * coverage percentage read permanently too low. Combined with there being no schedule at all — the
 * only caller was an admin's Refresh button, and production's mirror was found 6.4 days stale — a
 * list edit made in the CRM reached Phoenix late, or never.
 *
 * The original comment here argued against deleting, on the grounds that "one flaky vendor page
 * silently erasing a rep's whole doctor list is far worse than a stale entry". That danger is real
 * and it is answered rather than waved away — see `decidePlanPrune`, which refuses an empty answer
 * and refuses any prune that would take out most of the window, and note that the vendor call is
 * unpaginated and already throws on a malformed response, so the "flaky page" it feared cannot
 * occur. The prune is also confined to the window fetched and, when a single agent was synced, to
 * that agent: a pull that only knows the truth about one rep can only ever delete that rep's rows.
 *
 * A closed month is protected by never being fetched — see `resolvePlanSyncWindow`.
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

  // ── The removals ────────────────────────────────────────────────────────────────────────────
  //
  // Deliberately AFTER the upsert. If the process dies between the two, the mirror holds a superset
  // of the truth — a stale doctor on a list, which is the behaviour this module had for its whole
  // life and which the next run corrects. Pruning first would leave the opposite: a rep's list
  // missing doctors that are genuinely assigned to him, which reads as real work he failed to do.
  const mirrorIds = await mirroredPlanEntryIds({
    endDate: input.endDate,
    startDate: input.startDate,
    ...(input.agentId ? { agentId: input.agentId } : {}),
  });
  const decision = decidePlanPrune({
    mirrorIds,
    vendorIds: new Set(rows.map((row) => row.crm_plan_entry_id)),
    vendorRowCount: entries.length,
  });

  let pruned = 0;
  if (decision.prune) {
    for (let index = 0; index < decision.staleIds.length; index += PRUNE_DELETE_CHUNK) {
      const chunk = decision.staleIds.slice(index, index + PRUNE_DELETE_CHUNK);
      const { error } = await supabase.from(CRM_PLAN_ENTRIES_TABLE).delete().in("crm_plan_entry_id", chunk);
      if (error) throw new Error(error.message);
      pruned += chunk.length;
    }
  }

  return {
    agents: new Set(rows.map((row) => row.agent_crm_id)).size,
    contacts: new Set(rows.map((row) => row.contact_crm_id).filter((id): id is number => Boolean(id))).size,
    endDate: input.endDate,
    pruned,
    pruneRefusedReason: decision.refusedReason,
    skippedUndated,
    startDate: input.startDate,
    upserted: rows.length,
    vendorRows: entries.length,
  };
}
