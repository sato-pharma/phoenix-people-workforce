import { NextResponse } from "next/server";

import { systemIdentity } from "@/config/system-settings";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  invalidCommunicationEmails,
  splitCommunicationEmailList,
} from "@/lib/communication/metrics";
import { sendPhoenixEmail } from "@/lib/email/send-phoenix-email";
import {
  buildPhoenixHrReplyEmail,
  phoenixHrEmailSignatureHostedUrl,
  phoenixHrEmailSignatureSmallPath,
  type PhoenixHrEmailTone,
} from "@/lib/email/phoenix-hr-reply-template";
import { emailNotificationsEnabled } from "@/lib/notifications/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const allowedTones = new Set<PhoenixHrEmailTone>(["professional", "warm", "firm", "concise"]);

type EmailReplySendBody = {
  bcc?: unknown;
  cc?: unknown;
  recipientName?: unknown;
  replyMessage?: unknown;
  senderName?: unknown;
  subject?: unknown;
  to?: unknown;
  tone?: unknown;
};

function isLocalUrl(value: string) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function publicAssetUrl(publicPath: string, requestUrl: string) {
  const configuredBase =
    process.env.HR_EMAIL_ASSET_BASE_URL ||
    process.env.NOTIFICATION_DASHBOARD_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    process.env.VERCEL_URL ||
    new URL(requestUrl).origin;
  const base = /^https?:\/\//i.test(configuredBase) ? configuredBase : `https://${configuredBase}`;

  return `${base.replace(/\/+$/, "")}/${publicPath.replace(/^\/+/, "")}`;
}

function emailSignatureUrl(requestUrl: string) {
  const explicitUrl = process.env.HR_EMAIL_SIGNATURE_URL?.trim();
  if (explicitUrl) return explicitUrl;

  if (!process.env.HR_EMAIL_ASSET_BASE_URL?.trim()) {
    return phoenixHrEmailSignatureHostedUrl;
  }

  const assetUrl = publicAssetUrl(phoenixHrEmailSignatureSmallPath, requestUrl);
  return isLocalUrl(assetUrl) ? phoenixHrEmailSignatureHostedUrl : assetUrl;
}

async function assertReachableImageUrl(url: string) {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Email signature image URL is invalid.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Email signature image URL must be HTTPS so email clients can load it.");
  }

  const verify = async (method: "GET" | "HEAD") =>
    fetch(url, {
      cache: "no-store",
      headers: method === "GET" ? { Range: "bytes=0-0" } : undefined,
      method,
      signal: AbortSignal.timeout(8000),
    });

  let response = await verify("HEAD").catch(() => null);

  if (!response?.ok || !String(response.headers.get("content-type") ?? "").toLowerCase().startsWith("image/")) {
    response = await verify("GET").catch(() => null);
  }

  const contentType = response?.headers.get("content-type") ?? "";

  if (!response?.ok || !contentType.toLowerCase().startsWith("image/")) {
    throw new Error(
      `Email signature image is not reachable as an image. Status: ${response?.status ?? "network_error"}.`,
    );
  }
}

function stringField(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

async function sendEmail({
  bcc,
  cc,
  html,
  subject,
  text,
  to,
}: {
  bcc: string[];
  cc: string[];
  html: string;
  subject: string;
  text: string;
  to: string[];
}) {
  if (!emailNotificationsEnabled()) {
    return { reason: "EMAIL_NOTIFICATIONS_ENABLED is not true.", skipped: true as const };
  }

  const from = process.env.HR_REPLY_EMAIL_FROM || process.env.NOTIFICATION_EMAIL_FROM;

  if (!from) return { reason: "HR_REPLY_EMAIL_FROM or NOTIFICATION_EMAIL_FROM is missing.", skipped: true as const };

  const requestId = `phoenix-hr-${Date.now()}`;
  return sendPhoenixEmail({ bcc, cc, from, html, idempotencyKey: requestId, subject, text, to });
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "communication", "update");

    const body = (await request.json().catch(() => ({}))) as EmailReplySendBody;
    const to = splitCommunicationEmailList(body.to);
    const cc = splitCommunicationEmailList(body.cc);
    const bcc = splitCommunicationEmailList(body.bcc);
    const subject = stringField(body.subject);
    const replyMessage = stringField(body.replyMessage);
    const recipientName = stringField(body.recipientName);
    const senderName = stringField(body.senderName) || systemIdentity.hrSignatureName;
    const tone = allowedTones.has(body.tone as PhoenixHrEmailTone)
      ? (body.tone as PhoenixHrEmailTone)
      : "professional";

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

    if (!subject) {
      return NextResponse.json({ error: "missing_subject", message: "Subject is required." }, { status: 400 });
    }

    if (!replyMessage) {
      return NextResponse.json({ error: "missing_reply", message: "Reply message is required." }, { status: 400 });
    }

    const signatureImageSrc = emailSignatureUrl(request.url);
    await assertReachableImageUrl(signatureImageSrc);

    const generated = buildPhoenixHrReplyEmail({
      cc: cc.join(", "),
      recipientName,
      replyMessage,
      senderName,
      signatureImageSrc,
      subject,
      to: to.join(", "),
      tone,
    });

    const result = await sendEmail({
      bcc,
      cc,
      html: generated.html,
      subject,
      text: generated.plainText,
      to,
    });

    return NextResponse.json({ result: { ...result, signatureImageVerified: true } });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to send HR emails." }, { status: 403 });
    }

    const message = error instanceof Error ? error.message : "Email send failed.";
    return NextResponse.json({ error: "email_send_failed", message }, { status: 500 });
  }
}
