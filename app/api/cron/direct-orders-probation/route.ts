import { NextResponse } from "next/server";

import { isProductionRuntime } from "@/config/system-settings";
import { systemAccessContext } from "@/lib/auth/permissions";
import { runDirectOrderProbationSweep } from "@/lib/direct-orders/pharmacy-probation";
import { sendDirectOrderPhantomReport } from "@/lib/direct-orders/phantom-report";
import { logCronUnauthorized, logError } from "@/lib/observability/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return !isProductionRuntime();
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * The 90-day probation sweep (spec A3 — docs/specs/direct-orders-v2.md).
 *
 * Daily: promote every provisional pharmacy that has earned a footprint (distributor sales or a
 * paid collection), and report the ones whose window closed in silence — by name, with the rep's
 * name — to the owner and the CEO.
 *
 * The report is only SENT when there is something to report. A daily "nothing to report" email
 * trains people to ignore the one that matters.
 */
export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    logCronUnauthorized("cron/direct-orders-probation", request);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await runDirectOrderProbationSweep(systemAccessContext);
    if (result.flagged.length > 0) {
      await sendDirectOrderPhantomReport(result.flagged);
    }
    return NextResponse.json({
      success: true,
      checked: result.checked,
      promoted: result.promoted.length,
      flagged: result.flagged.length,
    });
  } catch (error) {
    logError("Direct-order probation sweep failed", {
      labels: { event: "cron_failed", job: "direct-orders-probation" },
      error,
    });
    const message = error instanceof Error ? error.message : "Probation sweep failed.";
    return NextResponse.json({ error: "probation_sweep_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
