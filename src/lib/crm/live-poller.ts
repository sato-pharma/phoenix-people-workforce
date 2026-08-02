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
 * The scheduled crons (3x/day rolling 10-day sync + weekly wide reconcile) stay as the
 * correctness backstop for edits/deletions older than this poller's 2-day horizon.
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
import { addDaysIso, cairoHourMinute, cairoTodayIso } from "@/lib/crm/dates";
import { syncIReports360Visits } from "@/lib/crm/sync";
import { notifyIReports360SyncResult } from "@/lib/notifications/ireports360-sync-digest";
import { pingDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";

// ── Cadence (Africa/Cairo wall-clock) ────────────────────────────────────────────────────────────
// 08:00–12:30 is the morning compliance window (CRM First Visit / Early Birds) — poll fastest
// there. Daytime otherwise polls at half that rate; overnight drops to a slow keep-fresh tick
// (reps do log visits after midnight — the saveDate histogram shows real 00:00–03:00 activity —
// it just doesn't need minute-level latency). Exported for the unit tests.
export const FAST_TICK_SECONDS = 60;
export const DAY_TICK_SECONDS = 120;
export const NIGHT_TICK_SECONDS = 300;
// Most day ticks probe TODAY only (small payload, kind to the vendor's shared hosting). Every
// Nth tick widens to yesterday+today so a back-dated save still appears within ~10 minutes.
// Night ticks always probe the 2-day window: after the midnight flip "yesterday" is where the
// evening's visits live.
export const WIDE_PROBE_EVERY_N_TICKS = 8;

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

// ── Poller runtime (module-singleton) ────────────────────────────────────────────────────────────

type PollerState = {
  consecutiveFailures: number;
  running: boolean;
  stopped: boolean;
  tickIndex: number;
  timer: ReturnType<typeof setTimeout> | null;
};

const state: PollerState = { consecutiveFailures: 0, running: false, stopped: false, tickIndex: 0, timer: null };
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
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
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
    void tick().finally(scheduleNext);
  }, STARTUP_DELAY_MS);
  unrefTimer(state.timer);
  console.log(
    `[crm:live-poll] started — ${FAST_TICK_SECONDS}s in the 08:00–12:30 Cairo compliance window, ` +
      `${DAY_TICK_SECONDS}s daytime, ${NIGHT_TICK_SECONDS}s overnight; wide (2-day) probe every ` +
      `${WIDE_PROBE_EVERY_N_TICKS} ticks and all night ticks`,
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
