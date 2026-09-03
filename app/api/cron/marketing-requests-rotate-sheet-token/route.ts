import { NextResponse } from "next/server";

import { rotateMarketingSheetToken } from "@/lib/marketing-requests/sheet-token-rotation";
import { failureDetail, pingDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Healthchecks slug, `phoenix-<route>` like every other watched cron route.
 *
 * cron-job.org job 8313171, created 2026-08-23: **Fridays 03:43 Africa/Cairo** (`43 3 * * 5`), GET,
 * 30s request timeout — twenty minutes behind its direct-orders counterpart so the two never
 * overlap (each waits on a Google Apps Script round-trip and is allowed 60s by `maxDuration`, well
 * past the 30s at which cron-job.org gives up on the request). Before that job existed
 * nothing called this route on any schedule: the live feed token was minted 2026-08-05, the same
 * day the exposure that motivated this rotation path was found, and never rotated again.
 */
const JOB_SLUG = "phoenix-marketing-requests-rotate-sheet-token";

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
 *
 * THE HTTP CONTRACT AND THE SWITCH DELIBERATELY DISAGREE, AND BOTH ARE RIGHT — the reasoning is
 * identical to the direct-orders counterpart, see that route's own comment. In production every
 * path that yields `rotated: false` is something a person has to fix, and a successful rotation
 * always leaves exactly one live link behind, so the steady state is `rotated: true` every week.
 * `withDeadMansSwitch` reads throw/no-throw and so cannot say that; the outcome is derived here.
 * It matters more here than anywhere: this token opens every marketing request in scope AND the
 * evidence photographs, and it is the one that was found publicly readable on 2026-08-05.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/marketing-requests-rotate-sheet-token");
  if (denied) return denied;
  try {
    const result = await rotateMarketingSheetToken();
    await pingDeadMansSwitch(
      JOB_SLUG,
      result.rotated ? "success" : "fail",
      result.rotated ? undefined : `the token was not rotated: ${result.reason}`,
    );
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Marketing sheet token rotation failed", {
      labels: { event: "marketing_sheet_rotation_failed" },
      error,
    });
    // A throw never reaches the ping above, and that is the case the external monitor exists for:
    // nothing about this run's outcome would otherwise leave the app at all.
    await pingDeadMansSwitch(
      JOB_SLUG,
      "fail",
      failureDetail(error),
    );
    return NextResponse.json({ success: false, error: "rotation_failed" }, { status: 500 });
  }
}
