import { NextResponse } from "next/server";

import { isProductionRuntime } from "@/config/system-settings";
import { rotateMarketingSheetToken } from "@/lib/marketing-requests/sheet-token-rotation";
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
 * Rotate the marketing live sheet's feed token — the counterpart to
 * cron/direct-orders-rotate-sheet-token.
 *
 * WHY MARKETING NEEDED THIS. Direct orders has rotated automatically since it shipped; marketing
 * did not, and on 2026-08-05 the difference showed. check:schema-shape found
 * marketing_request_report_share_links reachable by `anon` with RLS disabled, so its `token`
 * column had been publicly readable — the secret that reads every marketing request in scope and
 * opens the evidence photographs. Revoking the grant stopped the bleeding but could not un-expose
 * the token, and with no rotation path the owner had to paste a new one into the Apps Script by
 * hand while the sheet sat dead. This route removes that failure mode.
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
    logCronUnauthorized("cron/marketing-requests-rotate-sheet-token", request);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await rotateMarketingSheetToken();
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Marketing sheet token rotation failed", {
      labels: { event: "marketing_sheet_rotation_failed" },
      error,
    });
    return NextResponse.json({ success: false, error: "rotation_failed" }, { status: 500 });
  }
}
