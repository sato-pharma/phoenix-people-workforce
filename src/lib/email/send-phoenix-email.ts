import { phoenixEmailSignatureHostedUrl } from "@/emails/phoenix-email-layout";
import { systemEmail, systemIdentity } from "@/config/system-settings";

const resendEndpoint = "https://api.resend.com/emails";

export type SendPhoenixEmailInput = {
  bcc?: string[];
  cc?: string[];
  from?: string;
  html: string;
  idempotencyKey: string;
  subject: string;
  text: string;
  to: string[];
};

export type SendPhoenixEmailResult =
  | { id?: string; skipped?: false }
  | { reason: string; skipped: true };

function emailNotificationsEnabled() {
  return ["1", "true", "yes", "on"].includes(String(process.env.EMAIL_NOTIFICATIONS_ENABLED ?? "").toLowerCase());
}

function splitEmailList(value: string | null | undefined) {
  return String(value ?? "")
    .split(/[,\n;]/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

function resolveTestingRecipients() {
  const deliveryMode = String(process.env.PHOENIX_EMAIL_DELIVERY_MODE ?? "").trim().toLowerCase();
  const testRecipients = splitEmailList(process.env.PHOENIX_EMAIL_TEST_RECIPIENTS);
  // Redirect all mail to the testing recipients when the config safety switch is on
  // (systemEmail.forceTestingDelivery) OR the env delivery mode is explicitly "testing".
  const testingEnabled = systemEmail.forceTestingDelivery || deliveryMode === "testing";
  if (!testingEnabled) return null;
  return testRecipients.length > 0 ? Array.from(new Set(testRecipients)) : [...systemEmail.testingRecipientFallback];
}

export async function assertReachablePhoenixEmailImage(url = phoenixEmailSignatureHostedUrl) {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Email signature image URL is invalid.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Email signature image URL must be HTTPS so email clients can load it.");
  }

  if (/localhost|127\.0\.0\.1|\/assets\//i.test(url)) {
    throw new Error("Email signature image must not use localhost or a relative /assets URL.");
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

export async function sendPhoenixEmail(input: SendPhoenixEmailInput): Promise<SendPhoenixEmailResult> {
  if (!emailNotificationsEnabled()) {
    return { reason: "EMAIL_NOTIFICATIONS_ENABLED is not true.", skipped: true };
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = input.from || process.env.NOTIFICATION_EMAIL_FROM || `${systemIdentity.appName} <${systemEmail.defaultFromEmail}>`;

  if (!apiKey) return { reason: "RESEND_API_KEY is missing.", skipped: true };
  if (!from) return { reason: "Email sender is missing.", skipped: true };

  await assertReachablePhoenixEmailImage();
  const testingRecipients = resolveTestingRecipients();
  const to = testingRecipients ?? input.to;
  const cc = testingRecipients ? undefined : input.cc && input.cc.length > 0 ? input.cc : undefined;
  const bcc = testingRecipients ? undefined : input.bcc && input.bcc.length > 0 ? input.bcc : undefined;

  const response = await fetch(resendEndpoint, {
    body: JSON.stringify({
      bcc,
      cc,
      from,
      html: input.html,
      replyTo: process.env.NOTIFICATION_REPLY_TO || systemEmail.defaultReplyTo,
      subject: input.subject,
      text: input.text,
      to,
    }),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey,
    },
    method: "POST",
  });

  const payload = (await response.json().catch(() => null)) as { error?: string; id?: string; message?: string } | null;

  if (!response.ok) {
    throw new Error(payload?.message ?? payload?.error ?? `Resend request failed with ${response.status}.`);
  }

  if (!payload?.id) {
    throw new Error("Resend accepted the request without returning a message id.");
  }

  return { id: payload.id, skipped: false };
}
