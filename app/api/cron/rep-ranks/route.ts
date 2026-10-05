import { NextResponse } from "next/server";

import { cairoTodayIso } from "@/lib/crm/dates";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { backfillRepRanksMonth, REP_RANKS_JOB_SLUG, runRepRanksNightly } from "@/lib/rep-ranks/server/compute";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// Phoenix Ranks, nightly at 04:17 Cairo: rebuilds every window that holds yesterday. cron-job.org
// cuts the request at 30 s; the server finishes the work and the dead-man's switch is the witness
// (docs/observability.md). `?backfill=YYYY-MM` rebuilds one past month instead — the same
// CRON_SECRET guard, run by hand once so a rep's timeline does not begin on the deploy date.
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/rep-ranks");
  if (denied) return denied;
  const backfill = new URL(request.url).searchParams.get("backfill");
  try {
    const todayIso = cairoTodayIso();
    if (backfill && MONTH.test(backfill)) {
      const result = await backfillRepRanksMonth({ month: backfill, todayIso });
      return NextResponse.json({ success: true, backfill, ...result });
    }
    const result = await withDeadMansSwitch(REP_RANKS_JOB_SLUG, () => runRepRanksNightly({ todayIso }));
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Phoenix Ranks nightly run failed", {
      error,
      labels: { event: "cron_failed", job: "rep-ranks" },
    });
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Phoenix Ranks run failed.") },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
