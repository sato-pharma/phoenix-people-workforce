// Owner rule (2026-11-03): the watches built for him add no outbound email. They ask for in-app, Telegram
// and push, and the one way an email could still go out is the Telegram-failure fallback, which re-sends a
// failed Telegram notice as ["email", "in_app", "push"]. The in-app and push copies already went with the
// first send, so the only thing that re-send adds here is the email that must not happen, and the whole
// fallback is skipped. Same shape as closingPublishBlocksTelegramFallback.

const OPERATOR_WATCH_EVENTS: ReadonlySet<string> = new Set([
  "email_block_new",
  "github_workflow_overdue",
  "marketing_pharmacy_code_sync_notice",
  "tablet_fleet_watch",
  "whatsapp_handset_echoes_off",
  "whatsapp_handset_open_reminder",
]);

/** Whether a FAILED Telegram delivery may be covered by the email/in-app/push re-send. False for these notices. */
export function operatorWatchBlocksTelegramFallback(eventType?: string | null): boolean {
  return OPERATOR_WATCH_EVENTS.has(String(eventType ?? "").trim().toLowerCase());
}
