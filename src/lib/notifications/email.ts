import crypto from "crypto";

import { getSupabaseAdmin } from "@/lib/supabase/server";

type NotificationMetric = {
  label: string;
  value: string | number;
};

export type NotificationEmailInput = {
  ctaHref?: string;
  ctaLabel?: string;
  metrics?: NotificationMetric[];
  recipients?: string[];
  subject: string;
  summary: string;
  title: string;
  tone?: "success" | "warning" | "danger" | "neutral";
};

type SendEmailResult =
  | { id?: string; skipped?: false }
  | { reason: string; skipped: true };

type NotificationOutboxRow = {
  attempts: number;
  created_at: string;
  dedupe_key: string;
  id: string;
  last_error: string | null;
  locked_at: string | null;
  max_attempts: number;
  next_attempt_at: string | null;
  payload: NotificationEmailInput;
  provider_message_id: string | null;
  sent_at: string | null;
  status: "pending" | "processing" | "sent" | "failed";
  updated_at: string;
};

type NotificationOutboxProcessResult = {
  attempted: number;
  failed: number;
  processedIds: string[];
  sent: number;
};

const resendEndpoint = "https://api.resend.com/emails";
const notificationOutboxTable = "notification_outbox";
const notificationOutboxMaxAttempts = 5;
const notificationOutboxBatchSize = 10;

function envFlag(value: string | undefined) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

function recipientsFromEnv() {
  return String(process.env.HR_NOTIFICATION_EMAILS ?? "")
    .split(/[;,]/)
    .map((email) => email.trim())
    .filter(Boolean);
}

function dashboardUrl(path = "/") {
  const base = String(process.env.NOTIFICATION_DASHBOARD_URL ?? "").replace(/\/+$/, "");
  if (!base) return path;
  if (/^https?:\/\//.test(path)) return path;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function escapeHtml(value: string | number) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toneColor(tone: NotificationEmailInput["tone"]) {
  if (tone === "success") return "#16a34a";
  if (tone === "warning") return "#f97316";
  if (tone === "danger") return "#ef4444";
  return "#0f172a";
}

function renderText(input: NotificationEmailInput) {
  const lines = [
    input.title,
    "",
    input.summary,
    "",
    ...(input.metrics ?? []).map((metric) => `${metric.label}: ${metric.value}`),
  ];

  if (input.ctaHref) {
    lines.push("", `${input.ctaLabel ?? "Open dashboard"}: ${dashboardUrl(input.ctaHref)}`);
  }

  return lines.join("\n");
}

function renderHtml(input: NotificationEmailInput) {
  const color = toneColor(input.tone);
  const metrics = (input.metrics ?? [])
    .map(
      (metric) => `
        <tr>
          <td style="padding:10px 0;color:#64748b;font-size:13px">${escapeHtml(metric.label)}</td>
          <td style="padding:10px 0;color:#0f172a;font-size:14px;font-weight:700;text-align:right">${escapeHtml(metric.value)}</td>
        </tr>`,
    )
    .join("");
  const cta = input.ctaHref
    ? `<a href="${escapeHtml(dashboardUrl(input.ctaHref))}" style="display:inline-block;margin-top:22px;border:1px solid #fed7aa;border-radius:12px;background:#fff7ed;color:#ea580c;font-weight:700;text-decoration:none;padding:12px 18px">${escapeHtml(input.ctaLabel ?? "Open dashboard")}</a>`
    : "";

  return `
    <div style="margin:0;background:#f8fafc;padding:28px;font-family:Inter,Arial,sans-serif;color:#0f172a">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:20px;box-shadow:0 18px 46px rgba(15,23,42,0.08);overflow:hidden">
        <div style="padding:24px 28px;border-bottom:1px solid #f1f5f9">
          <div style="font-size:11px;letter-spacing:0.24em;font-weight:800;color:#ea580c;text-transform:uppercase">Phoenix Workforce</div>
          <h1 style="margin:12px 0 0;font-size:22px;line-height:1.25;color:#0f172a">${escapeHtml(input.title)}</h1>
        </div>
        <div style="padding:24px 28px">
          <div style="height:4px;width:72px;border-radius:999px;background:${color};box-shadow:0 0 18px ${color}66"></div>
          <p style="margin:18px 0 18px;color:#334155;font-size:15px;line-height:1.7">${escapeHtml(input.summary)}</p>
          ${
            metrics
              ? `<table style="width:100%;border-collapse:collapse;border-top:1px solid #f1f5f9;border-bottom:1px solid #f1f5f9">${metrics}</table>`
              : ""
          }
          ${cta}
        </div>
        <div style="padding:16px 28px;background:#f8fafc;color:#94a3b8;font-size:12px">
          Automated notification from Phoenix Workforce.
        </div>
      </div>
    </div>`;
}

export function emailNotificationsEnabled() {
  return envFlag(process.env.EMAIL_NOTIFICATIONS_ENABLED);
}

function notificationSchemaMissing(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes(notificationOutboxTable) ||
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

function normalizeNotificationPayload(input: NotificationEmailInput) {
  return {
    ctaHref: input.ctaHref ?? null,
    ctaLabel: input.ctaLabel ?? null,
    metrics: (input.metrics ?? []).map((metric) => ({
      label: metric.label,
      value: String(metric.value),
    })),
    recipients: input.recipients?.map((recipient) => recipient.trim().toLowerCase()).sort() ?? null,
    subject: input.subject,
    summary: input.summary,
    title: input.title,
    tone: input.tone ?? "neutral",
  };
}

function notificationDedupeKey(input: NotificationEmailInput) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(normalizeNotificationPayload(input)))
    .digest("hex");
}

function retryDelayMinutes(attemptNumber: number) {
  const delays = [5, 15, 60, 240];
  return delays[Math.min(Math.max(attemptNumber - 1, 0), delays.length - 1)];
}

function nextAttemptAtIso(attemptNumber: number) {
  const next = new Date();
  next.setMinutes(next.getMinutes() + retryDelayMinutes(attemptNumber));
  return next.toISOString();
}

async function sendNotificationEmailDirect(input: NotificationEmailInput): Promise<SendEmailResult> {
  if (!emailNotificationsEnabled()) {
    return { reason: "EMAIL_NOTIFICATIONS_ENABLED is not true.", skipped: true };
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.NOTIFICATION_EMAIL_FROM;
  const to = input.recipients?.length ? input.recipients : recipientsFromEnv();

  if (!apiKey) return { reason: "RESEND_API_KEY is missing.", skipped: true };
  if (!from) return { reason: "NOTIFICATION_EMAIL_FROM is missing.", skipped: true };
  if (to.length === 0) return { reason: "HR_NOTIFICATION_EMAILS is empty.", skipped: true };

  const response = await fetch(resendEndpoint, {
    body: JSON.stringify({
      from,
      html: renderHtml(input),
      reply_to: process.env.NOTIFICATION_REPLY_TO || undefined,
      subject: input.subject,
      text: renderText(input),
      to,
    }),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  const payload = (await response.json().catch(() => null)) as { id?: string; message?: string } | null;

  if (!response.ok) {
    throw new Error(payload?.message ?? `Resend request failed with ${response.status}.`);
  }

  return { id: payload?.id, skipped: false };
}

export async function sendNotificationEmail(input: NotificationEmailInput): Promise<SendEmailResult> {
  return sendNotificationEmailDirect(input);
}

async function getNotificationOutboxRowByDedupeKey(dedupeKey: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(notificationOutboxTable)
    .select("*")
    .eq("dedupe_key", dedupeKey)
    .maybeSingle();

  if (error) throw error;
  return (data as NotificationOutboxRow | null) ?? null;
}

async function enqueueNotificationEmail(input: NotificationEmailInput) {
  const dedupeKey = notificationDedupeKey(input);
  const existing = await getNotificationOutboxRowByDedupeKey(dedupeKey);
  if (existing) return existing;

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from(notificationOutboxTable)
    .insert({
      attempts: 0,
      dedupe_key: dedupeKey,
      max_attempts: notificationOutboxMaxAttempts,
      next_attempt_at: now,
      payload: input,
      status: "pending",
      updated_at: now,
    })
    .select("*")
    .single();

  if (error) {
    const fallback = await getNotificationOutboxRowByDedupeKey(dedupeKey);
    if (fallback) return fallback;
    throw error;
  }

  return data as NotificationOutboxRow;
}

async function claimNotificationOutboxRow(id: string) {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from(notificationOutboxTable)
    .update({
      locked_at: now,
      status: "processing",
      updated_at: now,
    })
    .eq("id", id)
    .in("status", ["pending", "failed"])
    .select("*")
    .maybeSingle();

  if (error) throw error;
  return (data as NotificationOutboxRow | null) ?? null;
}

async function markNotificationOutboxSent(row: NotificationOutboxRow, providerMessageId?: string) {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  await supabase
    .from(notificationOutboxTable)
    .update({
      attempts: row.attempts + 1,
      last_error: null,
      locked_at: null,
      next_attempt_at: null,
      provider_message_id: providerMessageId ?? null,
      sent_at: now,
      status: "sent",
      updated_at: now,
    })
    .eq("id", row.id);
}

async function markNotificationOutboxFailed(row: NotificationOutboxRow, errorMessage: string) {
  const supabase = getSupabaseAdmin();
  const attempts = row.attempts + 1;
  const terminal = attempts >= row.max_attempts;
  const now = new Date().toISOString();
  await supabase
    .from(notificationOutboxTable)
    .update({
      attempts,
      last_error: errorMessage,
      locked_at: null,
      next_attempt_at: terminal ? null : nextAttemptAtIso(attempts),
      status: "failed",
      updated_at: now,
    })
    .eq("id", row.id);
}

async function loadDueNotificationOutboxRows(limit: number) {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from(notificationOutboxTable)
    .select("*")
    .in("status", ["pending", "failed"])
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${now}`)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw error;
  return ((data ?? []) as NotificationOutboxRow[]).filter((row) => row.attempts < row.max_attempts);
}

async function processNotificationOutboxRow(row: NotificationOutboxRow): Promise<SendEmailResult> {
  const claimed = await claimNotificationOutboxRow(row.id);
  if (!claimed) {
    return { reason: "Notification is already being processed.", skipped: true };
  }

  try {
    const result = await sendNotificationEmailDirect(claimed.payload);
    if (result.skipped) {
      await markNotificationOutboxFailed(claimed, result.reason);
      return result;
    }

    await markNotificationOutboxSent(claimed, result.id);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Email notification failed.";
    await markNotificationOutboxFailed(claimed, message);
    return { reason: message, skipped: true };
  }
}

export async function processNotificationOutbox(limit = notificationOutboxBatchSize): Promise<NotificationOutboxProcessResult> {
  const rows = await loadDueNotificationOutboxRows(limit);
  const processedIds: string[] = [];
  let attempted = 0;
  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    attempted += 1;
    const result = await processNotificationOutboxRow(row);
    processedIds.push(row.id);
    if (result.skipped) {
      failed += 1;
    } else {
      sent += 1;
    }
  }

  return { attempted, failed, processedIds, sent };
}

export async function safeSendNotificationEmail(input: NotificationEmailInput) {
  try {
    const queued = await enqueueNotificationEmail(input);
    if (queued.status === "sent") {
      return { id: queued.provider_message_id ?? queued.id, skipped: false } satisfies SendEmailResult;
    }

    const result = await processNotificationOutboxRow(queued);
    if (result.skipped) {
      return {
        reason: `Queued for retry: ${result.reason}`,
        skipped: true,
      } satisfies SendEmailResult;
    }

    return result;
  } catch (error) {
    if (notificationSchemaMissing(error)) {
      return sendNotificationEmailDirect(input);
    }
    console.error("Email notification failed", error);
    return {
      reason: error instanceof Error ? error.message : "Email notification failed.",
      skipped: true,
    } satisfies SendEmailResult;
  }
}
