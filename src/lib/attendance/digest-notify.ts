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

export async function notifyDigestSent(input: {
  employeeHrId: string;
  weekLabel: string;
  totalDeductionValue: number;
  currency: string;
  autoConfirmHours: number;
  actionUrl: string;
}): Promise<{ eventId: string | null }> {
  const result = await createSystemNotification({
    actionUrl: input.actionUrl,
    actorId: "system",
    channels: ["email", "telegram", "in_app"],
    eventType: "attendance_digest_sent",
    message:
      input.totalDeductionValue > 0
        ? `Your attendance digest for ${input.weekLabel} shows ${input.totalDeductionValue.toFixed(2)} ${input.currency} in deductions. Confirm or dispute within ${input.autoConfirmHours}h — no reply auto-confirms to salary.`
        : `Your attendance digest for ${input.weekLabel} is clean — no deductions this week.`,
    metadata: { autoConfirmHours: input.autoConfirmHours, employeeHrId: input.employeeHrId },
    module: "attendance",
    priority: input.totalDeductionValue > 0 ? "high" : "normal",
    recipientHrId: input.employeeHrId,
    subjectHrId: input.employeeHrId,
    title: `Weekly attendance digest — ${input.weekLabel}`,
  });
  return { eventId: result.eventId };
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
