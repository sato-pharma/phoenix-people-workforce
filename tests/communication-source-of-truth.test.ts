import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildCommunicationMetrics,
  invalidCommunicationEmails,
  mapInAppNotificationRows,
  splitCommunicationEmailList,
  summarizeEmailTemplateReadiness,
  summarizeNotificationMonitoring,
  summarizeNotificationOutboxRows,
} from "../src/lib/communication/metrics.ts";

export function runCommunicationSourceOfTruthTests() {
  assert.deepEqual(splitCommunicationEmailList("a@x.com; b@y.com\nbad"), ["a@x.com", "b@y.com", "bad"]);
  assert.deepEqual(invalidCommunicationEmails(["a@x.com", "bad"]), ["bad"]);

  const templateReadiness = summarizeEmailTemplateReadiness([
    {
      bodyHtml: "<p>Hello</p>",
      isActive: true,
      rules: { toRoles: ["employee"] },
      subject: "Ready",
      templateKey: "ready",
    },
    {
      bodyText: "",
      isActive: true,
      rules: { toRoles: [] },
      subject: "",
      templateKey: "not_ready",
    },
  ]);
  assert.equal(templateReadiness.totalTemplates, 2);
  assert.equal(templateReadiness.readyTemplates, 1);
  assert.equal(templateReadiness.missingSubject, 1);
  assert.equal(templateReadiness.missingBody, 1);
  assert.equal(templateReadiness.missingRecipients, 1);
  assert.equal(templateReadiness.readinessRate, 0.5);

  assert.deepEqual(
    summarizeNotificationOutboxRows([
      { createdAt: "2026-05-18T10:00:00Z", payload: { notificationType: "birthday" }, status: "sent" },
      { createdAt: "2026-05-18T09:00:00Z", payload: { notificationType: "general" }, status: "failed" },
      { createdAt: "2026-05-18T08:00:00Z", payload: { notificationType: "other" }, status: "pending" },
    ], ["birthday", "general"]),
    {
      failed: 1,
      lastSentAt: "2026-05-18T10:00:00Z",
      pending: 1,
      recentAllowed: 2,
      recentTotal: 3,
      sent: 1,
    },
  );

  // notification_delivery_logs retired by migration 20260616120000.
  // failed24h / sent24h are now derived from deliveryEvents (email_delivery_events)
  // which is the canonical Resend webhook log.
  const monitoring = summarizeNotificationMonitoring({
    deliveryEvents: [
      { id: "1", occurredAt: "2026-05-18T10:00:00Z", status: "delivered", subject: "A", recipients: ["a@x.com"] },
      { id: "2", occurredAt: "2026-05-18T11:00:00Z", status: "bounced", subject: "B", recipients: ["b@y.com"] },
      { id: "3", occurredAt: "2026-05-18T12:00:00Z", status: "sent", subject: "C", recipients: ["c@x.com"] },
      { id: "4", occurredAt: "2026-05-18T13:00:00Z", status: "failed", subject: "D", recipients: ["d@x.com"] },
    ],
    notificationEvents: [
      { createdAt: "2026-05-18T10:00:00Z", status: "pending" },
      { createdAt: "2026-05-18T11:00:00Z", status: "sent" },
    ],
    sinceIso: "2026-05-18T00:00:00Z",
  });
  assert.equal(monitoring.actualDelivery24h.delivered, 1);
  assert.equal(monitoring.actualDelivery24h.bounced, 1);
  assert.equal(monitoring.actualDelivery24h.sent, 1);
  assert.equal(monitoring.actualDelivery24h.failed, 1);
  assert.equal(monitoring.sent24h, 1);
  assert.equal(monitoring.failed24h, 1);
  assert.equal(monitoring.pending24h, 1);
  assert.equal(monitoring.totalQueuedEvents, 2);

  const communication = buildCommunicationMetrics({
    outboxRows: [{ status: "pending" }, { status: "sent" }, { status: "failed" }],
    templateRows: [{ bodyText: "Body", isActive: true, rules: { toRoles: ["hr"] }, subject: "Subject" }],
  });
  assert.equal(communication.pendingNotifications, 1);
  assert.equal(communication.sentNotifications, 1);
  assert.equal(communication.failedNotifications, 1);
  assert.equal(communication.templateReadinessRate, 1);

  assert.deepEqual(
    mapInAppNotificationRows([
      {
        category: "probation",
        id: "p1",
        metadata: { href: "/probation", message: "Review", title: "Probation" },
        recipients: ["E001"],
        scheduledFor: "2026-05-18",
        sentAt: "2026-05-18T10:00:00Z",
        status: "sent",
        subject: "Probation",
      },
      {
        category: "probation",
        id: "p2",
        metadata: { message: "Other" },
        recipients: ["E002"],
        status: "sent",
        subject: "Other",
      },
    ], "E001").map((row) => row.id),
    ["p1"],
  );

  const notificationEmailSource = readFileSync("src/lib/notifications/email.ts", "utf8");
  assert.match(notificationEmailSource, /summarizeNotificationOutboxRows/);

  // operations/events.ts stopped summarising notifications on 23 Oct 2026, when the Monitoring page
  // it fed was retired. summarizeNotificationMonitoring stays the one summary — the nightly
  // notifications integrity check compares against it — and nothing re-derives it by hand.
  const operationsSource = readFileSync("src/lib/operations/events.ts", "utf8");
  assert.doesNotMatch(operationsSource, /notificationLogRows\.filter/);
  assert.doesNotMatch(operationsSource, /from\("notification_events"\)/);

  const templateServiceSource = readFileSync("src/lib/email-templates/service.ts", "utf8");
  assert.match(templateServiceSource, /summarizeEmailTemplateReadiness/);
  assert.match(templateServiceSource, /getEmailTemplateReadinessMetrics/);
  assert.match(templateServiceSource, /templateSupportsAction/);
  assert.match(templateServiceSource, /EMAIL_TEMPLATE_KEYS\.BIRTHDAY/);

  const templatePageSource = readFileSync("app/(admin)/admin/email-templates/page.tsx", "utf8");
  assert.match(templatePageSource, /getEmailTemplateReadinessMetrics/);

  const inAppSource = readFileSync("src/lib/notifications/in-app.ts", "utf8");
  assert.match(inAppSource, /mapInAppNotificationRows/);

  const platformSource = readFileSync("src/lib/platform/metrics.ts", "utf8");
  assert.match(platformSource, /buildCommunicationMetrics/);
  assert.match(platformSource, /communication/);

  const composerRouteSource = readFileSync("app/api/admin/email-reply/send/route.ts", "utf8");
  assert.match(composerRouteSource, /resolveComposerRecipients/);
  assert.match(composerRouteSource, /invalidCommunicationEmails/);

  const contractReminderRoute = readFileSync("app/api/notifications/contract-renewals/route.ts", "utf8");
  // This asserted `lifecycleRiskWindows` until 2026-09-29, when the owner set the reminder ladder
  // to 75/60/30/15 days and it moved to its own constant. Those windows colour the Contract Renewal
  // board and drive its "due in 7 / 30 days" tiles, so the cron must NOT read them any more:
  // sharing them made the board's bands load-bearing for when mail goes out. The schedule itself is
  // pinned by tests/contract-renewal-reminder-ladder.test.ts.
  assert.match(contractReminderRoute, /contractRenewalReminderDaysAhead/);
  assert.doesNotMatch(contractReminderRoute, /lifecycleRiskWindows/);

  const probationServiceSource = readFileSync("src/lib/probation/service.ts", "utf8");
  assert.match(probationServiceSource, /lifecycleRiskWindows\.probationRiskDays/);

  const birthdayRouteSource = readFileSync("app/api/notifications/birthdays/route.ts", "utf8");
  assert.match(birthdayRouteSource, /buildHrCalendarEvents/);
  assert.doesNotMatch(birthdayRouteSource, /ctaHref/);
  assert.doesNotMatch(birthdayRouteSource, /ctaLabel/);
}
