import { createHmac, timingSafeEqual } from "node:crypto";

import { resolveAdminTelegramChatIds } from "@/lib/email/admin-telegram-mirror";
import { sendTelegramNotification } from "@/lib/notifications/telegram";
import { logError } from "@/lib/observability/log";
import { scrubSentryText } from "@/lib/observability/sentry-policy";

// A new production error, sent to the owner's Telegram. Sentry posts an alert (an "issue alert" rule firing, or a
// newly created issue) to /api/webhooks/sentry, signed with the client secret of an internal integration; this
// module verifies the signature, shapes a short message and sends it to the standing admin through the same chat
// resolution every other admin mirror uses. Nothing here reads the database beyond that resolution, and a payload
// that is not an alert is acknowledged and ignored.

const MAX_FIELD = 300;

export function verifySentrySignature(body: string, signature: string | null | undefined, secret: string): boolean {
  const received = String(signature ?? "").trim().toLowerCase();
  if (!received || !secret) return false;
  const expected = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  const left = Buffer.from(received, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

type SentryAlertEvent = {
  title?: unknown;
  message?: unknown;
  culprit?: unknown;
  level?: unknown;
  environment?: unknown;
  web_url?: unknown;
  url?: unknown;
  permalink?: unknown;
};

export type SentryAlertMessage = { title: string; message: string; url: string | null };

function text(value: unknown): string {
  const clean = scrubSentryText(String(value ?? "")).replace(/\s+/g, " ").trim();
  return clean.length > MAX_FIELD ? clean.slice(0, MAX_FIELD) : clean;
}

function sentryLink(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && /(^|\.)sentry\.io$/i.test(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Shape a Sentry webhook into a short Telegram message, or null when it is not an alert about an issue. */
export function buildSentryAlertMessage(resource: string | null | undefined, payload: unknown): SentryAlertMessage | null {
  const body = (payload ?? {}) as { action?: unknown; data?: { event?: SentryAlertEvent; issue?: SentryAlertEvent; triggered_rule?: unknown } };
  const kind = String(resource ?? "").trim().toLowerCase();
  if (kind === "event_alert") {
    const event = body.data?.event;
    if (!event) return null;
    return compose(event, text(body.data?.triggered_rule));
  }
  if (kind === "issue" && String(body.action ?? "").toLowerCase() === "created") {
    const issue = body.data?.issue;
    if (!issue) return null;
    return compose(issue, "");
  }
  return null;
}

function compose(source: SentryAlertEvent, rule: string): SentryAlertMessage | null {
  const title = text(source.title ?? source.message);
  if (!title) return null;
  const level = text(source.level);
  const lines = [
    title,
    text(source.culprit) ? `Where: ${text(source.culprit)}` : null,
    level ? `Level: ${level}` : null,
    rule ? `Rule: ${rule}` : null,
  ].filter((line): line is string => Boolean(line));
  return {
    title: "Phoenix production error",
    message: lines.join("\n"),
    url: sentryLink(source.web_url ?? source.permalink ?? source.url),
  };
}

/** Send one alert to the owner's connected Telegram chats. Never throws; returns how many chats took it. */
export async function forwardSentryAlertToAdminTelegram(alert: SentryAlertMessage): Promise<number> {
  let sent = 0;
  try {
    const chatIds = await resolveAdminTelegramChatIds();
    const message = alert.url ? `${alert.message}\n\n${alert.url}` : alert.message;
    for (const chatId of chatIds) {
      try {
        const result = await sendTelegramNotification({ chatId, message, title: alert.title });
        if (!result.skipped) sent += 1;
      } catch (error) {
        logError("Sentry alert to Telegram: send failed", { labels: { event: "sentry_alert_telegram_send_failed" }, error });
      }
    }
  } catch (error) {
    logError("Sentry alert to Telegram: could not resolve the admin chat", {
      labels: { event: "sentry_alert_telegram_error" },
      error,
    });
  }
  return sent;
}
