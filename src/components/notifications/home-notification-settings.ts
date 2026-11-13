/**
 * The one settings read a home page's notification cards share.
 *
 * A home page draws two cards that each need the person's notification settings: the push card and the
 * Telegram card (13 Nov 2026). Asked separately that is the same request twice on every home page, for
 * every person, on every visit. Both ask here instead, and the cards of one page share one request: the
 * read in flight is handed to whoever asks while it is still running, and is forgotten the moment it
 * answers, so the next page reads afresh.
 *
 * Pure browser code: `fetch` only, no server imports, safe in any client bundle.
 */

export type HomeNotificationSettings = {
  /** How many devices receive push now. */
  pushDeviceCount: number;
  /** When the most recent device that no longer receives push was last seen receiving it, or null. */
  pushLastDroppedSubscribedAt: string | null;
  modulePreferences: Record<string, unknown>;
  /** Whether the server says the Telegram card is drawn for this person. */
  telegramCard: boolean;
};

let inFlight: Promise<HomeNotificationSettings | null> | null = null;

/** The settings, or null when they cannot be read: a card that cannot know draws nothing. */
export function readHomeNotificationSettings(): Promise<HomeNotificationSettings | null> {
  if (inFlight) return inFlight;
  const read = fetch("/api/notifications/settings", { cache: "no-store" })
    .then(async (response): Promise<HomeNotificationSettings | null> => {
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.data) return null;
      const data = payload.data as {
        preferences?: { modulePreferences?: Record<string, unknown> };
        push?: { deviceCount?: number; lastDroppedSubscribedAt?: string | null };
      };
      return {
        modulePreferences: data.preferences?.modulePreferences ?? {},
        pushDeviceCount: data.push?.deviceCount ?? 0,
        pushLastDroppedSubscribedAt: typeof data.push?.lastDroppedSubscribedAt === "string" ? data.push.lastDroppedSubscribedAt : null,
        telegramCard: payload.homeCards?.telegram === true,
      };
    })
    .catch(() => null)
    .finally(() => {
      if (inFlight === read) inFlight = null;
    });
  inFlight = read;
  return read;
}
