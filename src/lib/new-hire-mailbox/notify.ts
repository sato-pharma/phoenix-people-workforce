/**
 * New hire mailboxes — opening the task and telling whoever creates mailboxes.
 *
 * The I/O shell around ./messages.ts. ONE entry point for both employee-create paths (the manual
 * add and the confirmed import), as the retired crm/account-setup-notify.ts was, so neither can open a task
 * without announcing it.
 *
 * The audience is the admin-editable `new_hire_mailbox_alert` role policy — Super Admin alone by
 * default, the owner's choice on 2026-09-18 — and the channels are in-app and Telegram. NEVER
 * email: the notice is about a mailbox that does not exist yet.
 *
 * NOTHING HERE THROWS INTO ITS CALLER. It runs after the employee has been written; a queue or a
 * notice that could fail an employee save would block hiring over a missed message.
 */

import { canonicalHrIdKey } from "@/lib/hr-id";
import { getEmployeeDirectoryRows, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { logError } from "@/lib/observability/log";
import { resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";
import { createSystemNotificationForRecipients, logNotificationSendFailure } from "@/lib/notifications/system";
import { openNewHireMailboxTasks, type NewHireMailboxSource } from "@/lib/new-hire-mailbox/service";
import {
  NEW_HIRE_MAILBOX_AUDIENCE,
  NEW_HIRE_MAILBOX_CHANNELS,
  NEW_HIRE_MAILBOX_EVENT_TYPE,
  NEW_HIRE_MAILBOX_MODULE,
  newHireMailboxDetails,
  newHireMailboxHref,
  newHireMailboxMessage,
  newHireMailboxTitle,
} from "@/lib/new-hire-mailbox/messages";

export type NewHireMailboxNotifyResult = {
  announced: number;
  opened: number;
  recipients: number;
  skipped: number;
  warnings: string[];
};

export async function openAndAnnounceNewHireMailboxes(input: {
  actorId?: string | null;
  hrIds: Array<string | null | undefined>;
  source: NewHireMailboxSource;
}): Promise<NewHireMailboxNotifyResult> {
  const warnings: string[] = [];
  const empty = (): NewHireMailboxNotifyResult => ({ announced: 0, opened: 0, recipients: 0, skipped: 0, warnings });
  const wanted = new Set(
    input.hrIds.map((hrId) => canonicalHrIdKey(hrId)).filter((key): key is string => Boolean(key)),
  );
  if (wanted.size === 0) return empty();

  let everyone: EmployeeDirectoryRow[];
  try {
    everyone = await getEmployeeDirectoryRows({ includeInactive: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warnings.push(`The new hires could not be read back for their mailbox task: ${detail}`.slice(0, 200));
    logError("New hire mailbox task could not read the new employees", {
      error: error instanceof Error ? error : new Error(detail),
      labels: { event: "new_hire_mailbox_subject_read_failed" },
    });
    return empty();
  }
  const hires = everyone.filter((row) => wanted.has(canonicalHrIdKey(row.hrId) ?? ""));
  if (hires.length < wanted.size) {
    warnings.push(`${wanted.size - hires.length} new employee record(s) could not be read back, so no mailbox task was opened for them.`);
  }

  const opened = await openNewHireMailboxTasks({ everyone, hires, source: input.source });
  warnings.push(...opened.warnings);
  if (opened.opened.length === 0) return { ...empty(), warnings };

  const audience = await resolveNotificationPersonRecipients(NEW_HIRE_MAILBOX_AUDIENCE, "New hire mailbox — recipients");
  warnings.push(...audience.warnings);
  if (audience.recipients.length === 0) {
    warnings.push(`${opened.opened.length} new hire(s) need a company email, but the new hire mailbox audience resolved to nobody.`);
    logError("New hires need a mailbox but the new hire mailbox audience resolved to nobody", {
      error: new Error(`${opened.opened.length} new hires had no mailbox recipient. Warnings: ${warnings.join("; ") || "none"}`),
      labels: { event: "new_hire_mailbox_no_recipient" },
    });
    return { ...empty(), opened: opened.opened.length, warnings };
  }

  let announced = 0;
  let skipped = 0;
  for (const subject of opened.opened) {
    const href = newHireMailboxHref(subject.hrId);
    try {
      // ForRecipients, never a loop of single sends: it suffixes the idempotency key per recipient.
      await createSystemNotificationForRecipients(
        {
          actionUrl: href,
          actorId: input.actorId ?? null,
          channels: [...NEW_HIRE_MAILBOX_CHANNELS],
          eventType: NEW_HIRE_MAILBOX_EVENT_TYPE,
          message: newHireMailboxMessage(subject),
          metadata: {
            // Resolved from the admin-editable role policy, never from a request.
            authorizedRecipient: true,
            details: newHireMailboxDetails(subject),
            // No date in the key: a hire is announced once, and a later edit is never a second hire.
            idempotencyKey: `new-hire-mailbox:${canonicalHrIdKey(subject.hrId)}`,
            subjectDisplayName: subject.displayName,
          },
          module: NEW_HIRE_MAILBOX_MODULE,
          priority: "high",
          subjectHrId: subject.hrId,
          title: newHireMailboxTitle(subject),
        },
        audience.recipients.map((recipient) => recipient.hrId),
      );
      announced += 1;
    } catch (error) {
      skipped += 1;
      logNotificationSendFailure("newHireMailbox.openAndAnnounceNewHireMailboxes", error);
    }
  }

  return { announced, opened: opened.opened.length, recipients: audience.recipients.length, skipped, warnings };
}
