/**
 * Pulls the iReports360 PLAN into Phoenix's mirror — weekly at the top of this file, monthly at the
 * bottom. The two are separate end to end because a monthly plan carries a frequency and no date at
 * all; see the MONTHLY PLANS banner below for what that changes.
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
import { addDaysIso } from "@/lib/crm/dates";
import { getIReports360Config } from "@/lib/crm/config";
import {
  iReports360GetMonthlyPlans,
  iReports360GetWeeklyPlans,
  iReports360Login,
  type IReports360MonthlyPlanEntry,
  type IReports360PlanEntry,
} from "@/lib/crm/client";
import { loadCrmIdentityMaps, resolveEmployeeHrId } from "@/lib/crm/identity";
import type { PlanKind } from "@/lib/crm/plan-verification";
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
 * How far PAST the month's last day a scheduled sync reaches, in days.
 *
 * THIRTEEN IS DERIVED, NOT PICKED. A field week runs Saturday to Friday, and the Plan Verification
 * board's whole promise — its own on-screen words — is that a plan is verified BEFORE the week it
 * covers. So from any day D the sync has to reach the end of the week AFTER D's own week. That end
 * is `saturdayOf(D) + 13`, which is at most `D + 13`, with equality exactly when D is a Saturday.
 * Taking D as the month's last day gives `monthEnd + 13`. Twelve would be short by one day for a
 * month ending on a Saturday — the case a hand-picked "about two weeks" gets wrong.
 *
 * It does NOT reach the third week ahead, and that is a limit worth knowing rather than a bug: the
 * week picker offers about four weeks forward, and covering all of them would need `monthEnd + 34`,
 * i.e. a 65-day window against the {@link MAX_PLAN_SYNC_DAYS} ceiling of 62. Widening that far is a
 * decision about vendor call size, not a constant to nudge.
 */
export const PLAN_SYNC_FORWARD_MARGIN_DAYS = 13;

/**
 * The window a scheduled sync pulls: the current Cairo month, plus {@link
 * PLAN_SYNC_FORWARD_MARGIN_DAYS} past its end.
 *
 * THE ASYMMETRY IS THE WHOLE DESIGN — it reaches FORWARD and never backward, and the two ends are
 * load-bearing for opposite reasons. Do not "tidy" this into a symmetric margin.
 *
 * The START is a guard. The owner's ruling of 2026-08-27 is that a doctor removed from a rep's list
 * takes effect for the CURRENT month onward and never rewrites a month that has already closed — so
 * a coverage figure he read in July still reads the same in December. That ruling is enforced by
 * the WINDOW rather than by a condition inside the prune: a closed month is simply never fetched,
 * so it can never be pruned, and no future edit to the prune logic can quietly reach back into one.
 * Moving the start one day earlier hands the prune a closed month. Never do it.
 *
 * The END is coverage, and until 2026-09-02 it stopped dead on the month's last day. That was a
 * real hole, measured in production the day it was found: the mirror held 2,536 September plan
 * entries and NOT ONE of them existed before 1 September. So on 31 August a district manager who
 * opened the board, picked "next week" — which the picker puts at the top, because that is when a
 * plan is supposed to be verified — and looked at all 70 reps, saw "no plan filed" for every one of
 * them. Nothing was wrong with the reps; Phoenix had never asked the CRM for those dates. Worse, a
 * week straddling the boundary (11% of them, see plan-board.ts) showed only its first half, so the
 * doctor, call and day counts on the board were all quietly short.
 *
 * The read side was already widened for exactly this shape — `PLAN_STRADDLE_MARGIN_DAYS` in
 * plan-board.ts — so the board was reaching for rows the fetch had never gone to get. This closes
 * that gap on the fetch side, which is the only side that can.
 *
 * Reaching into next month is safe in the way reaching into last month is not: an OPEN month has no
 * settled figure to rewrite, and the prune is confined to the window fetched, so the worst it can
 * do there is drop a planned call the CRM itself no longer lists.
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
  const monthEnd = `${monthKey}-${String(lastDay).padStart(2, "0")}`;
  return { endDate: addDaysIso(monthEnd, PLAN_SYNC_FORWARD_MARGIN_DAYS), startDate: `${monthKey}-01` };
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

/**
 * A plan this run saw for the FIRST time — the mirror had never held a row for it.
 *
 * Returned so the caller can tell the rep's manager it is waiting. Deliberately NOT "every plan
 * currently pending": see the note at the call site, and `NEW_PLAN_ANNOUNCE_LIMIT`.
 */
export type NewlySeenPlan = {
  crmPlanId: number;
  firstDate: string | null;
  kind: PlanKind;
  lastDate: string | null;
  month: number | null;
  repHrId: string | null;
  year: number | null;
};

/**
 * The plans in this payload the mirror has never held, with the period each one covers.
 *
 * Chunked at 50: a long `.in()` travels in the URL and comes back `{ data: [], error: null }` — an
 * empty set indistinguishable from a true answer, which here would mean EVERY plan reads as new and
 * every manager gets emailed about a month of history.
 */
async function collectNewPlans(
  rows: ReadonlyArray<{
    agent_hr_id: string | null;
    crm_plan_id: number | null;
    plan_date?: string | null;
    plan_month?: number | null;
    plan_year?: number | null;
  }>,
  kind: PlanKind,
): Promise<NewlySeenPlan[]> {
  const byPlan = new Map<number, NewlySeenPlan>();
  for (const row of rows) {
    if (row.crm_plan_id == null) continue;
    const existing = byPlan.get(row.crm_plan_id) ?? {
      crmPlanId: row.crm_plan_id,
      firstDate: null,
      kind,
      lastDate: null,
      month: row.plan_month ?? null,
      repHrId: row.agent_hr_id,
      year: row.plan_year ?? null,
    };
    const date = row.plan_date ?? null;
    if (date) {
      if (!existing.firstDate || date < existing.firstDate) existing.firstDate = date;
      if (!existing.lastDate || date > existing.lastDate) existing.lastDate = date;
    }
    byPlan.set(row.crm_plan_id, existing);
  }
  if (byPlan.size === 0) return [];

  const planIds = [...byPlan.keys()];
  const known = new Set<number>();
  for (let from = 0; from < planIds.length; from += 50) {
    const chunk = planIds.slice(from, from + 50);
    const { data, error } = await getSupabaseAdmin()
      .from(CRM_PLAN_ENTRIES_TABLE)
      .select("crm_plan_id")
      .in("crm_plan_id", chunk);
    // A failed read must NOT be treated as "nothing is known" — that would announce every plan in
    // the payload. Fail closed: announce nothing this run and let the next one do it.
    if (error) return [];
    for (const found of (data ?? []) as Array<{ crm_plan_id: number | null }>) {
      if (found.crm_plan_id != null) known.add(found.crm_plan_id);
    }
  }
  return [...byPlan.values()].filter((plan) => !known.has(plan.crmPlanId));
}

export type PlanSyncResult = {
  agents: number;
  contacts: number;
  endDate: string;
  /** Plans this run saw for the first time — the input to the manager's notification. */
  newPlans: NewlySeenPlan[];
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
 * A closed month is protected by never being fetched — see `resolvePlanSyncWindow`. The same
 * protection has a cost: `agent_hr_id` is resolved once, at upsert time (`rowFromPlanEntry`), from
 * whatever `loadCrmIdentityMaps()` knew THEN — and because a closed month's rows are never revisited,
 * a row written before an identity resolved (a leaver's crm_username match not yet learned, an admin
 * mapping not yet made) stays unmapped forever, even after `ireports360_visits` correctly re-stamps
 * the same person's visit rows via `stampUnmappedVisitRows`. There is no plan-side equivalent of that
 * re-stamp.
 *
 * 2026-09-03 audit (prompted by the crm_id 1367/1485 reused-slot fixes in reads.ts): 39,750 of
 * 165,470 plan_entries rows (24%), across 61 agent_crm_ids, carry a null agent_hr_id. 36 of the 61
 * already resolve cleanly via the SAME identity sources this module already trusts (the admin
 * resolution table, employees.crm_id, or a unique crm_username match) — confirmed name-for-name
 * against employees.crm_username and resignation date against last real visit date. 35 of those 36
 * are resigned employees' old history; the one active exception (crm_id 1485 / CN-0007) only has
 * rows that predate her hire — B-171's own pre-handover history on the same slot, not hers. The
 * remaining 25 are either an already-decided "resigned, no owner" (13, matches the admin resolution
 * table on purpose) or a dead id with no visit activity ever (12). Full row-by-row breakdown sent to
 * the owner as an XLSX the same day — ask for a copy rather than trusting these counts to still be
 * current.
 *
 * Net: nobody currently active has their live Coverage/Frequency numbers suppressed by this today —
 * it is inert historical debt, not a repeat of the reused-CRM-slot bug class (CRM_RESIGNED_AGENT_CRM_IDS
 * in reads.ts). Still a real gap worth closing: a retroactive re-stamp for plan_entries, mirroring
 * stampUnmappedVisitRows, next time this module is substantially touched. Not fixed here — low
 * urgency, and any future backfill should re-run the audit fresh rather than trust these numbers,
 * since they will have moved on by then.
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

  // WHICH PLANS ARE NEW — asked BEFORE the upsert, or every plan is already known by the time we
  // look. It feeds the manager's "a plan is waiting for you" notification, and the shape of the
  // question IS the safety property: only a plan the mirror has never held counts as new.
  // Announcing everything currently PENDING instead would have emailed a manager once for each of
  // production's 204 unverified plans going back to January, on the first run after deploy.
  const newPlans = await collectNewPlans(rows, "weekly");

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
    newPlans,
    pruned,
    pruneRefusedReason: decision.refusedReason,
    skippedUndated,
    startDate: input.startDate,
    upserted: rows.length,
    vendorRows: entries.length,
  };
}

// ── MONTHLY PLANS ─────────────────────────────────────────────────────────────────────────────
//
// Added 2026-08-28. Until now this module fetched only weekly plans, so `plan_kind = 'monthly'` was
// a value the table's CHECK admitted and nothing ever wrote — the mirror held ZERO monthly rows.
// That was not because monthly plans are rare: the vendor returned 2,409 monthly entries for August
// 2026 across 17 reps, and 2,512 for July across 21. Every one of them was invisible to Phoenix, so
// a rep on a monthly plan appeared to have no assigned list at all.
//
// A MONTHLY PLAN IS NOT A WIDER WEEKLY PLAN, and the shape is where that bites:
//   - no date, so it cannot be placed on a calendar day and every date-ranged query drops it;
//   - no AM/PM start times;
//   - a frequency instead, meaning "see this doctor N times this month" (0-16 observed).
// So it gets its own row builder, its own window and its own prune scan. Sharing the weekly ones
// would write NULL dates into a date-filtered world and lose the rows on the next read.

/**
 * One mirror row from one vendor MONTHLY plan entry.
 *
 * The weekly builder resolves `agent_hr_id` against the entry's own plan date. A monthly entry has
 * no date, so the month's FIRST day stands in: a month's plan is authored at its start, and the
 * first day is the reading that credits whoever held the CRM account when the plan was written
 * rather than whoever inherited that account later in the month.
 *
 * The weekly-only fields are written as explicit nulls rather than left absent. An upsert only
 * touches the columns it names, so an entry id that somehow changed kind would otherwise keep a
 * stale `plan_date` from its earlier life and be read as both kinds at once.
 */
export function rowFromMonthlyPlanEntry(entry: IReports360MonthlyPlanEntry, maps: CrmIdentityMaps) {
  const month = entry.month ?? null;
  const year = entry.year ?? null;
  const asOf = month && year ? `${year}-${String(month).padStart(2, "0")}-01` : null;
  const now = new Date().toISOString();
  return {
    agent_crm_id: entry.agentID,
    agent_hr_id: resolveEmployeeHrId(entry.agentID, null, maps, asOf),
    ampm: normalizeAmpm(entry.appm),
    contact_crm_id: entry.contactID,
    contact_grade: normalizeContactGrade(entry.grade),
    contact_name: entry.contactName,
    crm_plan_entry_id: entry.id,
    crm_plan_id: entry.planID,
    crm_region_name: entry.region,
    plan_date: null,
    plan_frequency: entry.frequency,
    plan_kind: "monthly" as const,
    plan_month: month,
    plan_status: entry.planStatus,
    plan_year: year,
    raw_payload: entry as unknown as Record<string, unknown>,
    speciality: entry.speciality,
    start_am: null,
    start_pm: null,
    synced_at: now,
    updated_at: now,
  };
}

export type MonthlyPlanDraftRow = ReturnType<typeof rowFromMonthlyPlanEntry>;

export type MonthlyPlanSyncResult = {
  agents: number;
  contacts: number;
  month: number;
  /** Plans this run saw for the first time — the input to the manager's notification. */
  newPlans: NewlySeenPlan[];
  /** Mirror rows deleted because the CRM no longer lists them. */
  pruned: number;
  pruneRefusedReason: string | null;
  /** Entries the vendor sent with no month/year to place them in — counted, never silently dropped. */
  skippedUnplaceable: number;
  upserted: number;
  vendorRows: number;
  year: number;
};

/** Validates a month and year, throwing a message an admin can act on. */
export function assertPlanMonth(month: number, year: number): void {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new PlanSyncRangeError(`Month must be 1-12, not ${month}.`);
  }
  // The CRM's own plan data starts in 2026. The bounds exist so a typo'd year cannot send the
  // vendor a request for a year nobody meant to ask about.
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    throw new PlanSyncRangeError(`Year ${year} is outside the range this sync will request.`);
  }
}

/**
 * Every mirrored MONTHLY plan-entry id for one month, paged so a long month cannot be silently cut
 * at PostgREST's 1000-row default.
 *
 * Scoped to `plan_kind = 'monthly'` for the same reason the weekly scan is scoped to weekly: a
 * monthly answer says nothing about a weekly row, and reading it as licence to delete one would
 * erase a rep's dated plan.
 */
async function mirroredMonthlyPlanEntryIds(input: { month: number; year: number }): Promise<number[]> {
  const supabase = getSupabaseAdmin();
  const ids: number[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(CRM_PLAN_ENTRIES_TABLE)
      .select("crm_plan_entry_id")
      .eq("plan_kind", "monthly")
      .eq("plan_month", input.month)
      .eq("plan_year", input.year)
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
 * Fetches one calendar month of MONTHLY plans, upserts them, and removes the ones the CRM no longer
 * lists.
 *
 * Mirrors `syncIReports360WeeklyPlans` deliberately, including the order: upsert first, prune
 * second, so a process that dies between them leaves a superset of the truth — a stale doctor on a
 * list — rather than a rep's list missing doctors that are genuinely assigned to him, which would
 * read as real work he failed to do. `decidePlanPrune` is shared, so the empty-answer refusal and
 * the share ceiling apply here unchanged.
 *
 * Unlike the weekly sync, a closed month is NOT protected by the window, because the caller names
 * the month outright. That is deliberate — a monthly plan holds one row per doctor for the whole
 * month, so re-reading a closed month re-reads the same rows — but it does mean a caller must not
 * loop this over history without weighing the owner's ruling that a list edit takes effect from the
 * current month onward and never rewrites a month that has closed.
 */
export async function syncIReports360MonthlyPlans(input: {
  month: number;
  year: number;
}): Promise<MonthlyPlanSyncResult> {
  assertPlanMonth(input.month, input.year);

  const config = getIReports360Config();
  const token = await iReports360Login(config);
  const entries = await iReports360GetMonthlyPlans(config, token, input.month, input.year);

  const maps = await loadCrmIdentityMaps();
  // The vendor's `id` is unique per planned contact, but a repeated id inside one response would
  // make the upsert fail on "cannot affect row a second time" — the same guard the weekly sync and
  // the visits sync both apply.
  const unique = dedupeByKey(entries, (entry) => entry.id);

  const rows: MonthlyPlanDraftRow[] = [];
  let skippedUnplaceable = 0;
  for (const entry of unique) {
    const row = rowFromMonthlyPlanEntry(entry, maps);
    // An entry with no month or year cannot be placed in any window, so it would be invisible to
    // every reader while still occupying a row — and, worse, invisible to this sync's own prune
    // scan, which is keyed on exactly those two columns. Counted and reported, never dropped
    // silently.
    if (row.plan_month == null || row.plan_year == null) {
      skippedUnplaceable += 1;
      continue;
    }
    rows.push(row);
  }

  const supabase = getSupabaseAdmin();

  // Same question as the weekly sync, asked in the same place and for the same reason: before the
  // upsert, or the answer is always "none". A monthly plan carries no dates, so `firstDate` and
  // `lastDate` come back null here and the notification names the month instead.
  const newPlans = await collectNewPlans(rows, "monthly");

  for (let index = 0; index < rows.length; index += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(index, index + UPSERT_BATCH_SIZE);
    const { error } = await supabase
      .from(CRM_PLAN_ENTRIES_TABLE)
      .upsert(batch, { onConflict: "crm_plan_entry_id" });
    if (error) throw new Error(error.message);
  }

  const mirrorIds = await mirroredMonthlyPlanEntryIds({ month: input.month, year: input.year });
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
    month: input.month,
    newPlans,
    pruned,
    pruneRefusedReason: decision.refusedReason,
    skippedUnplaceable,
    upserted: rows.length,
    vendorRows: entries.length,
    year: input.year,
  };
}
