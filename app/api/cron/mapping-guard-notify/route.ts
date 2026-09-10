import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { runMappingGuardNotify } from "@/lib/sales/mapping-guard";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Tell the owner which customer, brick or area re-mappings were stopped and are waiting for him.
 *
 * Owner decision 2026-09-10, asked directly and answered: quarantine the risky ones rather than
 * only reporting them, reach him on Telegram and in the app, and speak ONCE PER BATCH.
 *
 * In-app/Telegram/push only, never email. House rule for operational alerts since 2026-07-25.
 *
 * A CLOCK OF ITS OWN rather than a seat on `phoenix-notify-daily`. That bundle already carries its
 * sub-jobs against cron-job.org's unraisable 30-second cut, and this one has to be prompt: a held
 * change means the map is refusing writes, so the gap between the hold and the message is a window
 * in which an import quietly under-applies. Every few minutes, not daily.
 *
 * Safe to run as often as you like. `notified_at` is stamped only on a batch that actually reached
 * somebody, so a repeat run re-sends nothing, while a batch that reached nobody is deliberately
 * left for the next run rather than being marked done.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/mapping-guard-notify");
  if (denied) return denied;
  try {
    const result = await withDeadMansSwitch("phoenix-mapping-guard-notify", () => runMappingGuardNotify());
    return NextResponse.json({
      success: true,
      batches: result.batches,
      held: result.held,
      notified: result.notified,
      skipped: result.skipped,
      warnings: result.warnings,
    });
  } catch (error) {
    logError("Mapping guard notify failed", {
      labels: { event: "cron_failed", job: "mapping-guard-notify" },
      error,
    });
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error) }, { status: 500 });
  }
}
