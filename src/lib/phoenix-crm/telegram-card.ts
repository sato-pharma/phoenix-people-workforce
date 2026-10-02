/**
 * Phoenix CRM — the "Get Phoenix CRM messages on Telegram" card, with no I/O.
 *
 * Owner, 2026-10-02. Measured that day: 0 of 74 active reps — and none of the district managers — had
 * Telegram connected (`telegram_connections.status = 'connected'`), so every Telegram leg of every
 * Phoenix CRM notice reached nobody. So the module asks, once, in one compact card at the top of the
 * page, until he is connected:
 *
 *   - it is for the people Phoenix CRM's notices are FOR: the reps, their managers (district,
 *     regional and national) and the SFE Manager. Never the Super Admin, and never a test account,
 *     whose messages go nowhere real;
 *   - its one button goes into the EXISTING connect flow — the same `POST
 *     /api/integrations/telegram/connect` the Notification Settings panel calls, through the one
 *     client helper both use (src/components/notifications/telegram-connect.ts). There is no second
 *     way to connect;
 *   - it disappears once he is connected: the SERVER says whether he is (the overview's `telegram`),
 *     and the card asks the same settings read again when he comes back from the bot;
 *   - "Later" hides it for the rest of that Cairo day, in this browser only (localStorage, every
 *     read and write wrapped — a phone that refuses storage simply shows the card again).
 *
 * It is a card, not a step: nothing waits on it and nothing is blocked by it.
 */

/** The browser key "Later" writes the Cairo day under. */
export const TELEGRAM_CARD_LATER_KEY = "phoenix-crm:telegram-card:later";

export type TelegramCardViewer = {
  isSuperAdmin: boolean;
  isTestPersona: boolean;
  isRep: boolean;
  isManager: boolean;
  isSfeManager: boolean;
};

/** Who is asked: the reps and the managers Phoenix CRM's notices go to. */
export function telegramCardOffered(viewer: TelegramCardViewer): boolean {
  if (viewer.isSuperAdmin || viewer.isTestPersona) return false;
  return viewer.isRep || viewer.isManager || viewer.isSfeManager;
}

/** Whether the page draws the card at all, from what the server said: offered, and not connected. */
export function showsTelegramCard(telegram: { connected: boolean } | null | undefined): boolean {
  return Boolean(telegram && !telegram.connected);
}

/** "Later" was pressed today (Cairo) — the card stays away until tomorrow. */
export function telegramCardLaterToday(storedDay: string | null | undefined, cairoToday: string): boolean {
  return typeof storedDay === "string" && storedDay.length > 0 && storedDay === cairoToday;
}
