/**
 * New-hire CRM account setup — telling the SFE Manager.
 *
 * The I/O shell around ./account-setup-messages.ts, which holds every word this sends. Owner
 * instruction 2026-09-07: when an employee is added to the employee master, the SFE Manager is
 * told — email AND in-app — with the new person's line, hiring date, region, area, manager, work
 * email and mobile, and following the notice puts him on the screen that asks for the CRM username
 * and the CRM code.
 *
 * The audience is the admin-editable `crm_account_setup_alert` role policy, not a hardcoded role,
 * so it can be retargeted from /admin/notification-recipients without a deploy.
 *
 * NOTHING HERE THROWS INTO ITS CALLER. It runs after an employee has already been written, on the
 * employee-save and import-confirm paths. A notification that could fail a save would mean an
 * unreachable SFE Manager blocks HR from hiring anybody, which is much worse than a missed notice —
 * so every failure is collected into `warnings` and logged.
 */

import { canonicalHrIdKey } from "@/lib/hr-id";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { logError } from "@/lib/observability/log";
import { resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";
import { createSystemNotificationForRecipients, logNotificationSendFailure } from "@/lib/notifications/system";
import { subjectFromEmployee } from "@/lib/crm/account-setup";
import {
  CRM_ACCOUNT_SETUP_AUDIENCE,
  CRM_ACCOUNT_SETUP_CHANNELS,
  CRM_ACCOUNT_SETUP_CTA_LABEL,
  CRM_ACCOUNT_SETUP_EVENT_TYPE,
  CRM_ACCOUNT_SETUP_MODULE,
  crmAccountSetupDetails,
  crmAccountSetupEmailSummary,
  crmAccountSetupHref,
  crmAccountSetupMessage,
  crmAccountSetupTitle,
  subjectLabel,
  type CrmAccountSetupSubject,
} from "@/lib/crm/account-setup-messages";

export type CrmAccountSetupNotifyResult = {
  /** How many employees produced at least one delivery attempt. */
  announced: number;
  notified: number;
  recipients: number;
  skipped: number;
  warnings: string[];
};

/**
 * Announce each newly created employee once per recipient.
 *
 * The idempotency key is the employee and the recipient, with no date in it, so a later edit to
 * the same person's record can never re-announce them. A new hire is announced exactly once.
 */
export async function notifyNewEmployeesNeedCrmAccount(input: {
  actorId?: string | null;
  hrIds: Array<string | null | undefined>;
}): Promise<CrmAccountSetupNotifyResult> {
  const warnings: string[] = [];
  const wanted = new Set(
    input.hrIds.map((hrId) => canonicalHrIdKey(hrId)).filter((key): key is string => Boolean(key)),
  );
  if (wanted.size === 0) {
    return { announced: 0, notified: 0, recipients: 0, skipped: 0, warnings };
  }

  let subjects: CrmAccountSetupSubject[] = [];
  try {
    const rows = await getEmployeeDirectoryRows({ includeInactive: true });
    subjects = rows
      .filter((row) => wanted.has(canonicalHrIdKey(row.hrId) ?? ""))
      .map((row) => subjectFromEmployee(row));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warnings.push(`The new hires could not be read back for the CRM notice: ${detail}`.slice(0, 200));
    logError("CRM account setup notice could not read the new employees", {
      labels: { event: "crm_account_setup_subject_read_failed" },
      error: error instanceof Error ? error : new Error(detail),
    });
    return { announced: 0, notified: 0, recipients: 0, skipped: 0, warnings };
  }

  const missing = wanted.size - subjects.length;
  if (missing > 0) {
    // The employee was written moments ago, so this is a directory-cache miss rather than a real
    // absence. Say so instead of silently announcing fewer people than were hired.
    warnings.push(`${missing} newly created employee record(s) could not be read back, so no CRM notice was sent for them.`);
  }
  if (subjects.length === 0) {
    return { announced: 0, notified: 0, recipients: 0, skipped: 0, warnings };
  }

  const audience = await resolveNotificationPersonRecipients(
    CRM_ACCOUNT_SETUP_AUDIENCE,
    "New hire CRM account setup — recipients",
  );
  warnings.push(...audience.warnings);

  // An audience that resolves to nobody looks exactly like an audience with nothing to say, and
  // that is how a notice runs green and unread for weeks. Say it loudly rather than returning clean.
  if (audience.recipients.length === 0) {
    warnings.push(
      `${subjects.length} employee(s) were added but the CRM account setup audience resolved to nobody, so no notice was sent.`,
    );
    logError("New employees were added but the CRM account setup audience resolved to nobody", {
      labels: { event: "crm_account_setup_no_recipient" },
      error: new Error(
        `${subjects.length} new employees had no CRM-setup recipient. Warnings: ${warnings.join("; ") || "none"}`,
      ),
    });
    return { announced: 0, notified: 0, recipients: 0, skipped: 0, warnings };
  }

  let announced = 0;
  let notified = 0;
  let skipped = 0;

  for (const subject of subjects) {
    const details = crmAccountSetupDetails(subject);
    const href = crmAccountSetupHref(subject.hrId);

    try {
      // createSystemNotificationForRecipients, NOT a loop over createSystemNotification: looping
      // it once per recipient bypasses the email-envelope consolidation and sends one INDEPENDENT
      // email per person (the bug fixed on 2026-07-22). The default audience is one person today,
      // so the two are equivalent right now — and that is exactly why the wrong one would ship
      // unnoticed and only misbehave the day somebody is added from the recipients console.
      // It suffixes the idempotency key per recipient itself, so the key below carries the
      // employee and nothing else.
      await createSystemNotificationForRecipients(
        {
          actionUrl: href,
          actorId: input.actorId ?? null,
          channels: [...CRM_ACCOUNT_SETUP_CHANNELS],
          email: {
            ctaHref: href,
            ctaLabel: CRM_ACCOUNT_SETUP_CTA_LABEL,
            metrics: details.map((detail) => ({ label: detail.label, value: detail.value })),
            notificationType: "general",
            subject: `New employee added — CRM account needed for ${subjectLabel(subject)}`,
            summary: crmAccountSetupEmailSummary(subject),
            title: crmAccountSetupTitle(subject),
            tone: "neutral",
          },
          eventType: CRM_ACCOUNT_SETUP_EVENT_TYPE,
          message: crmAccountSetupMessage(subject),
          metadata: {
            // Resolved from the admin-editable role policy, never from a request — the sanctioned
            // trusted-server-caller path, same as retention-risk/notify.ts.
            authorizedRecipient: true,
            details,
            // No date in the key: this employee is announced once, for good. A later edit to the
            // same record must never look like a second hire.
            idempotencyKey: `crm-account-setup:${canonicalHrIdKey(subject.hrId)}`,
            subjectDisplayName: subject.displayName,
          },
          module: CRM_ACCOUNT_SETUP_MODULE,
          priority: "high",
          subjectHrId: subject.hrId,
          title: crmAccountSetupTitle(subject),
        },
        audience.recipients.map((recipient) => recipient.hrId),
      );
      announced += 1;
      notified += audience.recipients.length;
    } catch (error) {
      skipped += 1;
      logNotificationSendFailure("crmAccountSetup.notifyNewEmployeesNeedCrmAccount", error);
    }
  }

  return { announced, notified, recipients: audience.recipients.length, skipped, warnings };
}
