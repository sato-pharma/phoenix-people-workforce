// Owner rule (2026-10-10): publishing a Monthly Closing tells EVERYONE seated on that line — by email,
// by Telegram and in the app. The email is ONE shared message built by closing-publish-notification.ts
// (To: the line's team, Cc: the leadership roster), so the per-person notice carries in-app and Telegram
// ONLY.
//
// The one way a second email could reach a rep is the Telegram-failure fallback, which re-sends a
// failed Telegram notice as ["email", "in_app", "push"]: for a rep who never linked Telegram that is
// every time, and it would mail him a copy of the shared email he already holds. Both channels that
// re-send adds are therefore redundant for this notice — the email is already out and the bell row
// already exists — so the whole fallback is skipped. Same shape as phoenixCrmBlocksTelegramFallback.

export const CLOSING_PUBLISH_NOTIFICATION_MODULE = "sales";
export const CLOSING_PUBLISH_NOTIFICATION_EVENT = "closing_published";

/** Whether a FAILED Telegram delivery may be covered by the email/in-app/push re-send. False for this notice. */
export function closingPublishBlocksTelegramFallback(module: string | null | undefined, eventType?: string | null): boolean {
  return (
    String(module ?? "").trim().toLowerCase() === CLOSING_PUBLISH_NOTIFICATION_MODULE &&
    String(eventType ?? "").trim().toLowerCase() === CLOSING_PUBLISH_NOTIFICATION_EVENT
  );
}
