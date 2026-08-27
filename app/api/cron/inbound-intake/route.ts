import { NextResponse } from "next/server";

import { logCronUnauthorized, logError, logInfo } from "@/lib/observability/log";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { drainInboundIntake } from "@/lib/recruitment/inbound/intake-worker";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { bearerSecretMatches } from "@/lib/security/constant-time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Drains the inbound-CV intake queue (ats_inbound_intake_queue). The WhatsApp webhook and the email
// poller only ENQUEUE; this worker does the media download + AI + candidate creation, with retries
// and dead-lettering. Runs frequently so a queued CV becomes a candidate within a couple of
// minutes. A clean no-op when the queue is empty.
function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  // An unset CRON_SECRET may ONLY be bypassed on a real developer machine. Anything less
  // would leave this route callable unauthenticated wherever CRON_SECRET is unset —
  // including staging, which is a 1:1 clone of production data.
  if (!secret) return process.env.NODE_ENV === "development";
  return bearerSecretMatches(request.headers.get("authorization"), secret);
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    logCronUnauthorized("cron/inbound-intake", request);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
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
