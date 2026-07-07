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
    "src/lib/email-templates/service.ts",
    "src/lib/email/send-phoenix-email.ts",
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

  assert.deepEqual(resendSendEndpointFiles(), ["src/lib/email/send-phoenix-email.ts"]);

  // Verify daily dispatcher cron hardening
  const dailyCronRoute = readFileSync("app/api/notifications/daily/route.ts", "utf8");
  assert.match(dailyCronRoute, /export const maxDuration = 300;/, "daily route must declare maxDuration of 300s");
  assert.match(dailyCronRoute, /runBirthdayNotifications\(request\)\.catch\(/, "daily birthday run must have catch boundary");
  assert.match(dailyCronRoute, /runContractRenewalNotifications\(request\)\.catch\(/, "daily contract renewal run must have catch boundary");
  assert.match(dailyCronRoute, /runHolidayConfirmationReminder\(request\)\.catch\(/, "daily holiday confirmation run must have catch boundary");
  assert.match(dailyCronRoute, /runVacationSlaDaily\(\)\.catch\(/, "daily vacation SLA run must have catch boundary");
  assert.match(dailyCronRoute, /runMarketingSlaDaily\(\)\.catch\(/, "daily marketing SLA run must have catch boundary");
  assert.match(dailyCronRoute, /runRecruitmentDailyNotifications\(\)\.catch\(/, "daily recruitment run must have catch boundary");
  assert.match(dailyCronRoute, /runTelegramDailyHrDigest\(\)\.catch\(/, "daily telegram digest run must have catch boundary");
  assert.match(dailyCronRoute, /runOutstationGeocodeWarmup\(\)\.catch\(/, "daily outstation geocode warmup must have catch boundary");
  assert.match(dailyCronRoute, /runOutstationHighRiskDigest\(\)\.catch\(/, "daily outstation high risk digest must have catch boundary");
  assert.match(dailyCronRoute, /runFieldWorkforceComplianceDigest\(\)\.catch\(/, "daily FWC digest must have catch boundary");
  assert.match(dailyCronRoute, /runFieldWorkforceComplianceDeductionsAutoSync\(\)\.catch\(/, "daily deductions auto sync must have catch boundary");
  assert.match(dailyCronRoute, /runExcuseSlaDaily\(\)\.catch\(/, "daily excuse SLA must have catch boundary");
  assert.match(dailyCronRoute, /runOutstationSlaDaily\(\)\.catch\(/, "daily outstation SLA must have catch boundary");
  assert.match(dailyCronRoute, /runResignationSlaDaily\(\)\.catch\(/, "daily resignation SLA must have catch boundary");
  assert.match(dailyCronRoute, /runWeeklyPlansDriftCheck\(\)\.catch\(/, "daily weekly plans drift check must have catch boundary");
  assert.match(dailyCronRoute, /pruneExpiredRateLimitBuckets\(\)\.catch\(/, "daily rate limit prune must have catch boundary");
  assert.match(dailyCronRoute, /Sentry\.captureException\(e, \{ tags: \{ cron: "daily-birthday" \} \}\)/, "errors must be captured in Sentry with tags");
  assert.match(dailyCronRoute, /Sentry\.captureException\(e, \{ tags: \{ cron: "daily-vacation-sla" \} \}\)/, "errors must be captured in Sentry with tags");
}
