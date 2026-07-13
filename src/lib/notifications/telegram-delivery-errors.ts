// Telegram Bot API errors that are PERMANENT for a recipient: the bot cannot reach their chat
// until they re-link (start the current bot). Retrying is useless, and — the bug this guards
// against — the connection would otherwise stay `connected` and every later send fails silently
// while the app still shows the person as reachable. A bot swap (as on 2026-07-09) turns every
// pre-existing chat into "chat not found" at once; treating these as permanent lets the sender
// flag the connection for re-link instead of swallowing notifications indefinitely.
//
// Kept dependency-free (no imports) so it stays trivially unit-testable and reusable by both the
// live send path and the retry worker.
export function isPermanentTelegramDeliveryError(message: string): boolean {
  const normalized = String(message ?? "").toLowerCase();
  return (
    normalized.includes("chat not found") ||
    normalized.includes("bot was blocked") ||
    normalized.includes("user is deactivated") ||
    normalized.includes("bot can't initiate a conversation") ||
    normalized.includes("peer_id_invalid")
  );
}
