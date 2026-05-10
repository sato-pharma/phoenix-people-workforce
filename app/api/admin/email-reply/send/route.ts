import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  buildPhoenixHrReplyEmail,
  phoenixHrEmailSignatureHostedUrl,
  phoenixHrEmailSignatureSmallPath,
  type PhoenixHrEmailTone,
} from "@/lib/email/phoenix-hr-reply-template";
import { emailNotificationsEnabled } from "@/lib/notifications/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const resendEndpoint = "https://api.resend.com/emails";
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

function splitEmails(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(splitEmails);
  }

  return String(value ?? "")
    .split(/[;,\n\r]+/)
    .map((email) => email.trim())
    .filter(Boolean);
}

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

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

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.HR_REPLY_EMAIL_FROM || process.env.NOTIFICATION_EMAIL_FROM;

  if (!apiKey) return { reason: "RESEND_API_KEY is missing.", skipped: true as const };
  if (!from) return { reason: "HR_REPLY_EMAIL_FROM or NOTIFICATION_EMAIL_FROM is missing.", skipped: true as const };

  const requestId = `phoenix-hr-${Date.now()}`;
  const response = await fetch(resendEndpoint, {
    body: JSON.stringify({
      bcc: bcc.length > 0 ? bcc : undefined,
      cc: cc.length > 0 ? cc : undefined,
      from,
      html,
      replyTo: process.env.NOTIFICATION_REPLY_TO || undefined,
      subject,
      text,
      to,
    }),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": requestId,
    },
    method: "POST",
  });

  const payload = (await response.json().catch(() => null)) as {
    error?: string;
    id?: string;
    message?: string;
    name?: string;
  } | null;

  if (!response.ok) {
    throw new Error(payload?.message ?? payload?.error ?? `Resend request failed with ${response.status}.`);
  }

  if (!payload?.id) {
    throw new Error("Resend accepted the request without returning a message id.");
  }

  return { id: payload.id, skipped: false as const };
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "admin", "read");

    const body = (await request.json().catch(() => ({}))) as EmailReplySendBody;
    const to = splitEmails(body.to);
    const cc = splitEmails(body.cc);
    const bcc = splitEmails(body.bcc);
    const subject = stringField(body.subject);
    const replyMessage = stringField(body.replyMessage);
    const recipientName = stringField(body.recipientName);
    const senderName = stringField(body.senderName) || "Phoenix HR Team";
    const tone = allowedTones.has(body.tone as PhoenixHrEmailTone)
      ? (body.tone as PhoenixHrEmailTone)
      : "professional";

    if (to.length === 0) {
      return NextResponse.json({ error: "missing_to", message: "Add at least one recipient." }, { status: 400 });
    }

    const invalidRecipients = [...to, ...cc, ...bcc].filter((email) => !validEmail(email));
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
