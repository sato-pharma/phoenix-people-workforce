import { NextResponse } from "next/server";

import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { pingDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { notifyGithubWorkflows } from "@/lib/observability/github-workflow-watch-alert";
import { assessGithubWorkflows, readGithubWorkflowRuns } from "@/lib/observability/github-workflow-watch";
import { readJobHeartbeats } from "@/lib/observability/job-heartbeat";
import { logError } from "@/lib/observability/log";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const JOB_SLUG = "phoenix-github-workflow-watch";

/**
 * Hourly: when did each check on GitHub last succeed (owner, 2026-11-03). The verdict and the reasons
 * for it are in src/lib/observability/github-workflow-watch.ts.
 *
 * The switch is pinged directly, never through withDeadMansSwitch, which would report success on a run
 * that returned having seen nothing. `?dryRun=1` reads GitHub and reports, with no alert and no ping.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/github-workflow-watch");
  if (denied) return denied;
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  try {
    const previous = (await readJobHeartbeats()).find((row) => row.slug === JOB_SLUG) ?? null;
    const token = process.env.GITHUB_ACTIONS_DISPATCH_TOKEN?.trim() ?? "";
    const reads = token ? await readGithubWorkflowRuns(token) : [];
    const verdict = assessGithubWorkflows({
      firstSeenAt: previous?.firstSeenAt ?? null,
      nowMs: Date.now(),
      previousDetail: previous?.lastDetail ?? null,
      reads,
      tokenSet: Boolean(token),
    });
    if (dryRun) return NextResponse.json({ dryRun: true, success: true, ...verdict });

    const alert = await notifyGithubWorkflows(verdict);
    // An overdue check nobody was told about is not a clean run of this job.
    const alertLost = alert.skipped && alert.reason !== "healthy";
    await pingDeadMansSwitch(
      JOB_SLUG,
      verdict.outcome === "fail" || alertLost ? "fail" : "success",
      alertLost ? `The overdue alert did not go out (${alert.reason}). ${verdict.detail}` : verdict.detail,
    );
    return NextResponse.json({ alert, success: true, ...verdict });
  } catch (error) {
    logError("GitHub workflow watch failed", {
      error,
      labels: { event: "cron_failed", job: "github-workflow-watch" },
    });
    await pingDeadMansSwitch(JOB_SLUG, "fail", describeThrown(error));
    return NextResponse.json({ error: "watch_failed", success: false }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
