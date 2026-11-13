import { NextResponse } from "next/server";

import { logInfo } from "@/lib/observability/log";
import { DAILY_JOBS, dailyJobCairoTime, dailyJobPath } from "@/lib/scheduled-jobs/daily-jobs";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * RETIRED 13 Nov 2026 — this route runs NOTHING now, on purpose.
 *
 * It used to run the Needs You daily digest and then about thirty unrelated morning jobs at once, in
 * one request at 06:36 Cairo, under one heartbeat (`phoenix-notify-daily`). The owner chose that each
 * job gets its own schedule (enterprise audit F-HR-012 / REC-049): every job now runs on its own
 * address, `/api/cron/daily/<job>`, on its own cron-job.org entry and minute, with its own heartbeat
 * (src/lib/scheduled-jobs/daily-jobs.ts, app/api/cron/daily/[job]/route.ts).
 *
 * WHY IT STILL ANSWERS. Two schedulers this repository does not manage still call it: cron-job.org
 * job `8200909` (06:36 Cairo, made by hand, not in scripts/cronjob-sync.mjs) and the `phoenix-cron`
 * fallback service in .railway/railway.ts. An error here would put a red on every morning for work
 * that now happens elsewhere, so it answers 200 and says where the jobs went.
 *
 * 🔴 NEVER MAKE IT RUN A JOB AGAIN. Every job here also has its own schedule, so anything this route
 * ran would run twice a morning. `tests/daily-jobs-split.test.ts` fails the PR if it imports any of
 * the job functions. Retire the two callers above, then this file.
 */
async function answerRetired(request: Request) {
  const denied = assertCronAuthorized(request, "notifications/daily", {
    message: "Daily notification run is not authorized.",
  });
  if (denied) return denied;

  // Logged so the two stale callers above can be found and switched off: their fires land here.
  logInfo("The retired daily fan-out was called; it ran nothing (each morning job has its own schedule now)", {
    labels: { event: "retired_route_called", job: "notifications/daily" },
  });

  return NextResponse.json({
    jobs: DAILY_JOBS.map((job) => ({ cairoTime: dailyJobCairoTime(job), job: job.key, name: job.name, path: dailyJobPath(job.key) })),
    message:
      "Nothing was run. Since 13 Nov 2026 each morning job runs on its own schedule at /api/cron/daily/<job>, " +
      "with its own heartbeat; this address is retired and only answers so its old scheduler does not record a failure.",
    ran: 0,
    retired: true,
  });
}

export async function GET(request: Request) {
  return answerRetired(request);
}

export async function POST(request: Request) {
  return answerRetired(request);
}
