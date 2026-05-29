import { canViewerSeeNotification } from "@/lib/notifications/recipients";

export type CommunicationTemplateMetricRow = {
  bodyHtml?: string | null;
  bodyText?: string | null;
  isActive?: boolean | null;
  rules?: {
    bccRoles?: string[];
    bccStaticEmails?: string[];
    ccRoles?: string[];
    ccStaticEmails?: string[];
    toRoles?: string[];
    toStaticEmails?: string[];
  } | null;
  subject?: string | null;
  templateKey?: string | null;
};

export type NotificationOutboxMetricRow = {
  createdAt?: string | null;
  payload?: { notificationType?: string | null } | null;
  status?: string | null;
};

export type NotificationDeliveryLogMetricRow = {
  sentAt?: string | null;
  status?: string | null;
};

export type NotificationEventMetricRow = {
  createdAt?: string | null;
  status?: string | null;
};

export type EmailDeliveryEventMetricRow = {
  failureReason?: string | null;
  id?: string | null;
  occurredAt?: string | null;
  recipients?: string[];
  status?: string | null;
  subject?: string | null;
};

export type InAppNotificationMetricRow = {
  category?: string | null;
  employeeHrId?: string | null;
  id?: string | number | null;
  metadata?: Record<string, unknown> | null;
  recipients?: unknown[] | null;
  scheduledFor?: string | null;
  sentAt?: string | null;
  status?: string | null;
  subject?: string | null;
};

export type InAppNotificationDetail = {
  label: string;
  value: string;
};

const deliveryStatuses = ["bounced", "complained", "delivered", "failed", "sent", "suppressed", "unknown"] as const;

export function splitCommunicationEmailList(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(splitCommunicationEmailList);
  return String(value ?? "")
    .split(/[;,\n\r]+/)
    .map((email) => email.trim())
    .filter(Boolean);
}

export function isValidCommunicationEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim().toLowerCase());
}

export function invalidCommunicationEmails(values: string[]) {
  return values.filter((email) => !isValidCommunicationEmail(email));
}

function normalizedStatus(value: string | null | undefined) {
  return String(value ?? "unknown").trim().toLowerCase();
}

function inWindow(timestamp: string | null | undefined, sinceIso?: string | null) {
  return !sinceIso || Boolean(timestamp && timestamp >= sinceIso);
}

function hasAnyRecipientRule(row: CommunicationTemplateMetricRow) {
  const rules = row.rules;
  if (!rules) return false;
  return [
    rules.bccRoles,
    rules.bccStaticEmails,
    rules.ccRoles,
    rules.ccStaticEmails,
    rules.toRoles,
    rules.toStaticEmails,
  ].some((values) => Array.isArray(values) && values.length > 0);
}

export function summarizeEmailTemplateReadiness(rows: CommunicationTemplateMetricRow[]) {
  const totalTemplates = rows.length;
  const missingSubject = rows.filter((row) => !String(row.subject ?? "").trim()).length;
  const missingBody = rows.filter((row) => !String(row.bodyHtml ?? row.bodyText ?? "").trim()).length;
  const missingRecipients = rows.filter((row) => !hasAnyRecipientRule(row)).length;
  const activeTemplates = rows.filter((row) => row.isActive !== false).length;
  const readyTemplates = rows.filter((row) =>
    row.isActive !== false &&
    String(row.subject ?? "").trim() &&
    String(row.bodyHtml ?? row.bodyText ?? "").trim() &&
    hasAnyRecipientRule(row),
  ).length;

  return {
    activeTemplates,
    inactiveTemplates: Math.max(0, totalTemplates - activeTemplates),
    missingBody,
    missingRecipients,
    missingSubject,
    readinessRate: totalTemplates > 0 ? readyTemplates / totalTemplates : 1,
    readyTemplates,
    totalTemplates,
  };
}

export function summarizeNotificationOutboxRows(
  rows: NotificationOutboxMetricRow[],
  allowedTypes: readonly string[] = [],
) {
  const allowed = new Set(allowedTypes);
  const sortedRows = [...rows].sort((left, right) =>
    String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")),
  );

  return {
    failed: sortedRows.filter((row) => normalizedStatus(row.status) === "failed").length,
    lastSentAt: sortedRows.find((row) => normalizedStatus(row.status) === "sent")?.createdAt ?? null,
    pending: sortedRows.filter((row) => normalizedStatus(row.status) === "pending").length,
    recentAllowed: allowed.size > 0
      ? sortedRows.filter((row) => allowed.has(String(row.payload?.notificationType ?? ""))).length
      : sortedRows.length,
    recentTotal: sortedRows.length,
    sent: sortedRows.filter((row) => normalizedStatus(row.status) === "sent").length,
  };
}

export function summarizeNotificationMonitoring(input: {
  deliveryEvents?: EmailDeliveryEventMetricRow[];
  deliveryLogs?: NotificationDeliveryLogMetricRow[];
  notificationEvents?: NotificationEventMetricRow[];
  sinceIso?: string;
}) {
  const sinceIso = input.sinceIso;
  const deliveryLogs = (input.deliveryLogs ?? []).filter((row) => inWindow(row.sentAt, sinceIso));
  const notificationEvents = (input.notificationEvents ?? []).filter((row) => inWindow(row.createdAt, sinceIso));
  const deliveryCounts = Object.fromEntries(deliveryStatuses.map((status) => [status, 0])) as Record<(typeof deliveryStatuses)[number], number>;

  for (const row of input.deliveryEvents ?? []) {
    if (!inWindow(row.occurredAt, sinceIso)) continue;
    const status = normalizedStatus(row.status) as keyof typeof deliveryCounts;
    if (status in deliveryCounts) deliveryCounts[status] += 1;
    else deliveryCounts.unknown += 1;
  }

  return {
    actualDelivery24h: deliveryCounts,
    failed24h: deliveryLogs.filter((row) => normalizedStatus(row.status) === "failed").length,
    pending24h: notificationEvents.filter((row) => normalizedStatus(row.status) === "pending").length,
    recentDeliveryEvents: (input.deliveryEvents ?? [])
      .slice()
      .sort((left, right) => String(right.occurredAt ?? "").localeCompare(String(left.occurredAt ?? "")))
      .slice(0, 20)
      .map((row) => ({
        failureReason: row.failureReason ?? null,
        id: String(row.id ?? ""),
        occurredAt: row.occurredAt ?? null,
        recipients: Array.isArray(row.recipients) ? row.recipients.map(String) : [],
        status: String(row.status ?? "unknown"),
        subject: row.subject ?? null,
      })),
    sent24h: deliveryLogs.filter((row) => normalizedStatus(row.status) === "sent").length,
    totalQueuedEvents: notificationEvents.length,
  };
}

export function buildCommunicationMetrics(input: {
  outboxRows?: NotificationOutboxMetricRow[];
  templateRows?: CommunicationTemplateMetricRow[];
}) {
  const templateReadiness = summarizeEmailTemplateReadiness(input.templateRows ?? []);
  const outbox = summarizeNotificationOutboxRows(input.outboxRows ?? []);

  return {
    failedNotifications: outbox.failed,
    pendingNotifications: outbox.pending,
    sentNotifications: outbox.sent,
    templateReadinessRate: templateReadiness.readinessRate,
    templatesActive: templateReadiness.activeTemplates,
    templatesReady: templateReadiness.readyTemplates,
    templatesTotal: templateReadiness.totalTemplates,
  };
}

export function mapInAppNotificationRows(rows: InAppNotificationMetricRow[], employeeHrId: string | null) {
  return rows
    // Fail-closed recipient isolation for EVERY category: a viewer only sees a
    // notification where they are the employee subject or an explicit, valid
    // recipient. Invalid/fixture recipients are ignored. See
    // src/lib/notifications/recipients.ts.
    .filter((row) =>
      canViewerSeeNotification(employeeHrId, {
        employeeHrId: row.employeeHrId,
        recipients: row.recipients,
      }),
    )
    .map((row) => {
      const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? row.metadata
        : {};
      const details = notificationDetails(metadata);

      return {
        category: String(row.category ?? "general"),
        details,
        href: typeof metadata.href === "string" ? metadata.href : null,
        id: String(row.id ?? ""),
        message: typeof metadata.message === "string" ? metadata.message : String(row.subject ?? "Notification"),
        scheduledFor: row.scheduledFor ? new Date(String(row.scheduledFor)).toISOString() : null,
        sentAt: row.sentAt ? new Date(String(row.sentAt)).toISOString() : null,
        status: String(row.status ?? "pending"),
        title: typeof metadata.title === "string" ? metadata.title : String(row.subject ?? "Notification"),
      };
    });
}

const sensitiveMetadataKeyPattern =
  /(token|password|secret|otp|passcode|api[_-]?key|authorization|cookie|session|hash|signature|credential|ssn|national[_-]?id|bank|iban|email|recipients?|salary|net[_-]?pay|gross|compensation|wage|payslip|pay[_-]?slip)/i;

/** True for metadata keys that must never be rendered in the notification card. */
function isSensitiveMetadataKey(key: string): boolean {
  return sensitiveMetadataKeyPattern.test(key);
}

function detailValue(value: unknown) {
  if (value === null || typeof value === "undefined") return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return "";
  return String(value).trim();
}

function notificationDetails(metadata: Record<string, unknown>): InAppNotificationDetail[] {
  // Explicit producer-provided detail rows take precedence: clean, ordered, and
  // already shaped (Employee / Type / Period / Status / Action). Sensitive labels
  // are still dropped defensively.
  const explicit = metadata.details;
  if (Array.isArray(explicit)) {
    const rows: InAppNotificationDetail[] = [];
    for (const entry of explicit) {
      if (!entry || typeof entry !== "object") continue;
      const label = detailValue((entry as { label?: unknown }).label);
      const value = detailValue((entry as { value?: unknown }).value);
      if (!label || !value || isSensitiveMetadataKey(label)) continue;
      rows.push({ label, value });
    }
    if (rows.length > 0) return rows.slice(0, 8);
  }

  const preferred: Array<[string, string[]]> = [
    ["Order", ["orderId", "order_id", "orderNo", "order_no", "orderNumber", "order_number"]],
    ["Request", ["requestId", "request_id", "requestNo", "request_no"]],
    ["Employee", ["employee", "employeeName", "employee_name", "employeeHrId", "employee_hr_id"]],
    ["Status", ["status", "workflowStatus", "workflow_status"]],
    ["Amount", ["amount", "total", "value"]],
    ["Date", ["date", "createdAt", "created_at", "submittedAt", "submitted_at"]],
  ];
  const details: InAppNotificationDetail[] = [];
  const used = new Set<string>();

  for (const [label, keys] of preferred) {
    const key = keys.find((candidate) => detailValue(metadata[candidate]));
    if (!key) continue;
    used.add(key);
    details.push({ label, value: detailValue(metadata[key]) });
  }

  const metrics = metadata.metrics;
  if (Array.isArray(metrics)) {
    for (const metric of metrics) {
      if (!metric || typeof metric !== "object") continue;
      const label = detailValue((metric as { label?: unknown }).label);
      const value = detailValue((metric as { value?: unknown }).value);
      if (!label || !value) continue;
      details.push({ label, value });
    }
  }

  for (const [key, value] of Object.entries(metadata)) {
    if (details.length >= 8) break;
    if (used.has(key) || ["href", "message", "metrics", "title", "details"].includes(key)) continue;
    // Never surface sensitive raw metadata (tokens, passwords, emails, etc.).
    if (isSensitiveMetadataKey(key)) continue;
    const text = detailValue(value);
    if (!text) continue;
    details.push({
      label: key.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2"),
      value: text,
    });
  }

  return details.slice(0, 8);
}
