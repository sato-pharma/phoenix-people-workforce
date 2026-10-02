/**
 * The browser's half of connecting Telegram — ONE path, used by every screen that offers it.
 *
 * The Notification Settings panel (src/components/notifications/notification-settings-panel.tsx) had
 * the only "Connect Telegram" button until 2026-10-02, when Phoenix CRM gained a card asking its reps
 * and managers to connect (0 of 74 reps had). Both now go through this file to the same two routes,
 * so there is exactly one connect flow: a one-time deep link from POST /api/integrations/telegram/connect
 * (15 minutes, single use), which the person opens and presses START in the bot; the bot's webhook then
 * marks the connection, and GET /api/notifications/settings reads it back.
 *
 * Pure browser code: `fetch` only, no server imports, safe in any client bundle.
 */

/** What a Telegram action's refusal says — a 403 is a permission, never a vague failure. */
export function telegramActionErrorMessage(
  response: Pick<Response, "status">,
  payload: { error?: string; message?: string } | null,
  fallback: string,
): string {
  // A 403 from these endpoints is a permission denial (the API returns {error:"forbidden"} with no
  // message), so it is said plainly instead of the generic fallback — otherwise a blocked role reads
  // "Unable to create Telegram link." and chases the wrong problem.
  if (response.status === 403 || payload?.error === "forbidden") {
    return "You don't have permission to manage Telegram notifications. Please contact an administrator.";
  }
  return payload?.message ?? fallback;
}

export type TelegramConnectLink = { link: string | null; expiresAt: string | null };

/** A fresh one-time link into the Phoenix bot. Throws with a sentence when the server refuses. */
export async function requestTelegramConnectLink(): Promise<TelegramConnectLink> {
  const response = await fetch("/api/integrations/telegram/connect", { method: "POST" });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(telegramActionErrorMessage(response, payload, "Unable to create Telegram link."));
  return { link: payload?.data?.link ?? null, expiresAt: payload?.data?.expiresAt ?? null };
}

/** The person's Telegram status as the settings read has it ("connected", "pending", …), or null when it cannot be read. */
export async function readTelegramConnectionStatus(): Promise<string | null> {
  try {
    const response = await fetch("/api/notifications/settings", { cache: "no-store" });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    const status = payload?.data?.telegram?.status;
    return typeof status === "string" ? status : null;
  } catch {
    return null;
  }
}
