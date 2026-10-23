/**
 * FULL-HISTORY PARITY SWEEP — the guarantee that the CRM module and Phoenix never disagree about
 * how many visits a rep made.
 *
 * THE GAP THIS CLOSES. Every sync this repo runs is bounded to a recent window: the live poll covers
 * today, the rolling cron covers 10 days, and the wide reconcile covers 120 days as four 30-day
 * slices on a 4-week rotation. Nothing has ever re-examined a day older than 120 days. Measured on
 * production 2026-08-28: 53,068 of 126,547 mirror rows (42%) sat past that horizon and had not been
 * compared against the CRM since the day they were first pulled.
 *
 * The mismatch that produced is real and was measured the same day — 509 rows across 8 months where
 * the mirror and the CRM disagree (473 the mirror has and the CRM does not, 36 the CRM has and the
 * mirror does not). Every one of the missing rows was SAVED 18-91 days after its own visit date: the
 * vendor's API can only be queried by visit date and has no "changed since" filter, so a visit
 * entered late lands in a window every scheduled sync has already passed over, and nothing ever goes
 * back for it. That is not a bug in the sync — it is the sync's window being finite while the CRM's
 * edit history is not.
 *
 * WHAT THIS DOES. Slices the ENTIRE history into 30-day windows and re-verifies the stalest one on
 * every run, so coverage is complete rather than trailing. At 8 windows (2026-01-01 to date) and one
 * run a day, every day of history is re-proved against the CRM every 8 days, and the cost of a run
 * stays flat as history grows — the number of windows grows, the work per run does not.
 *
 * WHY IT VERIFIES BEFORE IT REPAIRS, rather than just re-running the sync over old windows. A blind
 * re-sync of a historic window is a destructive operation wearing an idempotent costume: the sync's
 * delete-reconciliation removes every mirror row the fetch did not return, so one degraded vendor
 * response over a 30-day window of settled history deletes real rows that no later run will bring
 * back (the CRM would have to still be serving them, which is exactly what just failed). The sweep
 * therefore fetches, compares id sets, and only then decides — and refuses outright on the shapes
 * that mean "the fetch is wrong" rather than "the mirror is wrong". See `decideParityAction`.
 */

import { getIReports360Config, isIReports360Configured } from "@/lib/crm/config";
import { iReports360GetVisits, iReports360Login } from "@/lib/crm/client";
import { addDaysIso } from "@/lib/crm/dates";
import { syncIReports360Visits } from "@/lib/crm/sync";
import { CRM_PARITY_WINDOWS_TABLE, CRM_VISITS_TABLE } from "@/lib/crm/tables";
import { isCrmSchemaMissingError } from "@/lib/crm/schema";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { logError } from "@/lib/observability/log";

/** One 30-day window of history. `from` and `to` are both INCLUSIVE `YYYY-MM-DD`. */
export type ParityWindow = { from: string; to: string };

/** The earliest visit date the mirror has ever held. Used as the floor when the mirror is empty so
 * a first run still has something well-defined to do. */
export const PARITY_HISTORY_FLOOR = "2026-01-01";

/** Matches the wide reconcile's slice size — a window small enough that one fetch plus one repair
 * comfortably fits the 300s route budget, which is the constraint that set 30 days in the first
 * place (see runWideIReports360Reconciliation's 2026-07-06 note). */
export const PARITY_SLICE_DAYS = 30;

/** How long a window may go unverified before the sweep says so out loud. With one run a day and
 * ~8 windows the true cycle is ~8 days, so 21 days means "the sweep itself has stopped working",
 * not "we are mid-rotation". */
export const PARITY_STALE_AFTER_DAYS = 21;

/**
 * The deletion ceilings, and why 50% was not one.
 *
 * Measured on production over five consecutive nights (Sept 29 — Oct 2, 2026): the sweep deleted
 * 366, 351, 353 and 458 mirror rows from the March, April, May and June windows, every one of them
 * between 2.0% and 2.6% of its window. The existing >50% guard was never even approached, so in
 * practice nothing bounded the destructive direction at all — and 1,879 rows left with no id
 * recorded anywhere, against a database with no point-in-time recovery.
 *
 * These two ceilings sit BELOW the >50% one rather than replacing it, because they answer a
 * different question. 50% asks "did the fetch fail?"; these ask "is this more history than a
 * routine reconciliation should remove while nobody is watching?" A window over either ceiling is
 * recorded as a refusal and left unequal, which is visible and reversible; the alternative is a
 * delete that is neither.
 *
 * The owner's locked CRM rule is the reason the bar is this low: the CRM admin deactivates and
 * CLONES, never deletes (.claude/rules/crm.md). A large one-sided `extraInMirror` is therefore more
 * likely to be a vendor-side scope or activation artefact than a real deletion, and the sweep
 * cannot tell the two apart from row counts.
 */
export const PARITY_MAX_DELETE_ROWS = 250;
export const PARITY_MAX_DELETE_SHARE = 0.05;

/**
 * Every window covering [earliest, today], oldest first. The last window is clamped to today rather
 * than allowed to run past it — an unclamped window would ask the vendor for future dates, and a
 * window whose bounds move every day could never be recorded as "verified" against a stable key.
 */
export function resolveParityWindows(earliestIso: string, todayIso: string): ParityWindow[] {
  if (earliestIso > todayIso) return [];
  const windows: ParityWindow[] = [];
  let from = earliestIso;
  // Bounded by construction (each step advances `from` by PARITY_SLICE_DAYS), but a hard cap keeps a
  // malformed date from spinning: 400 windows is ~33 years of history.
  for (let guard = 0; guard < 400 && from <= todayIso; guard += 1) {
    const to = addDaysIso(from, PARITY_SLICE_DAYS - 1);
    windows.push({ from, to: to > todayIso ? todayIso : to });
    from = addDaysIso(from, PARITY_SLICE_DAYS);
  }
  return windows;
}

/** The stable identity of a window — its start date. Deliberately not the pair: a window's end
 * moves when it is the last one (clamped to today), so keying on both would make the newest window
 * look brand new every single day and starve every older window of its turn. */
export function parityWindowKey(window: ParityWindow): string {
  return window.from;
}

/**
 * Which window this run should verify: the one checked longest ago, with never-checked windows
 * first. Oldest-start wins a tie so a fresh installation walks history forward predictably rather
 * than in map order.
 */
export function selectStalestWindow(
  windows: readonly ParityWindow[],
  checkedAtByKey: ReadonlyMap<string, string>,
): ParityWindow | null {
  let best: ParityWindow | null = null;
  let bestCheckedAt: string | null = null;
  for (const window of windows) {
    const checkedAt = checkedAtByKey.get(parityWindowKey(window)) ?? null;
    if (best === null) {
      best = window;
      bestCheckedAt = checkedAt;
      continue;
    }
    // A never-checked window always beats a checked one.
    if (checkedAt === null && bestCheckedAt !== null) {
      best = window;
      bestCheckedAt = null;
      continue;
    }
    if (checkedAt !== null && bestCheckedAt === null) continue;
    if (checkedAt !== null && bestCheckedAt !== null && checkedAt < bestCheckedAt) {
      best = window;
      bestCheckedAt = checkedAt;
    }
  }
  return best;
}

/** The id-set comparison, as counts plus the ids needed to act. */
export type ParityDiff = {
  /** In the CRM's answer but not in the mirror — the late-save case. */
  missingInMirror: number;
  /** In the mirror but not in the CRM's answer — a visit deleted or re-dated in the CRM. */
  extraInMirror: number;
  crmRows: number;
  mirrorRows: number;
};

/**
 * The comparison plus the ids behind each count.
 *
 * The ids were always computed here and then thrown away, and that is how 1,879 mirror rows left
 * across five nights with no id recorded anywhere: `ireports360_parity_windows` keeps counts, the
 * sync-run row keeps `rows_deleted`, and production has no point-in-time recovery. `extraIds` is
 * exactly what the repair is about to delete, so it is also what has to be archived first.
 */
export type ParityIdSets = ParityDiff & {
  /** In the CRM's answer, not in the mirror — these get upserted, and adding rows destroys nothing. */
  missingIds: readonly number[];
  /** In the mirror, not in the CRM's answer — these are the candidates for DELETION. */
  extraIds: readonly number[];
};

export function compareVisitIdSets(crmIds: readonly number[], mirrorIds: readonly number[]): ParityIdSets {
  const crm = new Set(crmIds);
  const mirror = new Set(mirrorIds);
  const missingIds: number[] = [];
  for (const id of crm) if (!mirror.has(id)) missingIds.push(id);
  const extraIds: number[] = [];
  for (const id of mirror) if (!crm.has(id)) extraIds.push(id);
  return {
    crmRows: crm.size,
    mirrorRows: mirror.size,
    missingInMirror: missingIds.length,
    extraInMirror: extraIds.length,
    missingIds,
    extraIds,
  };
}

export type ParityAction = "equal" | "repair" | "refuse";

/**
 * The safety decision, kept pure and separate because it is the only part of this file where being
 * wrong destroys data.
 *
 * REFUSE covers the two shapes that mean the FETCH failed rather than the mirror drifting. Both are
 * indistinguishable from a genuine mass deletion by row count alone, and both would otherwise hand
 * the repair path a mandate to delete settled history:
 *
 *   empty answer   the vendor returned nothing for a window the mirror has rows for. A real month
 *                  in which no rep in the company logged a single visit does not happen here.
 *   mass shortfall the vendor returned some rows but is missing more than half of what the mirror
 *                  holds. The sync carries its own 50% delete guard for exactly this, and this is
 *                  the same threshold applied one step earlier — before the destructive call rather
 *                  than inside it — so the sweep can record WHY it stopped instead of running a
 *                  repair that silently skips its own reconciliation.
 *   bulk deletion  the vendor is missing more than PARITY_MAX_DELETE_SHARE of the window, or more
 *                  than PARITY_MAX_DELETE_ROWS rows outright. See the constants for why 50% turned
 *                  out to be no guard at all in practice.
 *
 * Anything else is a real difference and gets repaired. Note that a window needing only ADDITIONS is
 * never refused: extra rows arriving is the late-save case this sweep exists for, and adding rows
 * cannot destroy anything.
 */
export function decideParityAction(diff: ParityDiff): { action: ParityAction; reason: string | null } {
  if (diff.missingInMirror === 0 && diff.extraInMirror === 0) return { action: "equal", reason: null };
  if (diff.crmRows === 0 && diff.mirrorRows > 0) {
    return {
      action: "refuse",
      reason: `CRM returned 0 visits for a window the mirror holds ${diff.mirrorRows} rows for — treating this as a failed fetch, not a mass deletion.`,
    };
  }
  if (diff.mirrorRows > 0 && diff.extraInMirror / diff.mirrorRows > 0.5) {
    return {
      action: "refuse",
      reason: `CRM answer is missing ${diff.extraInMirror} of the mirror's ${diff.mirrorRows} rows (>50%) — treating this as a truncated fetch, not a mass deletion.`,
    };
  }
  if (diff.extraInMirror > PARITY_MAX_DELETE_ROWS) {
    return {
      action: "refuse",
      reason: `CRM answer is missing ${diff.extraInMirror} of the mirror's ${diff.mirrorRows} rows, over the ${PARITY_MAX_DELETE_ROWS}-row ceiling for one window — leaving the window unequal for a human to read rather than deleting that many settled rows unattended.`,
    };
  }
  if (diff.mirrorRows > 0 && diff.extraInMirror / diff.mirrorRows > PARITY_MAX_DELETE_SHARE) {
    const share = ((diff.extraInMirror / diff.mirrorRows) * 100).toFixed(1);
    return {
      action: "refuse",
      reason: `CRM answer is missing ${diff.extraInMirror} of the mirror's ${diff.mirrorRows} rows (${share}%, over the ${PARITY_MAX_DELETE_SHARE * 100}% ceiling) — leaving the window unequal for a human to read rather than deleting that share of a window unattended.`,
    };
  }
  return { action: "repair", reason: null };
}

export type ParitySweepResult = {
  window: ParityWindow | null;
  diff: ParityDiff | null;
  action: ParityAction | "skipped";
  reason: string | null;
  /** Rows the repair actually wrote / removed, when one ran. */
  repairedUpserted: number;
  repairedDeleted: number;
  /** Windows whose last verification is older than PARITY_STALE_AFTER_DAYS — the sweep reporting on
   * its own health, so a sweep that silently stops running is visible. */
  staleWindows: number;
  totalWindows: number;
};

type ParityRow = {
  checked_at: string;
  window_from: string;
};

async function loadCheckedAt(): Promise<Map<string, string> | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(CRM_PARITY_WINDOWS_TABLE)
    .select("window_from, checked_at");
  if (error) {
    if (isCrmSchemaMissingError(error)) return null;
    throw new Error(error.message);
  }
  const map = new Map<string, string>();
  for (const row of (data ?? []) as ParityRow[]) map.set(row.window_from, row.checked_at);
  return map;
}

/**
 * When the sweep last verified ANY window, in epoch ms — the restart marker.
 *
 * The poller's schedule lives in module memory, which is wiped on every deploy, and this repo
 * deploys on every merge to `main` (~30 commits a day). Without this the sweep would read as
 * never-run on each restart and fire immediately, so a busy afternoon of merges would run it many
 * times over — repeatedly re-fetching 30-day windows from a vendor API that is the slowest and
 * least robust dependency in the pipeline, and defeating the once-a-day cadence outright.
 *
 * The parity table IS its own marker, so no separate bookkeeping is needed: `checked_at` is written
 * on every verification, and the newest one across all windows is by definition the last time the
 * sweep did anything. Returns null when it has genuinely never run, or when the table is not there
 * yet — in both cases the first due tick simply runs it, which is correct and cheap.
 */
export async function latestParityCheckAtMs(): Promise<number | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(CRM_PARITY_WINDOWS_TABLE)
    .select("checked_at")
    .order("checked_at", { ascending: false })
    .limit(1);
  if (error) {
    if (isCrmSchemaMissingError(error)) return null;
    throw new Error(error.message);
  }
  const checkedAt = (data ?? [])[0]?.checked_at;
  if (!checkedAt) return null;
  const ms = new Date(checkedAt).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The floor of the sweep: the mirror's earliest visit date, or PARITY_HISTORY_FLOOR, whichever is
 * earlier.
 *
 * Read straight off the table rather than through `queryVisits`/`queryVisitsLimited`, because both
 * of those apply the resigned-agent exclusion — and `queryVisitsLimited` applies it unconditionally,
 * with no opt-out to pass. The oldest visit in the mirror is quite likely to belong to somebody who
 * has since left, so an excluded read would start the sweep AFTER the real beginning of history and
 * leave the earliest window permanently unverified — the exact blind spot this file exists to close.
 */
async function loadEarliestVisitDate(): Promise<string> {
  const { data, error } = await getSupabaseAdmin()
    .from(CRM_VISITS_TABLE)
    .select("visit_date")
    .order("visit_date", { ascending: true })
    .limit(1);
  if (error) {
    if (isCrmSchemaMissingError(error)) return PARITY_HISTORY_FLOOR;
    throw new Error(error.message);
  }
  const earliest = (data ?? [])[0]?.visit_date?.slice(0, 10);
  return earliest && earliest < PARITY_HISTORY_FLOOR ? earliest : PARITY_HISTORY_FLOOR;
}

/**
 * The window's visit ids as the MIRROR holds them — read straight off `ireports360_visits`.
 *
 * NOT through `queryVisits`, and that distinction is the whole correctness of this sweep.
 * `queryVisits` scans `crm_visits_unified`, which carries Phoenix-born visits alongside the
 * mirrored ones — visits logged in Phoenix CRM that iReports360 has never held and never will.
 * Comparing the vendor's answer against that view counts every Phoenix visit as a row the vendor
 * "lost", which is the one shape {@link decideParityAction} is built to refuse. Measured on
 * production: the first Phoenix visit landed 2026-10-03, the current window was refused on 14 Oct
 * at 2,013 extra rows and again on 23 Oct at 4,779 of 12,116, growing by roughly 300 a day — so
 * the newest window could never again be verified, and the 8 genuinely late-saved rows it should
 * have pulled in on 23 Oct were not pulled in. The mirror this sweep is about is the iReports360
 * mirror table, and nothing else belongs in the comparison.
 *
 * Reading the table also drops the resigned-agent question entirely. `queryVisits` needed
 * `includeResignedAgents: true` here, because its default exclusion hides every visit whose
 * resolved agent has left and would have reported a mismatch of exactly that size on every window.
 * The raw mirror applies no exclusion at all, so there is nothing left to opt out of.
 *
 * Keyset by `crm_visit_id`, matching the sync's own reconcile scan: a page is capped, and
 * `.range()` with no ORDER BY gives no stable row order, so pages repeat ids and skip others — and
 * a skipped id here reads as a row the vendor deleted.
 */
async function loadMirrorVisitIds(window: ParityWindow): Promise<number[] | null> {
  const supabase = getSupabaseAdmin();
  const pageSize = 5000;
  const ids: number[] = [];
  let cursor: number | null = null;
  for (;;) {
    let query = supabase
      .from(CRM_VISITS_TABLE)
      .select("crm_visit_id")
      .gte("visit_date", window.from)
      .lte("visit_date", window.to)
      .order("crm_visit_id", { ascending: true })
      .limit(pageSize);
    if (cursor !== null) query = query.gt("crm_visit_id", cursor);
    const { data, error } = await query;
    if (error) {
      if (isCrmSchemaMissingError(error)) return null;
      throw new Error(error.message);
    }
    const page = (data ?? []) as Array<{ crm_visit_id: number }>;
    if (page.length === 0) break;
    for (const row of page) {
      const id = Number(row.crm_visit_id);
      if (Number.isFinite(id)) ids.push(id);
    }
    if (page.length < pageSize) break;
    const last = Number(page[page.length - 1]?.crm_visit_id);
    if (!Number.isFinite(last)) break; // no usable cursor — stop rather than loop forever
    cursor = last;
  }
  return ids;
}

/**
 * Verify one window of history against the CRM and repair it if it differs.
 *
 * Never throws for a parity difference — a difference is the normal finding this exists to report.
 * It does throw when it cannot do its job at all (vendor login down, mirror unreadable), so the
 * caller's dead-man's switch sees a real failure rather than a silent success.
 */
export async function runIReports360ParitySweep(now: Date = new Date()): Promise<ParitySweepResult> {
  if (!isIReports360Configured()) {
    throw new Error("iReports360 is not configured (missing IREPORTS360_BASE_URL/USERNAME/PASSWORD).");
  }
  const todayIso = now.toISOString().slice(0, 10);
  const checkedAtByKey = await loadCheckedAt();
  if (checkedAtByKey === null) {
    // Migration not applied yet. Degrade to a no-op rather than failing the cron that calls us.
    return {
      window: null,
      diff: null,
      action: "skipped",
      reason: `${CRM_PARITY_WINDOWS_TABLE} is not present yet — apply the parity-window migration.`,
      repairedUpserted: 0,
      repairedDeleted: 0,
      staleWindows: 0,
      totalWindows: 0,
    };
  }

  const windows = resolveParityWindows(await loadEarliestVisitDate(), todayIso);
  const staleBefore = addDaysIso(todayIso, -PARITY_STALE_AFTER_DAYS);
  const staleWindows = windows.filter((window) => {
    const checkedAt = checkedAtByKey.get(parityWindowKey(window));
    return !checkedAt || checkedAt.slice(0, 10) < staleBefore;
  }).length;

  const window = selectStalestWindow(windows, checkedAtByKey);
  if (!window) {
    return {
      window: null,
      diff: null,
      action: "skipped",
      reason: "no history windows to verify",
      repairedUpserted: 0,
      repairedDeleted: 0,
      staleWindows,
      totalWindows: windows.length,
    };
  }

  const config = getIReports360Config();
  const token = await iReports360Login(config);
  // Taken BEFORE the fetch, and handed to the sync below as `prefetched.capturedAt`. It is what
  // keeps the sync's concurrent-insert guard measuring against OUR snapshot instead of an instant
  // minutes later: a row another sync wrote in between is newer than this and must not be read as
  // something the vendor deleted.
  const capturedAt = new Date().toISOString();
  const crmVisits = await iReports360GetVisits(config, token, window.from, window.to);
  const crmIds = crmVisits
    .map((visit) => Number(visit.id))
    .filter((id) => Number.isFinite(id));

  const mirrorIds = (await loadMirrorVisitIds(window)) ?? [];

  const diff = compareVisitIdSets(crmIds, mirrorIds);
  const { action, reason } = decideParityAction(diff);

  let repairedUpserted = 0;
  let repairedDeleted = 0;
  if (action === "repair") {
    // Hand the already-fetched visits to the sync so it does not re-query the vendor for the same
    // window, and so its deletion guard measures against the instant WE captured rather than a later
    // one. Check-ins are omitted deliberately and the sync fetches those itself — passing an empty
    // list would read as "the CRM has no check-ins for this window" and reconcile them all away.
    //
    // This comment described the intent from the day the file was written, but the call below did
    // not pass `prefetched` at all, so the vendor was fetched TWICE and the rows actually deleted
    // came from the second fetch — not from the `extraIds` this sweep measured, logged and (now)
    // archives. The two agreeing was luck, not a guarantee.
    const result = await syncIReports360Visits({
      dateFrom: window.from,
      dateTo: window.to,
      trigger: "cron",
      prefetched: { capturedAt, visits: crmVisits },
    });
    repairedUpserted = result.rowsUpserted;
    repairedDeleted = result.rowsDeleted;
  }

  if (action === "refuse") {
    logError("CRM parity sweep refused to repair a window — the vendor answer looks wrong, not the mirror", {
      labels: {
        event: "crm_parity_sweep_refused",
        windowFrom: window.from,
        windowTo: window.to,
      },
      error: new Error(reason ?? "refused"),
    });
  }

  await getSupabaseAdmin()
    .from(CRM_PARITY_WINDOWS_TABLE)
    .upsert(
      {
        window_from: window.from,
        window_to: window.to,
        checked_at: new Date().toISOString(),
        crm_rows: diff.crmRows,
        mirror_rows: diff.mirrorRows,
        missing_in_mirror: diff.missingInMirror,
        extra_in_mirror: diff.extraInMirror,
        status: action,
        last_error: reason,
      },
      { onConflict: "window_from" },
    );

  return {
    window,
    diff,
    action,
    reason,
    repairedUpserted,
    repairedDeleted,
    staleWindows,
    totalWindows: windows.length,
  };
}
