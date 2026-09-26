import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { runInterviewDigest } from "@/lib/recruitment/interview-digest";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The weekly recruitment-interview digest (owner, 2026-09-26): the week's interviews at a glance —
 * coming up, held, decided vs awaiting, attended vs did-not-come, and average days to a decision.
 * To the SUPER ADMIN(s) ONLY, in-app + Telegram, never e-mail and never the CEO. Sunday 08:00 Cairo.
 *
 * Safe to run more than once in the week: the digest carries a weekly idempotency key, so a repeat
 * tells nobody twice.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/interview-digest");
  if (denied) return denied;
  try {
    const result = await withDeadMansSwitch("phoenix-interview-digest", () => runInterviewDigest());
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Interview digest failed", { error, labels: { event: "cron_failed", job: "interview-digest" } });
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Interview digest failed.") }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
