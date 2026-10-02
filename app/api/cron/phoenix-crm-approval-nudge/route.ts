import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { APPROVAL_NUDGE_JOB_SLUG } from "@/lib/phoenix-crm/approval-nudge-rules";
import { runPhoenixCrmApprovalNudge } from "@/lib/phoenix-crm/server/approval-nudge";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Phoenix CRM's daily nudge to a slow approver (owner, 2026-10-02), at 09:57 Cairo. Whoever has a list
 * request, an off-plan visit or a request to edit a week waiting on him for more than a day at his step
 * — the territory's district manager, or the SFE Manager — gets ONE message naming the counts by kind.
 * In-app, Telegram and push, never email. A morning with nothing overdue sends nothing, which is the
 * job working, not failing.
 *
 * Safe to fire twice: the key is per approver per Cairo day, so a second fire reaches only someone the
 * first one missed.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/phoenix-crm-approval-nudge");
  if (denied) return denied;
  try {
    const result = await withDeadMansSwitch(APPROVAL_NUDGE_JOB_SLUG, () => runPhoenixCrmApprovalNudge());
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Phoenix CRM approval nudge failed", {
      error,
      labels: { event: "cron_failed", job: APPROVAL_NUDGE_JOB_SLUG },
    });
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Phoenix CRM approval nudge failed.") }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
