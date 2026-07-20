// Notification senders for the weekly-digest settlement flow.
//
// Two distinct trust levels:
//  - The employee's OWN digest/settlement notices carry full detail (EGP
//    amounts, per-day breakdown) on every channel — recipientHrId always
//    equals subjectHrId here, so no extra gating is needed.
//  - Notices ABOUT one employee sent to someone else (a Tier-2 flag to their
//    manager, a dispute to HR/Admin, cc manager/CEO) are marked
//    metadata.sensitivity: "payroll" + metadata.authorizedRecipient: true.
//    This deliberately reuses the existing payroll-sensitive Telegram masking
//    (src/lib/notifications/system.ts) — those channels get a generic ping,
//    full detail is only in email/in-app — rather than bypassing it.

import { createSystemNotification } from "@/lib/notifications/system";

async function sendToMany(
  recipients: string[],
  build: (recipientHrId: string) => Parameters<typeof createSystemNotification>[0],
) {
  await Promise.all(recipients.map((hrId) => createSystemNotification(build(hrId))));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDisplayDate(dateIso: string): string {
  return new Date(`${dateIso}T00:00:00`).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

export type DigestTableLine = {
  workDate: string;
  deductionDays: number;
  deductionValue: number;
  reason: string;
};

/**
 * The digest table: three columns (Day+date, Deduction Value, Quantity), with
 * the reason for that day shown as a note under its row. Only deduction lines
 * (deductionDays > 0) are shown — missing-punch lines carry zero EGP impact
 * and are handled entirely by the separate verification chain.
 */
export function buildDigestTableHtml(lines: DigestTableLine[], currency: string): string {
  const deductible = lines.filter((line) => line.deductionDays > 0);
  if (deductible.length === 0) return "";
  const rows = deductible
    .map(
      (line) => `
      <tr>
        <td style="padding:8px 10px;border:1px solid #e2e8f0;">${escapeHtml(formatDisplayDate(line.workDate))}</td>
        <td style="padding:8px 10px;border:1px solid #e2e8f0;text-align:right;">${escapeHtml(line.deductionValue.toFixed(2))} ${escapeHtml(currency)}</td>
        <td style="padding:8px 10px;border:1px solid #e2e8f0;text-align:right;">${escapeHtml(String(line.deductionDays))}</td>
      </tr>
      <tr>
        <td colspan="3" style="padding:2px 10px 10px;border:1px solid #e2e8f0;border-top:none;color:#64748b;font-size:12px;">${escapeHtml(line.reason)}</td>
      </tr>`,
    )
    .join("");
  return `<table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
      <thead>
        <tr style="background:#0f172a;color:#ffffff;">
          <th style="padding:8px 10px;text-align:left;">Day</th>
          <th style="padding:8px 10px;text-align:right;">Deduction Value</th>
          <th style="padding:8px 10px;text-align:right;">Quantity</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

export function buildDigestTableText(lines: DigestTableLine[], currency: string): string {
  const deductible = lines.filter((line) => line.deductionDays > 0);
  if (deductible.length === 0) return "";
  return deductible
    .map((line) => `- ${formatDisplayDate(line.workDate)}: ${line.deductionValue.toFixed(2)} ${currency}, ${line.deductionDays} day(s) — ${line.reason}`)
    .join("\n");
}

export async function notifyDigestSent(input: {
  employeeHrId: string;
  employeeName: string;
  weekLabel: string;
  totalDeductionValue: number;
  currency: string;
  autoConfirmHours: number;
  actionUrl: string;
  lines: DigestTableLine[];
}): Promise<{ eventId: string | null }> {
  const summary =
    input.totalDeductionValue > 0
      ? `Your attendance digest for ${input.weekLabel} shows ${input.totalDeductionValue.toFixed(2)} ${input.currency} in deductions. Confirm or dispute within ${input.autoConfirmHours}h — no reply auto-confirms to salary.`
      : `Your attendance digest for ${input.weekLabel} is clean — no deductions this week.`;
  const result = await createSystemNotification({
    actionUrl: input.actionUrl,
    actorId: "system",
    channels: ["telegram", "in_app"],
    email: {
      recipientName: input.employeeName,
      templateContext: {
        digestTable: buildDigestTableHtml(input.lines, input.currency),
        digestTableText: buildDigestTableText(input.lines, input.currency),
        status: input.totalDeductionValue > 0 ? `Please confirm or dispute within ${input.autoConfirmHours} hours.` : "",
        summary,
        weekLabel: input.weekLabel,
      },
      templateKey: "attendance_digest",
    },
    eventType: "attendance_digest_sent",
    message: summary,
    metadata: { autoConfirmHours: input.autoConfirmHours, employeeHrId: input.employeeHrId },
    module: "attendance",
    priority: input.totalDeductionValue > 0 ? "high" : "normal",
    recipientHrId: input.employeeHrId,
    subjectHrId: input.employeeHrId,
    title: `Weekly attendance digest — ${input.weekLabel}`,
  });
  return { eventId: result.eventId };
}

/**
 * A deduction-bearing digest never reaches the employee directly — this
 * notifies the System Administrator / HR Manager approver list (same pool as
 * dispute review) that it's waiting for them in the review queue.
 */
export async function notifyDigestPendingReview(input: {
  employeeHrId: string;
  employeeName: string;
  weekLabel: string;
  totalDeductionValue: number;
  currency: string;
  reviewers: string[];
  actionUrl: string;
}) {
  const build = (recipientHrId: string) => ({
    actionUrl: input.actionUrl,
    actorId: "system",
    channels: ["email" as const, "in_app" as const],
    eventType: "attendance_digest_pending_review",
    message: `${input.employeeName}'s attendance digest for ${input.weekLabel} shows ${input.totalDeductionValue.toFixed(2)} ${input.currency} in deductions and is waiting for your review before it sends.`,
    metadata: { authorizedRecipient: true, employeeHrId: input.employeeHrId, sensitivity: "payroll" },
    module: "attendance",
    priority: "high" as const,
    recipientHrId,
    subjectHrId: input.employeeHrId,
    title: `Digest review needed — ${input.employeeName} (${input.weekLabel})`,
  });
  await sendToMany(input.reviewers, build);
}

export async function notifyDigestAutoConfirmed(input: {
  employeeHrId: string;
  weekLabel: string;
  totalDeductionValue: number;
  currency: string;
}) {
  await createSystemNotification({
    actorId: "system",
    channels: ["email", "in_app"],
    eventType: "attendance_digest_auto_confirmed",
    message: `No response to your ${input.weekLabel} attendance digest within the review window — ${input.totalDeductionValue.toFixed(2)} ${input.currency} has been auto-confirmed for salary deduction.`,
    metadata: { employeeHrId: input.employeeHrId },
    module: "attendance",
    priority: "high",
    recipientHrId: input.employeeHrId,
    subjectHrId: input.employeeHrId,
    title: `Attendance digest auto-confirmed — ${input.weekLabel}`,
  });
}

export async function notifyDisputeSubmitted(input: {
  employeeHrId: string;
  employeeName: string;
  workDate: string;
  reason: string;
  reviewers: string[];
  cc: string[];
  actionUrl: string;
}) {
  const build = (recipientHrId: string) => ({
    actionUrl: input.actionUrl,
    actorId: input.employeeHrId,
    channels: ["email" as const, "telegram" as const, "in_app" as const],
    eventType: "attendance_dispute_submitted",
    message: `${input.employeeName} disputed an attendance deduction for ${input.workDate}: "${input.reason}"`,
    metadata: { authorizedRecipient: true, sensitivity: "payroll", subjectHrId: input.employeeHrId, workDate: input.workDate },
    module: "attendance",
    priority: "high" as const,
    recipientHrId,
    subjectHrId: input.employeeHrId,
    title: `Attendance dispute — ${input.employeeName} (${input.workDate})`,
  });
  await sendToMany([...input.reviewers, ...input.cc], build);
}

export async function notifyDisputeResolved(input: {
  employeeHrId: string;
  workDate: string;
  upheld: boolean;
  reviewerHrId: string;
  notes: string | null;
}) {
  await createSystemNotification({
    actorId: input.reviewerHrId,
    channels: ["email", "in_app"],
    eventType: "attendance_dispute_resolved",
    message: input.upheld
      ? `Your dispute for ${input.workDate} was upheld — no deduction will be applied.`
      : `Your dispute for ${input.workDate} was reviewed and rejected — the deduction will be applied to salary.${input.notes ? ` Reviewer note: ${input.notes}` : ""}`,
    metadata: { employeeHrId: input.employeeHrId, workDate: input.workDate },
    module: "attendance",
    priority: "high",
    recipientHrId: input.employeeHrId,
    subjectHrId: input.employeeHrId,
    title: `Dispute ${input.upheld ? "upheld" : "rejected"} — ${input.workDate}`,
  });
}

export async function notifyDigestFlag(input: {
  employeeHrId: string;
  employeeName: string;
  workDate: string;
  flagType: "office_no_show" | "field_punch_anomaly";
  reason: string;
  primary: string[];
  cc: string[];
  actionUrl: string;
}) {
  const label = input.flagType === "office_no_show" ? "planned office day, no punch" : "planned field day, but punched";
  const build = (recipientHrId: string) => ({
    actionUrl: input.actionUrl,
    actorId: "system",
    channels: ["email" as const, "in_app" as const],
    eventType: "attendance_tier2_mismatch",
    message: `${input.employeeName} — ${label} on ${input.workDate}. ${input.reason}`,
    metadata: { authorizedRecipient: true, sensitivity: "payroll", subjectHrId: input.employeeHrId, workDate: input.workDate },
    module: "attendance",
    priority: "normal" as const,
    recipientHrId,
    subjectHrId: input.employeeHrId,
    title: `Plan/punch mismatch — ${input.employeeName} (${input.workDate})`,
  });
  await sendToMany([...input.primary, ...input.cc], build);
}

export async function notifyMissingPunchSubmitted(input: {
  employeeHrId: string;
  recipientHrId: string;
  reason: string;
  workDate: string;
}) {
  await createSystemNotification({
    actionUrl: "/attendance/missing-punch",
    actorId: input.employeeHrId,
    channels: ["email", "in_app"],
    eventType: "attendance_missing_punch_submitted",
    message: `${input.employeeHrId} submitted a reason for a missing punch on ${input.workDate}: "${input.reason}". Please verify.`,
    metadata: { authorizedRecipient: true, sensitivity: "payroll", subjectHrId: input.employeeHrId, workDate: input.workDate },
    module: "attendance",
    priority: "normal",
    recipientHrId: input.recipientHrId,
    subjectHrId: input.employeeHrId,
    title: `Missing-punch verification needed — ${input.employeeHrId} (${input.workDate})`,
  });
}

export async function notifyMissingPunchStepReady(input: {
  employeeHrId: string;
  recipients: string[];
  step: "hr" | "ceo";
  workDate: string;
}) {
  const stepLabel = input.step === "hr" ? "HR" : "CEO";
  const build = (recipientHrId: string) => ({
    actionUrl: "/attendance/missing-punch",
    actorId: "system",
    channels: ["email" as const, "in_app" as const],
    eventType: "attendance_missing_punch_step_ready",
    message: `A missing-punch verification for ${input.employeeHrId} (${input.workDate}) is ready for ${stepLabel} confirmation.`,
    metadata: { authorizedRecipient: true, sensitivity: "payroll", subjectHrId: input.employeeHrId, workDate: input.workDate },
    module: "attendance",
    priority: "normal" as const,
    recipientHrId,
    subjectHrId: input.employeeHrId,
    title: `Missing-punch verification — ${stepLabel} step (${input.employeeHrId}, ${input.workDate})`,
  });
  await sendToMany(input.recipients, build);
}

export async function notifyMissingPunchDecided(input: {
  employeeHrId: string;
  rejected: boolean;
  reason: string | null;
  step: "verifier" | "hr" | "ceo";
  workDate: string;
}) {
  await createSystemNotification({
    actorId: "system",
    channels: ["email", "in_app"],
    eventType: "attendance_missing_punch_decided",
    message: input.rejected
      ? `Your missing-punch explanation for ${input.workDate} was rejected at the ${input.step} step.${input.reason ? ` Reason: ${input.reason}` : ""}`
      : `Your missing-punch explanation for ${input.workDate} has been fully verified.`,
    metadata: { employeeHrId: input.employeeHrId, workDate: input.workDate },
    module: "attendance",
    priority: "normal",
    recipientHrId: input.employeeHrId,
    subjectHrId: input.employeeHrId,
    title: `Missing-punch ${input.rejected ? "rejected" : "verified"} — ${input.workDate}`,
  });
}
