import { NextResponse } from "next/server";

import { afterResponse } from "@/lib/http/after-response";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError, logInfo } from "@/lib/observability/log";
import { runCommentReadingFire } from "@/lib/phoenix-crm/server/comment-reading";
import { runHeldSignboardRecheck } from "@/lib/phoenix-crm/server/signboard-holds";
import { runPhoenixCrmVisitRollup } from "@/lib/phoenix-crm/server/visit-rollup";
import { VISIT_ROLLUP_JOB_SLUG } from "@/lib/phoenix-crm/visit-rollup-rules";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/phoenix-crm-visit-rollup");
  if (denied) return denied;
  try {
    const result = await withDeadMansSwitch(VISIT_ROLLUP_JOB_SLUG, () => runPhoenixCrmVisitRollup());
    // The hourly re-read of places the door held on their signboard (owner, 2026-10-17: "Hold; re-read;
    // else you decide"). It rides this hourly fire rather than a cron of its own, and runs AFTER the
    // reply: it can take most of a minute, and neither the scheduler's timeout nor the roll-up's
    // dead-man's switch is ever made to wait on it. Its failure is logged and never fails the roll-up.
    await afterResponse("phoenix_crm_held_signboard_recheck", async () => {
      const recheck = await runHeldSignboardRecheck();
      logInfo("Phoenix CRM held signboards re-read", {
        labels: { event: "phoenix_crm_held_signboard_recheck" },
        context: { ...recheck },
      });
    });
    // The hourly read of new visit comments (owner, 2026-11-03: "build 3"), on the same terms: after the
    // reply, no cron of its own, and its failure is logged and never fails the roll-up.
    await afterResponse("phoenix_crm_comment_reading", async () => {
      const reading = await runCommentReadingFire();
      logInfo("Phoenix CRM visit comments read", {
        labels: { event: "phoenix_crm_comment_reading" },
        context: { ...reading },
      });
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Phoenix CRM visit rollup failed", {
      error,
      labels: { event: "cron_failed", job: "phoenix-crm-visit-rollup" },
    });
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Phoenix CRM visit rollup failed.") },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
