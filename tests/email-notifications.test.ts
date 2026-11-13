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
  // Owner 2026-09-13: phoenix@satopharma.com is on Resend's suppression list, so replies to system
  // mail and the fan-out To go to care.phx@ instead, and phoenix@ is no longer a testing inbox.
  assert.match(
    systemSettingsSource,
    /defaultReplyTo: "care\.phx@satopharma\.com"/,
    "system replies and the fan-out To must use care.phx@satopharma.com",
  );
  assert.doesNotMatch(
    systemSettingsSource,
    /"phoenix@satopharma\.com"/,
    "the suppressed phoenix@satopharma.com inbox must not be a default reply-to or testing recipient",
  );

  assert.match(notificationTestRouteSource, /renderPhoenixEmailHtml/);
  assert.match(notificationTestRouteSource, /renderPhoenixEmailText/);
  assert.doesNotMatch(notificationTestRouteSource, /const html = `<div/);

  // The authoritative list of modules still building their own email body and calling the
  // sender directly. Six came OFF this list on 2026-09-09 — direct orders (approved + probation
  // report), the monthly closing publish, the SoS executive report, the CV intake digest and the
  // Telegram connect invitation — and now render from an admin-editable template. What remains
  // is what genuinely cannot: see tests/email-templates-for-code-built-senders.test.ts.
  assert.deepEqual(directSendPhoenixEmailFiles(), [
    "app/api/admin/email-reply/send/route.ts",
    "app/api/notifications/test/route.ts",
    // The CEO Email Composer, added 2026-10-06. Same reason as the Sato composer below, plus one
    // of its own: its body is a LETTERHEAD, not wording. The frame — masthead, date line and the
    // signature block resolved from the directory at render time — is the document identity, so it
    // cannot live in the admin email-template catalogue where a seat could edit the signature. What
    // the sender writes is the letter inside it. A manual human send: no origin, no bypass of the
    // confidence gate; see tests/ceo-email-composer.test.ts.
    "src/lib/ceo-email/service.ts",
    "src/lib/email-templates/service.ts",
    "src/lib/email/send-phoenix-email.ts",
    // The Marketing Manager's "Approved requests" email from CEO Approvals, added 2026-11-08. It
    // replaces the email he wrote by hand each week: sent only on his own press of "Send now", in his
    // name with his reply-to, its table built from the rows and notes he ticked — no fixed wording for
    // the template catalogue and no preference to resolve. It passes an origin so the confidence gate
    // still reviews it (ceiling in CEILING_OVERRIDES), and writes the audit log. See
    // tests/marketing-ceo-approvals-email.test.ts.
    "src/lib/marketing-requests/ceo-approvals-email-service.ts",
    // A Super Admin's manual approval of a held item re-sends the EXACT held content,
    // bypassing the gate for that one already-reviewed send. See approveHeldNotification
    // in src/lib/notifications/confidence-gate.ts.
    "src/lib/notifications/confidence-gate.ts",
    // The durable approval-email door (REC-048, 13 Nov 2026). The leave emails and the two background
    // interview emails write their EXACT sender input to the outbox first; this module calls that same
    // sender with that same input, inline and on every drain retry. It adds no recipient, CC or body of
    // its own — the five leave fallback bodies (which fire ONLY when the matching template has been
    // deactivated, so they cannot themselves be templates) now reach sendPhoenixEmail through it.
    "src/lib/notifications/direct-email-payload.ts",
    "src/lib/notifications/email.ts",
    // An offer of employment goes to a candidate who has no Phoenix account, so there is no
    // notification preference to resolve and nothing for the dispatcher to hold. It is also the
    // one send in the system that must NOT carry Phoenix's identity — the owner's rule is that an
    // official offer comes from Sato Pharmaceuticals — and it carries a rendered PDF attachment.
    // Its body is built from the letter design HR edits in the module itself, not from a DB email
    // template. See src/lib/offers/send.ts.
    "src/lib/offers/send.ts",
    // The careers-site application confirmation goes to the applicant, who has no Phoenix account and
    // so no notification preference for the dispatcher to resolve. Like the offer and the interview
    // invitation it must carry the SATO identity, not Phoenix's, and its body is the SATO house
    // template rendered in the module itself (renderSatoEmail), not a DB email template. Best-effort
    // on top of an already-captured application — it never bypasses the confidence gate. See
    // src/lib/recruitment/inbound/website-apply-confirmation-email.ts.
    "src/lib/recruitment/inbound/website-apply-confirmation-email.ts",
    // An interview invitation goes to a candidate (no Phoenix account, no notification preference) or
    // to the interviewer the person picked by hand, and is sent only on that person's own press of
    // "Send" in the Interview Calendar — a manual human send, audited through
    // recordManualEmailSendAudit, not a notification for the dispatcher to hold or template.
    "src/lib/recruitment/interview-invitations.ts",
    // The Sato Email Composer, added 2026-09-12. There is no fixed wording to move into the
    // admin email-template catalogue: the body is written by the sender at send time, either
    // free-typed or from a Sato template the two seats edit inside the module itself and which
    // lives in sato_email_templates, not in the DB email-template catalogue. The dispatcher has
    // no preference to resolve either — the audience is chosen by hand, list or person, on the
    // screen. It is a manual human send, so it passes no origin and never bypasses the
    // confidence gate; see tests/sato-email-lists-only-composer.test.ts.
    "src/lib/sato-email/service.ts",
  ]);
  assert.match(emailTemplateServiceSource, /renderPhoenixEmailHtml/);
  assert.match(emailTemplateServiceSource, /renderPhoenixEmailText/);
  assert.match(source, /renderGeneralNotificationEmailHtml/);
  assert.match(source, /renderGeneralNotificationEmailText/);
  assert.match(manualHrRouteSource, /buildPhoenixHrReplyEmail/);
  // The invitation's wording moved into the template module; what stays in code is the
  // numbered walkthrough, which reaches the body as {{stepsBlock}}.
  assert.match(telegramOnboardingSource, /telegramConnectStepsHtml/);
  assert.match(telegramOnboardingSource, /telegramConnectStepsText/);
  assert.match(telegramOnboardingSource, /templateKey: "telegram_connect"/);
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
  assert.match(dailyCronRoute, /runMarketingSlaDaily\(\)\.catch\(/, "marketing SLA reminder is restored behind a real admin toggle (see marketing_sla_reminder in role-recipients.ts)");
  assert.match(dailyCronRoute, /runRecruitmentDailyNotifications\(\)\.catch\(/, "daily recruitment run must have catch boundary");
  assert.match(dailyCronRoute, /runTelegramDailyHrDigest\(\)\.catch\(/, "daily telegram digest run must have catch boundary");
  assert.match(dailyCronRoute, /runOutstationGeocodeWarmup\(\)\.catch\(/, "daily outstation geocode warmup must have catch boundary");
  // Both FWC cron jobs are now retired. The *digest* went 2026-08-02. The deductions auto-sync went
  // in the C6 deductions cutover (2026-08-30): it wrote into the legacy governance
  // `deduction_candidates` table (frozen, read by nothing outside the now-removed governance module),
  // and the unified Deductions module's CRM collector is the live no-activity path now. Neither must
  // be re-wired into the daily cron.
  assert.doesNotMatch(dailyCronRoute, /runFieldWorkforceComplianceDigest\(/, "the FWC digest was retired — it must not be re-wired into the daily cron");
  assert.doesNotMatch(dailyCronRoute, /runFieldWorkforceComplianceDeductionsAutoSync\(/, "the FWC deductions auto-sync was retired in the C6 cutover — it must not be re-wired into the daily cron");
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

  // Regression (2026-08-08): the Part 2 ready + Published payroll milestone emails silently
  // vanished because their own body text said "...publish to payslips" / "...published to
  // payslips" — email.ts's payloadLooksLikePayslip() content-sniffs summary/title (not just
  // eventType) and hard-blocked them as if they were real payslip content. See notify.ts.
  const automatedPayrollNotifySource = readFileSync("src/lib/automated-payroll/notify.ts", "utf8");
  assert.doesNotMatch(
    automatedPayrollNotifySource,
    /message: `[^`]*payslip[^`]*`/i,
    "an automated-payroll milestone email body must never contain \"payslip\" — payloadLooksLikePayslip() in email.ts hard-blocks any email whose summary contains that substring, even ordinary admin prose, regardless of eventType",
  );
  assert.doesNotMatch(
    automatedPayrollNotifySource,
    /title: `[^`]*payslip[^`]*`/i,
    "same guard for the notification title, which payloadLooksLikePayslip() also scans",
  );

  // Regression (2026-08-08): safeSendNotificationEmail used to prefix EVERY outbox skip reason
  // with "Queued for retry:", regardless of whether the skip was terminal (payslip block,
  // identity guard — never retried) or genuinely transient. system.ts's two callers both branch
  // on that exact prefix to decide "sent" vs "skipped", so a permanently-blocked email was
  // recorded as a successful delivery with no error anywhere in notification_deliveries.
  const safeSendNotificationEmailSource = source.slice(source.indexOf("export async function safeSendNotificationEmail"));
  assert.match(
    safeSendNotificationEmailSource,
    /classifyOutboxSkip\(result\.reason, input\.notificationType\)/,
    "safeSendNotificationEmail must classify an outbox skip as terminal/transient (classifyOutboxSkip) before deciding whether to report it as \"Queued for retry\" — a blanket prefix makes a terminal skip look like a successful, retryable handoff",
  );
}
