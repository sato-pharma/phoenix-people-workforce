import { NextResponse } from "next/server";

import { runHireHandoffReconciler } from "@/lib/employees/hire-handoff-reconciler";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Finish every new hire's hand-off (enterprise audit 2026-11-13, REC-027).
 *
 * Hourly. Reads `hire_handoff_steps` for steps the two hiring doors left failed, or pending for more
 * than half an hour (a door that crashed mid-way), and re-runs each due one through the same
 * idempotent write the door made — at most 25 a run, inside a 40-second budget, waiting 15 minutes,
 * then 30, 1 hour, 2 hours and at most 6 hours between attempts. A step that fails its fifth attempt,
 * or can never succeed (an offer letter that names someone else), is marked `gave_up` and shows on
 * the Needs You board by the employee's name. A job lease keeps two runs from retrying one step at
 * once. It sends no email of its own: a retried step sends only what it always sent (the mailbox
 * task's notice is in-app and Telegram, idempotent per hire).
 *
 * Silent when there is nothing to retry. Logic: `src/lib/employees/hire-handoff-reconciler.ts`.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/hire-handoff-reconcile");
  if (denied) return denied;
  try {
    const result = await withDeadMansSwitch("phoenix-hire-handoff-reconcile", () => runHireHandoffReconciler());
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Hire hand-off reconciler failed", {
      error,
      labels: { event: "cron_failed", job: "hire-handoff-reconcile" },
    });
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Hire hand-off reconciler failed.") },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
