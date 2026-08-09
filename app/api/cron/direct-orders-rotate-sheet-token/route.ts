import { NextResponse } from "next/server";

import { isProductionRuntime } from "@/config/system-settings";
import { rotateDirectOrderSheetToken } from "@/lib/direct-orders/sheet-token-rotation";
import { logCronUnauthorized, logError } from "@/lib/observability/log";
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
 * Rotate the live sheet's feed token (spec D5e hardening).
 *
 * The Apps Script that drives the owner's sheet is committed to this repository, so the token it
 * starts life with is in git history permanently. Rotation makes that harmless: the live token moves
 * into a Script Property that is committed nowhere, and the bootstrap value is revoked.
 *
 * Safe to run on a schedule and safe to run twice. The old token is revoked ONLY after the sheet
 * confirms it has stored the new one, so an unreachable sheet leaves everything working on the old
 * token rather than stranding the owner with a report that can no longer read anything.
 *
 * Returns 200 with `{ rotated: false, reason }` when there is nothing to do — a no-op is a normal
 * outcome here, not a failure, and returning non-200 for it would train whoever schedules this to
 * ignore genuine errors.
 */
export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    logCronUnauthorized("cron/direct-orders-rotate-sheet-token", request);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await rotateDirectOrderSheetToken();
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Direct Orders sheet token rotation failed", {
      labels: { event: "direct_order_sheet_rotation_failed" },
      error,
    });
    return NextResponse.json({ success: false, error: "rotation_failed" }, { status: 500 });
  }
}
