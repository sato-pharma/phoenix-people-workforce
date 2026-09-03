/**
 * Continuous live poller for the iReports360 CRM — the "rep submits → visible in Phoenix" path.
 *
 * Runs INSIDE the production app process (started once from instrumentation.ts, Railway-only via
 * hard guards below) rather than as an external cron: no scheduler dependency, no CRON_SECRET
 * round-trip, and a deploy restart simply restarts it. Each tick does ONE cheap vendor fetch of a
 * narrow window and compares it against the previous tick's in-memory snapshot; only when
 * something actually changed does it invoke the full sync engine — handing over the very payload
 * it just fetched (see PrefetchedCrmWindow) with the changed ids as the upsert delta. A quiet
 * minute therefore costs zero database writes and exactly one vendor fetch pair, while a new
 * visit lands in the mirror — and so on every Phoenix surface that reads it — within one tick.
 *
 * The rolling 10-day sync and the weekly wide reconcile — the correctness backstop for
 * edits/deletions older than this poller's 2-day horizon — ALSO run from this loop now (see
 * resolveDueScheduledWork below): the external scheduler (cron-job.org, a free third-party
 * account outside the repo, capped at 30s per request and able to silently auto-disable a job)
 * is no longer load-bearing for CRM freshness or correctness. Its jobs remain harmless,
 * idempotent backstops; the engine's capturedAt/synced_at guard already makes overlapping runs
 * safe.
 *
 * Since 2026-08-27 the rep DOCTOR LISTS ride here too, hourly. Everything above concerns what a rep
 * DID; the list is what he was ASSIGNED, and it had no schedule of any kind — the sole trigger was
 * an admin pressing Refresh, so production's mirror was found 6.4 days stale, and a doctor removed
 * from a list in the CRM was never removed here at all. It runs through runScheduledPlanSync, which
 * cannot throw and raises none of the visits pipeline's alarms: that pipeline feeds payroll
 * attendance and keeping it un-entangled is the point of the separation.
 *
 * Deliberately NO success notifications (the 15-min morning live-sync set that precedent — at
 * this cadence they would be pure noise); failures notify Super Admins once per sustained outage
 * (see FAILURE_NOTIFY_AT_STREAK) and every tick pings the phoenix-ireports360-live-poll
 * dead-man's switch, so a poller that stops ticking is caught by the ABSENCE of pings.
 */

import {
  IReports360ApiError,
  iReports360GetCheckins,
  iReports360GetVisits,
  iReports360Login,
  type IReports360Checkin,
  type IReports360Visit,
} from "@/lib/crm/client";
import { getIReports360Config, isIReports360Configured, type IReports360Config } from "@/lib/crm/config";
import { addDaysIso, cairoDayOfWeek, cairoHourMinute, cairoTodayIso } from "@/lib/crm/dates";
import {
  resolveWideReconciliationSlice,
  runScheduledIReports360Sync,
  runWideIReports360Reconciliation,
  reapStaleIReports360SyncRuns,
  syncIReports360Visits,
} from "@/lib/crm/sync";
import { announceNewPlansToManagers } from "@/lib/crm/plan-notifications";
import {
  latestPlanSyncAtMs,
  resolvePlanSyncWindow,
  syncIReports360WeeklyPlans,
  type NewlySeenPlan,
} from "@/lib/crm/plan-sync";
import { PARITY_STALE_AFTER_DAYS, latestParityCheckAtMs, runIReports360ParitySweep } from "@/lib/crm/parity";
import { CRM_SYNC_RUNS_TABLE } from "@/lib/crm/tables";
import { notifyIReports360SyncResult } from "@/lib/notifications/ireports360-sync-digest";
import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { pingDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { runDueEarlyBirdsClose } from "@/lib/early-birds/close";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ── Cadence (Africa/Cairo wall-clock) ────────────────────────────────────────────────────────────
// The owner's requirement (2026-08-04) is that a CRM submission is visible in Phoenix essentially
// as it happens, ALL day — not just in the morning compliance window. 08:00–12:30 (CRM First
// Visit / Early Birds) polls fastest; the rest of the day runs nearly as fast because the sync-run
// history shows reps submit heavily through the evening; overnight (00:00–06:00) drops to a
// keep-fresh tick (real 00:00–03:00 saveDate activity exists, it just doesn't need 20s latency).
// Exported for the unit tests, which pin the VALUES too — these numbers are the latency promise.
export const FAST_TICK_SECONDS = 20;
export const DAY_TICK_SECONDS = 30;
export const NIGHT_TICK_SECONDS = 120;
// Most day ticks probe TODAY only (small payload, kind to the vendor's shared hosting). Every
// Nth tick widens to yesterday+today so a back-dated save still appears within ~3 minutes.
// Night ticks always probe the 2-day window: after the midnight flip "yesterday" is where the
// evening's visits live.
export const WIDE_PROBE_EVERY_N_TICKS = 6;

// A sustained-failure notification fires once when the streak reaches this count (≈5+ minutes of
// consecutive vendor/db errors), then once every NOTIFY_AGAIN_EVERY failures while it persists —
// the scheduled crons' own failure alerts and the dead-man's switch cover the rest.
export const FAILURE_NOTIFY_AT_STREAK = 5;
export const FAILURE_NOTIFY_AGAIN_EVERY = 60;
// While broken, don't hammer the vendor faster than this.
const FAILURE_BACKOFF_SECONDS = 300;

const DEAD_MANS_SWITCH_SLUG = "phoenix-ireports360-live-poll";
const STARTUP_DELAY_MS = 15_000;
const TICK_JITTER_MS = 5_000;
// The vendor JWT is valid ~30 days; refresh well before that.
const TOKEN_REFRESH_MS = 20 * 24 * 60 * 60 * 1000;
// Log a heartbeat line every N quiet ticks so Railway logs show life without flooding.
const QUIET_HEARTBEAT_EVERY = 30;

// ── Pure planning/diff core (unit-tested) ────────────────────────────────────────────────────────

export type PollPlan = { includeYesterday: boolean; intervalSeconds: number };

/** Which cadence tier applies at `minutesSinceMidnight` (Cairo), and whether this tick should
 * probe the wide (yesterday+today) window. Pure so the tiers are testable without a clock. */
export function resolvePollPlan(minutesSinceMidnight: number, tickIndex: number): PollPlan {
  const night = minutesSinceMidnight < 6 * 60;
  if (night) return { includeYesterday: true, intervalSeconds: NIGHT_TICK_SECONDS };
  const inComplianceWindow = minutesSinceMidnight >= 8 * 60 && minutesSinceMidnight <= 12 * 60 + 30;
  return {
    includeYesterday: tickIndex % WIDE_PROBE_EVERY_N_TICKS === 0,
    intervalSeconds: inComplianceWindow ? FAST_TICK_SECONDS : DAY_TICK_SECONDS,
  };
}

/** JSON with recursively sorted object keys — a stable fingerprint for change detection, immune
 * to the vendor reordering fields between responses. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(",")}}`;
}

/** id → { day it belongs to, content fingerprint } for one record type. */
export type SnapshotMemo = Map<number, { day: string; hash: string }>;

export type CrmDelta = {
  changedCheckinIds: Set<number>;
  changedVisitIds: Set<number>;
  /** True when an id the memo saw inside this probe's window is absent from this probe — the CRM
   * deleted/voided it. The engine's reconciliation (with its 50% truncation guard and concurrent-
   * sync protection) makes the actual delete decision; this only says "worth running the engine". */
  deletionSuspected: boolean;
  nextCheckinMemo: SnapshotMemo;
  nextVisitMemo: SnapshotMemo;
};

function buildMemo(
  records: Array<{ day: string; hash: string; id: number }>,
  previous: SnapshotMemo,
  windowFrom: string,
  windowTo: string,
  retentionFrom: string,
): SnapshotMemo {
  const next: SnapshotMemo = new Map();
  // Carry over what we know about days OUTSIDE the probed window (still within retention) —
  // a today-only probe must not forget what it knew about yesterday.
  for (const [id, entry] of previous) {
    if (entry.day >= retentionFrom && (entry.day < windowFrom || entry.day > windowTo)) next.set(id, entry);
  }
  for (const record of records) next.set(record.id, { day: record.day, hash: record.hash });
  return next;
}

/** Compares one probe fetch against the previous snapshot. Pure — the heart of the poller. */
export function computeCrmDelta(input: {
  checkinMemo: SnapshotMemo;
  fetchedCheckins: IReports360Checkin[];
  fetchedVisits: IReports360Visit[];
  visitMemo: SnapshotMemo;
  windowFrom: string;
  windowTo: string;
}): CrmDelta {
  const visitRecords = input.fetchedVisits.map((visit) => ({
    day: (visit.visitDate ?? "").slice(0, 10),
    hash: stableStringify(visit),
    id: visit.id,
  }));
  const checkinRecords = input.fetchedCheckins.map((checkin) => ({
    day: (checkin.checkDate ?? "").slice(0, 10),
    hash: stableStringify(checkin),
    id: checkin.id,
  }));

  const changedVisitIds = new Set<number>();
  for (const record of visitRecords) {
    if (input.visitMemo.get(record.id)?.hash !== record.hash) changedVisitIds.add(record.id);
  }
  const changedCheckinIds = new Set<number>();
  for (const record of checkinRecords) {
    if (input.checkinMemo.get(record.id)?.hash !== record.hash) changedCheckinIds.add(record.id);
  }

  const fetchedVisitIds = new Set(visitRecords.map((record) => record.id));
  const fetchedCheckinIds = new Set(checkinRecords.map((record) => record.id));
  let deletionSuspected = false;
  for (const [id, entry] of input.visitMemo) {
    if (entry.day >= input.windowFrom && entry.day <= input.windowTo && !fetchedVisitIds.has(id)) {
      deletionSuspected = true;
      break;
    }
  }
  if (!deletionSuspected) {
    for (const [id, entry] of input.checkinMemo) {
      if (entry.day >= input.windowFrom && entry.day <= input.windowTo && !fetchedCheckinIds.has(id)) {
        deletionSuspected = true;
        break;
      }
    }
  }

  // Retention = the poller's 2-day horizon; anything older is the scheduled crons' territory.
  const retentionFrom = addDaysIso(input.windowTo, -1);
  return {
    changedCheckinIds,
    changedVisitIds,
    deletionSuspected,
    nextCheckinMemo: buildMemo(checkinRecords, input.checkinMemo, input.windowFrom, input.windowTo, retentionFrom),
    nextVisitMemo: buildMemo(visitRecords, input.visitMemo, input.windowFrom, input.windowTo, retentionFrom),
  };
}

// ── In-process scheduled work (rolling sync + weekly reconcile) ──────────────────────────────────
// These used to live only on external schedulers (GCP Cloud Scheduler, then cron-job.org). The
// external account is a single point of failure nobody can see from this repo — its 30s request
// cap already logs the 25s rolling sync as "Failed (timeout)" and it can auto-disable a job
// silently. Running them from this loop makes the CRM pipeline self-sufficient; the engine's
// idempotent upsert + capturedAt deletion guard keep any still-configured external firings safe.

/** Rolling 10-day sync: every 3h through the Cairo working day (the poller's own 2-day probe
 * makes an overnight deep pull pointless). */
export const ROLLING_SYNC_MIN_GAP_MS = 3 * 60 * 60 * 1000;
export const ROLLING_SYNC_EARLIEST_CAIRO_MINUTES = 6 * 60;
/** Weekly wide reconcile: Sundays from 04:00 Cairo (matches the historical cron slot). The gap
 * guard (5.5 days) is what makes "Sunday after 04:00" fire exactly once per week. */
export const RECONCILE_CAIRO_DAY_OF_WEEK = 0;
export const RECONCILE_EARLIEST_CAIRO_MINUTES = 4 * 60;
export const RECONCILE_MIN_GAP_MS = 5.5 * 24 * 60 * 60 * 1000;
/** After a scheduled run FAILS, don't retry it on the very next 20s tick — the vendor is likely
 * unwell; these gaps bound the retry pressure while still recovering unattended. */
export const ROLLING_SYNC_FAILURE_RETRY_GAP_MS = 15 * 60 * 1000;
export const RECONCILE_FAILURE_RETRY_GAP_MS = 60 * 60 * 1000;

/** Doctor-list sync: hourly through the Cairo working day. The plan is the rep's ASSIGNED doctor
 * list, and until 2026-08-27 nothing pulled it on a schedule at all — the only trigger was an
 * admin's Refresh button, and production's mirror was measured 6.4 days stale. Hourly rather than
 * per-tick because an assignment list moves in edits per week, not events per minute, and one pull
 * is a whole month of rows; hourly rather than daily because "he added a doctor this morning and
 * Phoenix still doesn't know" is the complaint this exists to end. Overnight is skipped for the
 * same reason the rolling sync skips it — nobody edits a list at 03:00. */
export const PLAN_SYNC_MIN_GAP_MS = 60 * 60 * 1000;
export const PLAN_SYNC_EARLIEST_CAIRO_MINUTES = 6 * 60;
export const PLAN_SYNC_FAILURE_RETRY_GAP_MS = 30 * 60 * 1000;

/** Full-history parity sweep: one 30-day window of history re-proved against the CRM per day.
 *
 * DAILY, not weekly, and that is the whole point. The wide reconcile covers 120 days as four slices
 * on a 4-week rotation, so nothing older than 120 days has ever been re-examined at all — 42% of the
 * mirror on 2026-08-28. This walks EVERY window instead, stalest first, so ~8 windows of history are
 * fully re-proved every ~8 days rather than never. One window a day keeps the per-run cost identical
 * to a reconcile slice however far back history goes.
 *
 * 02:00 Cairo: outside the working day entirely. It is the only scheduled job that touches settled
 * history, so it should never compete with a rep saving a visit, and it must not sit in the same
 * slot as the Sunday 04:00 reconcile. */
export const PARITY_SWEEP_MIN_GAP_MS = 20 * 60 * 60 * 1000;
export const PARITY_SWEEP_EARLIEST_CAIRO_MINUTES = 2 * 60;
export const PARITY_SWEEP_FAILURE_RETRY_GAP_MS = 2 * 60 * 60 * 1000;

export type ScheduledCrmWork = "rolling-sync" | "wide-reconcile" | "plan-sync" | "parity-sweep" | null;

/** Which (if any) scheduled deep run is due at this tick — pure, so week/day/hour edges are
 * testable without a clock. Reconcile outranks rolling: it is rarer and includes a 30-day slice
 * the rolling window can't reach. Both outrank the plan sync, which is the cheapest of the three
 * and the only one that costs nothing by waiting a tick — it is the doctor LIST, not the day's
 * work, and the other two feed payroll attendance. At most ONE deep run per tick; the probe
 * resumes next tick. */
export function resolveDueScheduledWork(input: {
  cairoDayOfWeek: number;
  minutesSinceMidnight: number;
  nowMs: number;
  lastParitySweepFailureMs: number | null;
  lastParitySweepSuccessMs: number | null;
  lastPlanSyncFailureMs: number | null;
  lastPlanSyncSuccessMs: number | null;
  lastReconcileFailureMs: number | null;
  lastReconcileSuccessMs: number | null;
  lastRollingFailureMs: number | null;
  lastRollingSuccessMs: number | null;
}): ScheduledCrmWork {
  const reconcileDue =
    input.cairoDayOfWeek === RECONCILE_CAIRO_DAY_OF_WEEK &&
    input.minutesSinceMidnight >= RECONCILE_EARLIEST_CAIRO_MINUTES &&
    (input.lastReconcileSuccessMs === null || input.nowMs - input.lastReconcileSuccessMs >= RECONCILE_MIN_GAP_MS) &&
    (input.lastReconcileFailureMs === null || input.nowMs - input.lastReconcileFailureMs >= RECONCILE_FAILURE_RETRY_GAP_MS);
  if (reconcileDue) return "wide-reconcile";

  const rollingDue =
    input.minutesSinceMidnight >= ROLLING_SYNC_EARLIEST_CAIRO_MINUTES &&
    (input.lastRollingSuccessMs === null || input.nowMs - input.lastRollingSuccessMs >= ROLLING_SYNC_MIN_GAP_MS) &&
    (input.lastRollingFailureMs === null || input.nowMs - input.lastRollingFailureMs >= ROLLING_SYNC_FAILURE_RETRY_GAP_MS);
  if (rollingDue) return "rolling-sync";

  const planSyncDue =
    input.minutesSinceMidnight >= PLAN_SYNC_EARLIEST_CAIRO_MINUTES &&
    (input.lastPlanSyncSuccessMs === null || input.nowMs - input.lastPlanSyncSuccessMs >= PLAN_SYNC_MIN_GAP_MS) &&
    (input.lastPlanSyncFailureMs === null || input.nowMs - input.lastPlanSyncFailureMs >= PLAN_SYNC_FAILURE_RETRY_GAP_MS);
  if (planSyncDue) return "plan-sync";

  // Lowest priority of the four, deliberately. It re-proves SETTLED history, so it is the only one
  // that costs nothing at all by waiting a tick — the other three feed today's attendance, today's
  // doctor list, and payroll. Its 02:00 window is also outside the hours the others contend for.
  const paritySweepDue =
    input.minutesSinceMidnight >= PARITY_SWEEP_EARLIEST_CAIRO_MINUTES &&
    (input.lastParitySweepSuccessMs === null ||
      input.nowMs - input.lastParitySweepSuccessMs >= PARITY_SWEEP_MIN_GAP_MS) &&
    (input.lastParitySweepFailureMs === null ||
      input.nowMs - input.lastParitySweepFailureMs >= PARITY_SWEEP_FAILURE_RETRY_GAP_MS);
  return paritySweepDue ? "parity-sweep" : null;
}

// ── Poller runtime (module-singleton) ────────────────────────────────────────────────────────────

type PollerState = {
  consecutiveFailures: number;
  lastParitySweepFailureMs: number | null;
  lastParitySweepSuccessMs: number | null;
  lastPlanSyncFailureMs: number | null;
  lastPlanSyncSuccessMs: number | null;
  lastReconcileFailureMs: number | null;
  lastReconcileSuccessMs: number | null;
  lastRollingFailureMs: number | null;
  lastRollingSuccessMs: number | null;
  running: boolean;
  stopped: boolean;
  tickIndex: number;
  timer: ReturnType<typeof setTimeout> | null;
};

const state: PollerState = {
  consecutiveFailures: 0,
  lastParitySweepFailureMs: null,
  lastParitySweepSuccessMs: null,
  lastPlanSyncFailureMs: null,
  lastPlanSyncSuccessMs: null,
  lastReconcileFailureMs: null,
  lastReconcileSuccessMs: null,
  lastRollingFailureMs: null,
  lastRollingSuccessMs: null,
  running: false,
  stopped: false,
  tickIndex: 0,
  timer: null,
};
let visitMemo: SnapshotMemo = new Map();
let checkinMemo: SnapshotMemo = new Map();
let cachedToken: { fetchedAtMs: number; token: string } | null = null;

async function getVendorToken(config: IReports360Config): Promise<string> {
  if (cachedToken && Date.now() - cachedToken.fetchedAtMs < TOKEN_REFRESH_MS) return cachedToken.token;
  const token = await iReports360Login(config);
  cachedToken = { fetchedAtMs: Date.now(), token };
  return token;
}

async function probeWindow(
  config: IReports360Config,
  dateFrom: string,
  dateTo: string,
): Promise<{ checkins: IReports360Checkin[]; visits: IReports360Visit[] }> {
  const fetchPair = async () => {
    const token = await getVendorToken(config);
    const [visits, checkins] = await Promise.all([
      iReports360GetVisits(config, token, dateFrom, dateTo),
      iReports360GetCheckins(config, token, dateFrom, dateTo),
    ]);
    return { checkins, visits };
  };
  try {
    return await fetchPair();
  } catch (error) {
    // One silent retry after re-login on an auth rejection — the cached 30-day JWT may have been
    // invalidated server-side (vendor restart, credential rotation).
    if (error instanceof IReports360ApiError && error.status === 401) {
      cachedToken = null;
      return await fetchPair();
    }
    throw error;
  }
}

/**
 * Seeds the scheduled-work markers from the most recent successful deep runs in
 * ireports360_visits_sync_runs, so a deploy restart (which happens on every merge to main)
 * doesn't immediately re-run a 10-day sync it just ran. Window WIDTH tells the runs apart —
 * rolling pulls span ~10 days, reconcile slices span ~30 — because both record trigger "cron"
 * (the trigger column's CHECK constraint predates in-process scheduling). Best-effort: on any
 * failure the markers stay null and the first due tick simply runs the work — idempotent, ~15s.
 */
async function seedScheduledWorkMarkers(): Promise<void> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from(CRM_SYNC_RUNS_TABLE)
      .select("date_from, date_to, started_at, status")
      .eq("status", "success")
      .order("started_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Array<{ date_from: string; date_to: string; started_at: string; status: string }>) {
      const spanDays = Math.round(
        (new Date(`${row.date_to}T00:00:00Z`).getTime() - new Date(`${row.date_from}T00:00:00Z`).getTime()) / 86_400_000,
      );
      const startedMs = new Date(row.started_at).getTime();
      if (!Number.isFinite(startedMs)) continue;
      if (spanDays >= 25 && state.lastReconcileSuccessMs === null) state.lastReconcileSuccessMs = startedMs;
      else if (spanDays >= 9 && spanDays < 25 && state.lastRollingSuccessMs === null) state.lastRollingSuccessMs = startedMs;
      if (state.lastReconcileSuccessMs !== null && state.lastRollingSuccessMs !== null) break;
    }
  } catch (error) {
    logError("CRM live poller could not seed scheduled-work markers; deep runs will fire on the first due tick", {
      error,
      labels: { event: "crm_live_poll_seed_markers_failed", job: "crm-live-poll" },
    });
  }

  // The plan sync keeps no run table, so its own mirror rows are the marker: the newest synced_at
  // inside this month IS the last time the month's lists were refreshed. Seeded separately so a
  // failure in the block above cannot cost this one its marker, and vice versa.
  try {
    state.lastPlanSyncSuccessMs = await latestPlanSyncAtMs(resolvePlanSyncWindow(cairoTodayIso()));
  } catch (error) {
    logError("CRM live poller could not seed the plan-sync marker; the doctor lists will refresh on the first due tick", {
      error,
      labels: { event: "crm_live_poll_seed_plan_marker_failed", job: "ireports360-plan-sync" },
    });
  }

  // The parity sweep's own table is its marker — the newest checked_at across every window IS the
  // last time it ran. Seeded in its own try so it cannot cost either block above its marker, and
  // vice versa. Without this the sweep would fire on every deploy restart (~30 merges a day here),
  // re-fetching 30-day windows from the vendor many times over instead of once daily.
  try {
    state.lastParitySweepSuccessMs = await latestParityCheckAtMs();
  } catch (error) {
    logError("CRM live poller could not seed the parity-sweep marker; the sweep will verify one window on the first due tick", {
      error,
      labels: { event: "crm_live_poll_seed_parity_marker_failed", job: "ireports360-parity-sweep" },
    });
  }
}

/**
 * Pulls the current Cairo month's doctor lists and removes the ones the CRM no longer holds.
 *
 * Firewalled deliberately, and this is the whole reason it is a separate function rather than a
 * third branch of runScheduledWork: it never throws, never pings the visits sync's dead-man's
 * switch, and never sends a digest. The visits pipeline feeds payroll attendance; a doctor-list
 * refresh must not be able to raise its alarms or cost it a tick. A failure here is logged and the
 * failure gap holds it off for half an hour — the list is simply as stale as it was before.
 */
/**
 * Tells each rep's manager about the plans this run saw for the first time.
 *
 * Firewalled from the sync twice over. `announceNewPlansToManagers` is best-effort by construction
 * and returns its skips rather than throwing, but it still reads the roster and writes
 * notifications — so a throw is caught here rather than in the caller's `catch`, where it would set
 * `lastPlanSyncFailureMs` and report a FAILED sync for a mirror that was written perfectly. An
 * unsent email is an inconvenience; a plan sync that reads as broken sends someone looking for a
 * data problem that does not exist.
 *
 * Silence is never the outcome: an announcement, a withheld run and a per-plan skip each leave a
 * line. The 13-day outbox strand is the standing lesson here — a job that "runs fine" and does
 * nothing looks identical to a quiet week unless it says which one it was.
 */
async function announceNewPlans(newPlans: NewlySeenPlan[]): Promise<void> {
  if (newPlans.length === 0) return;
  try {
    const announcement = await announceNewPlansToManagers(newPlans);
    console.log(
      `[crm:live-poll] plan-sync saw ${newPlans.length} new plan(s) — announced ${announcement.announced}` +
        (announcement.skipped.length > 0 ? `, skipped ${announcement.skipped.length}` : "") +
        (announcement.withheldReason ? ` — WITHHELD: ${announcement.withheldReason}` : ""),
    );
    // A withheld run means managers were told about NOTHING while plans really did arrive, so it is
    // the one outcome that has to be findable later without reading stdout.
    if (announcement.withheldReason) {
      logError(`CRM plan sync did not announce ${newPlans.length} new plan(s): ${announcement.withheldReason}`, {
        labels: { event: "crm_plan_announce_withheld", job: "ireports360-plan-sync" },
      });
    }
    for (const skip of announcement.skipped) {
      console.log(`[crm:live-poll] plan ${skip.crmPlanId} not announced — ${skip.reason}`);
    }
  } catch (error) {
    logError("CRM plan sync could not announce new plans; the mirror is fine and managers were not told", {
      error,
      labels: { event: "crm_plan_announce_failed", job: "ireports360-plan-sync" },
    });
  }
}

async function runScheduledPlanSync(): Promise<void> {
  const window = resolvePlanSyncWindow(cairoTodayIso());
  try {
    const result = await syncIReports360WeeklyPlans(window);
    state.lastPlanSyncSuccessMs = Date.now();
    console.log(
      `[crm:live-poll] in-process plan-sync ${result.startDate}..${result.endDate} — ${result.vendorRows} entries from the CRM, ` +
        `upserted ${result.upserted} across ${result.agents} reps / ${result.contacts} doctors, pruned ${result.pruned}` +
        (result.skippedUndated > 0 ? `, skipped ${result.skippedUndated} undated` : "") +
        (result.pruneRefusedReason ? ` — PRUNE REFUSED: ${result.pruneRefusedReason}` : ""),
    );
    // A refused prune is not a failure — the additions applied — but it means the mirror is
    // knowingly holding doctors the CRM no longer lists, so it must not pass in silence.
    if (result.pruneRefusedReason) {
      logError(`CRM plan sync withheld a prune of ${result.startDate}..${result.endDate}: ${result.pruneRefusedReason}`, {
        labels: { event: "crm_plan_sync_prune_refused", job: "ireports360-plan-sync" },
      });
    }
    await announceNewPlans(result.newPlans);
  } catch (error) {
    state.lastPlanSyncFailureMs = Date.now();
    logError("CRM in-process plan-sync failed; the rep doctor lists are as stale as they were", {
      error,
      labels: { event: "crm_plan_sync_failed", job: "ireports360-plan-sync" },
    });
  }
}

/**
 * Re-proves the stalest 30-day window of history against the CRM, and repairs it if it differs.
 *
 * Firewalled exactly like runScheduledPlanSync, and for the same reason: it never throws, never
 * pings the visits sync's dead-man's switch, and never sends the visits digest. This is the job that
 * touches SETTLED history, so it must not be able to raise the alarms that mean "today's attendance
 * data is broken" — a reader who sees the visits pipeline paging cannot be left guessing whether the
 * problem is today's payroll input or a re-check of March.
 *
 * A parity DIFFERENCE is a normal finding and is reported by the log line, not by throwing. Only an
 * inability to do the job at all (vendor login down, mirror unreadable) reaches the catch, and even
 * then the failure gap simply holds the sweep off for two hours: history stays exactly as verified
 * as it already was, which is the one thing this job can safely defer.
 */
async function runScheduledParitySweep(): Promise<void> {
  try {
    const result = await runIReports360ParitySweep();
    state.lastParitySweepSuccessMs = Date.now();
    if (!result.window) {
      console.log(`[crm:live-poll] in-process parity-sweep — nothing to verify (${result.reason ?? "no windows"})`);
      return;
    }
    const diff = result.diff;
    console.log(
      `[crm:live-poll] in-process parity-sweep ${result.window.from}..${result.window.to} — ` +
        `crm ${diff?.crmRows ?? 0} vs mirror ${diff?.mirrorRows ?? 0}, ` +
        `missing ${diff?.missingInMirror ?? 0}, extra ${diff?.extraInMirror ?? 0} -> ${result.action}` +
        (result.action === "repair" ? ` (upserted ${result.repairedUpserted}, deleted ${result.repairedDeleted})` : "") +
        ` [${result.staleWindows}/${result.totalWindows} windows stale]`,
    );
    // A window that needed repairing is the signal this whole sweep exists to produce: the two
    // systems HAD disagreed, silently, and nothing else would ever have said so.
    if (result.action === "repair") {
      logError(
        `CRM parity sweep repaired ${result.window.from}..${result.window.to}: the mirror was missing ` +
          `${diff?.missingInMirror ?? 0} visit(s) the CRM holds and held ${diff?.extraInMirror ?? 0} the CRM does not`,
        {
          labels: {
            event: "crm_parity_sweep_repaired",
            windowFrom: result.window.from,
            windowTo: result.window.to,
          },
        },
      );
    }
    // The sweep reporting on its own health. With ~8 windows and one run a day the rotation
    // completes in ~8 days, so anything still unverified after 21 means the sweep stopped running
    // rather than that it is mid-cycle — and a parity guarantee nobody notices has stopped is worth
    // nothing at all.
    if (result.staleWindows > 0) {
      logError(
        `CRM parity sweep has ${result.staleWindows} of ${result.totalWindows} history window(s) unverified for ` +
          `more than ${PARITY_STALE_AFTER_DAYS} days — the sweep is not completing its rotation`,
        { labels: { event: "crm_parity_sweep_stale", job: "ireports360-parity-sweep" } },
      );
    }
  } catch (error) {
    state.lastParitySweepFailureMs = Date.now();
    logError("CRM in-process parity-sweep failed; history is as verified as it already was", {
      error,
      labels: { event: "crm_parity_sweep_failed", job: "ireports360-parity-sweep" },
    });
  }
}

/** Runs one due deep job (rolling sync or wide reconcile) in place of this tick's probe, with the
 * same dead-man's-switch slugs and digest behavior the external cron routes use — so monitoring
 * continuity holds no matter which scheduler fired last. Reconcile always notifies (weekly
 * cadence); rolling notifies only when degraded or failed, because at ~6 runs/day an
 * unconditional success ping would be noise the owner never asked for. */
async function runScheduledWork(work: Exclude<ScheduledCrmWork, null>): Promise<void> {
  if (work === "plan-sync") {
    await runScheduledPlanSync();
    return;
  }
  if (work === "parity-sweep") {
    await runScheduledParitySweep();
    return;
  }
  const isReconcile = work === "wide-reconcile";
  const slug = isReconcile ? "phoenix-reconcile-visits" : "phoenix-ireports360-sync";
  const jobName = isReconcile ? "ireports360-visits-reconcile" : "ireports360-visits-sync";
  const today = cairoTodayIso();
  // Resolved BEFORE the run so the digest reports the exact window the run used, even if the
  // run itself straddles an ISO-week boundary.
  const scheduledAt = new Date();
  try {
    await reapStaleIReports360SyncRuns();
    const result = isReconcile ? await runWideIReports360Reconciliation(scheduledAt) : await runScheduledIReports360Sync();
    if (isReconcile) state.lastReconcileSuccessMs = Date.now();
    else state.lastRollingSuccessMs = Date.now();
    console.log(
      `[crm:live-poll] in-process ${work} — fetched ${result.rowsFetched}, upserted ${result.rowsUpserted}, ` +
        `deleted ${result.rowsDeleted}${result.rowsSkippedReconcile > 0 ? `, RECONCILE SKIPPED ${result.rowsSkippedReconcile}` : ""} (run ${result.runId})`,
    );
    await pingDeadMansSwitch(slug, "success");
    const degraded =
      result.rowsSkippedReconcile > 0 ||
      result.checkinsFailed ||
      result.rowsFetched === 0 ||
      result.blockedPostExitAttributions > 0 ||
      result.blockedPreHireAttributions > 0;
    if (isReconcile || degraded) {
      const window = isReconcile ? resolveWideReconciliationSlice(scheduledAt) : { dateFrom: addDaysIso(today, -10), dateTo: today };
      await notifyIReports360SyncResult({
        dateFrom: window.dateFrom,
        dateTo: window.dateTo,
        jobName,
        result,
        runId: result.runId,
        status: "success",
      }).catch(() => undefined);
    }
  } catch (error) {
    if (isReconcile) state.lastReconcileFailureMs = Date.now();
    else state.lastRollingFailureMs = Date.now();
    logError(`CRM in-process ${work} failed`, {
      error,
      labels: { event: "crm_live_poll_scheduled_work_failed", job: jobName },
    });
    await pingDeadMansSwitch(slug, "fail", describeThrown(error));
    await notifyIReports360SyncResult({
      dateFrom: today,
      dateTo: today,
      errorMessage: error instanceof Error ? error.message : String(error),
      jobName,
      status: "failed",
    }).catch(() => undefined);
  }
}

async function notifySustainedFailure(dateFrom: string, dateTo: string, error: unknown): Promise<void> {
  const streak = state.consecutiveFailures;
  const shouldNotify =
    streak === FAILURE_NOTIFY_AT_STREAK ||
    (streak > FAILURE_NOTIFY_AT_STREAK && (streak - FAILURE_NOTIFY_AT_STREAK) % FAILURE_NOTIFY_AGAIN_EVERY === 0);
  if (!shouldNotify) return;
  await notifyIReports360SyncResult({
    dateFrom,
    dateTo,
    errorMessage: `${state.consecutiveFailures} consecutive live-poll failures. Latest: ${
      error instanceof Error ? error.message : String(error)
    }`,
    jobName: "ireports360-live-poll",
    status: "failed",
  }).catch((notifyError: unknown) => {
    logError("Failed to send live-poll failure notification", { error: notifyError, labels: { job: "crm-live-poll" } });
  });
}

/** Timers must never hold the process open (deploy shutdowns, tests) — but in a DOM-typed
 * bundle setTimeout's return type is a number, so reach for unref only when it exists. */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}

async function tick(): Promise<void> {
  const today = cairoTodayIso();
  const { hour, minute } = cairoHourMinute();

  // A due deep run takes this tick's slot instead of the probe — one vendor-facing job at a time,
  // serialized through this single loop, so the app never runs two engine pulls concurrently.
  const dueWork = resolveDueScheduledWork({
    cairoDayOfWeek: cairoDayOfWeek(),
    lastParitySweepFailureMs: state.lastParitySweepFailureMs,
    lastParitySweepSuccessMs: state.lastParitySweepSuccessMs,
    lastPlanSyncFailureMs: state.lastPlanSyncFailureMs,
    lastPlanSyncSuccessMs: state.lastPlanSyncSuccessMs,
    lastReconcileFailureMs: state.lastReconcileFailureMs,
    lastReconcileSuccessMs: state.lastReconcileSuccessMs,
    lastRollingFailureMs: state.lastRollingFailureMs,
    lastRollingSuccessMs: state.lastRollingSuccessMs,
    minutesSinceMidnight: hour * 60 + minute,
    nowMs: Date.now(),
  });
  if (dueWork) {
    await runScheduledWork(dueWork);
    return;
  }

  // Early Birds closes its fortnights here rather than from a cron route: the external scheduler is
  // a third-party account with a 30s request cap, far too short for a company-wide close. This is
  // self-throttling (it asks the database at most every 15 minutes) and never throws, so a failure
  // cannot cost the CRM probe its tick.
  await runDueEarlyBirdsClose().catch((error: unknown) =>
    logError("Early Birds sweep threw into the poller tick", {
      labels: { event: "early_birds_sweep_threw" },
      error,
    }),
  );

  const plan = resolvePollPlan(hour * 60 + minute, state.tickIndex);
  const dateFrom = plan.includeYesterday ? addDaysIso(today, -1) : today;
  const dateTo = today;

  try {
    const capturedAt = new Date().toISOString();
    const config = getIReports360Config();
    const probe = await probeWindow(config, dateFrom, dateTo);
    const delta = computeCrmDelta({
      checkinMemo,
      fetchedCheckins: probe.checkins,
      fetchedVisits: probe.visits,
      visitMemo,
      windowFrom: dateFrom,
      windowTo: dateTo,
    });

    const hasWork = delta.changedVisitIds.size > 0 || delta.changedCheckinIds.size > 0 || delta.deletionSuspected;
    if (hasWork) {
      const result = await syncIReports360Visits({
        dateFrom,
        dateTo,
        onlyUpsertIds: { checkinIds: delta.changedCheckinIds, visitIds: delta.changedVisitIds },
        prefetched: { capturedAt, checkins: probe.checkins, visits: probe.visits },
        trigger: "cron",
      });
      console.log(
        `[crm:live-poll] ${dateFrom}..${dateTo} — upserted ${result.rowsUpserted} visits, ${result.checkinsUpserted} check-ins` +
          (result.rowsDeleted > 0 ? `, deleted ${result.rowsDeleted}` : "") +
          (result.rowsSkippedReconcile > 0 ? `, RECONCILE SKIPPED ${result.rowsSkippedReconcile}` : "") +
          ` (run ${result.runId})`,
      );
    } else if (state.tickIndex % QUIET_HEARTBEAT_EVERY === 0) {
      console.log(`[crm:live-poll] quiet — ${probe.visits.length} visits / ${probe.checkins.length} check-ins in ${dateFrom}..${dateTo}, no changes`);
    }

    // Adopt the snapshot ONLY after the engine call succeeded (or wasn't needed): a failed engine
    // run keeps the old memo, so the same delta is retried next tick instead of silently dropped.
    visitMemo = delta.nextVisitMemo;
    checkinMemo = delta.nextCheckinMemo;

    if (state.consecutiveFailures >= FAILURE_NOTIFY_AT_STREAK) {
      console.log(`[crm:live-poll] recovered after ${state.consecutiveFailures} consecutive failures`);
    }
    state.consecutiveFailures = 0;
    await pingDeadMansSwitch(DEAD_MANS_SWITCH_SLUG, "success");
  } catch (error) {
    state.consecutiveFailures += 1;
    logError("CRM live poll tick failed", {
      error,
      labels: { event: "crm_live_poll_tick_failed", failures: String(state.consecutiveFailures), job: "crm-live-poll" },
    });
    await pingDeadMansSwitch(
      DEAD_MANS_SWITCH_SLUG,
      "fail",
      describeThrown(error),
    );
    await notifySustainedFailure(dateFrom, dateTo, error);
  }
}

function scheduleNext(): void {
  if (state.stopped) return;
  const { hour, minute } = cairoHourMinute();
  const plan = resolvePollPlan(hour * 60 + minute, state.tickIndex);
  const intervalSeconds =
    state.consecutiveFailures >= FAILURE_NOTIFY_AT_STREAK
      ? Math.max(plan.intervalSeconds, FAILURE_BACKOFF_SECONDS)
      : plan.intervalSeconds;
  const delayMs = intervalSeconds * 1000 + Math.floor(Math.random() * TICK_JITTER_MS);
  state.timer = setTimeout(() => {
    state.tickIndex += 1;
    void tick().finally(scheduleNext);
  }, delayMs);
  unrefTimer(state.timer);
}

export type LivePollerStartResult = { reason?: string; started: boolean };

/**
 * Starts the singleton poller. Hard guards, in order:
 *  - PHOENIX_LIVE_CRM_POLL must be exactly "true" (the Railway-only opt-in switch; NOT in any
 *    .env file in this repo, so a dev machine — whose .env.local points at PRODUCTION Supabase —
 *    can never start a second writer against prod);
 *  - a production Next.js build (`next dev` is excluded even if someone exports the flag);
 *  - RAILWAY_ENVIRONMENT_NAME === "production" (belt-and-braces host pin);
 *  - iReports360 secrets present.
 */
export function startLiveCrmPoller(): LivePollerStartResult {
  if (state.running) return { reason: "already running", started: false };
  if (process.env.PHOENIX_LIVE_CRM_POLL !== "true") return { reason: "PHOENIX_LIVE_CRM_POLL is not 'true'", started: false };
  if (process.env.NODE_ENV !== "production") return { reason: "not a production build", started: false };
  if (process.env.RAILWAY_ENVIRONMENT_NAME !== "production") {
    return { reason: "RAILWAY_ENVIRONMENT_NAME is not 'production'", started: false };
  }
  if (!isIReports360Configured()) return { reason: "iReports360 secrets are not configured", started: false };

  state.running = true;
  state.stopped = false;
  state.timer = setTimeout(() => {
    // Marker seeding must finish before the first tick, or a fresh deploy would immediately
    // re-run a 10-day sync the previous process ran minutes earlier.
    void seedScheduledWorkMarkers()
      .then(() => tick())
      .finally(scheduleNext);
  }, STARTUP_DELAY_MS);
  unrefTimer(state.timer);
  console.log(
    `[crm:live-poll] started — ${FAST_TICK_SECONDS}s in the 08:00–12:30 Cairo compliance window, ` +
      `${DAY_TICK_SECONDS}s daytime, ${NIGHT_TICK_SECONDS}s overnight; wide (2-day) probe every ` +
      `${WIDE_PROBE_EVERY_N_TICKS} ticks and all night ticks; rolling 10-day sync every ` +
      `${ROLLING_SYNC_MIN_GAP_MS / 3_600_000}h, the rep doctor lists every ` +
      `${PLAN_SYNC_MIN_GAP_MS / 3_600_000}h, and the weekly wide reconcile now run in-process`,
  );
  return { started: true };
}

/** Stops the poller (tests / graceful teardown). Safe to call repeatedly. */
export function stopLiveCrmPoller(): void {
  state.stopped = true;
  state.running = false;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
}
