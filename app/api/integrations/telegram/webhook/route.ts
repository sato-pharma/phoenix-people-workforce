import { NextResponse } from "next/server";

import { linkTelegramConnection } from "@/lib/notifications/settings";
import { sendTelegramNotification, telegramWebhookSecretToken } from "@/lib/notifications/telegram";
import {
  classifyTelegramInbound,
  classifyTelegramLinkError,
  isPermanentTelegramLinkOutcome,
  telegramLinkReply,
  telegramWebhookLogLabels,
  type TelegramReply,
} from "@/lib/notifications/telegram-webhook-outcome";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { logError, logInfo } from "@/lib/observability/log";
import { secretMatches } from "@/lib/security/constant-time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function extractStartToken(text: string | null | undefined) {
  const match = String(text ?? "").trim().match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]+)$/);
  return match?.[1] ?? null;
}

// Best-effort: a reply failure must never turn into a webhook error, or Telegram will retry the
// same update indefinitely for something that isn't fixable by retrying.
async function replyInChat(chatId: unknown, reply: TelegramReply | null) {
  if (!reply || !chatId) return;
  await sendTelegramNotification({ chatId: String(chatId), message: reply.message, title: reply.title }).catch(() => {});
}

export async function POST(request: Request) {
  // Must match the token registered with Telegram in provisionTelegramBot's setWebhook —
  // both derive from NOTIFICATION_WEBHOOK_SECRET via telegramWebhookSecretToken().
  const expectedSecret = telegramWebhookSecretToken();
  // Fail-closed everywhere: no secret configured ⇒ refuse to accept webhooks, development included,
  // because a local server reads the production database (S01, F-COM-014). Telegram only ever
  // calls the address registered by setWebhook, so a local server needs no unsigned path.
  if (!expectedSecret) {
    return NextResponse.json({ error: "telegram_webhook_secret_missing" }, { status: 500 });
  }
  const received = request.headers.get("x-telegram-bot-api-secret-token");
  if (!secretMatches(received, expectedSecret)) {
    return NextResponse.json({ error: "telegram_webhook_forbidden" }, { status: 403 });
  }

  // Held outside the try so a refusal can still answer in the chat the update came from.
  let chatId: unknown = null;
  try {
    const body = await request.json();
    const message = body?.message ?? body?.edited_message ?? null;
    const kind = classifyTelegramInbound(message?.text);
    const token = extractStartToken(message?.text);
    const incomingChatId = message?.chat?.id;
    chatId = incomingChatId;
    if (!token || !incomingChatId) {
      // One line per update, so "did START ever reach us?" has an answer. Kind and outcome only —
      // never the token, the chat id or the username.
      logInfo("Telegram webhook update ignored.", { labels: telegramWebhookLogLabels(kind, "ignored") });
      // A bare /start (no personal token) means someone found the bot without the emailed
      // connect link -- distinct from any other un-handled text, which stays silently ignored.
      if (incomingChatId && kind === "bare_start") {
        await sendTelegramNotification({
          chatId: String(incomingChatId),
          message: "To connect your account, use the personal link sent to your work email. If you can't find it, ask HR to resend your Telegram connect invite.",
          title: "👋 Welcome to Phoenix Workforce",
        }).catch(() => {});
      }
      return NextResponse.json({ ok: true, ignored: true });
    }

    await linkTelegramConnection({
      chatId: incomingChatId,
      telegramUsername: message?.from?.username ?? null,
      token,
    });
    logInfo("Telegram connect link used.", { labels: telegramWebhookLogLabels(kind, "linked") });
    await replyInChat(chatId, telegramLinkReply("linked"));
    return NextResponse.json({ ok: true });
  } catch (error) {
    const outcome = classifyTelegramLinkError(error);
    const message = clientSafeErrorMessage(error, "Telegram webhook failed.");
    if (isPermanentTelegramLinkOutcome(outcome)) {
      logInfo("Telegram connect link refused.", { labels: telegramWebhookLogLabels("start_with_token", outcome) });
      // Tell the person why, then ack so Telegram does not retry a permanently-failing update.
      await replyInChat(chatId, telegramLinkReply(outcome));
      return NextResponse.json({ ok: true, ignored: true, reason: message });
    }
    logError("Telegram webhook failed.", { error, labels: telegramWebhookLogLabels("start_with_token", outcome) });
    return NextResponse.json({ error: "telegram_webhook_failed", message }, { status: 400 });
  }
}
