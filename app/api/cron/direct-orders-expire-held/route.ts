import { NextResponse } from "next/server";

import { isProductionRuntime } from "@/config/system-settings";
import { systemAccessContext } from "@/lib/auth/permissions";
import { expireStaleHeldDirectOrders } from "@/lib/direct-orders/service";
import { logCronUnauthorized, logError } from "@/lib/observability/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return !isProductionRuntime();
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * The held-order 14-day clock (spec B6 — docs/specs/direct-orders-v2.md).
 *
 * Daily sweep: any direct order still `held` 14 days after it was parked expires — logged,
 * evented, the requester notified. A held lane with no drain would grow into exactly the swamp
 * of unresolvable requests the owner is draining now; this keeps it a parking lot.
 *
 * Runs as the system context; each expiry is individually registry-gated (`expire_held`),
 * audited, and evented in the service.
 */
export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    logCronUnauthorized("cron/direct-orders-expire-held", request);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await expireStaleHeldDirectOrders(systemAccessContext);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Held direct-order expiry sweep failed", {
      labels: { event: "cron_failed", job: "direct-orders-expire-held" },
      error,
    });
    const message = error instanceof Error ? error.message : "Expiry sweep failed.";
    return NextResponse.json({ error: "expire_held_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
