import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { runScheduledTerritorySync } from "@/lib/sales/territory/scheduled-sync";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
 * the slicing `/api/cron/crm-contact-lists` uses, because the run is idempotent and cheap at rest:
 * it writes only rows whose brick actually moved and refreshes rollups only for batches it moved,
 * so a steady-state night is one indexed scan (the read-only reconciliation over a full 12-month
 * window measured 1.19s). A rare heavy night can outrun the client cut; the work still completes
 * server-side in its single transaction, and the next night's run is a no-op confirming it.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/territory-restamp");
  if (denied) return denied;
  try {
    const result = await withDeadMansSwitch("phoenix-territory-restamp", () => runScheduledTerritorySync());
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
    const message = clientSafeErrorMessage(error, "Territory re-stamp failed.");
    return NextResponse.json({ error: "territory_restamp_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
