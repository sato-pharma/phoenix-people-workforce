import { NextResponse } from "next/server";

import { rotateDirectOrderSheetToken } from "@/lib/direct-orders/sheet-token-rotation";
import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { pingDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Healthchecks slug, `phoenix-<route>` like every other watched cron route.
 *
 * cron-job.org job 8313169, created 2026-08-23: **Fridays 03:23 Africa/Cairo** (`23 3 * * 5`), GET,
 * 30s request timeout. Weekly, on the Egyptian weekend, on purpose — rotation is cheap and safely
 * repeatable, but every run is one more chance to disturb the owner's live sheet, so it happens
 * when nobody is reading it. Before that job existed nothing called this route on any schedule at
 * all: the live feed token was minted 2026-08-05 and sat unrotated for 18 days while the code
 * written to rotate it looked perfectly healthy.
 */
const JOB_SLUG = "phoenix-direct-orders-rotate-sheet-token";

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
 *
 * THE HTTP CONTRACT AND THE SWITCH DELIBERATELY DISAGREE, AND BOTH ARE RIGHT.
 * `rotated: false` stays HTTP 200 for the reason above. But it is pinged as a FAILURE, because in
 * production every path that produces it is something a person has to fix: the webhook variables
 * are set, so "not configured" means somebody unset them; "no live feed link" means the owner's
 * report is dead; "more than one live feed link" needs a human to resolve the ambiguity; and "the
 * sheet never read with the new token" means the rotation did not happen. A successful rotation
 * always leaves exactly one live link behind, so the steady state is `rotated: true` every week —
 * there is no benign `false` to tolerate. `withDeadMansSwitch` cannot express that (it reads
 * throw/no-throw), so the outcome is derived here instead, as the morning jobs' route (cron/daily/[job]) does. Otherwise
 * this route could no-op every Friday for a year with a green check above it, which is precisely
 * the shape of the 18 silent days that preceded the schedule.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/direct-orders-rotate-sheet-token");
  if (denied) return denied;
  try {
    const result = await rotateDirectOrderSheetToken();
    await pingDeadMansSwitch(
      JOB_SLUG,
      result.rotated ? "success" : "fail",
      result.rotated ? undefined : `the token was not rotated: ${result.reason}`,
    );
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Direct Orders sheet token rotation failed", {
      labels: { event: "direct_order_sheet_rotation_failed" },
      error,
    });
    // A throw never reaches the ping above, and that is the case the external monitor exists for:
    // nothing about this run's outcome would otherwise leave the app at all.
    await pingDeadMansSwitch(
      JOB_SLUG,
      "fail",
      describeThrown(error),
    );
    return NextResponse.json({ success: false, error: "rotation_failed" }, { status: 500 });
  }
}
