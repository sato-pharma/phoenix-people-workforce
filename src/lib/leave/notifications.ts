import type { NotificationEmailInput } from "@/lib/notifications/email";
import { safeSendNotificationEmail } from "@/lib/notifications/email";
import { writeLeaveAuditLog } from "@/lib/leave/audit";

export type LeaveNotificationEnvelope = {
  actionUrl: string;
  actorName: string;
  deliveryStatus: "queued" | "sent" | "failed" | "skipped";
  requestId: string;
  requestType: "leave";
  requestorId: string;
  routeLevel: "admin" | "direct_manager" | "hr" | "nsm";
};

export type LeaveNotificationEvent =
  | "accrual_completed"
  | "balance_adjusted"
  | "cancelled"
  | "hr_approved"
  | "hr_rejected"
  | "manager_approved"
  | "manager_rejected"
  | "request_submitted";

export async function emitLeaveNotification(
  event: LeaveNotificationEvent,
  input: Omit<NotificationEmailInput, "notificationType">,
) {
  try {
    return await safeSendNotificationEmail({
      ...input,
      metrics: [
        ...(input.metrics ?? []),
        { label: "Leave Event", value: event.replace(/_/g, " ") },
      ],
      notificationType: "leave",
    });
  } catch (error) {
    await writeLeaveAuditLog({
      employeeHrId: input.employeeHrId,
      eventType: "leave.notification.failed",
      metadata: {
        error: error instanceof Error ? error.message : String(error),
        notificationEvent: event,
        subject: input.subject,
      },
    });
    console.warn("Leave notification skipped", {
      error: error instanceof Error ? error.message : String(error),
      event,
    });
    return {
      reason: error instanceof Error ? error.message : "Leave notification failed.",
      skipped: true,
    } as const;
  }
}
