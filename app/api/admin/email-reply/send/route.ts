import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  invalidCommunicationEmails,
} from "@/lib/communication/metrics";
import { assertReachableEmailImage, validateManualEmailRecipientPolicy } from "@/lib/email/email-safety";
import {
  buildComposerIdempotency,
  composerHtmlToText,
  emailSignatureUrl,
  interpolateComposerHtml,
  interpolateComposerText,
  normalizeComposerBody,
  recordManualEmailSendAudit,
  resolveComposerRecipients,
  type ComposerPayload,
} from "@/lib/email/email-composer-service";
import { sendPhoenixEmail } from "@/lib/email/send-phoenix-email";
import { buildPhoenixHrReplyEmail } from "@/lib/email/phoenix-hr-reply-template";
import { emailNotificationsEnabled } from "@/lib/notifications/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function sendEmail({
  bcc,
  cc,
  html,
  idempotencyKey,
  subject,
  text,
  to,
}: {
  bcc: string[];
  cc: string[];
  html: string;
  idempotencyKey: string;
  subject: string;
  text: string;
  to: string[];
}) {
  if (!emailNotificationsEnabled()) {
    return { reason: "EMAIL_NOTIFICATIONS_ENABLED is not true.", skipped: true as const };
  }

  const from = process.env.HR_REPLY_EMAIL_FROM || process.env.NOTIFICATION_EMAIL_FROM;

  if (!from) return { reason: "HR_REPLY_EMAIL_FROM or NOTIFICATION_EMAIL_FROM is missing.", skipped: true as const };

  return sendPhoenixEmail({ bcc, cc, from, html, idempotencyKey, subject, text, to });
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "communication", "update");

    const body = (await request.json().catch(() => ({}))) as ComposerPayload;
    const normalized = normalizeComposerBody(body);
    const resolved = await resolveComposerRecipients(body);
    const to = resolved.emails.to;
    const cc = resolved.emails.cc;
    const bcc = resolved.emails.bcc;
    const subject = interpolateComposerText(normalized.subject, resolved.context);
    const replyMessage = interpolateComposerText(normalized.replyMessage, resolved.context);
    const replyMessageHtml = interpolateComposerHtml(normalized.replyMessageHtml, resolved.context);
    const recipientName = normalized.recipientName || resolved.context.recipientName;

    if (to.length === 0) {
      return NextResponse.json({ error: "missing_to", message: "Add at least one recipient." }, { status: 400 });
    }

    const invalidRecipients = invalidCommunicationEmails([...to, ...cc, ...bcc]);
    if (invalidRecipients.length > 0) {
      return NextResponse.json(
        { error: "invalid_email", message: `Invalid email address: ${invalidRecipients[0]}` },
        { status: 400 },
      );
    }

    const recipientPolicy = validateManualEmailRecipientPolicy({
      bcc,
      cc,
      externalJustification: normalized.externalJustification,
      to,
    });
    if (recipientPolicy.issues.length > 0) {
      return NextResponse.json(
        {
          allowedDomains: recipientPolicy.allowedDomains,
          error: recipientPolicy.issues[0].code,
          externalRecipients: recipientPolicy.externalRecipients,
          issues: recipientPolicy.issues,
          message: recipientPolicy.issues[0].message,
        },
        { status: 400 },
      );
    }

    if (!subject) {
      return NextResponse.json({ error: "missing_subject", message: "Subject is required." }, { status: 400 });
    }

    if (!replyMessage) {
      return NextResponse.json({ error: "missing_reply", message: "Reply message is required." }, { status: 400 });
    }

    const signatureImageSrc = emailSignatureUrl(request.url);
    const signatureImageCheck = await assertReachableEmailImage(signatureImageSrc);

    const generated = buildPhoenixHrReplyEmail({
      cc: cc.join(", "),
      recipientName,
      // With a rich body, the text part is projected from the same html server-side so
      // the multipart/alternative parts cannot diverge (mirrors previewManualEmail).
      replyMessage: replyMessageHtml ? composerHtmlToText(replyMessageHtml) || replyMessage : replyMessage,
      replyMessageHtml,
      senderName: normalized.senderName,
      signatureImageSrc,
      subject,
      to: to.join(", "),
      tone: normalized.tone,
    });
    const idempotencyKey = buildComposerIdempotency({
      bcc,
      cc,
      normalized: { ...normalized, recipientName, replyMessage, subject },
      to,
    });

    const result = await sendEmail({
      bcc,
      cc,
      html: generated.html,
      idempotencyKey,
      subject,
      text: generated.plainText,
      to,
    });
    await recordManualEmailSendAudit({
      actor: access.loginId ?? access.hrId ?? null,
      bcc,
      cc,
      clientRequestId: normalized.clientRequestId,
      externalJustification: normalized.externalJustification,
      externalRecipients: recipientPolicy.externalRecipients,
      providerMessageId: "id" in result ? result.id ?? null : null,
      providerReason: "reason" in result ? result.reason ?? null : null,
      providerSkipped: "skipped" in result ? result.skipped : false,
      status: "skipped" in result && result.skipped ? "skipped" : "sent",
      subject,
      templateKey: normalized.templateKey,
      to,
    }).catch((auditError) => {
      console.error("manual_email_send_audit_failed", auditError);
    });

    return NextResponse.json({
      result: {
        ...result,
        externalRecipients: recipientPolicy.externalRecipients,
        signatureImageVerified: true,
        signatureImageWarning: signatureImageCheck.warning,
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to send HR emails." }, { status: 403 });
    }

    const message = error instanceof Error ? error.message : "Email send failed.";
    return NextResponse.json({ error: "email_send_failed", message }, { status: 500 });
  }
}
