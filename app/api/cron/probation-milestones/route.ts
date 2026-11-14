// On-demand trigger for the probation Day 30 / 60 / 75 milestone sweep.
//
// The sweep already runs every morning as its own job, `probation-milestone-emails` (07:28 Cairo,
// /api/cron/daily/probation-milestone-emails, heartbeat `phoenix-daily-probation-milestone-emails`).
// This route exists so it can also be run the moment it is needed, without waiting for the next morning.
//
// It is how the released catch-up was delivered on 2026-09-29 without waiting for the next
// morning (owner: "release the held probation milestones").
//
// It runs ONLY this sweep. (Before 13 Nov 2026 the alternative was the whole daily route, which would
// have re-fired about thirty other jobs; the morning job's own address runs only this sweep too, but
// under its heartbeat, so a hand run there would be counted as that morning's run.)
//
// This route is deliberately NOT declared in JOB_SCHEDULES: a declaration with no cron job behind it
// reads to job-heartbeat-assess as a job that has STOPPED and alarms every Super Admin for ever. This
// is a manual trigger, not a schedule; the schedule is the morning job's.
//
// Safe to call repeatedly: every email is keyed per (case, milestone), so a second call sends
// nothing — and a milestone an earlier recipient already received is not sent again.

import { NextResponse } from "next/server";

import { logError } from "@/lib/observability/log";
import { assertCronAuthorized } from "@/lib/security/cron-auth";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { processProbationMilestoneEmails } from "@/lib/probation/intelligence/milestone-emails";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function run(request: Request) {
  const denied = assertCronAuthorized(request, "cron/probation-milestones", {
    message: "Probation milestone sweep is not authorized.",
  });
  if (denied) return denied;

  try {
    const result = await processProbationMilestoneEmails();
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Probation milestone sweep failed", {
      labels: { event: "cron_failed", job: "cron/probation-milestones" },
      error,
    });
    return NextResponse.json(
      {
        success: false,
        error: "probation_milestone_sweep_failed",
        message: clientSafeErrorMessage(error, "Probation milestone sweep failed."),
      },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}
