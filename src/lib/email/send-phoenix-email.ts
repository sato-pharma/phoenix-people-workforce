import { phoenixEmailSignatureHostedUrl } from "@/emails/phoenix-email-layout";
import { isForceTestingDelivery, systemEmail, systemIdentity } from "@/config/system-settings";
import { assertReachableEmailImage } from "@/lib/email/email-safety";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const resendEndpoint = "https://api.resend.com/emails";

export type SendPhoenixEmailInput = {
  bcc?: string[];
  cc?: string[];
  from?: string;
  headers?: Record<string, string>;
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
  // (isForceTestingDelivery()) OR the env delivery mode is explicitly "testing".
  const testingEnabled = isForceTestingDelivery() || deliveryMode === "testing";
  if (!testingEnabled) return null;
  return testRecipients.length > 0 ? Array.from(new Set(testRecipients)) : [...systemEmail.testingRecipientFallback];
}

export async function assertReachablePhoenixEmailImage(url = phoenixEmailSignatureHostedUrl) {
  return assertReachableEmailImage(url, { blockLocalAssets: true });
}

const suppressedStatuses = ["bounced", "complained", "suppressed"];

async function loadSuppressedRecipients(emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("email_delivery_events")
      .select("recipients")
      .in("status", suppressedStatuses);

    if (error) throw error;

    const suppressed = new Set<string>();
    for (const row of (data ?? []) as Array<{ recipients: string[] }>) {
      for (const r of row.recipients ?? []) {
        suppressed.add(r.trim().toLowerCase());
      }
    }
    return suppressed;
  } catch {
    return new Set();
  }
}

function removeSuppressed(emails: string[], suppressed: Set<string>): string[] {
  return emails.filter((e) => !suppressed.has(e.trim().toLowerCase()));
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

  const allCandidates = [...(testingRecipients ?? input.to), ...(input.cc ?? []), ...(input.bcc ?? [])];
  const suppressed = await loadSuppressedRecipients(allCandidates);

  const to = removeSuppressed(testingRecipients ?? input.to, suppressed);
  if (to.length === 0) {
    return { reason: "All recipients are suppressed (bounce/complaint).", skipped: true };
  }
  const cc = testingRecipients ? undefined : input.cc && input.cc.length > 0 ? removeSuppressed(input.cc, suppressed) : undefined;
  const bcc = testingRecipients ? undefined : input.bcc && input.bcc.length > 0 ? removeSuppressed(input.bcc, suppressed) : undefined;

  const emailHeaders = input.headers && Object.keys(input.headers).length > 0 ? input.headers : undefined;

  const response = await fetch(resendEndpoint, {
    body: JSON.stringify({
      bcc,
      cc,
      from,
      headers: emailHeaders,
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
