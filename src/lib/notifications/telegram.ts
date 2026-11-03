import crypto from "crypto";

export type TelegramSendInput = {
  actionUrl?: string | null;
  buttons?: Array<{ label: string; url: string }> | null;
  chatId: string;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  /** Keep the message's paragraph breaks instead of running it into one block. */
  keepParagraphs?: boolean;
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
  /** The status Telegram answered a failed read with. A dead key and Telegram's own fault are not the same news. */
  httpStatus?: number;
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

// Telegram's setWebhook `secret_token` accepts ONLY [A-Za-z0-9_-], 1-256 chars. A raw
// NOTIFICATION_WEBHOOK_SECRET that contains other characters (e.g. base64 "+/=") makes
// setWebhook fail ("secret token contains unallowed characters"), so the webhook never
// registers and every inbound update fails signature validation (HTTP 403). Derive a
// stable, always-compliant token: pass the secret through untouched when it already
// complies (backward compatible), else use its SHA-256 hex (64 chars, guaranteed valid).
// Both setWebhook and the inbound validator MUST use this same helper so the registered
// token and the expected token match.
export function telegramWebhookSecretToken() {
  const raw = telegramWebhookSecret();
  if (!raw) return null;
  if (/^[A-Za-z0-9_-]{1,256}$/.test(raw)) return raw;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * How long a Telegram connect link stays usable, for BOTH ways of issuing one.
 *
 * ONE WINDOW, DELIBERATELY. The two paths used to disagree: the emailed invitation lasted 48 hours,
 * and the link the employee generates for himself in the portal lasted 15 MINUTES. The short one
 * was measured against reality on 2026-09-09 and it fails: every pending row in production — eight
 * of them, going back to June, against two people ever connected — expired UNUSED, and every one
 * carried the 15-minute stamp. Nobody abandoned the flow; the credential died while they were
 * looking for it.
 *
 * Fifteen minutes assumes the link is used where it is shown. It is not: the employee sees it on a
 * desktop and has to reach Telegram on his phone, which means installing the app, signing up, or
 * simply finding the message he sent himself. The email path's own comment already says people
 * "may open the invitation hours later" — that is just as true of the portal link.
 *
 * The exposure is no worse than the email path's, and is arguably smaller: this link never leaves
 * the authenticated session it was created in, it is single-use, the webhook nulls the hash on
 * first use, and a post-link security alert makes a hijack detectable.
 */
export const TELEGRAM_CONNECT_TOKEN_TTL_MINUTES = 48 * 60;

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
        httpStatus: response.status,
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

function appOrigin() {
  const base = appUrl();
  if (!base) return null;
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
}

function isPhoenixTelegramButtonUrl(value: string | null | undefined) {
  const url = String(value ?? "").trim();
  if (!url) return false;
  // Relative Phoenix paths are only safe to accept if we have an app URL to build an
  // absolute link from — otherwise phoenixActionUrl() would emit a bare broken relative
  // link in the Telegram button. Disallow the relative path when the app URL is unset.
  if (url.startsWith("/") && !url.startsWith("//")) return Boolean(appUrl());
  if (!/^https?:\/\//i.test(url)) return false;
  const origin = appOrigin();
  if (!origin) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function cleanTelegramText(value: string) {
  return value
    .replace(/\s+/g, " ")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 900);
}

/** Each paragraph cleaned as one line, the blank line between paragraphs kept. */
function cleanTelegramParagraphs(value: string) {
  return value
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").replace(/[<>]/g, "").trim())
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 900);
}

/**
 * The text a Telegram notification sends: the title, a blank line, then the message. The message is
 * one block, unless `keepParagraphs` asks for its paragraph breaks to stay.
 */
export function telegramNotificationText(input: Pick<TelegramSendInput, "keepParagraphs" | "message" | "title">): string {
  return [cleanTelegramText(input.title), input.keepParagraphs ? cleanTelegramParagraphs(input.message) : cleanTelegramText(input.message)]
    .filter(Boolean)
    .join("\n\n");
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
    .filter((button) => isPhoenixTelegramButtonUrl(button.url))
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

type TelegramApiResult<T> = { ok: true; result: T } | { error: string; ok: false };

// Generic Telegram Bot API caller used by the provisioning helpers. Send/webhook
// status keep their own bespoke logic above; this one centralises the boilerplate
// for the one-time setup calls (getMe, setWebhook, setMyCommands, …).
async function callTelegram<T = unknown>(method: string, body?: Record<string, unknown>): Promise<TelegramApiResult<T>> {
  const token = telegramBotToken();
  if (!token) return { error: "TELEGRAM_BOT_TOKEN is missing.", ok: false };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), telegramTimeoutMs());
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      body: body ? JSON.stringify(body) : undefined,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      method: "POST",
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => null)) as { description?: string; ok?: boolean; result?: T } | null;
    if (!response.ok || payload?.ok === false) {
      return { error: cleanWebhookError(payload?.description) ?? `Telegram ${method} failed with ${response.status}.`, ok: false };
    }
    return { ok: true, result: payload?.result as T };
  } catch (error) {
    return {
      error: error instanceof Error && error.name === "AbortError" ? `Telegram ${method} timed out.` : `Telegram ${method} unavailable.`,
      ok: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export type TelegramBotIdentity = {
  canJoinGroups: boolean | null;
  firstName: string | null;
  id: number | null;
  username: string | null;
};

export async function getTelegramBotIdentity(): Promise<{ error: string | null; identity: TelegramBotIdentity | null; ok: boolean }> {
  const result = await callTelegram<{ can_join_groups?: boolean; first_name?: string; id?: number; username?: string }>("getMe");
  if (!result.ok) return { error: result.error, identity: null, ok: false };
  return {
    error: null,
    identity: {
      canJoinGroups: result.result?.can_join_groups ?? null,
      firstName: result.result?.first_name ?? null,
      id: result.result?.id ?? null,
      username: result.result?.username ?? null,
    },
    ok: true,
  };
}

let cachedBotUsername: { at: number; value: string } | null = null;
const BOT_USERNAME_CACHE_MS = 5 * 60 * 1000;

// The connect link's bot is defined by the TOKEN, not the env username. We resolve
// the live username from getMe (cached ~5 min) so connect deep links always point at
// the bot that actually owns the token and the configured webhook — they can never
// drift to a stale/old bot if TELEGRAM_BOT_USERNAME is wrong.
//
// IMPORTANT: when getMe is unavailable we return null rather than falling back to the
// env username. A connect link is a credential; pointing it at a possibly-stale env
// bot is worse than failing loudly ("bot temporarily unreachable, try again"). The env
// value is only a labelled *display* fallback elsewhere (provisioning report, pilot
// health), never a source of truth for generated connect links.
export async function resolveTelegramBotUsername(): Promise<string | null> {
  const now = Date.now();
  if (cachedBotUsername && now - cachedBotUsername.at < BOT_USERNAME_CACHE_MS) {
    return cachedBotUsername.value;
  }
  const identity = await getTelegramBotIdentity();
  const liveUsername = identity.ok ? identity.identity?.username?.replace(/^@/, "") ?? null : null;
  if (liveUsername) {
    cachedBotUsername = { at: now, value: liveUsername };
    return liveUsername;
  }
  return null;
}

export async function buildTelegramDeepLinkFromToken(token: string): Promise<string | null> {
  const username = await resolveTelegramBotUsername();
  if (!username) return null;
  return `https://t.me/${encodeURIComponent(username)}?start=${encodeURIComponent(token)}`;
}

export type TelegramProvisionStep = { detail: string; ok: boolean; step: string };

export type TelegramProvisionReport = {
  botUsername: string | null;
  ok: boolean;
  secretConfigured: boolean;
  steps: TelegramProvisionStep[];
  webhook: TelegramWebhookStatus;
};

// One-shot provisioning of the Telegram bot as Phoenix's notification channel:
// validate the token, point the webhook at this deployment (secret-protected),
// register the /start command, and publish a polished bot profile. Everything is
// idempotent and safe to re-run; BotFather bot *creation* is the only step that
// cannot be automated through the API.
export async function provisionTelegramBot(input?: { dropPendingUpdates?: boolean }): Promise<TelegramProvisionReport> {
  const steps: TelegramProvisionStep[] = [];
  const secret = telegramWebhookSecret();
  const expectedUrl = expectedTelegramWebhookUrl();

  const identity = await getTelegramBotIdentity();
  steps.push({
    detail: identity.ok ? `Bot @${identity.identity?.username ?? "unknown"} is reachable.` : identity.error ?? "Bot token is invalid.",
    ok: identity.ok,
    step: "Validate bot token",
  });
  if (!identity.ok) {
    return { botUsername: telegramBotUsername(), ok: false, secretConfigured: Boolean(secret), steps, webhook: await getTelegramWebhookStatus() };
  }
  const botUsername = identity.identity?.username ?? telegramBotUsername();

  if (!expectedUrl) {
    steps.push({ detail: "PHOENIX_APP_URL / NEXT_PUBLIC_APP_URL is missing; cannot set the webhook.", ok: false, step: "Resolve webhook URL" });
    return { botUsername, ok: false, secretConfigured: Boolean(secret), steps, webhook: await getTelegramWebhookStatus() };
  }
  steps.push({ detail: expectedUrl, ok: true, step: "Resolve webhook URL" });

  const setWebhook = await callTelegram("setWebhook", {
    // Match the webhook handler, which reads message + edited_message.
    allowed_updates: ["message", "edited_message"],
    drop_pending_updates: input?.dropPendingUpdates ?? true,
    max_connections: 40,
    // Empty string explicitly CLEARS a previously-set secret on Telegram's side when
    // NOTIFICATION_WEBHOOK_SECRET is removed (passing undefined would leave it stale).
    // Use the sanitized token (telegramWebhookSecretToken) so a secret containing
    // Telegram-disallowed characters still registers instead of failing setWebhook.
    secret_token: telegramWebhookSecretToken() ?? "",
    url: expectedUrl,
  });
  steps.push({
    detail: setWebhook.ok
      ? `Webhook set to ${expectedUrl}${secret ? " (secret-protected)." : " — add NOTIFICATION_WEBHOOK_SECRET to protect it."}`
      : setWebhook.error,
    ok: setWebhook.ok,
    step: "Set webhook",
  });

  const setCommands = await callTelegram("setMyCommands", {
    commands: [{ command: "start", description: "Connect & receive Phoenix Workforce notifications" }],
  });
  steps.push({ detail: setCommands.ok ? "/start command registered." : setCommands.error, ok: setCommands.ok, step: "Register /start command" });

  // Bot profile copy — best effort (does not block provisioning ok), but reported honestly.
  const setShort = await callTelegram("setMyShortDescription", { short_description: "Phoenix Workforce notifications center." });
  const setDesc = await callTelegram("setMyDescription", {
    description:
      "Receive your Phoenix Workforce HR notifications — approvals, payroll alerts, contracts, leave, and reminders — directly in Telegram. Send /start with your personal Phoenix connect link to link your account.",
  });
  const profileOk = setShort.ok && setDesc.ok;
  steps.push({
    detail: profileOk
      ? "Bot description and short description published."
      : `Profile partially updated: ${[setShort.ok ? null : setShort.error, setDesc.ok ? null : setDesc.error].filter(Boolean).join("; ")}`,
    ok: profileOk,
    step: "Publish bot profile",
  });

  const webhook = await getTelegramWebhookStatus();
  const ok = identity.ok && setWebhook.ok && webhook.urlMatchesExpected === true;
  return { botUsername, ok, secretConfigured: Boolean(secret), steps, webhook };
}

export async function sendTelegramNotification(input: TelegramSendInput): Promise<TelegramSendResult> {
  const token = telegramBotToken();
  if (!token) return { reason: "TELEGRAM_BOT_TOKEN is missing.", skipped: true };
  if (!input.chatId.trim()) return { reason: "Telegram chat id is missing.", skipped: true };

  const text = telegramNotificationText(input);
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
  let payload: {
    description?: string;
    ok?: boolean;
    result?: { message_id?: number | string };
  } | null;
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
    // Read the body INSIDE the timer's scope. It used to sit after the `finally`, so the deadline
    // ended once headers arrived and a stalled body could hang this send with no bound at all —
    // and this is the outbox drain's delivery path, where one hung send is a head-of-line block.
    // The sibling telegramApi() below already had it right; only this call site did not.
    payload = (await response.json().catch(() => null)) as {
      description?: string;
      ok?: boolean;
      result?: { message_id?: number | string };
    } | null;
    if (controller.signal.aborted) throw new Error("Telegram request timed out.");
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new Error("Telegram request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok || payload?.ok === false) {
    // Redact any bot token the API might echo back, matching every other Telegram call path.
    throw new Error(cleanWebhookError(payload?.description) ?? `Telegram request failed with ${response.status}.`);
  }

  return { providerMessageId: String(payload?.result?.message_id ?? ""), skipped: false };
}
