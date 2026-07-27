import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";

import { isProductionRuntime } from "@/config/system-settings";
import { logCronUnauthorized, logError, logInfo } from "@/lib/observability/log";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import {
  pollAllRecruitmentMailboxes,
  summarizePollFailures,
  type MailboxPollSummary,
} from "@/lib/recruitment/inbound/email-poller";
import { notifyWhatsAppIntakeUnhealthy } from "@/lib/recruitment/inbound/recruitment-notify";
import { checkWhatsAppIntakeHealth, type WhatsAppIntakeHealth } from "@/lib/recruitment/inbound/whatsapp-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Fires every 10 minutes at :04/:14/.../:54 (Africa/Cairo) — collision-free against the other
// 5 scheduled jobs (see docs/deployment.md / scripts/setup-gcp-cron.sh). No mailboxes configured
// (RECRUITMENT_EMAIL_INBOXES_JSON unset) => a clean, cheap no-op every run, not an error.
//
// This job also carries the WhatsApp intake health check. WhatsApp has no cron of its own — the
// webhook only runs when Meta calls it, which is precisely why a Meta-side block on 2026-07-26
// went unnoticed for ~19 hours. Piggybacking on the one job that already runs every 10 minutes
// for the sibling inbound channel gives that blind spot 10-minute detection with no new
// infrastructure. It is reported separately from the mailbox result (see below), so a WhatsApp
// problem never disguises itself as an email-intake failure.
function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return !isProductionRuntime();
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

class RecruitmentIntakePollError extends Error {
  constructor(
    readonly failures: string[],
    readonly summaries: MailboxPollSummary[],
  ) {
    super(`Recruitment email intake failed for ${failures.length} mailbox/folder(s): ${failures.join("; ")}`);
    this.name = "RecruitmentIntakePollError";
  }
}

/**
 * WhatsApp health is logged, never thrown. Failing this route on it would turn the email cron red
 * for a problem in a different channel and, worse, would stop reporting the mailbox result
 * accurately. logError puts it in Sentry as its own issue, which is the thing that actually pages.
 */
async function reportWhatsAppIntakeHealth(): Promise<WhatsAppIntakeHealth> {
  const health = await checkWhatsAppIntakeHealth();
  if (health.status === "api_unreachable" || health.status === "silent") {
    logError("Inbound WhatsApp CV intake is not healthy", {
      context: {
        apiError: health.apiError,
        detail: health.detail,
        lastInboundAt: health.lastInboundAt,
        probes: health.probes,
      },
      labels: {
        event: "whatsapp_intake_unhealthy",
        hoursSinceLastInbound: health.hoursSinceLastInbound === null ? null : Math.floor(health.hoursSinceLastInbound),
        job: "recruitment-email-intake",
        numbersDown: health.probes.filter((probe) => !probe.ok).length,
        status: health.status,
      },
    });
    // Push to Telegram/OneSignal (throttled to once per status per Cairo day) so it reaches a
    // phone, not just Sentry. Best-effort — never let an alerting failure break the poll.
    await notifyWhatsAppIntakeUnhealthy(health).catch((error) => {
      logError("Failed to push WhatsApp intake health alert", {
        error,
        labels: { event: "whatsapp_intake_alert_failed", job: "recruitment-email-intake" },
      });
    });
  }
  return health;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    logCronUnauthorized("cron/recruitment-email-intake", request);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Runs regardless of how the mailbox poll goes, and can never fail the request — a broken
  // health probe must not become a third failure mode on top of the two it is watching.
  const whatsapp = await reportWhatsAppIntakeHealth().catch((error) => {
    logError("WhatsApp intake health check failed to run", {
      error,
      labels: { event: "whatsapp_health_check_failed", job: "recruitment-email-intake" },
    });
    return null;
  });

  try {
    // Slug matches the live Cloud Scheduler job name (phoenix-recruitment-email-intake).
    const summaries = await withDeadMansSwitch("phoenix-recruitment-email-intake", () =>
      Sentry.withMonitor(
        "recruitment-email-intake",
        async () => {
          const result = await pollAllRecruitmentMailboxes();
          // Thrown, not returned: a mailbox that cannot be reached is a real outage of inbound CV
          // intake. Reporting it as a 200 success (the previous behaviour) is what let a dead
          // mailbox look healthy on every dashboard at once.
          const failures = summarizePollFailures(result);
          if (failures.length > 0) throw new RecruitmentIntakePollError(failures, result);
          return result;
        },
        {
          checkinMargin: 15,
          maxRuntime: 5,
          schedule: { type: "crontab", value: "4-59/10 * * * *" },
          timezone: "Africa/Cairo",
        },
      ),
    );

    const backlog = summaries.some((mailbox) => mailbox.folders.some((folder) => folder.backlogRemaining));
    if (backlog) {
      logInfo("Recruitment email intake left a backlog for the next run", {
        labels: { event: "recruitment_email_intake_backlog", job: "recruitment-email-intake" },
      });
    }

    return NextResponse.json({ success: true, mailboxes: summaries, whatsapp });
  } catch (error) {
    logError("Recruitment email-intake poll failed", {
      error,
      labels: { event: "cron_failed", job: "recruitment-email-intake" },
    });
    const message = error instanceof Error ? error.message : "Recruitment email-intake poll failed.";
    return NextResponse.json(
      {
        error: "recruitment_email_intake_failed",
        mailboxes: error instanceof RecruitmentIntakePollError ? error.summaries : undefined,
        message,
        whatsapp,
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
