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

import { resolveVendorSyncStandDown } from "@/lib/crm/cutover";
import { addDaysIso, cairoTodayIso } from "@/lib/crm/dates";
import { PROBATION_DV_LOOKBACK_DAYS, resolveInProcessHostRefusal, unrefTimer } from "@/lib/crm/live-poller";
import { logError } from "@/lib/observability/log";
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

let started = false;
let inFlight = false;
const state: { lastFailureMs: number | null; lastSuccessMs: number | null } = { lastFailureMs: null, lastSuccessMs: null };

async function runOnce(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    // Before the vendor is retired the poller's deep runs own the capture.
    if (!(await resolveVendorSyncStandDown())) return;
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
  } finally {
    inFlight = false;
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
    `[crm:housekeeping] started — asks every ${CRM_HOUSEKEEPING_TICK_MS / 60_000} minutes; captures probation double visits only once the CRM cutover retires iReports360`,
  );
  return { started: true };
}
