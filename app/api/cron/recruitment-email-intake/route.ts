import { NextResponse } from "next/server";

import { isProductionRuntime } from "@/config/system-settings";
import { logCronUnauthorized, logError, logInfo, logWarning } from "@/lib/observability/log";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import {
  pollAllRecruitmentMailboxes,
  summarizePollFailures,
  type MailboxPollSummary,
} from "@/lib/recruitment/inbound/email-poller";
import { buildTodaysCvDigest, isDailyCvDigestTime } from "@/lib/recruitment/inbound/daily-cv-digest";
import { getInboundIntakeAnalytics, shouldAlertIntakeSpike } from "@/lib/recruitment/inbound/intake-analytics";
import {
  notifyDailyCvDigest,
  notifyInboundIntakeSpike,
  notifyWhatsAppIntakeUnhealthy,
} from "@/lib/recruitment/inbound/recruitment-notify";
import { checkWhatsAppIntakeHealth, type WhatsAppIntakeHealth } from "@/lib/recruitment/inbound/whatsapp-health";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { bearerSecretMatches } from "@/lib/security/constant-time";

const DEFAULT_SPIKE_THRESHOLD = 8;

// Best-effort surge guard: a burst of errors/dead-letters over the last hour means processing is
// systematically failing (vs one bad CV). Throttled to once/day inside the notify. Never fatal.
async function reportInboundIntakeSpike(): Promise<void> {
  const rawThreshold = Number(process.env.RECRUITMENT_INBOUND_SPIKE_THRESHOLD);
  const threshold = Number.isFinite(rawThreshold) && rawThreshold > 0 ? Math.floor(rawThreshold) : DEFAULT_SPIKE_THRESHOLD;
  const analytics = await getInboundIntakeAnalytics(1 / 24); // last hour
  if (shouldAlertIntakeSpike({ deadLettered: analytics.deadLettered, errors: analytics.errors, threshold })) {
    logError("Inbound CV intake error spike", {
      labels: { deadLettered: analytics.deadLettered, errors: analytics.errors, event: "inbound_intake_spike", job: "recruitment-email-intake" },
    });
    await notifyInboundIntakeSpike({ deadLettered: analytics.deadLettered, errors: analytics.errors, windowLabel: "hour" });
  }
}

/**
 * Best-effort daily summary of the day's CVs, in place of one alert per CV. Piggybacks here for the
 * same reason the WhatsApp health check does: cron-job.org is the live production scheduler and it
 * is owner-managed, so a new route would need a new entry created by hand before it ever fired,
 * whereas this job already runs every 10 minutes for the same channel.
 *
 * Gated to the one Cairo hour the digest sends in, so 138 of the day's 144 ticks skip it without a
 * single database round trip. The six ticks inside that hour all build the digest; only the first
 * one delivers, because the notification layer claims a Cairo-dated idempotency key atomically
 * (notifyDailyCvDigest documents exactly how). Never fatal — a summary that fails to send must not
 * turn the mailbox poll red.
 */
async function reportDailyCvDigest(): Promise<void> {
  if (!isDailyCvDigestTime()) return;
  const digest = await buildTodaysCvDigest();
  if (digest.total === 0) return;
  logInfo("Recruitment daily CV digest", {
    labels: {
      awaitingReview: digest.awaitingReview,
      dayKey: digest.dayKey,
      event: "recruitment_daily_cv_digest",
      job: "recruitment-email-intake",
      total: digest.total,
    },
  });
  await notifyDailyCvDigest(digest);
}

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
//
// Since 2026-08-15 it also carries the daily CV digest, for the same "no new infrastructure"
// reason — see reportDailyCvDigest below.
function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return !isProductionRuntime();
  return bearerSecretMatches(request.headers.get("authorization"), secret);
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
 * Only a DETERMINISTIC fault pages. `api_unreachable` (Meta rejects our credentials) and
 * `webhook_misrouted` (Meta is configured to deliver somewhere that is not us) are both facts about
 * the current configuration, checked directly, and both are actionable the moment they appear.
 *
 * `silent` is deliberately NOT in this set any more. Measured on production, this channel's normal
 * inbound gap has reached 333 hours against a 96-hour threshold - so silence fired for roughly ten
 * straight days in early August 2026 with nothing whatsoever wrong, and it is firing again now. An
 * alert that is on during normal operation cannot signal an outage; it only trains its reader to
 * ignore it, and the real 2026-07-26 block would have been invisible inside that noise. Silence is
 * still computed and still logged - as a WARNING, which does not page - because it remains useful
 * context once something else has drawn attention.
 */
const PAGING_STATUSES = new Set<WhatsAppIntakeHealth["status"]>(["api_unreachable", "webhook_misrouted"]);

/**
 * WhatsApp health is logged, never thrown. Failing this route on it would turn the email cron red
 * for a problem in a different channel and, worse, would stop reporting the mailbox result
 * accurately. logError emits an ERROR-severity Cloud Logging entry, which is what the production
 * error alert policy fires on.
 */
async function reportWhatsAppIntakeHealth(): Promise<WhatsAppIntakeHealth> {
  const health = await checkWhatsAppIntakeHealth();
  if (health.status === "silent") {
    logWarning("Inbound WhatsApp CV intake has been quiet", {
      labels: {
        event: "whatsapp_intake_quiet",
        hoursSinceLastInbound: health.hoursSinceLastInbound === null ? null : Math.floor(health.hoursSinceLastInbound),
        job: "recruitment-email-intake",
        routingOk: health.routing?.ok ?? null,
      },
    });
  }
  if (PAGING_STATUSES.has(health.status)) {
    logError("Inbound WhatsApp CV intake is not healthy", {
      context: {
        apiError: health.apiError,
        detail: health.detail,
        lastInboundAt: health.lastInboundAt,
        probes: health.probes,
        routing: health.routing,
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
    // phone, not just the log-based email alert. Best-effort — never let an alerting failure
    // break the poll.
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

  await reportInboundIntakeSpike().catch((error) => {
    logError("Inbound intake spike check failed to run", {
      error,
      labels: { event: "inbound_spike_check_failed", job: "recruitment-email-intake" },
    });
  });

  await reportDailyCvDigest().catch((error) => {
    logError("Daily CV digest failed to run", {
      error,
      labels: { event: "recruitment_daily_cv_digest_failed", job: "recruitment-email-intake" },
    });
  });

  try {
    // Slug matches the live Cloud Scheduler job name (phoenix-recruitment-email-intake).
    const summaries = await withDeadMansSwitch("phoenix-recruitment-email-intake", async () => {
      const result = await pollAllRecruitmentMailboxes();
      // Thrown, not returned: a mailbox that cannot be reached is a real outage of inbound CV
      // intake. Reporting it as a 200 success (the previous behaviour) is what let a dead
      // mailbox look healthy on every dashboard at once.
      const failures = summarizePollFailures(result);
      if (failures.length > 0) throw new RecruitmentIntakePollError(failures, result);
      return result;
    });

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
    const message = clientSafeErrorMessage(error, "Recruitment email-intake poll failed.");
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
