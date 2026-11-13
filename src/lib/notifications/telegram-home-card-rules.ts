// The home page's "Connect Telegram" card — its rules, with no I/O and NO server-only imports, for the
// same reason push-opt-in-nudge-rules.ts has none: it is read by the server (settings.ts, the settings
// route) and by a "use client" card.
//
// Owner, 13 Nov 2026 (integration audit, the provider changes): asked where the card should appear, he
// chose "Every home page, once". Measured on production that day: 55 people had Telegram connected, 34
// had started and 32 of those never finished, so the Telegram leg of their notices reached nobody.
//
//   - it is on every home page, beside the push card, for everybody who is not connected;
//   - ONCE: the first time the person connects through it, or closes it, is the last time it is drawn
//     for them, on any device. A card asked twice becomes wallpaper;
//   - never for a test account, whose messages go nowhere real;
//   - Phoenix CRM's own daily card (src/lib/phoenix-crm/telegram-card.ts) is a different card with its
//     own rule, and stays as it is.

/** Key inside `notification_preferences.module_preferences`. Its own key: nothing else means this card was answered. */
export const TELEGRAM_HOME_CARD_ANSWERED_KEY = "telegramHomeCardAnsweredAt";

/** True once this person connected through the card or closed it. Never drawn again after this. */
export function isTelegramHomeCardAnswered(modulePreferences: Record<string, unknown> | null | undefined): boolean {
  return typeof modulePreferences?.[TELEGRAM_HOME_CARD_ANSWERED_KEY] === "string";
}

/**
 * Whether the home page draws the card. The SERVER asks this (the settings route), because only the
 * server knows a test account; the card draws what the server said.
 *
 * Every status but "connected" is asked: a link started and never finished ("pending"), a connection
 * that failed, one switched off, and no row at all are all the same thing to the person's phone.
 */
export function shouldShowTelegramHomeCard(input: {
  telegramStatus: string | null | undefined;
  modulePreferences: Record<string, unknown> | null | undefined;
  isTestAccount: boolean;
}): boolean {
  if (input.isTestAccount) return false;
  if (input.telegramStatus === "connected") return false;
  return !isTelegramHomeCardAnswered(input.modulePreferences);
}

/** Merges the answer into `module_preferences` without touching any other key stored there. */
export function withTelegramHomeCardAnswered(
  modulePreferences: Record<string, unknown> | null | undefined,
  answeredAtIso: string,
): Record<string, unknown> {
  const current = modulePreferences && typeof modulePreferences === "object" ? modulePreferences : {};
  return { ...current, [TELEGRAM_HOME_CARD_ANSWERED_KEY]: answeredAtIso };
}
