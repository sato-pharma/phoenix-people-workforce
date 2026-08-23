import { NextResponse } from "next/server";

import { isProductionRuntime } from "@/config/system-settings";
import { systemAccessContext } from "@/lib/auth/permissions";
import { expireStaleHeldDirectOrders } from "@/lib/direct-orders/service";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logCronUnauthorized, logError } from "@/lib/observability/log";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { bearerSecretMatches } from "@/lib/security/constant-time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return !isProductionRuntime();
  return bearerSecretMatches(request.headers.get("authorization"), secret);
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
 *
 * WIRED TO THE DEAD-MAN'S-SWITCH 2026-08-23, after this clock ran dead for nine nights unseen.
 * `CRON_SECRET` was rotated on Railway on 2026-08-14; the GitHub Actions copy that
 * .github/workflows/direct-orders-sweeps.yml sends was never re-aligned, so every nightly run
 * 401'd from 2026-08-14 to 2026-08-22 and nobody was told. The workflow's own comment claims a red
 * run "emails the owner" — nine silent nights say otherwise, and a red run in a log nobody opens is
 * not an alert. Healthchecks alerts on the ping that DIDN'T arrive, so it catches the case the
 * workflow cannot report on: the request never reaching this handler at all.
 */
export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    logCronUnauthorized("cron/direct-orders-expire-held", request);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await withDeadMansSwitch("phoenix-direct-orders-expire-held", () =>
      expireStaleHeldDirectOrders(systemAccessContext),
    );
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Held direct-order expiry sweep failed", {
      labels: { event: "cron_failed", job: "direct-orders-expire-held" },
      error,
    });
    const message = clientSafeErrorMessage(error, "Expiry sweep failed.");
    return NextResponse.json({ error: "expire_held_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
