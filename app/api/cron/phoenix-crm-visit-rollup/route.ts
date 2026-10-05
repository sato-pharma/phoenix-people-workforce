import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
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
