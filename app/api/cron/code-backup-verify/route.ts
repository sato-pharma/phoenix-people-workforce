import { NextResponse } from "next/server";

import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { assessCodeBackup, readCodeBackupFiles } from "@/lib/observability/code-backup-verify";
import { pingDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const JOB_SLUG = "phoenix-code-backup-verify";

/**
 * Daily: is the newest code backup on Drive recent and the right size. The verdict is in
 * src/lib/observability/code-backup-verify.ts. A failed ping is the alarm: the existing sweep carries it.
 * `?dryRun=1` reads Drive and reports, with no ping.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/code-backup-verify");
  if (denied) return denied;
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  try {
    const verdict = assessCodeBackup(await readCodeBackupFiles(), Date.now());
    if (dryRun) return NextResponse.json({ dryRun: true, success: true, ...verdict });
    await pingDeadMansSwitch(JOB_SLUG, verdict.outcome, verdict.detail);
    return NextResponse.json({ success: true, ...verdict });
  } catch (error) {
    logError("Code backup check failed", {
      error,
      labels: { event: "cron_failed", job: "code-backup-verify" },
    });
    if (!dryRun) await pingDeadMansSwitch(JOB_SLUG, "fail", `Google Drive could not be read. ${describeThrown(error)}`);
    return NextResponse.json({ error: "check_failed", success: false }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
