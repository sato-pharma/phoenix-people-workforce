import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function runtimeSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) return runtimeSourceFiles(fullPath);
    return /\.(ts|tsx)$/.test(entry) ? [fullPath.replace(/\\/g, "/")] : [];
  });
}

function directSendPhoenixEmailFiles() {
  return ["app", "src"]
    .flatMap(runtimeSourceFiles)
    .filter((file) => /\bsendPhoenixEmail\(/.test(readFileSync(file, "utf8")))
    .sort();
}

function resendSendEndpointFiles() {
  return ["app", "src"]
    .flatMap(runtimeSourceFiles)
    .filter((file) => /api\.resend\.com\/emails/.test(readFileSync(file, "utf8")))
    .sort();
}

export function runEmailNotificationTests() {
  const source = readFileSync("src/lib/notifications/email.ts", "utf8");
  const emailTemplateServiceSource = readFileSync("src/lib/email-templates/service.ts", "utf8");
  const sendPhoenixEmailSource = readFileSync("src/lib/email/send-phoenix-email.ts", "utf8");
  const systemSettingsSource = readFileSync("src/config/system-settings.ts", "utf8");
  const manualHrRouteSource = readFileSync("app/api/admin/email-reply/send/route.ts", "utf8");
  const notificationTestRouteSource = readFileSync("app/api/notifications/test/route.ts", "utf8");
  const telegramOnboardingSource = readFileSync("src/lib/notifications/telegram-onboarding.ts", "utf8");
  const vacationEmailSource = readFileSync("src/lib/vacation/email.ts", "utf8");

  for (const type of ["probation", "contract_renewal", "birthday", "offer", "resignation"]) {
    assert.match(source, new RegExp(`"${type}"`));
  }
  assert.doesNotMatch(source, /"vacation"/);

  assert.match(source, /notification type is not approved for automatic Resend delivery/);
  assert.match(source, /buildEmailNotificationPreview/);
  assert.match(source, /resolveNotificationDelivery/);
  assert.match(source, /cc\?: string\[\]/, "notification email payload must carry explicit CC recipients");
  assert.match(source, /bcc\?: string\[\]/, "notification email payload must carry explicit BCC recipients");
  assert.match(source, /cc: input\.cc/, "notification email sends must pass CC through to templates and direct sends");
  assert.match(source, /bcc: input\.bcc/, "notification email sends must pass BCC through to templates and direct sends");
  assert.match(sendPhoenixEmailSource, /PHOENIX_EMAIL_DELIVERY_MODE/);
  assert.match(sendPhoenixEmailSource, /PHOENIX_EMAIL_TEST_RECIPIENTS/);
  assert.match(sendPhoenixEmailSource, /testingRecipients \? undefined : input\.cc/);
  // Testing-delivery configuration is centralized in system-settings.ts (single
  // source of truth). The send layer reads the switch + fallback recipients from there.
  assert.match(sendPhoenixEmailSource, /isForceTestingDelivery/);
  assert.match(systemSettingsSource, /isForceTestingDelivery/);
  assert.match(systemSettingsSource, /testingRecipientFallback/);
  assert.match(systemSettingsSource, /omar\.anwar@satopharma\.com/);
  assert.match(systemSettingsSource, /phoenix@satopharma\.com/);

  assert.match(notificationTestRouteSource, /renderPhoenixEmailHtml/);
  assert.match(notificationTestRouteSource, /renderPhoenixEmailText/);
  assert.doesNotMatch(notificationTestRouteSource, /const html = `<div/);

  assert.deepEqual(directSendPhoenixEmailFiles(), [
    "app/api/admin/email-reply/send/route.ts",
    "app/api/notifications/test/route.ts",
    // Direct orders send a bespoke premium "approved" details table to a fixed recipient
    // (CEO + system admin CC'd) on final CEO approval — a fixed renderer, not the DB
    // template engine. See src/lib/direct-orders/approved-email.ts.
    "src/lib/direct-orders/approved-email.ts",
    "src/lib/email-templates/service.ts",
    "src/lib/email/send-phoenix-email.ts",
    // A Super Admin's manual approval of a held item re-sends the EXACT held content,
    // bypassing the gate for that one already-reviewed send. See approveHeldNotification
    // in src/lib/notifications/confidence-gate.ts.
    "src/lib/notifications/confidence-gate.ts",
    "src/lib/notifications/email.ts",
    "src/lib/notifications/telegram-onboarding.ts",
    "src/lib/sales/sos-report-delivery.ts",
    "src/lib/vacation/email.ts",
  ]);
  assert.match(emailTemplateServiceSource, /renderPhoenixEmailHtml/);
  assert.match(emailTemplateServiceSource, /renderPhoenixEmailText/);
  assert.match(source, /renderGeneralNotificationEmailHtml/);
  assert.match(source, /renderGeneralNotificationEmailText/);
  assert.match(manualHrRouteSource, /buildPhoenixHrReplyEmail/);
  assert.match(telegramOnboardingSource, /renderTelegramConnectEmailHtml/);
  assert.match(telegramOnboardingSource, /renderTelegramConnectEmailText/);
  assert.match(vacationEmailSource, /renderPhoenixEmailHtml/);
  assert.match(vacationEmailSource, /renderPhoenixEmailText/);

  // The single raw Resend send endpoint now lives in the provider-failover adapter.
  assert.deepEqual(resendSendEndpointFiles(), ["src/lib/email/email-providers.ts"]);

  // Verify daily dispatcher cron hardening
  const dailyCronRoute = readFileSync("app/api/notifications/daily/route.ts", "utf8");
  assert.match(dailyCronRoute, /export const maxDuration = 300;/, "daily route must declare maxDuration of 300s");
  assert.match(dailyCronRoute, /runBirthdayNotifications\(request\)\.catch\(/, "daily birthday run must have catch boundary");
  assert.match(dailyCronRoute, /runContractRenewalNotifications\(request\)\.catch\(/, "daily contract renewal run must have catch boundary");
  assert.match(dailyCronRoute, /runHolidayConfirmationReminder\(request\)\.catch\(/, "daily holiday confirmation run must have catch boundary");
  assert.match(dailyCronRoute, /runVacationSlaDaily\(\)\.catch\(/, "daily vacation SLA run must have catch boundary");
  assert.match(dailyCronRoute, /runMarketingSlaDaily\(\)\.catch\(/, "marketing SLA reminder/escalation is restored behind a real admin toggle (see marketing_sla_reminder in role-recipients.ts)");
  assert.match(dailyCronRoute, /runRecruitmentDailyNotifications\(\)\.catch\(/, "daily recruitment run must have catch boundary");
  assert.match(dailyCronRoute, /runTelegramDailyHrDigest\(\)\.catch\(/, "daily telegram digest run must have catch boundary");
  assert.match(dailyCronRoute, /runOutstationGeocodeWarmup\(\)\.catch\(/, "daily outstation geocode warmup must have catch boundary");
  // The FWC *digest* was retired 2026-08-02. The deductions auto-sync below has a near-identical
  // name and is deliberately kept — it writes deduction candidates, so this assertion is the guard
  // against the two being confused and the wrong one being removed.
  assert.doesNotMatch(dailyCronRoute, /runFieldWorkforceComplianceDigest\(/, "the FWC digest was retired — it must not be re-wired into the daily cron");
  assert.match(dailyCronRoute, /runFieldWorkforceComplianceDeductionsAutoSync\(\)\.catch\(/, "daily deductions auto sync must have catch boundary");
  assert.match(dailyCronRoute, /runExcuseSlaDaily\(\)\.catch\(/, "daily excuse SLA must have catch boundary");
  assert.match(dailyCronRoute, /runOutstationSlaDaily\(\)\.catch\(/, "outstation SLA reminder is restored behind a real admin toggle (see outstation_sla_reminder in role-recipients.ts)");
  assert.match(dailyCronRoute, /runResignationSlaDaily\(\)\.catch\(/, "daily resignation SLA must have catch boundary");
  assert.match(dailyCronRoute, /runWeeklyPlansDriftCheck\(\)\.catch\(/, "daily weekly plans drift check must have catch boundary");
  assert.match(dailyCronRoute, /runExcuseDriftCheck\(\)\.catch\(/, "daily excuse drift check must have catch boundary");
  assert.match(dailyCronRoute, /pruneExpiredRateLimitBuckets\(\)\.catch\(/, "daily rate limit prune must have catch boundary");
  // Sub-job failures must be observable. These two assertions previously pinned
  // `console.error(e, { tags: { cron: "..." } })` under the claim "errors must be captured in
  // Sentry with tags" — but that second argument is not a console.error parameter, no
  // console-capture integration is registered in sentry.server.config.ts, and the label
  // `event=cron_failed` that GCP log-based alerting matches on was never emitted. So 18 of the 22
  // sub-jobs failed completely silently while the route still returned `success: true`.
  // Now every sub-job routes through onJobFailure -> logError with the standard labels, matching
  // the convention already asserted for scheduled-processing.ts further down this file.
  assert.match(
    dailyCronRoute,
    /logError\(`Daily cron sub-job failed: \$\{job\}`, \{ labels: \{ event: "cron_failed", job \}, error \}\)/,
    "daily sub-job failures must be logged via logError with event=cron_failed so log-based alerting can match",
  );
  assert.doesNotMatch(
    dailyCronRoute,
    /console\.error\(e, \{ tags:/,
    "must not regress to console.error with a dead `tags` argument — it emits no cron_failed label and no Sentry issue",
  );
  assert.match(dailyCronRoute, /onJobFailure\("daily-birthday",/, "birthday sub-job must report failures through onJobFailure");
  assert.match(dailyCronRoute, /onJobFailure\("daily-vacation-sla",/, "vacation SLA sub-job must report failures through onJobFailure");

  // The run must never claim success while sub-jobs failed.
  assert.match(dailyCronRoute, /success: failures\.length === 0,/, "daily run must report success truthfully, not a hardcoded true");
  assert.doesNotMatch(dailyCronRoute, /\n    success: true,/, "daily run must not hardcode success: true");
  assert.match(dailyCronRoute, /event: "cron_run_summary"/, "daily run must emit a per-run summary log that alerting can key on");


  assert.doesNotMatch(dailyCronRoute, /maxRuntime: 60,/, "must not regress back to the 12x-looser maxRuntime");

  // Verify notification-outbox-drain cron hardening (drains every 30 min, so silent failures
  // here are far more consequential than on the once-daily dispatcher above)
  const processCronRoute = readFileSync("app/api/notifications/process/route.ts", "utf8");
  assert.match(processCronRoute, /export const maxDuration = 300;/, "process route must declare maxDuration of 300s");
  
  

  

  const scheduledProcessingSource = readFileSync("src/lib/notifications/scheduled-processing.ts", "utf8");
  assert.match(scheduledProcessingSource, /processDueProbationReminderEvents\(limit\)\.catch\(/, "probation reminder processing must have catch boundary");
  assert.match(scheduledProcessingSource, /processNotificationOutbox\(limit\)\.catch\(/, "outbox processing must have catch boundary");
  assert.match(scheduledProcessingSource, /processDeferredDeliveryRetries\(limit\)\.catch\(/, "deferred delivery retries must have catch boundary");
  assert.match(scheduledProcessingSource, /processTelegramDeliveryRetries\(limit\)\.catch\(/, "telegram delivery retries must have catch boundary");
  assert.match(scheduledProcessingSource, /logError\("Notification outbox processing step failed", \{\s*labels: \{ event: "cron_step_failed", cron: "notification-process-outbox" \},/, "outbox errors must be captured in Sentry with tags");
  assert.match(scheduledProcessingSource, /logError\("Telegram delivery retry processing step failed", \{\s*labels: \{ event: "cron_step_failed", cron: "notification-process-telegram" \},/, "telegram retry errors must be captured in Sentry with tags");
}
