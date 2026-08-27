import { isProductionRuntime } from "@/config/system-settings";
import { telegramEnvironmentStatus } from "@/lib/notifications/telegram";

// Non-fatal notification-config drift detection.
//
// On 2026-07-11, EMAIL_NOTIFICATIONS_ENABLED silently went MISSING from the Cloud Run
// service and email was dead for ~2 days before anyone noticed (the flag fails closed when
// unset). These vars are notification-critical but NOT required to serve HTTP requests, so
// their absence must WARN (observable via /api/readyz + a structured "config_drift" log)
// without making the service report "not ready".
//
// We flag only the UNSET/absent case in production. An explicit EMAIL_NOTIFICATIONS_ENABLED
// =false is a legitimate pause/containment switch (see DR runbook §6), NOT drift, so it is
// intentionally not warned on.
//
// Not every drift var is production-only, though — the environment a var MUST exist in is a
// per-var question, so this file carries three gates (see each list below):
//   • NOTIFICATION_DRIFT_ENV / PRODUCTION_ONLY_DRIFT_ENV — production only.
//   • DEPLOYMENT_DRIFT_ENV (CRON_SECRET) — every deployed env, because the routes it guards now
//     401 on staging too (PR #2479); a production-only gate would be blind to that.
//
// NOTIFICATION_EMAIL_FROM and RESEND_WEBHOOK_SECRET are the same failure shape as the
// original incident var: read directly with no code fallback on the paths that matter
// (sendNotificationEmailDirect skips ALL outbox mail if NOTIFICATION_EMAIL_FROM is unset;
// the Resend delivery webhook 500s on every callback if RESEND_WEBHOOK_SECRET is unset), so
// their silent absence must be just as loud here.
export const NOTIFICATION_DRIFT_ENV = [
  "EMAIL_NOTIFICATIONS_ENABLED",
  "RESEND_API_KEY",
  "NOTIFICATION_EMAIL_FROM",
  "RESEND_WEBHOOK_SECRET",
] as const;

function isUnset(name: string): boolean {
  return process.env[name] === undefined || process.env[name]?.trim() === "";
}

function unsetInProduction(names: readonly string[]) {
  if (!isProductionRuntime()) return [];
  return names.filter(isUnset);
}

// CRON_SECRET is a DIFFERENT failure shape from the notification vars above. PR #2479 hardened
// the 18 cron/notification routes so an unset CRON_SECRET now returns 401 on EVERY deployed
// environment — the bypass is `NODE_ENV === "development"`, no longer `!isProductionRuntime()` —
// so staging (a 1:1 production-data clone) falls open with it too, not just production. A
// production-only drift gate would therefore be blind to exactly the environment PR #2479 was
// meant to protect. This alarm must fire wherever a route would reject real cron traffic, which
// is the precise inverse of the routes' own bypass: anywhere that is not local `development`.
// Owner-signed-off 2026-08-27 to mirror the route condition rather than enumerate prod+staging.
export const DEPLOYMENT_DRIFT_ENV = ["CRON_SECRET"] as const;

function unsetOnAnyDeployment(names: readonly string[]) {
  if (process.env.NODE_ENV === "development") return [];
  return names.filter(isUnset);
}

// MASTER_MAP_SYNC_TOKEN is production-only ON PURPOSE. Only the Master Map Google Sheet's Apps
// Script calls /api/sales/master-map/sheet, and it is only ever pointed at production (AGENTS.md
// §3 / master-map-sheet-live-on-prod memory), so the token is deliberately ABSENT on staging.
// Unlike CRON_SECRET it must therefore stay on the production-only gate — a deployment-wide check
// would fire false drift noise on every staging readiness probe.
export const PRODUCTION_ONLY_DRIFT_ENV = ["MASTER_MAP_SYNC_TOKEN"] as const;

// Same failure shape, Telegram side, read via the notifications module's own env-status
// helper (this file must not read Telegram env vars directly — see
// tests/unified-notifications.test.ts's "modules must not call Telegram directly" guard).
// A missing bot token means sendTelegramNotification silently skips every send; a missing
// webhook secret means the inbound webhook fails closed (500 on every update: replies,
// connect/link /start commands) — the second of the two real failures on 2026-07-11,
// alongside a charset bug in the same variable (fixed separately). Telegram's global enable
// switch lives in the DB (notification_channel_settings), not an env var, so unlike
// EMAIL_NOTIFICATIONS_ENABLED there is no legitimate "intentionally unset" reading here — a
// missing bot token or webhook secret in production is always drift, pilot phase or not.
function telegramDriftWarnings(): string[] {
  if (!isProductionRuntime()) return [];
  const status = telegramEnvironmentStatus();
  const warnings: string[] = [];
  if (!status.telegramBotToken) {
    warnings.push("TELEGRAM_BOT_TOKEN is unset in production (notification drift — Telegram sends may be silently broken)");
  }
  if (!status.notificationWebhookSecret) {
    warnings.push("NOTIFICATION_WEBHOOK_SECRET is unset in production (notification drift — Telegram sends/webhook may be silently broken)");
  }
  return warnings;
}

export function notificationConfigWarnings(): string[] {
  return [
    ...unsetInProduction(NOTIFICATION_DRIFT_ENV).map(
      (name) => `${name} is unset in production (notification drift — email may be silently disabled)`,
    ),
    ...telegramDriftWarnings(),
    ...unsetOnAnyDeployment(DEPLOYMENT_DRIFT_ENV).map(
      (name) =>
        `${name} is unset on a deployed environment (config drift — every cron & notification route will 401 and scheduled jobs stop silently)`,
    ),
    ...unsetInProduction(PRODUCTION_ONLY_DRIFT_ENV).map(
      (name) =>
        `${name} is unset in production (config drift — the Master Map customer-sync route will 401 and the sheet stops updating)`,
    ),
  ];
}
