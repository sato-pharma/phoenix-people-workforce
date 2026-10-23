/**
 * A STORED NOTICE IS NEVER REWRITTEN ONCE IT HAS REACHED SOMEBODY.
 *
 * `notification_events.event_key` is the notice's idempotency key, and every delivery hangs off that
 * row. A second send with the same key is refused delivery (`claimDelivery` finds the key taken), but
 * until 23 Oct 2026 `createNotificationEvent` still upserted the row first — so the refused send
 * rewrote the title, body and sent time the in-app bell shows, with text nobody was ever sent. In the
 * 30 days to 23 Oct about twenty event types were rewritten that way (`interview_awaiting_response`
 * 566 times, `closing_published` 66, the System Audit daily message that read "365 issues" at 10:56
 * and "3 issues" by 11:53).
 *
 * The rule, for every sender: once any delivery of a notice was sent, or is on its way (pending,
 * retrying), the stored notice is what that person received and stays as it is. A notice whose every
 * delivery was skipped or failed reached nobody, so a later send may still rewrite it.
 */

/** Delivery statuses that mean the notice reached, or is on its way to, the person. */
export const REACHED_DELIVERY_STATUSES = ["sent", "pending", "retrying"] as const;

/** Pure: true when any of a notice's deliveries reached, or is on its way to, its person. */
export function noticeAlreadyReached(statuses: readonly (string | null | undefined)[]): boolean {
  return statuses.some((status) => (REACHED_DELIVERY_STATUSES as readonly string[]).includes(String(status ?? "")));
}
