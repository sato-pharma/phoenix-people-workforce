import { isProductionRuntime } from "@/config/system-settings";

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
export const NOTIFICATION_DRIFT_ENV = ["EMAIL_NOTIFICATIONS_ENABLED", "RESEND_API_KEY"] as const;

export function notificationConfigWarnings(): string[] {
  if (!isProductionRuntime()) return [];
  return NOTIFICATION_DRIFT_ENV.filter(
    (name) => process.env[name] === undefined || process.env[name]?.trim() === "",
  ).map((name) => `${name} is unset in production (notification drift — email may be silently disabled)`);
}
