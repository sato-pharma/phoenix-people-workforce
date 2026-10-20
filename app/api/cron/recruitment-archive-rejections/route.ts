import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { archiveOldRejections } from "@/lib/recruitment/workspace/archive";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Archive every CV rejected more than 30 days ago (owner's plan, Phase 4, 20 Oct 2026) — measured
 * from the rejection, never from arrival.
 *
 * Daily, 03:29 Cairo. ARCHIVES, NEVER DELETES: the row leaves the default lists and the Archived
 * filter still shows it. A manager's Skip still waiting in the Returned filter is left alone. Sends
 * nothing to anybody.
 *
 * `?dryRun=1` reports what would be archived and writes nothing.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/recruitment-archive-rejections");
  if (denied) return denied;
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  try {
    const result = dryRun
      ? await archiveOldRejections({ dryRun: true })
      : await withDeadMansSwitch("phoenix-recruitment-archive-rejections", () => archiveOldRejections());
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Recruitment rejection auto-archive failed", {
      error,
      labels: { event: "cron_failed", job: "recruitment-archive-rejections" },
    });
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Archiving old rejections failed.") },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
