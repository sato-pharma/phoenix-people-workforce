import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { DIGEST_JOB_SLUG } from "@/lib/phoenix-crm/digest-rules";
import { runPhoenixCrmDailyDigest } from "@/lib/phoenix-crm/server/daily-digest";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Phoenix CRM's 06:55 Cairo digest (owner, 2026-09-26): to each DISTRICT MANAGER, about the previous
 * field day, in-app and Telegram — never email, which the module blocks on its module key.
 *
 * 🔴 A CLEAN MANAGER IS TOLD NOTHING. Most mornings most managers hear nothing at all, and that is
 * the feature working, not the cron failing — the dead-man's switch is what proves it ran.
 *
 * It has its own clock rather than riding inside /api/notifications/daily, which cron-job.org cut
 * at 30 seconds: this reads the whole company's board, and one slow morning there must not take the
 * daily notifications down with it. (Since 13 Nov 2026 every morning job has its own clock too,
 * /api/cron/daily/<job>.)
 *
 * Safe to fire twice: the idempotency key is per manager per DAY, so a retry, a replay or a double
 * fire reaches nobody a second time.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/phoenix-crm-daily-digest");
  if (denied) return denied;
  try {
    const result = await withDeadMansSwitch(DIGEST_JOB_SLUG, () => runPhoenixCrmDailyDigest());
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Phoenix CRM daily digest failed", {
      error,
      labels: { event: "cron_failed", job: "phoenix-crm-daily-digest" },
    });
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Phoenix CRM daily digest failed.") }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
