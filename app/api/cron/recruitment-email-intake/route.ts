import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";

import { isProductionRuntime } from "@/config/system-settings";
import { logCronUnauthorized, logError } from "@/lib/observability/log";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { pollAllRecruitmentMailboxes } from "@/lib/recruitment/inbound/email-poller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Fires every 10 minutes at :04/:14/.../:54 (Africa/Cairo) — collision-free against the other
// 5 scheduled jobs (see docs/deployment.md / scripts/setup-gcp-cron.sh). No mailboxes configured
// (RECRUITMENT_EMAIL_INBOXES_JSON unset) => a clean, cheap no-op every run, not an error.
function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return !isProductionRuntime();
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    logCronUnauthorized("cron/recruitment-email-intake", request);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    // Slug matches the live Cloud Scheduler job name (phoenix-recruitment-email-intake).
    const summaries = await withDeadMansSwitch("phoenix-recruitment-email-intake", () =>
      Sentry.withMonitor(
        "recruitment-email-intake",
        () => pollAllRecruitmentMailboxes(),
        {
          checkinMargin: 15,
          maxRuntime: 5,
          schedule: { type: "crontab", value: "4-59/10 * * * *" },
          timezone: "Africa/Cairo",
        },
      ),
    );
    return NextResponse.json({ success: true, mailboxes: summaries });
  } catch (error) {
    logError("Recruitment email-intake poll failed", {
      error,
      labels: { event: "cron_failed", job: "recruitment-email-intake" },
    });
    const message = error instanceof Error ? error.message : "Recruitment email-intake poll failed.";
    return NextResponse.json({ error: "recruitment_email_intake_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
