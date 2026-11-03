import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { runMarketingListCheck } from "@/lib/marketing-requests/crm-list-check";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Re-checks every validated marketing customer against the reps' Phoenix CRM lists (owner, 2026-11-03).
 *
 * Hourly because ten different paths write a rep's list, and a full pass over fewer than 120 customers
 * is cheap: this covers all ten with no hook in any of them, and a doctor who leaves a list is seen the
 * same hour. It sends nothing to anyone, writes nothing to Phoenix CRM and never blocks a request.
 *
 * cron-job.org cuts a request at 30 seconds. The work goes on after that; the heartbeat, not the
 * scheduler's colour, is the truth (docs/observability.md).
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/marketing-list-check");
  if (denied) return denied;
  try {
    const result = await withDeadMansSwitch("phoenix-marketing-list-check", () => runMarketingListCheck());
    return NextResponse.json({ checks: result.checks, customers: result.customers, success: true });
  } catch (error) {
    logError("Marketing list check failed", {
      error,
      labels: { event: "cron_failed", job: "marketing-list-check" },
    });
    const message = clientSafeErrorMessage(error, "Marketing list check failed.");
    return NextResponse.json({ error: "marketing_list_check_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
