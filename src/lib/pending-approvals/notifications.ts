import type { InAppNotificationView } from "@/lib/notifications/in-app";
import type { PendingApprovalItem } from "@/lib/pending-approvals/service";

function pendingApprovalNotificationId(item: PendingApprovalItem) {
  return `pending-approval:${item.workflow}:${item.id}`;
}

function notificationSortKey(notification: InAppNotificationView) {
  return notification.createdAt ?? notification.sentAt ?? notification.scheduledFor ?? "";
}

export function pendingApprovalToInAppNotification(item: PendingApprovalItem): InAppNotificationView {
  const createdAt = item.submittedAt || new Date(0).toISOString();

  return {
    category: "pending_approval",
    createdAt,
    details: [
      { label: "Workflow", value: item.workflowLabel },
      { label: "Step", value: item.currentStep },
      ...(item.requesterHrId ? [{ label: "HR ID", value: item.requesterHrId }] : []),
    ],
    href: "/pending-approvals",
    id: pendingApprovalNotificationId(item),
    isRead: false,
    message: item.shortSummary,
    readAt: null,
    scheduledFor: null,
    sentAt: createdAt,
    status: "pending",
    summary: {
      name: item.requester,
      reference: item.id,
      requestDate: createdAt,
      requestType: item.workflowLabel,
      status: item.currentStep,
    },
    summaryLine: `${item.requester} - ${item.workflowLabel} - ${item.currentStep}`,
    title: "Pending approval required",
  };
}

export function mergePendingApprovalNotifications(
  notifications: InAppNotificationView[],
  pendingApprovals: PendingApprovalItem[],
  limit: number,
) {
  const requestedLimit = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 8, 200));
  const notificationIds = new Set(notifications.map((notification) => notification.id));
  const approvalNotifications = pendingApprovals
    .map(pendingApprovalToInAppNotification)
    .filter((notification) => !notificationIds.has(notification.id));

  return [...approvalNotifications, ...notifications]
    .sort((left, right) => notificationSortKey(right).localeCompare(notificationSortKey(left)))
    .slice(0, requestedLimit);
}
