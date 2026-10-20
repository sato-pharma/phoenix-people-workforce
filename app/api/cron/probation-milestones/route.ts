// On-demand trigger for the probation Day 30 / 60 / 75 milestone sweep.
//
// The sweep already rides the daily notifications cron (06:36 Cairo). This route exists so it can
// also be run the moment it is needed, without waiting for the next morning.
//
// It is how the released catch-up was delivered on 2026-09-29 without waiting for the next
// morning (owner: "release the held probation milestones").
//
// It runs ONLY this sweep. Calling the whole daily route instead would re-fire the other 29
// sub-jobs, several of which are idempotent per Cairo day and had already run.
//
// Deliberately NOT declared in JOB_SCHEDULES: a declaration with no cron job behind it reads to
// job-heartbeat-assess as a job that has STOPPED and alarms every Super Admin for ever. This is a
// manual trigger, not a schedule.
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
