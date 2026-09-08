// Weekly attendance digest — the four notices this module sends.
//
// CHANNELS. Owner decision 2026-09-08: in-app, Telegram AND email. That reverses the
// 2026-07 sequence, where email was switched off first (#1225), then every channel
// (#1226), then the employee step itself. It is safe to reverse now only because the
// engine behind the numbers was fixed and re-measured at a 0.00% false-positive rate
// across five closed months; the channels are per-setting so any of them can be shut
// off again without a deploy.
//
// The attendance email guard does NOT block these: it is keyed on the
// `attendance_agent_ingestion_stalled` event specifically, and says so — ordinary
// attendance notifications to employees keep their email.
//
// NEVER CALL THESE FROM A LAPTOP. A local run reaches PRODUCTION data but silently
// skips every email, and firing one by hand burns the idempotency key so the real
// send is then suppressed as a duplicate. These are for the cron path only.

import { createSystemNotification } from "@/lib/notifications/system";
import type { SystemNotificationChannel } from "@/lib/notifications/system";
import type { DigestRow, DigestSettings } from "@/lib/attendance/digest-service.ts";

const MODULE = "attendance";
const PORTAL_PATH = "/employee-portals/attendance/digests";

export function resolveDigestChannels(settings: DigestSettings): SystemNotificationChannel[] {
  const channels: SystemNotificationChannel[] = [];
  if (settings.channelInApp) channels.push("in_app");
  if (settings.channelTelegram) channels.push("telegram");
  if (settings.channelEmail) channels.push("email");
  return channels;
}

function weekLabel(digest: DigestRow): string {
  return `${digest.weekStart} to ${digest.weekEnd}`;
}

/**
 * How a digest describes what it is asking about.
 *
 * Owner decision 2026-09-08: show the estimated amount. `showEstimatedAmount` keeps
 * that switchable, because the figure is an ESTIMATE — the day still has to survive
 * the month-end connector, and a day quoted at 419.35 EGP can end up worth nothing
 * once later evidence lands. When the amount is hidden the day and reason still are
 * not, so the employee always knows which day is in question.
 */
export function describeDigest(digest: DigestRow, settings: DigestSettings): string {
  const dayCount = digest.lines.length;
  const days = `${dayCount} ${dayCount === 1 ? "day" : "days"}`;
  if (!settings.showEstimatedAmount) {
    return `Your attendance for ${weekLabel(digest)} shows ${days} needing your confirmation.`;
  }
  return (
    `Your attendance for ${weekLabel(digest)} shows ${days} needing your confirmation, ` +
    `estimated at ${digest.totalDeductionValue.toFixed(2)} ${digest.currency}.`
  );
}

export async function notifyDigestSent(input: {
  digest: DigestRow;
  settings: DigestSettings;
}): Promise<void> {
  const { digest, settings } = input;
  const hours = settings.autoConfirmHours;
  await createSystemNotification({
    actionUrl: PORTAL_PATH,
    category: "attendance",
    channels: resolveDigestChannels(settings),
    eventType: "attendance_weekly_digest_sent",
    message:
      `${describeDigest(digest, settings)} ` +
      `Confirm or dispute each day within ${hours} hours — no reply is treated as agreement.` +
      (digest.dryRun ? " (Trial run: nothing is deducted this cycle.)" : ""),
    metadata: {
      cycleKey: digest.cycleKey,
      weekIndex: digest.weekIndex,
      days: digest.lines.length,
      dryRun: digest.dryRun,
    },
    module: MODULE,
    priority: "high",
    recipientHrId: digest.employeeHrId,
    recordId: String(digest.id),
    subjectHrId: digest.employeeHrId,
    telegram: { ctaLabel: "Review my attendance", ctaUrl: PORTAL_PATH },
    title: `Attendance to confirm — ${weekLabel(digest)}`,
  });
}

/**
 * Sent when the window elapsed and the deduction was applied without the employee
 * answering. This notice is the whole reason auto-confirm is defensible: the person
 * is told after the fact, in the same three channels, rather than discovering it on
 * a payslip.
 */
export async function notifyDigestAutoConfirmed(input: {
  digest: DigestRow;
  settings: DigestSettings;
  linesAutoConfirmed: number;
}): Promise<void> {
  const { digest, settings } = input;
  const amount = settings.showEstimatedAmount
    ? ` (${digest.totalDeductionValue.toFixed(2)} ${digest.currency})`
    : "";
  await createSystemNotification({
    actionUrl: PORTAL_PATH,
    category: "attendance",
    channels: resolveDigestChannels(settings),
    eventType: "attendance_weekly_digest_auto_confirmed",
    message:
      `No reply was received for ${weekLabel(digest)}, so ${input.linesAutoConfirmed} ` +
      `${input.linesAutoConfirmed === 1 ? "day was" : "days were"} confirmed automatically${amount}.` +
      (digest.dryRun ? " This was a trial run — nothing has been deducted." : " Speak to HR if this is wrong."),
    metadata: { cycleKey: digest.cycleKey, weekIndex: digest.weekIndex, dryRun: digest.dryRun },
    module: MODULE,
    priority: "high",
    recipientHrId: digest.employeeHrId,
    recordId: String(digest.id),
    subjectHrId: digest.employeeHrId,
    title: `Attendance confirmed automatically — ${weekLabel(digest)}`,
  });
}

/** To the reviewers. A dispute is the one event where a human MUST look. */
export async function notifyDisputeSubmitted(input: {
  digest: DigestRow;
  workDate: string;
  reason: string;
  reviewerHrIds: readonly string[];
  settings: DigestSettings;
}): Promise<void> {
  for (const reviewerHrId of input.reviewerHrIds) {
    await createSystemNotification({
      actionUrl: "/attendance/disputes",
      category: "attendance",
      channels: resolveDigestChannels(input.settings),
      eventType: "attendance_digest_dispute_submitted",
      message:
        `${input.digest.employeeHrId} disputed the attendance charge for ${input.workDate}: ` +
        `"${input.reason}". It will not settle until someone decides.`,
      metadata: { digestId: input.digest.id, workDate: input.workDate },
      module: MODULE,
      priority: "high",
      recipientHrId: reviewerHrId,
      recordId: String(input.digest.id),
      subjectHrId: input.digest.employeeHrId,
      title: `Attendance dispute — ${input.workDate}`,
    });
  }
}

/** Back to the employee once a reviewer has ruled. */
export async function notifyDisputeResolved(input: {
  digest: DigestRow;
  workDate: string;
  upheld: boolean;
  notes?: string | null;
  settings: DigestSettings;
}): Promise<void> {
  await createSystemNotification({
    actionUrl: PORTAL_PATH,
    category: "attendance",
    channels: resolveDigestChannels(input.settings),
    eventType: "attendance_digest_dispute_resolved",
    message: input.upheld
      ? `Your dispute for ${input.workDate} was accepted — that day carries no deduction.` +
        (input.notes ? ` Note: ${input.notes}` : "")
      : `Your dispute for ${input.workDate} was reviewed and not accepted, so the day stands.` +
        (input.notes ? ` Note: ${input.notes}` : ""),
    metadata: { digestId: input.digest.id, workDate: input.workDate, upheld: input.upheld },
    module: MODULE,
    priority: "normal",
    recipientHrId: input.digest.employeeHrId,
    recordId: String(input.digest.id),
    subjectHrId: input.digest.employeeHrId,
    title: `Attendance dispute ${input.upheld ? "accepted" : "not accepted"} — ${input.workDate}`,
  });
}
