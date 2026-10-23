import { NextResponse } from "next/server";

import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { pingDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError, logInfo } from "@/lib/observability/log";
import { sendCvIntakeDigest6h } from "@/lib/recruitment/inbound/cv-intake-digest-6h";
import { assertCronAuthorized } from "@/lib/security/cron-auth";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

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

    // The detail now says whether the loop finished. A deferred count is the READABLE form of the
    // failure that previously showed up as a STRAND — nothing written at all, because the handler
    // was torn down before this line (the 18:47 fire on 02 Oct 2026).
    await pingDeadMansSwitch(
      JOB_SLUG,
      "success",
      result.deferred > 0
        ? `${result.total} CV(s) in the window; ${result.recipientCount} sent, ${result.deferred} deferred to the next tick`
        : `${result.total} CV(s) in the window`,
    );
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("CV intake 6h digest failed", {
      error,
      labels: { event: "cron_failed", job: "phoenix-recruitment-cv-digest" },
    });
    await pingDeadMansSwitch(JOB_SLUG, "fail", describeThrown(error));
    return NextResponse.json(
      { error: "cv_intake_digest_6h_failed", message: clientSafeErrorMessage(error, "Unknown error") },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
