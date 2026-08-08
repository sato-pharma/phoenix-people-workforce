import { timingSafeEqual } from "crypto";

import { NextResponse } from "next/server";

import { linkTelegramConnection } from "@/lib/notifications/settings";
import { sendTelegramNotification, telegramWebhookSecretToken } from "@/lib/notifications/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function extractStartToken(text: string | null | undefined) {
  const match = String(text ?? "").trim().match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]+)$/);
  return match?.[1] ?? null;
}

// A bare /start (no personal token) means someone found the bot without the emailed
// connect link -- distinct from any other un-handled text, which stays silently ignored.
function isBareStartCommand(text: string | null | undefined) {
  return /^\/start(?:@\w+)?\s*$/.test(String(text ?? "").trim());
}

// Constant-time secret comparison (mirrors src/lib/auth/session-token.ts) to avoid
// leaking the secret via timing. Length check first, then timingSafeEqual on Buffers.
function secretMatches(received: string | null, expected: string) {
  if (!received) return false;
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

// A token that is structurally invalid / expired / already used will NEVER succeed on
// retry, so we ack with 200 to stop Telegram's retry storm. Transient (DB) failures
// return 400 so Telegram retries them.
function isPermanentTokenError(error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("token is invalid")
    || message.includes("token was already used")
    || message.includes("token expired")
    || message.includes("token is required");
}

export async function POST(request: Request) {
  // Must match the token registered with Telegram in provisionTelegramBot's setWebhook —
  // both derive from NOTIFICATION_WEBHOOK_SECRET via telegramWebhookSecretToken().
  const expectedSecret = telegramWebhookSecretToken();
  // Fail-closed in production: no secret configured ⇒ refuse to accept webhooks.
  // In development the secret may be unset for local testing (documented exception).
  if (!expectedSecret && process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "telegram_webhook_secret_missing" }, { status: 500 });
  }
  if (expectedSecret) {
    const received = request.headers.get("x-telegram-bot-api-secret-token");
    if (!secretMatches(received, expectedSecret)) {
      return NextResponse.json({ error: "telegram_webhook_forbidden" }, { status: 403 });
    }
  }

  try {
    const body = await request.json();
    const message = body?.message ?? body?.edited_message ?? null;
    const token = extractStartToken(message?.text);
    const chatId = message?.chat?.id;
    if (!token || !chatId) {
      if (chatId && isBareStartCommand(message?.text)) {
        // Best-effort: a reply failure must never turn into a webhook error, or Telegram
        // will retry the same update indefinitely for something that isn't fixable by retrying.
        await sendTelegramNotification({
          chatId: String(chatId),
          message: "To connect your account, use the personal link sent to your work email. If you can't find it, ask HR to resend your Telegram connect invite.",
          title: "👋 Welcome to Phoenix Workforce",
        }).catch(() => {});
      }
      return NextResponse.json({ ok: true, ignored: true });
    }

    await linkTelegramConnection({
      chatId,
      telegramUsername: message?.from?.username ?? null,
      token,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Telegram webhook failed.";
    if (isPermanentTokenError(error)) {
      // Ack so Telegram does not retry a permanently-failing update.
      return NextResponse.json({ ok: true, ignored: true, reason: message });
    }
    return NextResponse.json({ error: "telegram_webhook_failed", message }, { status: 400 });
  }
}
