import { NextResponse } from "next/server";

import { linkTelegramConnection } from "@/lib/notifications/settings";
import { telegramWebhookSecret } from "@/lib/notifications/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function extractStartToken(text: string | null | undefined) {
  const match = String(text ?? "").trim().match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]+)$/);
  return match?.[1] ?? null;
}

export async function POST(request: Request) {
  const expectedSecret = telegramWebhookSecret();
  if (!expectedSecret && process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "telegram_webhook_secret_missing" }, { status: 500 });
  }
  if (expectedSecret) {
    const received = request.headers.get("x-telegram-bot-api-secret-token");
    if (received !== expectedSecret) {
      return NextResponse.json({ error: "telegram_webhook_forbidden" }, { status: 403 });
    }
  }

  try {
    const body = await request.json();
    const message = body?.message ?? body?.edited_message ?? null;
    const token = extractStartToken(message?.text);
    const chatId = message?.chat?.id;
    if (!token || !chatId) {
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
    return NextResponse.json({ error: "telegram_webhook_failed", message }, { status: 400 });
  }
}
