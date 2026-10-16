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
 * That covered only HALF the list, and the other half was found a day behind. `plan-sync` mirrors
 * the dated PLAN (`ireports360_plan_entries`); the CONTACT LIST itself (`ireports360_contacts` —
 * the only path by which Phoenix learns of a doctor assigned to a rep but never planned and never
 * visited) was refreshed solely by the external 05:00 Cairo cron, twelve calls five minutes apart,
 * ONCE A DAY. Measured on production 2026-09-21: 9,245 rows across 66 agents written in one burst
 * at 05:00, the previous writes 09-19 05:00 and 09-16 05:00 — so a doctor assigned at 09:00 was
 * invisible to Phoenix until the next morning. Since 2026-09-21 that sweep runs from this loop too,
 * one twelfth every five minutes through the Cairo working day, which is a FULL ROSTER EVERY HOUR
 * (owner's instruction, 2026-09-21: "make it hourly"). The cron entry stays as an idempotent
 * backstop — each agent is replaced independently and an empty vendor answer is refused rather than
 * applied, so the two schedules overlapping is safe by construction.
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
  restampUnmappedPlanEntries,
  syncIReports360WeeklyPlans,
  type NewlySeenPlan,
} from "@/lib/crm/plan-sync";
import { PARITY_STALE_AFTER_DAYS, latestParityCheckAtMs, runIReports360ParitySweep } from "@/lib/crm/parity";
import { contactMasterRefreshIncludesActivity, refreshCrmContactMaster } from "@/lib/crm/contact-master";
import {
  CONTACT_SYNC_SLICE_COUNT,
  contactSyncSliceForDate,
  contactSyncSliceRefreshedNothing,
  loadCrmContactSyncTargets,
  selectContactSyncSlice,
  syncCrmContactLists,
} from "@/lib/crm/contacts-sync";
import { CRM_SYNC_RUNS_TABLE } from "@/lib/crm/tables";
import { refreshSharedCrmWindows } from "@/lib/crm/shared-windows";
import { notifyIReports360SyncResult } from "@/lib/notifications/ireports360-sync-digest";
import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { resolveVendorSyncStandDown } from "@/lib/crm/cutover";
import { processRoleRefusal } from "@/lib/platform/process-role";
import { trackJob } from "@/lib/observability/running-jobs";
import { pingDeadMansSwitch, signalDeadMansSwitchStart } from "@/lib/observability/dead-mans-switch";
import { syncProbationDvDays } from "@/lib/probation/intelligence/dv-sync";
import { logError, logWarning } from "@/lib/observability/log";
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
/** The contact job's OWN switch — the same slug the cron route pings, so the check keeps meaning
 * one thing no matter which schedule fired last. Never the poller's slug above: a stale doctor
 * list is not a stalled poller, and the two must stay separately diagnosable. */
const CONTACT_LIST_JOB_SLUG = "phoenix-crm-contact-lists";
/** How long one slice may spend fetching before it stops starting new agents. Larger than the
 * cron route's 21s, which is sized to fit inside cron-job.org's 30-second request cap — there is
 * no HTTP request here to be cut, only this tick's slot, and the 5-minute gap is the real bound.
 * Measured on production: 8-10s for a full tick, so this is headroom, not a budget. */
const CONTACT_LIST_SLICE_BUDGET_MS = 90_000;
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

/** Contact-list sync: one twelfth of the roster every five minutes — a FULL ROSTER EVERY HOUR.
 *
 * THE GAP AND THE SLICE COUNT ARE ONE DESIGN, NOT TWO SETTINGS. `CONTACT_SYNC_SLICE_COUNT` is 12,
 * so a five-minute gap is exactly what makes "hourly" true; changing either alone changes how long
 * a full sweep takes. A slice is ~5 agents x 3 vendor pages, measured at 8-10s, so it fits inside
 * one tick's slot the same way a plan sync does.
 *
 * Bounded to 06:00-22:00 Cairo rather than run around the clock. The list is edited by a human
 * administrator during working hours, and every hour outside them is a full roster of vendor
 * requests bought for nothing — this is the one job whose cadence went up sixteenfold, so its
 * window is the thing keeping that honest. Overnight the external 05:00 cron still sweeps.
 *
 * A failure backs off 15 minutes, not a day: the vendor session is the usual cause, the next slice
 * re-logs in, and yesterday's rows are kept rather than emptied while it recovers. */
export const CONTACT_LIST_SYNC_MIN_GAP_MS = 5 * 60 * 1000;
export const CONTACT_LIST_SYNC_EARLIEST_CAIRO_MINUTES = 6 * 60;
export const CONTACT_LIST_SYNC_LATEST_CAIRO_MINUTES = 22 * 60;
export const CONTACT_LIST_SYNC_FAILURE_RETRY_GAP_MS = 15 * 60 * 1000;

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

export type ScheduledCrmWork =
  | "rolling-sync"
  | "wide-reconcile"
  | "plan-sync"
  | "contact-lists"
  | "parity-sweep"
  | null;

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
  lastContactListFailureMs: number | null;
  lastContactListSuccessMs: number | null;
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

  // Fourth, below the plan sync and above the parity sweep. It is the most FREQUENT of the five
  // (every five minutes) and the cheapest, so it must not be able to hold a slot the three jobs
  // above it want — and it is still today's data, so it outranks the re-proof of settled history.
  const contactListSyncDue =
    input.minutesSinceMidnight >= CONTACT_LIST_SYNC_EARLIEST_CAIRO_MINUTES &&
    input.minutesSinceMidnight < CONTACT_LIST_SYNC_LATEST_CAIRO_MINUTES &&
    (input.lastContactListSuccessMs === null ||
      input.nowMs - input.lastContactListSuccessMs >= CONTACT_LIST_SYNC_MIN_GAP_MS) &&
    (input.lastContactListFailureMs === null ||
      input.nowMs - input.lastContactListFailureMs >= CONTACT_LIST_SYNC_FAILURE_RETRY_GAP_MS);
  if (contactListSyncDue) return "contact-lists";

  // Lowest priority of the five, deliberately. It re-proves SETTLED history, so it is the only one
  // that costs nothing at all by waiting a tick — the other four feed today's attendance, today's
  // plan, today's doctor list, and payroll. Its 02:00 window is also outside the hours the others
  // contend for: at 02:00 the three day jobs are closed and the contact sweep has not opened.
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
  /** Which twelfth of the roster the next contact-list slice serves. Seeded from the Cairo clock on
   * the first slice after a restart, then advanced by one, so it is BOTH restart-proof (a deploy
   * does not send every sweep back to slice 1 and starve the other eleven) and drift-proof (a slow
   * vendor cannot make the schedule skip a slice the way a clock-derived slot can). */
  contactListSlice: number | null;
  /** Cairo day (YYYY-MM-DD) on which the contact master's full activity pass last succeeded. */
  contactActivityRebuiltOnCairoDay: string | null;
  lastContactListFailureMs: number | null;
  lastContactListSuccessMs: number | null;
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
  contactListSlice: null,
  contactActivityRebuiltOnCairoDay: null,
  lastContactListFailureMs: null,
  lastContactListSuccessMs: null,
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

/** A run is a DEEP run (rolling sync or wide reconcile) when its window is this many days wide. */
export const DEEP_RUN_MIN_SPAN_DAYS = 9;
const RECONCILE_MIN_SPAN_DAYS = 25;

/**
 * The last successful rolling sync and wide reconcile, read from ireports360_visits_sync_runs.
 *
 * The read asks for DEEP runs only (`date_from` at least DEEP_RUN_MIN_SPAN_DAYS back). It used to
 * take the newest 200 successful rows of every kind, and the live poll writes a row for each small
 * probe: on 2026-10-11 the table took 20-44 of them an hour from 10:00 Cairo, so by the 17:35
 * deploy the 04:00 reconcile was 231 rows back, fell outside the 200, and the restarted poller saw
 * "Sunday, past 04:00, never reconciled" and pulled the same 30 days again. Every other weekday is
 * safe because the reconcile is only ever due on a Sunday, which is why it surfaced on Sundays.
 * Probe rows begin within two days of today, so the filter drops them in SQL and the 200-row cap
 * can no longer be spent on them.
 */
export async function readDeepRunMarkers(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  todayIso: string,
): Promise<{ lastReconcileSuccessMs: number | null; lastRollingSuccessMs: number | null }> {
  const { data, error } = await supabase
    .from(CRM_SYNC_RUNS_TABLE)
    .select("date_from, date_to, started_at, status")
    .eq("status", "success")
    .lte("date_from", addDaysIso(todayIso, -DEEP_RUN_MIN_SPAN_DAYS))
    .order("started_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  let lastReconcileSuccessMs: number | null = null;
  let lastRollingSuccessMs: number | null = null;
  for (const row of (data ?? []) as Array<{ date_from: string; date_to: string; started_at: string; status: string }>) {
    const spanDays = Math.round(
      (new Date(`${row.date_to}T00:00:00Z`).getTime() - new Date(`${row.date_from}T00:00:00Z`).getTime()) / 86_400_000,
    );
    const startedMs = new Date(row.started_at).getTime();
    if (!Number.isFinite(startedMs)) continue;
    if (spanDays >= RECONCILE_MIN_SPAN_DAYS && lastReconcileSuccessMs === null) lastReconcileSuccessMs = startedMs;
    else if (spanDays >= DEEP_RUN_MIN_SPAN_DAYS && spanDays < RECONCILE_MIN_SPAN_DAYS && lastRollingSuccessMs === null) {
      lastRollingSuccessMs = startedMs;
    }
    if (lastReconcileSuccessMs !== null && lastRollingSuccessMs !== null) break;
  }
  return { lastReconcileSuccessMs, lastRollingSuccessMs };
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
    const markers = await readDeepRunMarkers(getSupabaseAdmin(), cairoTodayIso());
    if (state.lastReconcileSuccessMs === null) state.lastReconcileSuccessMs = markers.lastReconcileSuccessMs;
    if (state.lastRollingSuccessMs === null) state.lastRollingSuccessMs = markers.lastRollingSuccessMs;
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
 * Refreshes one twelfth of the roster's assigned doctor lists from the CRM web app.
 *
 * Firewalled exactly like runScheduledPlanSync, and for the same reason: it never throws, never
 * pings the visits sync's dead-man's switch, and never sends the visits digest. The contact mirror
 * is not an input to payroll attendance and must not be able to raise an alarm that reads as
 * "today's attendance data is broken".
 *
 * It DOES ping the contact job's own switch, `phoenix-crm-contact-lists`, on the same two
 * conditions the cron route uses — no agent refreshed at all, or a failed contact-master rebuild.
 * Those are the two shapes that mean the mirror is rotting behind a green job; partial degradation
 * deliberately stays green, because `agentsRefusedEmpty` is the designed safety and a check that
 * pages on an ordinary vendor hiccup gets muted, and a muted check is worth less than no check.
 * Continuity with the route matters: whichever schedule fired last, the switch says the same thing.
 */
async function runScheduledContactListSync(): Promise<void> {
  const slice = state.contactListSlice ?? contactSyncSliceForDate(new Date());
  const startedAt = Date.now();
  try {
    const { targets, unresolved } = await loadCrmContactSyncTargets();
    const result = await syncCrmContactLists({
      deadlineAt: startedAt + CONTACT_LIST_SLICE_BUDGET_MS,
      targets: selectContactSyncSlice(targets, slice, CONTACT_SYNC_SLICE_COUNT),
    });
    // THE CONTACT MASTER FOLLOWS THE MIRROR — the master's dated assignments are built from these
    // rows, so it is rebuilt right after the slice that changed them. It never throws.
    //
    // THE LIST HALF IS HOURLY; THE ACTIVITY HALF STAYS DAILY. `contactMasterRefreshIncludesActivity`
    // keys on the LAST slice of the sweep, which was written when a sweep meant "once a day" — under
    // this hourly cursor that slice comes round every hour, so the pass that reads every visit and
    // plan row (2.5 s measured on production 2026-09-13, against a PostgREST cut at 8 s) would run
    // about 16 times a day instead of once. Visits do not arrive through this job at all, so nothing
    // is gained by it. The Cairo-day stamp restores the daily cadence without touching the shared
    // helper, which the cron route — genuinely once a day — still uses as written.
    //
    // The stamp is in memory, so a deploy resets it and that day gets one more pass. Bounded by
    // deploys rather than by the clock, which is the cheap end of the trade: the alternative is a
    // row to persist it, for a 2.5-second read.
    const cairoToday = cairoTodayIso();
    const includeActivity =
      contactMasterRefreshIncludesActivity({ slice, sliceOf: CONTACT_SYNC_SLICE_COUNT }) &&
      state.contactActivityRebuiltOnCairoDay !== cairoToday;
    const contactMaster = await refreshCrmContactMaster({ includeActivity });
    // Only a pass that actually landed may claim the day — a failed one must not lock out the next.
    if (includeActivity && contactMaster.status === "refreshed") {
      state.contactActivityRebuiltOnCairoDay = cairoToday;
    }
    // Advance only on a slice that actually refreshed something, so a failure re-serves the same
    // twelfth rather than skipping it — the whole point of carrying a cursor instead of reading the
    // clock. `result.agents` alone cannot answer that: it counts ATTEMPTED agents, so a slice whose
    // every agent failed used to advance the cursor AND record a success, which both buried the
    // failed twelfth for a full sweep and swapped the 15-minute retry gap for the 5-minute success
    // gap. `contactSyncSliceRefreshedNothing` is the shared predicate; partial failure still counts
    // as a completed slice, deliberately.
    const refreshedNothing = contactSyncSliceRefreshedNothing(result);
    if (refreshedNothing) {
      state.lastContactListFailureMs = Date.now();
    } else {
      state.contactListSlice = (slice + 1) % CONTACT_SYNC_SLICE_COUNT;
      state.lastContactListSuccessMs = Date.now();
    }
    console.log(
      `[crm:live-poll] in-process contact-lists slice ${slice + 1}/${CONTACT_SYNC_SLICE_COUNT} — ` +
        `${result.upserted} rows across ${result.agents} agents (${result.contacts} distinct contacts), ` +
        `${result.deleted} removed` +
        (result.agentsRefusedEmpty ? `, ${result.agentsRefusedEmpty} kept unchanged (empty answer)` : "") +
        (result.agentsFailed ? `, ${result.agentsFailed} failed` : "") +
        (result.skipped ? `, ${result.skipped} out of time` : "") +
        (unresolved.length ? `, ${unresolved.length} with no CRM account yet` : "") +
        ` [master ${contactMaster.status}]`,
    );
    if (contactMaster.status === "failed") {
      logError("CRM in-process contact-lists: contact master refresh failed", {
        error: contactMaster.error,
        labels: { event: "contact_master_refresh_failed", job: "crm-contact-lists" },
      });
    }
    // NO CACHE BUST HERE — IT CANNOT WORK ON A TIMER. The cached picker counts
    // (`getRepListSummaries`, tag `crm-contact-list-summaries`, 300s) catch up with this slice through
    // their own TTL. `revalidateTag` needs the request's work store and THROWS without one
    // ("Invariant: static generation store missing", Next 16 `revalidate()`), and this function only
    // ever runs from the poller's timer. The call that used to sit here therefore failed on every
    // slice — every five minutes from 06:00 to 22:00 Cairo — and logged a false ERROR each time
    // (seen on production 2026-09-21), while busting nothing. The bust that DOES work stays where a
    // request exists: the cron route (after its master refresh) and a person's list edit
    // (`bustListSummaries`). Pinned by `tests/crm-live-poller.test.ts`.
    await pingDeadMansSwitch(
      CONTACT_LIST_JOB_SLUG,
      refreshedNothing || contactMaster.status === "failed" ? "fail" : "success",
      `in-process slice ${slice + 1}/${CONTACT_SYNC_SLICE_COUNT}: ${result.agents} agent(s) attempted, ` +
        `${result.upserted} row(s) upserted` +
        (result.agentsRefusedEmpty ? `, ${result.agentsRefusedEmpty} kept unchanged (empty answer)` : "") +
        (result.agentsFailed ? `, ${result.agentsFailed} failed` : "") +
        (result.skipped ? `, ${result.skipped} out of time` : "") +
        (contactMaster.status === "failed" ? `, contact master refresh FAILED: ${contactMaster.error}` : ""),
    );
  } catch (error) {
    state.lastContactListFailureMs = Date.now();
    logError(
      `CRM in-process contact-lists slice ${slice + 1}/${CONTACT_SYNC_SLICE_COUNT} failed; ` +
        "that twelfth of the roster keeps the doctor list it already had",
      { error, labels: { event: "crm_contact_list_sync_failed", job: "crm-contact-lists" } },
    );
    await pingDeadMansSwitch(CONTACT_LIST_JOB_SLUG, "fail", describeThrown(error));
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
    //
    // logWarning, not logError. This is the line `runScheduledParitySweep`'s own doc comment calls
    // "a normal finding", and it fired on four of five consecutive nights — an error channel that
    // reports a routine success nightly is one nobody reads on the night it finally matters. WARNING
    // goes to stdout rather than stderr (see observability/log.ts) so Railway stops classifying it as
    // an error, and `labels.event` keeps it exactly as greppable as before.
    if (result.action === "repair") {
      logWarning(
        `CRM parity sweep repaired ${result.window.from}..${result.window.to}: the mirror was missing ` +
          `${diff?.missingInMirror ?? 0} visit(s) the CRM holds and held ${diff?.extraInMirror ?? 0} the CRM does not` +
          `${result.repairedDeleted > 0 ? ` — ${result.repairedDeleted} deleted id(s) archived in ireports360_sync_deletions` : ""}`,
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

// How far back each rolling run re-captures probation Double-Visit days. Wider than the rolling
// sync's own 10 days because a double visit can be saved up to 16 days late (August 2026 maximum),
// and because the first run after 2026-09-13 has to heal the gap left since capture stopped on
// 2026-08-16. It reads only the mirror and writes new days only, so the width costs a few reads.
export const PROBATION_DV_LOOKBACK_DAYS = 45;

/**
 * Captures probation Double-Visit days from the mirror after a deep run refreshed it.
 *
 * Capture used to be called ONLY from the two cron-job.org routes (ireports360-visits-sync and
 * -reconcile). When this poller took those runs over, the jobs were switched off and nothing else
 * called it, so no probation DV day was captured after 2026-08-16 and every scorecard since had to
 * be opened by hand. Firewalled like runScheduledPlanSync: it never throws, never pings the visits
 * dead-man's switch, and never sends the visits digest — a probation hiccup must not read as
 * "today's attendance data is broken". It sends no email either (dv-sync.ts, MOD-1).
 */
async function runProbationDvCapture(window: { dateFrom: string; dateTo: string }): Promise<void> {
  try {
    const summary = await syncProbationDvDays(getSupabaseAdmin(), window);
    console.log(
      `[crm:live-poll] probation DV capture ${window.dateFrom}..${window.dateTo} — detected ${summary.detected}, ` +
        `inserted ${summary.inserted}, needs review ${summary.needsReview}, ingest issues ${summary.ingestIssues}`,
    );
  } catch (error) {
    logError("Probation DV-day capture failed after a CRM deep run; the next run retries the same window", {
      error,
      labels: { event: "probation_dv_capture_failed", job: "probation-dv-capture" },
    });
  }
}

/**
 * Stamps `agent_hr_id` onto plan-entry rows that were written before their rep's identity was known.
 *
 * Rides the deep visits runs for the same reason the probation capture does: those runs are where a
 * newly learned identity first reaches the mirror, and a plan row the sync wrote as null was never
 * revisited — 40,445 of them on 2026-09-13, invisible to every scoped plan board. Firewalled like
 * runProbationDvCapture: it never throws, never pings the visits dead-man's switch, and never
 * notifies anyone — an unmapped doctor list is old debt, not "today's attendance data is broken".
 */
async function runPlanEntryRestamp(): Promise<void> {
  try {
    const summary = await restampUnmappedPlanEntries();
    console.log(
      `[crm:live-poll] plan entry re-stamp — checked ${summary.checked} unmapped row(s), fixed ${summary.fixed}`,
    );
  } catch (error) {
    logError("Plan-entry identity re-stamp failed after a CRM deep run; the next run retries", {
      error,
      labels: { event: "plan_entry_restamp_failed", job: "plan-entry-restamp" },
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
  if (work === "contact-lists") {
    await runScheduledContactListSync();
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
  // The rolling sync only: a run a deploy cut off reads "started, never finished" at Healthchecks.
  // Every path below ends in a success or a fail ping, so a start is never orphaned by a normal exit.
  if (!isReconcile) await signalDeadMansSwitchStart(slug);
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
    await runProbationDvCapture(
      isReconcile
        ? resolveWideReconciliationSlice(scheduledAt)
        : { dateFrom: addDaysIso(today, -PROBATION_DV_LOOKBACK_DAYS), dateTo: today },
    );
    await runPlanEntryRestamp();
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
 * bundle setTimeout's return type is a number, so reach for unref only when it exists. Exported for
 * the Early Birds close scheduler, which runs its own timer beside this loop. */
export function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}

async function tick(): Promise<void> {
  // THE CRM CUTOVER. Once iReports360 is retired every job below would pull from a vendor that is
  // gone, so the tick stands down whole — no probe, no deep run, no dead-man's-switch ping (the
  // runbook deletes those checks). The probation double-visit capture that rode on these jobs moves
  // to src/lib/crm/housekeeping-scheduler.ts. Fails open: an unreadable setting keeps the poller on.
  if (await resolveVendorSyncStandDown()) return;

  const today = cairoTodayIso();
  const { hour, minute } = cairoHourMinute();

  // A due deep run takes this tick's slot instead of the probe — one vendor-facing job at a time,
  // serialized through this single loop, so the app never runs two engine pulls concurrently.
  const dueWork = resolveDueScheduledWork({
    cairoDayOfWeek: cairoDayOfWeek(),
    lastContactListFailureMs: state.lastContactListFailureMs,
    lastContactListSuccessMs: state.lastContactListSuccessMs,
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
    // Named in the process-health stall line, so a freeze points at the job that caused it.
    await trackJob(`crm:${dueWork}`, () => runScheduledWork(dueWork));
    return;
  }

  // The Early Birds close USED to run here. It moved to its own timer
  // (src/lib/early-birds/close-scheduler.ts) because this loop only starts when iReports360
  // credentials are present, and the close reads the mirror, not the vendor — so losing the vendor
  // credentials silently stopped every fortnight from closing. Do not put it back.

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
      // Rows changed, so a dashboard's minute-old copy is dropped (in this process; another process's copy
      // ages out within the minute).
      if (result.rowsUpserted > 0 || result.checkinsUpserted > 0 || result.rowsDeleted > 0) {
        refreshSharedCrmWindows("crm live poll wrote changes");
      }
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
    void trackJob("crm:live-poll", tick).finally(scheduleNext);
  }, delayMs);
  unrefTimer(state.timer);
}

export type LivePollerStartResult = { reason?: string; started: boolean };

/**
 * The HOST half of the in-process guards — why this process must not run a scheduled writer at all,
 * or null when it may. Shared with the Early Birds close scheduler, which needs exactly these three
 * and deliberately NOT the iReports360 credential check below.
 *  - PHOENIX_LIVE_CRM_POLL must be exactly "true" (the Railway-only opt-in switch; NOT in any
 *    .env file in this repo, so a dev machine — whose .env.local points at PRODUCTION Supabase —
 *    can never start a second writer against prod);
 *  - a production Next.js build (`next dev` is excluded even if someone exports the flag);
 *  - RAILWAY_ENVIRONMENT_NAME === "production" (belt-and-braces host pin);
 *  - and this is not the PAGE server (PHOENIX_PROCESS_ROLE=web): background work runs on the worker
 *    service, because work done here freezes every page while it runs (src/lib/platform/process-role.ts).
 */
export function resolveInProcessHostRefusal(): string | null {
  const roleRefusal = processRoleRefusal();
  if (roleRefusal) return roleRefusal;
  if (process.env.PHOENIX_LIVE_CRM_POLL !== "true") return "PHOENIX_LIVE_CRM_POLL is not 'true'";
  if (process.env.NODE_ENV !== "production") return "not a production build";
  if (process.env.RAILWAY_ENVIRONMENT_NAME !== "production") return "RAILWAY_ENVIRONMENT_NAME is not 'production'";
  return null;
}

/**
 * Starts the singleton poller. Hard guards, in order: the host guards in resolveInProcessHostRefusal,
 * then iReports360 secrets present.
 */
export function startLiveCrmPoller(): LivePollerStartResult {
  if (state.running) return { reason: "already running", started: false };
  const hostRefusal = resolveInProcessHostRefusal();
  if (hostRefusal) return { reason: hostRefusal, started: false };
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
