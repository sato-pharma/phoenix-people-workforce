// The "Monthly Closing published" email (owner decision, 2026-08-08). Recipients are resolved live
// against the organogram/HR data by closing-publish-recipients.ts; this module owns the content and
// the send. Built directly against the shared Phoenix email layout rather than the admin-configurable
// email-templates registry — this is a system-triggered domain announcement, not an HR-editable
// template, matching the existing pattern in src/lib/sales/sos-report-delivery.ts and
// src/lib/direct-orders/approved-email.ts.
//
// No sales figures appear in the body on purpose: this is ONE shared email reaching every District
// Manager on the line at once (plus a fixed Cc/Bcc roster), and a number safe for one DM to see is
// not necessarily safe for another. The action button routes through
// app/api/sales/monthly-closing/go/route.ts, which resolves each clicker's own correct destination
// (admin Matrix, portal tab, or their existing landing page) rather than embedding one link that
// only works for some of the recipients.

import { escapeEmailHtml, renderPhoenixEmailHtml, renderPhoenixEmailText } from "@/emails/phoenix-email-layout";
import { sendPhoenixEmail } from "@/lib/email/send-phoenix-email";
import { formatPhoenixDateTime } from "@/lib/i18n/format";
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
  ccCount: number;
  bccCount: number;
  warnings: string[];
};

export async function notifyClosingPublished(input: {
  line: string;
  period: string;
  /** ISO instant this (line, period) was published — also the send's idempotency anchor, so a true
   * re-publish (fresh row after an unpublish) sends again, but a same-row no-op publish does not. */
  publishedAt: string;
}): Promise<ClosingPublishNotificationResult> {
  const { to, cc, bcc, warnings } = await resolveClosingPublishRecipients(input.line);
  if (to.length === 0) {
    return { sent: false, reason: "No active District Manager resolved for this line.", toCount: 0, ccCount: cc.length, bccCount: bcc.length, warnings };
  }

  const label = periodLabel(input.period);
  const subject = `${input.line} — ${label} Monthly Closing Published`;
  const ctaParams = new URLSearchParams({ line: input.line, period: input.period });
  const ctaHref = `${appUrl("/api/sales/monthly-closing/go")}?${ctaParams.toString()}`;

  const lineEsc = escapeEmailHtml(input.line);
  const bodyHtml =
    `<p>The <strong>${escapeEmailHtml(label)}</strong> Monthly Closing for <strong>${lineEsc}</strong> has been published and is now live in Phoenix Workforce.</p>` +
    `<p>District Managers can review their own areas in the employee portal. Admin and product roles can open the full Closing Matrix.</p>`;
  const bodyText =
    `The ${label} Monthly Closing for ${input.line} has been published and is now live in Phoenix Workforce.\n\n` +
    `District Managers can review their own areas in the employee portal. Admin and product roles can open the full Closing Matrix.`;

  const metadataRows = [
    { label: "Line", value: input.line },
    { label: "Period", value: label },
    { label: "Published at", value: formatPhoenixDateTime(input.publishedAt) },
  ];
  const action = { href: ctaHref, label: "Open Phoenix Workforce" };
  const greeting = `Dear ${input.line} Leaders,`;

  const html = renderPhoenixEmailHtml({
    action,
    bodyHtml,
    closingText: "Please log in to review the details.",
    greeting,
    metadataRows,
    previewText: `${input.line} ${label} Monthly Closing is now published.`,
    subject,
    subtitle: `${input.line} · ${label}`,
    title: "Monthly Closing Published",
  });
  const text = renderPhoenixEmailText({
    action,
    bodyText,
    closingText: "Please log in to review the details.",
    greeting,
    metadataRows,
    title: "Monthly Closing Published",
  });

  const result = await sendPhoenixEmail({
    bcc: bcc.map((recipient) => recipient.email),
    cc: cc.map((recipient) => recipient.email),
    html,
    idempotencyKey: `closing-published:${input.line}:${input.period}:${input.publishedAt}`,
    origin: { eventType: "closing_published", module: "sales" },
    subject,
    text,
    to: to.map((recipient) => recipient.email),
  });

  return {
    sent: !result.skipped,
    reason: result.skipped ? result.reason : undefined,
    toCount: to.length,
    ccCount: cc.length,
    bccCount: bcc.length,
    warnings,
  };
}
