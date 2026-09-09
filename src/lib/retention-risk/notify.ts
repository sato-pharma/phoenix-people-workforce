/**
 * Retention risk — the announcement: who is told, and the delivery itself.
 *
 * Every word it sends lives in ./messages.ts, which imports nothing and is therefore directly
 * testable. This file is the I/O shell around it.
 */

import { createSystemNotification, logNotificationSendFailure } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { resolveHrIdsForRole, resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";
import {
  RETENTION_RISK_EXCLUDED_ROLE,
  planRetentionRiskRecipients,
} from "@/lib/retention-risk/recipients";
import { getRetentionRiskView, cairoDateIso } from "@/lib/retention-risk/service";
import { retentionRiskSignalKey } from "@/lib/retention-risk/detector";
import {
  RETENTION_RISK_AUDIENCE,
  RETENTION_RISK_CHANNELS,
  RETENTION_RISK_EVENT_TYPE,
  RETENTION_RISK_MODULE,
  RETENTION_RISK_PRE_PAYROLL_EVENT_TYPE,
  retentionRiskMessage,
  retentionRiskPrePayrollMessage,
  retentionRiskTitle,
  roleHrefsForSubject,
  subjectHref,
} from "@/lib/retention-risk/messages";

export type RetentionRiskNotifyResult = {
  /** Signals that produced at least one delivery attempt. */
  announced: number;
  notified: number;
  signals: number;
  skipped: number;
  warnings: string[];
};

/**
 * Announce every signal once.
 *
 * The idempotency key carries the run's START date and never its end (see
 * `retentionRiskSignalKey`). An ongoing run grows a day at a time, so keying on the end — or on
 * today — would re-announce the same person every morning for as long as they stayed away, which
 * is precisely the shape of alert people learn to delete unread.
 */
export async function runRetentionRiskSweep(): Promise<RetentionRiskNotifyResult> {
  const view = await getRetentionRiskView({ fresh: true });
  const warnings: string[] = [];
  if (view.crmUnavailable) {
    warnings.push("The CRM visits mirror could not be read, so no silence signal was evaluated on this run.");
  }
  if (view.signals.length === 0) {
    return { announced: 0, notified: 0, signals: 0, skipped: 0, warnings };
  }

  const audience = await resolveNotificationPersonRecipients(
    RETENTION_RISK_AUDIENCE,
    "Retention risk — recipients",
  );
  warnings.push(...audience.warnings);

  // An audience that resolves to nobody looks exactly like an audience with nothing to say, and
  // that is how a job runs green and unread for weeks. Say it loudly rather than returning clean.
  if (audience.recipients.length === 0) {
    logError("Retention-risk signals were raised but the audience resolved to nobody", {
      labels: { event: "retention_risk_no_recipient", job: "retention-risk-sweep" },
      error: new Error(
        `${view.signals.length} retention-risk signals had no recipient. Warnings: ${warnings.join("; ") || "none"}`,
      ),
    });
  }

  // THE CEO NEVER RECEIVES THIS ALERT — owner, 2026-09-09. Resolved ONCE per sweep rather than per
  // signal: it is one query whose answer cannot change mid-run, and the sweep already reads enough.
  // See ./recipients.ts for why it is the role and not an HR id, and why it filters the whole
  // audience rather than only the manager path.
  const excludedRole = await resolveHrIdsForRole(
    RETENTION_RISK_EXCLUDED_ROLE,
    `Retention risk — ${RETENTION_RISK_EXCLUDED_ROLE} exclusion`,
  );
  warnings.push(...excludedRole.warnings);

  let announced = 0;
  let notified = 0;
  let skipped = 0;
  const excludedSeen = new Set<string>();

  for (const signal of view.signals) {
    const key = retentionRiskSignalKey(signal);
    // The person's own line manager, on top of the standing audience — owner's choice 2026-09-06.
    // Deduped against it so someone who is both (an NSM who is also on the audience) is told once.
    const plan = planRetentionRiskRecipients({
      audience: audience.recipients,
      managerHrId: signal.managerHrId,
      excludedHrIds: excludedRole.hrIds,
    });
    const recipients = plan.recipients;
    for (const one of plan.excluded) excludedSeen.add(one);

    let anyAttempt = false;
    for (const recipient of recipients) {
      anyAttempt = true;
      try {
        await createSystemNotification({
          actionUrl: subjectHref(signal.hrId),
          channels: [...RETENTION_RISK_CHANNELS],
          eventType: RETENTION_RISK_EVENT_TYPE,
          message: retentionRiskMessage(signal),
          metadata: {
            // The recipients are resolved from the admin-editable role policy and from the
            // subject's own management chain, never from a request — this is the sanctioned
            // trusted-server-caller bypass, the same one automated-payroll/notify.ts uses.
            authorizedRecipient: true,
            endDate: signal.endDate,
            idempotencyKey: `${key}:${recipient.hrId}`,
            roleHrefs: roleHrefsForSubject(signal.hrId),
            startDate: signal.startDate,
            subjectDisplayName: signal.displayName,
            trigger: signal.trigger,
            workingDays: signal.workingDays,
          },
          module: RETENTION_RISK_MODULE,
          priority: "high",
          recipientHrId: recipient.hrId,
          recipientUserId: recipient.userId,
          subjectHrId: signal.hrId,
          title: retentionRiskTitle(signal),
        });
        notified += 1;
      } catch (error) {
        skipped += 1;
        logNotificationSendFailure("retentionRisk.runRetentionRiskSweep", error);
      }
    }
    if (anyAttempt) announced += 1;
  }

  // Say it when the exclusion actually removed somebody. On every normal run this is empty, because
  // the CEO holds none of the four roles and no rep reports to him — so a line here means either an
  // admin added the role to the policy or the CEO became a rep's direct manager, and both are
  // things whoever reads this run should be told rather than left to discover.
  if (excludedSeen.size > 0) {
    warnings.push(
      `${RETENTION_RISK_EXCLUDED_ROLE} is never a recipient of this alert (owner, 2026-09-09) — removed ${Array.from(excludedSeen).join(", ")}.`,
    );
  }

  return { announced, notified, signals: view.signals.length, skipped, warnings };
}

export type RetentionRiskPrePayrollResult = {
  notified: number;
  signals: number;
  skipped: number;
  warnings: string[];
};

/**
 * Send the pre-payroll notice.
 *
 * `reason` is part of the idempotency key together with the Cairo date, so the scheduled notice
 * and the one fired when Part 1 is confirmed are two different messages and neither suppresses the
 * other — the owner asked for both, on 2026-09-06.
 */
export async function runRetentionRiskPrePayrollNotice(
  reason: "part1_confirmed" | "scheduled",
  periodLabel: string,
): Promise<RetentionRiskPrePayrollResult> {
  const view = await getRetentionRiskView({ fresh: true });
  const warnings: string[] = [];
  if (view.crmUnavailable) {
    warnings.push("The CRM visits mirror could not be read, so the CRM half of this notice is incomplete.");
  }

  const audience = await resolveNotificationPersonRecipients(
    RETENTION_RISK_AUDIENCE,
    "Retention risk — pre-payroll recipients",
  );
  warnings.push(...audience.warnings);

  if (audience.recipients.length === 0) {
    logError("The pre-payroll retention-risk notice had no recipient", {
      labels: { event: "retention_risk_pre_payroll_no_recipient", job: "retention-risk-pre-payroll" },
      error: new Error(`Warnings: ${warnings.join("; ") || "none"}`),
    });
    return { notified: 0, signals: view.signals.length, skipped: 0, warnings };
  }

  const message = retentionRiskPrePayrollMessage(view.signals, reason);
  const title =
    view.signals.length === 0
      ? `Before payroll ${periodLabel}: nobody is flagged for retention risk`
      : `Before payroll ${periodLabel}: ${view.signals.length} employee${view.signals.length === 1 ? "" : "s"} flagged for retention risk`;

  let notified = 0;
  let skipped = 0;
  for (const recipient of audience.recipients) {
    try {
      await createSystemNotification({
        actionUrl: "/admin",
        channels: [...RETENTION_RISK_CHANNELS],
        eventType: RETENTION_RISK_PRE_PAYROLL_EVENT_TYPE,
        message,
        metadata: {
          authorizedRecipient: true,
          flaggedCount: view.signals.length,
          idempotencyKey: `retention-risk-pre-payroll:${reason}:${periodLabel}:${cairoDateIso()}:${recipient.hrId}`,
          period: periodLabel,
          reason,
        },
        module: RETENTION_RISK_MODULE,
        priority: "high",
        recipientHrId: recipient.hrId,
        recipientUserId: recipient.userId,
        subjectHrId: recipient.hrId,
        title,
      });
      notified += 1;
    } catch (error) {
      skipped += 1;
      logNotificationSendFailure("retentionRisk.runRetentionRiskPrePayrollNotice", error);
    }
  }

  return { notified, signals: view.signals.length, skipped, warnings };
}
