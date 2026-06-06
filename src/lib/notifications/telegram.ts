import crypto from "crypto";

export type TelegramSendInput = {
  actionUrl?: string | null;
  buttons?: Array<{ label: string; url: string }> | null;
  chatId: string;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  message: string;
  title: string;
};

export type TelegramSendResult =
  | { providerMessageId?: string; skipped?: false }
  | { reason: string; skipped: true };

export type TelegramEnvironmentStatus = {
  notificationWebhookSecret: boolean;
  phoenixAppUrl: boolean;
  telegramBotToken: boolean;
  telegramBotUsername: boolean;
};

export type TelegramWebhookStatus = {
  checked: boolean;
  configuredUrl: string | null;
  error: string | null;
  expectedUrl: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  pendingUpdateCount: number | null;
  urlMatchesExpected: boolean | null;
};

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

export function telegramEnvironmentStatus(): TelegramEnvironmentStatus {
  return {
    notificationWebhookSecret: Boolean(telegramWebhookSecret()),
    phoenixAppUrl: Boolean(appUrl()),
    telegramBotToken: Boolean(telegramBotToken()),
    telegramBotUsername: Boolean(telegramBotUsername()),
  };
}

export function expectedTelegramWebhookUrl() {
  const base = appUrl();
  return base ? `${base}/api/integrations/telegram/webhook` : null;
}

function cleanWebhookError(value: unknown) {
  return String(value ?? "")
    .replace(/[<>]/g, "")
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[redacted]")
    .trim()
    .slice(0, 160) || null;
}

export async function getTelegramWebhookStatus(): Promise<TelegramWebhookStatus> {
  const expectedUrl = expectedTelegramWebhookUrl();
  const token = telegramBotToken();
  if (!token) {
    return {
      checked: false,
      configuredUrl: null,
      error: "TELEGRAM_BOT_TOKEN is missing.",
      expectedUrl,
      lastErrorAt: null,
      lastErrorMessage: null,
      pendingUpdateCount: null,
      urlMatchesExpected: null,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), telegramTimeoutMs());
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
      method: "POST",
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null) as {
      description?: string;
      ok?: boolean;
      result?: {
        last_error_date?: number;
        last_error_message?: string;
        pending_update_count?: number;
        url?: string;
      };
    } | null;
    if (!response.ok || payload?.ok === false) {
      return {
        checked: true,
        configuredUrl: null,
        error: cleanWebhookError(payload?.description) ?? `Telegram webhook status failed with ${response.status}.`,
        expectedUrl,
        lastErrorAt: null,
        lastErrorMessage: null,
        pendingUpdateCount: null,
        urlMatchesExpected: null,
      };
    }

    const configuredUrl = String(payload?.result?.url ?? "").trim() || null;
    const lastErrorDate = payload?.result?.last_error_date;
    return {
      checked: true,
      configuredUrl,
      error: null,
      expectedUrl,
      lastErrorAt: typeof lastErrorDate === "number" ? new Date(lastErrorDate * 1000).toISOString() : null,
      lastErrorMessage: cleanWebhookError(payload?.result?.last_error_message),
      pendingUpdateCount: typeof payload?.result?.pending_update_count === "number" ? payload.result.pending_update_count : null,
      urlMatchesExpected: configuredUrl && expectedUrl ? configuredUrl === expectedUrl : null,
    };
  } catch (error) {
    return {
      checked: false,
      configuredUrl: null,
      error: error instanceof Error && error.name === "AbortError" ? "Telegram webhook status timed out." : "Telegram webhook status unavailable.",
      expectedUrl,
      lastErrorAt: null,
      lastErrorMessage: null,
      pendingUpdateCount: null,
      urlMatchesExpected: null,
    };
  } finally {
    clearTimeout(timeout);
  }
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

function buildTelegramButtons(input: TelegramSendInput) {
  const rawButtons = (input.buttons ?? [])
    .map((button) => ({
      label: cleanButtonLabel(button.label),
      url: String(button.url ?? "").trim(),
    }))
    .filter((button) => button.label || button.url);

  const buttons = rawButtons.length > 0
    ? rawButtons
    : [{
        label: cleanButtonLabel(input.ctaLabel) || "Open in Phoenix",
        url: String(input.ctaUrl ?? input.actionUrl ?? "").trim(),
      }];

  const safeButtons = buttons
    .filter((button) => button.url)
    .slice(0, 3)
    .map((button) => ({
      text: button.label || "Open in Phoenix",
      url: phoenixActionUrl(button.url),
    }));

  if (rawButtons.length > 0 && safeButtons.length === 0) return { error: "Telegram action button URL is missing." };
  if (input.ctaLabel && safeButtons.length === 0) return { error: "Telegram CTA URL is missing." };
  return { buttons: safeButtons };
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

  const actionButtons = buildTelegramButtons(input);
  if (actionButtons.error) return { reason: actionButtons.error, skipped: true };
  const replyMarkup = actionButtons.buttons && actionButtons.buttons.length > 0
    ? {
        inline_keyboard: actionButtons.buttons.map((button) => [button]),
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
