import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { runPhoenixCrmFraudScan } from "@/lib/phoenix-crm/server/fraud-scan";
import { FRAUD_SCAN_JOB_SLUG } from "@/lib/phoenix-crm/server/fraud-scan-summary";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Phoenix CRM's weekly visit-fraud scan (owner, 2026-10-07): Thursday 07:00 Cairo, the integrity
 * board's flags for the completed Sat–Wed week, to the Super Admin and the SFE Managers, in-app and
 * Telegram — never email or push, which the module blocks for this event type.
 *
 * 🔴 IT JUDGES NOTHING OF ITS OWN. It summarises the flags the GPS detector and the nightly photo
 * sweep already filed; it re-runs no detector and sets no threshold. Golden Rule #1 holds: the
 * audience is the two admin roles and the rep is never told anything.
 *
 * Unlike the 06:55 manager digest it reports a clean week too — weekly, to two admin roles, a report
 * that only appears with bad news cannot be told apart from one that stopped. The dead-man's switch
 * proves it ran either way.
 *
 * Safe to fire twice: the idempotency key is per recipient per WEEK, so a retry or double fire
 * reaches nobody a second time.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/phoenix-crm-fraud-scan");
  if (denied) return denied;
  try {
    const result = await withDeadMansSwitch(FRAUD_SCAN_JOB_SLUG, () => runPhoenixCrmFraudScan());
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Phoenix CRM fraud scan failed", {
      error,
      labels: { event: "cron_failed", job: "phoenix-crm-fraud-scan" },
    });
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Phoenix CRM fraud scan failed.") }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
