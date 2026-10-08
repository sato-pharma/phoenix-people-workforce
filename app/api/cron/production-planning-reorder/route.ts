import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { runProductionPlanningExpirySweep } from "@/lib/production-planning/expiry-sweep";
import { runProductionPlanningReorderSweep } from "@/lib/production-planning/reorder-sweep";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * The Ivyronc reorder alarm — every morning, the materials whose cover has fallen to about one run.
 *
 * It exists because the imported material takes about six months to arrive and the owner said
 * plainly that he would otherwise forget. It reads the same engine the planner screen reads, so the
 * email cannot disagree with the page.
 *
 * SILENT UNTIL HE ARMS IT. Four independent switches, each fail-safe on its own, and none of them a
 * default: `alarm_enabled`, `alarm_dry_run`, the template's `is_active` (it ships inactive) and
 * `EMAIL_NOTIFICATIONS_ENABLED`. Merging this route is what starts the clock on the SWEEP, not on
 * the sending — the sending is the owner's click in the module's Settings tab.
 *
 * A disabled pass answers `skipped: "disabled"` rather than `alarms: 0`, because "0 sent" and
 * "switched off" were indistinguishable during a 13-day outbox freeze. A dry-run pass writes the
 * rows a real pass would and sends nothing.
 *
 * 06:10 Cairo, a minute nothing else in the account uses, so a red execution here is unambiguous
 * about which job produced it — and early enough that the answer is waiting before the office opens.
 *
 * ── TWO sweeps on one schedule since Guamusin ───────────────────────────────────────────────────
 *
 * The EXPIRY sweep runs here too, with its own independent pair of arming flags. It is not a second
 * cron-job.org job because adding one is the owner's own click in a console, and this pass already
 * happens; the two verdicts also belong together — "order more of this" and "use THIS batch first"
 * are different answers about the same morning's stock. Each reports separately below, and a
 * failure in either is caught on its own so one cannot silence the other.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/production-planning-reorder");
  if (denied) return denied;
  try {
    const result = await withDeadMansSwitch("phoenix-production-planning-reorder", () =>
      runProductionPlanningReorderSweep(),
    );
    // Separately caught: a red reorder sweep must not hide the expiry verdict, and an expiry failure
    // must not turn a reorder email that already went out into a 500 the scheduler will retry.
    let expiry: Awaited<ReturnType<typeof runProductionPlanningExpirySweep>> | { error: string };
    try {
      expiry = await runProductionPlanningExpirySweep();
    } catch (error) {
      logError("Production planner expiry sweep failed", {
        labels: { event: "cron_partial_failed", job: "production-planning-reorder" },
        error,
      });
      expiry = { error: clientSafeErrorMessage(error, "Production planner expiry sweep failed.") };
    }
    return NextResponse.json({
      success: true,
      alarms: result.alarms,
      dryRun: result.dryRun,
      emailSent: result.emailSent,
      emailSkippedReason: result.emailSkippedReason,
      evaluatedOn: result.evaluatedOn,
      recorded: result.recorded,
      skipped: result.skipped,
      warnings: result.warnings,
      expiry,
    });
  } catch (error) {
    logError("Production planner reorder sweep failed", {
      labels: { event: "cron_failed", job: "production-planning-reorder" },
      error,
    });
    const message = clientSafeErrorMessage(error, "Production planner reorder sweep failed.");
    return NextResponse.json({ error: "production_planning_reorder_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
