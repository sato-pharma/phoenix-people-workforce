import crypto from "crypto";

export type TelegramSendInput = {
  actionUrl?: string | null;
  chatId: string;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  message: string;
  title: string;
};

export type TelegramSendResult =
  | { providerMessageId?: string; skipped?: false }
  | { reason: string; skipped: true };

function telegramBotToken() {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || null;
}

function telegramTimeoutMs() {
  const value = Number.parseInt(process.env.TELEGRAM_SEND_TIMEOUT_MS ?? "8000", 10);
  return Number.isFinite(value) && value > 0 ? value : 8000;
}

export function telegramBotUsername() {
  return process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "") || null;
}

export function telegramWebhookSecret() {
  return process.env.NOTIFICATION_WEBHOOK_SECRET?.trim() || null;
}

export function hashTelegramToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function appUrl() {
  return (
    process.env.PHOENIX_APP_URL ||
    process.env.NOTIFICATION_DASHBOARD_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    ""
  ).trim().replace(/\/+$/, "");
}

export function phoenixActionUrl(path: string | null | undefined) {
  const value = String(path ?? "").trim();
  if (!value) return appUrl() || "";
  if (/^https?:\/\//i.test(value)) return value;
  const base = appUrl();
  return base ? `${base}${value.startsWith("/") ? value : `/${value}`}` : value;
}

function cleanTelegramText(value: string) {
  return value
    .replace(/\s+/g, " ")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 900);
}

function cleanButtonLabel(value: string | null | undefined) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 64);
}

export function buildTelegramDeepLink(token: string) {
  const username = telegramBotUsername();
  if (!username) return null;
  return `https://t.me/${encodeURIComponent(username)}?start=${encodeURIComponent(token)}`;
}

export async function sendTelegramNotification(input: TelegramSendInput): Promise<TelegramSendResult> {
  const token = telegramBotToken();
  if (!token) return { reason: "TELEGRAM_BOT_TOKEN is missing.", skipped: true };
  if (!input.chatId.trim()) return { reason: "Telegram chat id is missing.", skipped: true };

  const text = [input.title, input.message]
    .map(cleanTelegramText)
    .filter(Boolean)
    .join("\n\n");
  if (!text) return { reason: "Telegram message is empty.", skipped: true };

  const rawActionUrl = String(input.ctaUrl ?? input.actionUrl ?? "").trim();
  if (input.ctaLabel && !rawActionUrl) return { reason: "Telegram CTA URL is missing.", skipped: true };
  const actionUrl = phoenixActionUrl(rawActionUrl);
  const ctaLabel = cleanButtonLabel(input.ctaLabel) || "Open in Phoenix";
  const replyMarkup = actionUrl
    ? {
        inline_keyboard: [[{ text: ctaLabel, url: actionUrl }]],
      }
    : undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), telegramTimeoutMs());
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      body: JSON.stringify({
        chat_id: input.chatId,
        disable_web_page_preview: true,
        reply_markup: replyMarkup,
        text,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Telegram request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const payload = await response.json().catch(() => null) as {
    description?: string;
    ok?: boolean;
    result?: { message_id?: number | string };
  } | null;

  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.description ?? `Telegram request failed with ${response.status}.`);
  }

  return { providerMessageId: String(payload?.result?.message_id ?? ""), skipped: false };
}
