import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
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
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/production-planning-reorder");
  if (denied) return denied;
  try {
    const result = await withDeadMansSwitch("phoenix-production-planning-reorder", () =>
      runProductionPlanningReorderSweep(),
    );
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
