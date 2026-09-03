import { NextResponse } from "next/server";

import { failureDetail, pingDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError, logInfo } from "@/lib/observability/log";
import { sendCvIntakeDigest6h } from "@/lib/recruitment/inbound/cv-intake-digest-6h";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const JOB_SLUG = "phoenix-recruitment-cv-digest";

/**
 * Pinged directly rather than through `withDeadMansSwitch`, for the reason that wrapper's own
 * docstring gives: this route CATCHES its error and answers 500 instead of throwing, so the
 * wrapper would see a clean resolve and report a false success — a monitor that goes green on the
 * failure it exists to catch.
 *
 * `total === 0` is NOT a failure. The digest covers a 6-hour window and an empty window is the
 * normal night-time answer; pinging fail on it would make the check red most of every night and
 * teach whoever reads the dashboard that red means nothing here.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/recruitment-cv-digest");
  if (denied) return denied;

  try {
    const result = await sendCvIntakeDigest6h();

    if (result.total === 0) {
      logInfo("CV intake 6h digest: no CVs in window, nothing sent", {
        labels: { event: "cv_intake_digest_6h_empty", job: "phoenix-recruitment-cv-digest" },
      });
    }

    await pingDeadMansSwitch(JOB_SLUG, "success", `${result.total} CV(s) in the window`);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("CV intake 6h digest failed", {
      error,
      labels: { event: "cron_failed", job: "phoenix-recruitment-cv-digest" },
    });
    await pingDeadMansSwitch(JOB_SLUG, "fail", failureDetail(error));
    return NextResponse.json(
      { error: "cv_intake_digest_6h_failed", message: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
