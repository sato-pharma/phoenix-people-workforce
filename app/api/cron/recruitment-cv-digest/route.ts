import { NextResponse } from "next/server";

import { isProductionRuntime } from "@/config/system-settings";
import { logCronUnauthorized, logError, logInfo } from "@/lib/observability/log";
import { bearerSecretMatches } from "@/lib/security/constant-time";
import { sendCvIntakeDigest6h } from "@/lib/recruitment/inbound/cv-intake-digest-6h";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return !isProductionRuntime();
  return bearerSecretMatches(request.headers.get("authorization"), secret);
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    logCronUnauthorized("cron/recruitment-cv-digest", request);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

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
