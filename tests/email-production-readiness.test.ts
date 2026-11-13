import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runEmailProductionReadinessTests() {
  const systemSettingsSource = readFileSync("src/config/system-settings.ts", "utf8");
  const sendSource = readFileSync("src/lib/email/send-phoenix-email.ts", "utf8");
  const emailSource = readFileSync("src/lib/notifications/email.ts", "utf8");
  const scheduledSource = readFileSync("src/lib/notifications/scheduled-processing.ts", "utf8");
  const dailySource = readFileSync("app/api/cron/daily/_lib/daily-job-runners.ts", "utf8");
  const healthSource = readFileSync("app/api/health/email/route.ts", "utf8");

  // P0-1: forceTestingDelivery is env-controlled
  assert.match(
    systemSettingsSource,
    /PHOENIX_EMAIL_FORCE_TESTING/,
    "system-settings must read PHOENIX_EMAIL_FORCE_TESTING env var",
  );
  assert.match(
    sendSource,
    /isForceTestingDelivery/,
    "send-phoenix-email must use isForceTestingDelivery function",
  );

  // P0-2: stuck processing row reaper
  assert.match(
    emailSource,
    /reapStaleProcessingOutboxRows/,
    "email module must export a stuck-row reaper function",
  );
  assert.match(
    scheduledSource,
    /reapStaleProcessingOutboxRows/,
    "scheduled processing must call the stuck-row reaper",
  );

  // P0-3: active employee filter. Now expressed as a null-safe positive allow-list against the
  // canonical ACTIVE_EMPLOYMENT_STATUSES_IN_LIST (was a hand-rolled `.not(... in
  // (resigned,terminated,inactive))` denylist that both missed `not_renewed` and silently
  // dropped NULL-status rows — see tests/employee-status-filter-consolidation.test.ts).
  assert.match(
    emailSource,
    /employment_status\.is\.null,employment_status\.in\.\$\{ACTIVE_EMPLOYMENT_STATUSES_IN_LIST\}/,
    "email recipient queries must filter to active employees via the canonical allow-list",
  );

  // P0-4: bounce/complaint suppression
  assert.match(
    sendSource,
    /loadSuppressedRecipients/,
    "send layer must check for suppressed recipients",
  );
  assert.match(
    sendSource,
    /All recipients are suppressed/,
    "send layer must skip when all recipients are suppressed",
  );

  // P0-5: List-Unsubscribe headers
  assert.match(
    emailSource,
    /List-Unsubscribe/,
    "notification email must add List-Unsubscribe header",
  );
  assert.match(
    sendSource,
    /headers/,
    "send-phoenix-email must support custom headers",
  );

  // P1-6: Sentry capture
  assert.match(
    emailSource,
    /logError/,
    "email module must report failures to Sentry",
  );

  // P1-7: health check endpoint
  assert.match(healthSource, /RESEND_API_KEY/, "health check must verify RESEND_API_KEY");
  assert.match(healthSource, /healthy.*degraded|degraded.*healthy/, "health check must report status");

  // P1-8: retention cleanup. Moved 2026-07-19 from the 5-min scheduled-processing cron to the
  // once-daily notifications cron (deleting rows past a fixed cutoff has no benefit running
  // 288x/day) — the P1 requirement is that it stays wired into a cron, so this asserts the daily
  // route now calls it rather than scheduled-processing.
  assert.match(
    emailSource,
    /cleanupOldNotificationData/,
    "email module must export a retention cleanup function",
  );
  assert.match(
    dailySource,
    /cleanupOldNotificationData/,
    "daily notifications cron must call retention cleanup",
  );

  // P1-9: terminal-failed stats
  assert.match(
    emailSource,
    /terminalFailed/,
    "outbox stats must include terminal failure count",
  );
}
