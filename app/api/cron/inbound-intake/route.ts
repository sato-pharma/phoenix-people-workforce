import { NextResponse } from "next/server";

import { logError, logInfo } from "@/lib/observability/log";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { drainInboundIntake } from "@/lib/recruitment/inbound/intake-worker";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Drains the inbound-CV intake queue (ats_inbound_intake_queue). The WhatsApp webhook and the email
// poller only ENQUEUE; this worker does the media download + AI + candidate creation, with retries
// and dead-lettering. Runs frequently so a queued CV becomes a candidate within a couple of
// minutes. A clean no-op when the queue is empty.
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/inbound-intake");
  if (denied) return denied;
  try {
    const limit = Number(new URL(request.url).searchParams.get("limit"));
    const maxItems = Number.isFinite(limit) && limit > 0 ? Math.min(25, Math.floor(limit)) : undefined;
    // Slug matches the live Cloud Scheduler job name (phoenix-inbound-intake).
    const result = await withDeadMansSwitch("phoenix-inbound-intake", () => drainInboundIntake(maxItems));
    const deadLettered = result.results.filter((r) => r.status === "dead").length;
    if (result.processed > 0) {
      logInfo("Inbound intake queue drained", {
        labels: { deadLettered, event: "inbound_intake_drained", job: "inbound-intake", processed: result.processed },
      });
    }
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Inbound intake worker failed", {
      error,
      labels: { event: "cron_failed", job: "inbound-intake" },
    });
    const message = clientSafeErrorMessage(error, "Inbound intake worker failed.");
    return NextResponse.json({ error: "inbound_intake_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
