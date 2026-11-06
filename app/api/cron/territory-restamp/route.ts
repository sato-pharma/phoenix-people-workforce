import { NextResponse } from "next/server";

import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { pingDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { runScheduledTerritorySync } from "@/lib/sales/territory/scheduled-sync";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Healthchecks slug, `phoenix-<route>` like every other watched cron route. */
const JOB_SLUG = "phoenix-territory-restamp";

/**
 * Keep every OPEN period's Source-of-Sales geography correct, nightly.
 *
 * This is the scheduled counterpart to the Territory Drilldown's Sync button. The owner's rule is
 * that all SoS sales attribute to TODAY's geography — but until now that rule only held for as long
 * as somebody remembered to press a button, and the event that breaks it is silent: inserting one
 * employee auto-seats them and flips `line_area_map.area_state`, which staled 8 of 8 periods off 3
 * inserts with no error anywhere.
 *
 * NOTIFIES NOBODY, BY DESIGN. It does work; it does not send mail, in-app, Telegram or push. The
 * trace it leaves is the audit row `syncTerritoryData` already writes, plus a `territory_restamp_
 * applied` INFO log on any run that actually moved rows.
 *
 * PUBLISHED CLOSINGS ARE NEVER TOUCHED — the guard lives in the domain service and is unit-tested
 * there. Publishing does not freeze a closing's figures (`snapshot_units` was NULL on every
 * published row as of 2026-08-29), so re-stamping a published period would silently move numbers
 * under a closing that has already gone out. Correcting a published month stays a deliberate human
 * act through the Drilldown button.
 *
 * TIMEOUT SHAPE. cron-job.org cuts every request at 30s — a platform cap `requestTimeout` cannot
 * raise — while `phx_sync_sos_run` is allowed 300s server-side. That is fine here and does not need
 * the slicing the retired `/api/cron/crm-contact-lists` used, because the run is idempotent and cheap at rest:
 * it writes only rows whose brick actually moved and refreshes rollups only for batches it moved,
 * so a steady-state night is one indexed scan (the read-only reconciliation over a full 12-month
 * window measured 1.19s). The re-stamp runs ONE PERIOD PER CALL, each its own transaction, so a slow
 * period never rolls back the others, and a period the database gateway cuts (it cuts at about two
 * minutes — the 4 Oct 2026 night) is tried once more while the run has time (`restampPeriodsOneByOne`).
 *
 * WHY THE PING IS EXPLICIT, AND WHY IT FIRES AT THE COMMIT RATHER THAN AT THE END.
 * `withDeadMansSwitch` reports at the very END of the run, which put roughly 25 seconds of
 * reporting tail — the reconciliation read, the cache invalidation, the audit write — between the
 * commit and the ping. On 2026-09-04 the run committed at 03:20:00 Cairo and the production deploy
 * of #3035 went live at 03:20:31, replacing the container mid-tail. The work had landed (7 periods
 * carry that exact `refreshed_at`) but nothing reported it, so the register alerted "stranded —
 * nothing has reported" every 15 minutes for 14 hours about a run that had done its job. With
 * production deploying on every merge, that collision is routine, not freak.
 *
 * So success is reported the instant the re-stamp COMMITS, through the domain service's
 * `onWorkCommitted` hook. `reportSuccessOnce` also covers the skip path, which commits nothing and
 * so never fires the hook: a night on which every period is published is a healthy run, not a
 * silent one. A later failure in the tail still pings "fail" on top — `recordJobHeartbeat` writes
 * only the timestamp for the outcome it is given, so `last_success_at` survives and the register
 * says what is true: the re-stamp landed, the tail did not.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/territory-restamp");
  if (denied) return denied;

  let reportedSuccess = false;
  const reportSuccessOnce = async () => {
    if (reportedSuccess) return;
    reportedSuccess = true;
    await pingDeadMansSwitch(JOB_SLUG, "success");
  };

  try {
    const result = await runScheduledTerritorySync({ onWorkCommitted: reportSuccessOnce });
    await reportSuccessOnce();
    return NextResponse.json({
      success: true,
      restampedRows: result.restampedRows,
      refreshedBatches: result.refreshedBatches,
      syncedPeriods: result.syncedPeriods,
      publishedPeriodsSkipped: result.publishedPeriodsSkipped,
      allReconciled: result.allReconciled,
      skippedEntirely: result.skippedEntirely,
      durationMs: result.durationMs,
      ranAt: result.ranAt,
    });
  } catch (error) {
    logError("Territory re-stamp failed", {
      labels: { event: "cron_failed", job: "territory-restamp" },
      error,
    });
    await pingDeadMansSwitch(JOB_SLUG, "fail", describeThrown(error));
    const message = clientSafeErrorMessage(error, "Territory re-stamp failed.");
    return NextResponse.json({ error: "territory_restamp_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
