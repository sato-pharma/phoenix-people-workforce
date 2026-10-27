// The CRM housekeeping timer — the work that must outlive iReports360.
//
// Probation double-visit days are captured from the CRM record by syncProbationDvDays. Until the CRM
// cutover that capture rides the live poller's deep runs (runProbationDvCapture in live-poller.ts),
// and before that it rode the two vendor cron routes. Once the cutover retires the vendor, the poller
// stands down whole and the crons answer "skipped" — and with them would go the only caller of the
// capture, silently, exactly as happened on 2026-08-16 when the crons were switched off.
//
// So this timer takes the capture over from the moment vendor sync is retired, and does nothing
// before that (the poller still owns it, and running both would only repeat idempotent reads). It
// reads the unified CRM view through the read door and never calls the vendor, so, like the Early
// Birds close, it keeps the poller's HOST guards and needs no iReports360 credentials.
//
// THE CONTACT MASTER IS THE SECOND JOB IT TAKES OVER (re-audit, 2026-10-22). crm_contact_master_refresh
// turns each Phoenix-born doctor into a crm_contacts row and keeps every started rep's dated doctor-list
// assignments, and its own SQL switches the vendor half off after the cutover date — it was written to
// keep running. But its only callers were the poller's contact-list slice and the crm-contact-lists cron,
// and both stand down with the vendor, so from the cutover a doctor a rep adds in Phoenix would never reach
// the master. This timer runs it from the same moment: the list half every tick, the activity half (every
// visit and plan row, ~2.5 s) once per Cairo day — the cadence the poller gave it.
//
// ONE TIMER ACROSS EVERY PROCESS, AND NO REFRESH WHEN NOTHING CHANGED (owner, 2026-10-27, on the afternoon
// stalls). Every production process passing the host guards ran its own copy of this timer, so the refresh
// ran about eight times an hour instead of four: 417 calls in 52 hours, 1.1 s mean, 7.2 s max — the
// heaviest daytime statement on a 2 GB database that swaps. The tick now claims the "crm-housekeeping"
// job lease first, and before the list pass it reads crm_contact_master_inputs_stamp: the same stamp as
// the last successful refresh, under two hours old, means the refresh would rewrite nothing. Both fail
// OPEN — an unreadable lease or stamp runs the refresh exactly as before.

import { readCrmContactMasterInputsStamp, refreshCrmContactMaster } from "@/lib/crm/contact-master";
import { resolveVendorSyncStandDown } from "@/lib/crm/cutover";
import { addDaysIso, cairoTodayIso } from "@/lib/crm/dates";
import { PROBATION_DV_LOOKBACK_DAYS, resolveInProcessHostRefusal, unrefTimer } from "@/lib/crm/live-poller";
import { logError } from "@/lib/observability/log";
import { createJobLeaseKeeper, type JobLeaseRpcClient } from "@/lib/platform/job-lease";
import { trackJob } from "@/lib/observability/running-jobs";
import { syncProbationDvDays } from "@/lib/probation/intelligence/dv-sync";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** How often the timer asks. Cheap: one cached settings read, and nothing more until work is due. */
export const CRM_HOUSEKEEPING_TICK_MS = 15 * 60_000;

/** The capture's cadence once the vendor is retired — about four times a day, the rhythm the vendor
 * sync gave it. Each run re-reads a 45-day window and writes new days only. */
export const CRM_HOUSEKEEPING_PROBATION_DV_GAP_MS = 6 * 60 * 60_000;

/** After a failed capture, wait this long before trying again rather than retrying every tick. */
export const CRM_HOUSEKEEPING_RETRY_AFTER_FAILURE_MS = 60 * 60_000;

/** The lease that makes the timer one across every process. It outlives one tick, so the holder renews it
 * on each of its own ticks and a dead holder is replaced within the TTL. */
export const CRM_HOUSEKEEPING_LEASE_KEY = "crm-housekeeping";
export const CRM_HOUSEKEEPING_LEASE_TTL_SECONDS = 20 * 60;

/** However still the inputs look, the list pass runs at least this often — the ceiling on what an input
 * the stamp does not cover could ever cost. */
export const CRM_CONTACT_MASTER_FORCE_REFRESH_MS = 2 * 60 * 60_000;

/**
 * Pure: whether this tick's contact-master refresh runs. Always with the activity pass, always when the
 * stamp could not be read or no refresh has landed yet, always past the two-hour ceiling — and otherwise
 * only when the inputs' stamp differs from the one the last successful refresh read.
 */
export function isContactMasterListRefreshDue(input: {
  includeActivity: boolean;
  lastRefreshMs: number | null;
  lastStamp: string | null;
  nowMs: number;
  stamp: string | null;
}): boolean {
  if (input.includeActivity) return true;
  if (input.stamp == null || input.lastStamp == null || input.lastRefreshMs == null) return true;
  if (input.nowMs - input.lastRefreshMs >= CRM_CONTACT_MASTER_FORCE_REFRESH_MS) return true;
  return input.stamp !== input.lastStamp;
}

/** Pure: whether the probation double-visit capture is due. */
export function isProbationDvCaptureDue(input: {
  lastFailureMs: number | null;
  lastSuccessMs: number | null;
  nowMs: number;
}): boolean {
  if (input.lastFailureMs != null && input.nowMs - input.lastFailureMs < CRM_HOUSEKEEPING_RETRY_AFTER_FAILURE_MS) {
    return false;
  }
  return input.lastSuccessMs == null || input.nowMs - input.lastSuccessMs >= CRM_HOUSEKEEPING_PROBATION_DV_GAP_MS;
}

/** Pure: whether this tick's contact-master refresh also runs the activity pass — once per Cairo day. */
export function isContactMasterActivityDue(input: { cairoToday: string; lastActivityCairoDay: string | null }): boolean {
  return input.lastActivityCairoDay !== input.cairoToday;
}

let started = false;
let inFlight = false;
const state: { lastFailureMs: number | null; lastSuccessMs: number | null } = { lastFailureMs: null, lastSuccessMs: null };
/** In memory, like the poller's stamp: a deploy resets it and that day gets one more activity pass. */
let contactActivityRebuiltOnCairoDay: string | null = null;
/** The inputs' stamp the last successful refresh read, and when it landed. In memory: a deploy or a lease
 * changing hands refreshes once more, which is the safe direction. */
const contactRefresh: { lastRefreshMs: number | null; lastStamp: string | null } = { lastRefreshMs: null, lastStamp: null };

const housekeepingLease = createJobLeaseKeeper({
  client: () => getSupabaseAdmin() as unknown as JobLeaseRpcClient,
  jobKey: CRM_HOUSEKEEPING_LEASE_KEY,
  ttlSeconds: CRM_HOUSEKEEPING_LEASE_TTL_SECONDS,
});

async function runOnce(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    // Before the vendor is retired the poller's deep runs own the capture and the contact master.
    if (!(await resolveVendorSyncStandDown())) return;
    // Another process holds the timer — stand by; it is doing this tick's work.
    if (!(await housekeepingLease.ensure())) return;
    await refreshContactMasterAfterCutover();
    await captureProbationDvDays();
  } finally {
    inFlight = false;
  }
}

async function refreshContactMasterAfterCutover(): Promise<void> {
  const cairoToday = cairoTodayIso();
  const includeActivity = isContactMasterActivityDue({ cairoToday, lastActivityCairoDay: contactActivityRebuiltOnCairoDay });
  // Read BEFORE the refresh: a change landing while it runs then moves the stamp, and the next tick refreshes.
  const stamp = await readCrmContactMasterInputsStamp();
  const nowMs = Date.now();
  if (!isContactMasterListRefreshDue({ ...contactRefresh, includeActivity, nowMs, stamp })) return;
  // Never throws: a failure comes back as an outcome, so the probation capture still runs this tick.
  const outcome = await trackJob("crm:housekeeping", () => refreshCrmContactMaster({ includeActivity }));
  if (outcome.status === "refreshed") {
    // Only a pass that actually landed may claim the day — a failed one must not lock out the next.
    if (includeActivity) contactActivityRebuiltOnCairoDay = cairoToday;
    contactRefresh.lastStamp = stamp;
    contactRefresh.lastRefreshMs = nowMs;
    console.log(
      `[crm:housekeeping] contact master refreshed${includeActivity ? " with the activity pass" : ""} — ` +
        `${outcome.result.assignmentsOpened} assignments opened, ${outcome.result.assignmentsClosed} closed, ` +
        `${outcome.result.listContactsChanged} contacts changed`,
    );
  } else if (outcome.status === "failed") {
    logError("CRM housekeeping contact master refresh failed; the next tick tries again", {
      error: outcome.error,
      labels: { event: "contact_master_refresh_failed", job: "crm-housekeeping" },
    });
  }
}

async function captureProbationDvDays(): Promise<void> {
  try {
    const nowMs = Date.now();
    if (!isProbationDvCaptureDue({ ...state, nowMs })) return;

    const today = cairoTodayIso();
    const window = { dateFrom: addDaysIso(today, -PROBATION_DV_LOOKBACK_DAYS), dateTo: today };
    const summary = await trackJob("crm:housekeeping", () => syncProbationDvDays(getSupabaseAdmin(), window));
    state.lastSuccessMs = nowMs;
    console.log(
      `[crm:housekeeping] probation DV capture ${window.dateFrom}..${window.dateTo} — detected ${summary.detected}, ` +
        `inserted ${summary.inserted}, needs review ${summary.needsReview}, ingest issues ${summary.ingestIssues}`,
    );
  } catch (error) {
    state.lastFailureMs = Date.now();
    logError("CRM housekeeping probation DV capture failed; it retries within the hour", {
      error,
      labels: { event: "probation_dv_capture_failed", job: "crm-housekeeping" },
    });
  }
}

export type CrmHousekeepingSchedulerStartResult = { reason?: string; started: boolean };

/** Starts the singleton timer. Safe to call repeatedly — the second call is refused. */
export function startCrmHousekeepingScheduler(): CrmHousekeepingSchedulerStartResult {
  if (started) return { reason: "already running", started: false };
  const hostRefusal = resolveInProcessHostRefusal();
  if (hostRefusal) return { reason: hostRefusal, started: false };

  started = true;
  const timer = setInterval(() => {
    void runOnce();
  }, CRM_HOUSEKEEPING_TICK_MS);
  unrefTimer(timer);
  console.log(
    `[crm:housekeeping] started — asks every ${CRM_HOUSEKEEPING_TICK_MS / 60_000} minutes; refreshes the contact master and captures probation double visits only once the CRM cutover retires iReports360`,
  );
  return { started: true };
}
