import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { PLAN_REMINDER_JOB_SLUG } from "@/lib/phoenix-crm/plan-reminder-rules";
import { runPhoenixCrmPlanReminder } from "@/lib/phoenix-crm/server/plan-reminder";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Phoenix CRM's "your coming week is not sent" reminder (owner, 2026-10-02), at 12:57 and 17:57 Cairo.
 * It goes to the rep and to his district manager, in the teams that have started. It speaks only from
 * the day the week is due until the day before it starts. On every other day it reads nothing and
 * sends nothing, which is the job working, not failing.
 *
 * Safe to fire twice: the keys are per person per week per Cairo day, so the second tick reaches only
 * someone the first one missed.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/phoenix-crm-plan-reminder");
  if (denied) return denied;
  try {
    const result = await withDeadMansSwitch(PLAN_REMINDER_JOB_SLUG, () => runPhoenixCrmPlanReminder());
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Phoenix CRM plan reminder failed", {
      error,
      labels: { event: "cron_failed", job: PLAN_REMINDER_JOB_SLUG },
    });
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Phoenix CRM plan reminder failed.") }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
