import { NextResponse } from "next/server";

import { logError, logInfo } from "@/lib/observability/log";
import { sendCvIntakeDigest6h } from "@/lib/recruitment/inbound/cv-intake-digest-6h";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("CV intake 6h digest failed", {
      error,
      labels: { event: "cron_failed", job: "phoenix-recruitment-cv-digest" },
    });
    return NextResponse.json(
      { error: "cv_intake_digest_6h_failed", message: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
