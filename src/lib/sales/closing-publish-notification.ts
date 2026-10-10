// The "Monthly Closing published" email (owner decision, 2026-08-08). Recipients are resolved live
// against the organogram/HR data by closing-publish-recipients.ts; this module owns the content and
// the send. Built directly against the shared Phoenix email layout rather than the admin-configurable
// email-templates registry — this is a system-triggered domain announcement, not an HR-editable
// template, matching the existing pattern in src/lib/sales/sos-report-delivery.ts and
// src/lib/direct-orders/approved-email.ts.
//
// WHO GETS IT (owner, 2026-10-10: "when I publish the closing the email and telegram and in app goes
// to all in the published line"): everyone seated on the line — District Managers, regional managers
// and every rep — by that one shared email, and ALSO by an in-app notice and a Telegram message each
// (a rep with no Telegram linked simply gets the bell and the email). Telegram and in-app are
// addressed by HR_ID through the unified notification pipeline; the email stays the one shared
// message below, so the pipeline's own email channel is never asked for here (and
// closing-publish-channel-guard.ts stops its Telegram-failure fallback from sending a second copy).
//
// No sales figures appear in ANY of the three on purpose: this is ONE message reaching every person
// on the line at once (plus a fixed Cc/Bcc roster), and a number safe for one DM to see is not
// necessarily safe for a rep on another team. The action button routes through
// app/api/sales/monthly-closing/go/route.ts, which resolves each clicker's own correct destination
// (admin Matrix, portal tab, or their existing landing page) rather than embedding one link that
// only works for some of the recipients.

import { renderPhoenixMetadataTable, renderPhoenixMetadataTableText } from "@/emails/phoenix-email-layout";
import { sendTemplatedEmail } from "@/lib/email-templates/service";
import { formatPhoenixDateTime } from "@/lib/i18n/format";
import {
  CLOSING_PUBLISH_NOTIFICATION_EVENT,
  CLOSING_PUBLISH_NOTIFICATION_MODULE,
} from "@/lib/notifications/closing-publish-channel-guard";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { resolveClosingPublishRecipients } from "@/lib/sales/closing-publish-recipients";

/** Same env-var convention src/lib/notifications/email.ts's dashboardUrl uses, kept local: this is
 * the only CTA link this module builds, so a shared export would cost more than it saves. */
function appUrl(path: string) {
  const base = (process.env.NOTIFICATION_DASHBOARD_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, "");
  if (!base) return path;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function periodLabel(period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return period;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export type ClosingPublishNotificationResult = {
  sent: boolean;
  reason?: string;
  toCount: number;
  /** People addressed by the in-app notice and the Telegram message (0 when none resolved). */
  teamCount: number;
  ccCount: number;
  bccCount: number;
  warnings: string[];
};

async function notifyTeamInAppAndTelegram(args: {
  ctaHref: string;
  ctaPath: string;
  input: { line: string; period: string; publishedAt: string };
  label: string;
  subject: string;
  team: Array<{ hrId: string; name: string }>;
}): Promise<void> {
  const { ctaHref, ctaPath, input, label, subject, team } = args;
  if (team.length === 0) return;
  try {
    await createSystemNotificationForRecipients(
      {
        actionUrl: ctaPath,
        category: "general",
        // In-app and Telegram ONLY. The email is the shared message below; asking this pipeline for
        // email too would mail every person a second, separate copy.
        channels: ["in_app", "telegram"],
        eventType: CLOSING_PUBLISH_NOTIFICATION_EVENT,
        message: `The ${label} Monthly Closing for ${input.line} has been published. Open Phoenix Workforce to see your own figures.`,
        metadata: {
          idempotencyKey: `closing-published:${input.line}:${input.period}:${input.publishedAt}`,
          line: input.line,
          period: input.period,
        },
        module: CLOSING_PUBLISH_NOTIFICATION_MODULE,
        priority: "normal",
        // Telegram only takes an absolute button URL; with no app URL configured the button is left off.
        telegram: /^https?:\/\//i.test(ctaHref) ? { ctaLabel: "Open Phoenix Workforce", ctaUrl: ctaHref } : undefined,
        title: subject,
      },
      team.map((member) => member.hrId),
    );
  } catch (error) {
    logError("closing_published_team_notification_failed", {
      error,
      labels: { event: "closing_published_team_notification_failed" },
      context: { line: input.line, period: input.period, teamCount: team.length },
    });
  }
}

export async function notifyClosingPublished(input: {
  line: string;
  period: string;
  /** ISO instant this (line, period) was published — also the send's idempotency anchor, so a true
   * re-publish (fresh row after an unpublish) sends again, but a same-row no-op publish does not. */
  publishedAt: string;
}): Promise<ClosingPublishNotificationResult> {
  const { to, team, cc, bcc, warnings } = await resolveClosingPublishRecipients(input.line);

  const label = periodLabel(input.period);
  const subject = `${input.line} — ${label} Monthly Closing Published`;
  const ctaParams = new URLSearchParams({ line: input.line, period: input.period });
  const ctaPath = `/api/sales/monthly-closing/go?${ctaParams.toString()}`;
  const ctaHref = appUrl(ctaPath);

  // The in-app notice and the Telegram message go FIRST and independently of the email: they are
  // per person, need no address, and a failure of either must never stop the email (nor the other
  // way round). Awaited, never fire-and-forget, so a thrown error is logged against this publish.
  await notifyTeamInAppAndTelegram({ ctaHref, ctaPath, input, label, subject, team });

  if (to.length === 0) {
    return { sent: false, reason: "No active team member with a work email resolved for this line.", toCount: 0, teamCount: team.length, ccCount: cc.length, bccCount: bcc.length, warnings };
  }

  const metadataRows = [
    { label: "Line", value: input.line },
    { label: "Period", value: label },
    { label: "Published at", value: formatPhoenixDateTime(input.publishedAt) },
  ];

  // The wording lives in /admin/email-templates under "Monthly Closing Published". Only the
  // live values are supplied here; routing stays ours (replaceRecipients), because who receives
  // a closing is decided by the publish itself, not by the template's recipient rules.
  const result = await sendTemplatedEmail({
    context: {
      ctaLabel: "Open Phoenix Workforce",
      ctaUrl: ctaHref,
      detailsTable: renderPhoenixMetadataTable(metadataRows),
      detailsTableText: renderPhoenixMetadataTableText(metadataRows),
      line: input.line,
      periodLabel: label,
      subject,
      summary: `The ${label} Monthly Closing for ${input.line} has been published.`,
    },
    fallbackTo: to.map((recipient) => recipient.email),
    idempotencyKey: `closing-published:${input.line}:${input.period}:${input.publishedAt}`,
    origin: { eventType: "closing_published", module: "sales" },
    overrides: {
      bcc: bcc.map((recipient) => recipient.email),
      cc: cc.map((recipient) => recipient.email),
      replaceRecipients: true,
      to: to.map((recipient) => recipient.email),
    },
    templateKey: "monthly_closing_published",
  });

  return {
    sent: !result.skipped,
    reason: result.skipped ? result.reason : undefined,
    toCount: to.length,
    teamCount: team.length,
    ccCount: cc.length,
    bccCount: bcc.length,
    warnings,
  };
}
