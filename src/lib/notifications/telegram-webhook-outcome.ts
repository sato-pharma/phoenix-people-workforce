/**
 * What the Telegram webhook tells the person in the chat, and what it writes to the log.
 *
 * Until 2026-10-04 a person who pressed START in the Phoenix bot got NOTHING back — not on success,
 * and not when the link was already used, expired or replaced. The webhook answered Telegram 200 and
 * said nothing in the chat or the log, so a connect that failed looked exactly like one nobody had
 * tried: production held fifteen "pending" connections, none with a used token, the last completed
 * link was 9 Aug, and one person asked for a fresh link about thirteen times in a night. Nothing on
 * the server could say whether START ever arrived.
 *
 * Pure rules only (no I/O), so the wording and the classification are pinned by
 * tests/telegram-webhook-outcome.test.ts. The route does the sending and the logging.
 *
 * Never put a token, a chat id or a username in anything built here: the log line is plain text on a
 * shared stream, and a connect token is a credential until it is used.
 */

/** What a person's message to the bot amounted to. */
export type TelegramInboundKind =
  /** `/start <token>` — the connect press this webhook exists for. */
  | "start_with_token"
  /** `/start` alone: found the bot without a connect link. */
  | "bare_start"
  /** Any other text, or an update with no message at all. */
  | "other";

/** How a connect attempt ended. */
export type TelegramLinkOutcome = "linked" | "token_invalid" | "token_used" | "token_expired" | "failed";

export function classifyTelegramInbound(text: string | null | undefined): TelegramInboundKind {
  const trimmed = String(text ?? "").trim();
  if (/^\/start(?:@\w+)?\s+[A-Za-z0-9_-]+$/.test(trimmed)) return "start_with_token";
  if (/^\/start(?:@\w+)?\s*$/.test(trimmed)) return "bare_start";
  return "other";
}

/**
 * A token that is invalid, used or expired will NEVER succeed on retry, so the route answers Telegram
 * 200 and stops its retry storm. Anything else (a database failure) is transient: Telegram retries it.
 */
export function classifyTelegramLinkError(error: unknown): TelegramLinkOutcome {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes("token was already used")) return "token_used";
  if (message.includes("token expired")) return "token_expired";
  if (message.includes("token is invalid") || message.includes("token is required")) return "token_invalid";
  return "failed";
}

export function isPermanentTelegramLinkOutcome(outcome: TelegramLinkOutcome): boolean {
  return outcome !== "linked" && outcome !== "failed";
}

export type TelegramReply = { message: string; title: string };

/** The words sent back in the chat — null when the outcome is transient and Telegram will retry. */
export function telegramLinkReply(outcome: TelegramLinkOutcome): TelegramReply | null {
  switch (outcome) {
    case "linked":
      return {
        title: "✅ Telegram connected",
        message: "Phoenix Workforce messages will reach you here. You can turn them off any time from Notification Settings in Phoenix.",
      };
    case "token_expired":
      return {
        title: "This link has expired",
        message: "Open Phoenix, press Connect Telegram to get a new link, then press START again.",
      };
    case "token_used":
      return {
        title: "This link was already used",
        message: "If Telegram is not showing as connected in Phoenix, press Connect Telegram there to get a new link.",
      };
    case "token_invalid":
      return {
        title: "This link is no longer valid",
        message: "Each new link replaces the one before it. Open Phoenix, press Connect Telegram once, and use only the newest link.",
      };
    case "failed":
      return null;
  }
}

/** The one line the webhook logs per update — an outcome and a kind, never a credential or a person. */
export function telegramWebhookLogLabels(kind: TelegramInboundKind, outcome: TelegramLinkOutcome | "ignored") {
  return { event: "telegram_webhook_update", kind, outcome };
}
