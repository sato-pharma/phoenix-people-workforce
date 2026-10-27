import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { runTouchTrailArchive } from "@/lib/phoenix-crm/server/touch-trail-archive";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Phoenix CRM's nightly touch-trail archive — 04:37 Cairo (owner, 2026-10-27: "Archive after 30 days").
 *
 * Every touch older than 30 days is written to a gzipped file in a private bucket, the file is read
 * BACK and checked, and only then are exactly those ids deleted from the database. The rules are in
 * `src/lib/phoenix-crm/touch-trail-archive.ts`.
 *
 * IT SENDS NOTHING AND TELLS NOBODY — the trail is the Super Admin's alone (Golden Rule #1), and the
 * archive is one more place a rep never learns exists.
 *
 * Why 04:37: the field is asleep, the 03:35 photo sweep has finished, and the minute is one no other
 * job in the account holds, so a red execution names one job.
 *
 * Safe to fire twice and safe to stop half-way: the rows still in the table are the work left.
 * `?dryRun=1` names the day that is due and how many rows its first file would hold, and writes nothing.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/phoenix-crm-touch-trail-archive");
  if (denied) return denied;
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  try {
    if (dryRun) return NextResponse.json({ success: true, ...(await runTouchTrailArchive({ dryRun: true })) });
    // `signalStart`: a run a deploy cut off mid-file reads "started, never finished" at the switch.
    const result = await withDeadMansSwitch("phoenix-crm-touch-trail-archive", () => runTouchTrailArchive(), {
      signalStart: true,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Phoenix CRM touch trail archive failed", {
      error,
      labels: { event: "cron_failed", job: "phoenix-crm-touch-trail-archive" },
    });
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Phoenix CRM touch trail archive failed.") },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
