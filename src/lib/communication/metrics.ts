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

/**
 * Non-sensitive, render-time enrichment for a notification (keyed by requestId).
 * Resolved read-only from the source record so OLD notifications can display the
 * employee subject / type / period even though their stored metadata is sparse.
 */
export type NotificationEnrichmentRecord = {
  employeeHrId?: string;
  employeeName?: string;
  endDate?: string;
  startDate?: string;
  status?: string;
  typeLabel?: string;
};

/**
 * Normalized display model used by the bell for BOTH old and new notifications.
 * `primaryText` (the employee/request subject) is shown prominently; `title` is
 * the human-readable event; the stored subject is only ever a fallback.
 */
export type NormalizedNotificationDisplay = {
  actionLabel?: string;
  category: string;
  details: InAppNotificationDetail[];
  href: string | null;
  id: string;
  message: string;
  primaryText?: string;
  scheduledFor: string | null;
  sentAt: string | null;
  status: string;
  statusLabel?: string;
  title: string;
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
  /**
   * @deprecated The notification_delivery_logs table was retired by migration
   * 20260616120000 (zero writers, zero rows in prod). This field is still
   * accepted for backward-compat with older callers, but `failed24h` and
   * `sent24h` are now derived from `deliveryEvents` (email_delivery_events)
   * which is the canonical Resend-webhook log. Pass nothing here.
   */
  deliveryLogs?: NotificationDeliveryLogMetricRow[];
  notificationEvents?: NotificationEventMetricRow[];
  sinceIso?: string;
}) {
  const sinceIso = input.sinceIso;
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
    failed24h: deliveryCounts.failed,
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
    sent24h: deliveryCounts.sent,
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

export function mapInAppNotificationRows(
  rows: InAppNotificationMetricRow[],
  employeeHrId: string | null,
  enrichmentByRequestId?: ReadonlyMap<string, NotificationEnrichmentRecord>,
): NormalizedNotificationDisplay[] {
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
      const category = String(row.category ?? "general");
      const subject = String(row.subject ?? "Notification");

      const requestId = detailValue(metadata.requestId);
      const enrichment = requestId ? enrichmentByRequestId?.get(requestId) : undefined;

      const display = buildNotificationDisplay({ category, enrichment, metadata, subject });

      return {
        actionLabel: display.actionLabel,
        category,
        details: display.details,
        href: typeof metadata.href === "string" ? metadata.href : null,
        id: String(row.id ?? ""),
        message: display.message,
        primaryText: display.primaryText,
        scheduledFor: row.scheduledFor ? new Date(String(row.scheduledFor)).toISOString() : null,
        sentAt: row.sentAt ? new Date(String(row.sentAt)).toISOString() : null,
        status: String(row.status ?? "pending"),
        statusLabel: display.statusLabel,
        title: display.title,
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

// --- Render-time polish (applies to EXISTING notifications too, no data change) ---

const NOTIFICATION_STATUS_LABELS: Record<string, string> = {
  pending_manager: "Pending manager decision",
  pending_hr: "Pending HR final decision",
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  sent: "Sent",
  feedback_required: "Feedback required",
};

/** Turn a raw status token (e.g. "pending_hr") into a readable label. */
function humanizeNotificationStatus(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  return (
    NOTIFICATION_STATUS_LABELS[raw.toLowerCase()] ??
    raw.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/** Derive a clear next-action label from category + status (best-effort, read-time). */
function deriveNotificationAction(category: string, status: string): string {
  const c = category.trim().toLowerCase();
  const s = status.trim().toLowerCase();
  if (c === "vacation_request") {
    if (s === "pending_manager") return "Review request";
    if (s === "pending_hr") return "Complete HR decision";
  }
  if (c === "probation") return "Submit feedback";
  if (c === "excuse" && s.includes("pending")) return "Review excuse";
  if (c === "recruitment") return "Open recruitment";
  return "";
}

/** UUIDs are internal identifiers and must never be shown as a useful detail row. */
function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

// --- Subject-first display model (used for OLD + NEW notifications) ----------

const VACATION_TITLE_BY_STATUS: Record<string, string> = {
  pending_manager: "Vacation request pending manager decision",
  pending_hr: "Vacation request pending HR final decision",
  approved: "Vacation request approved",
  rejected: "Vacation request rejected",
};

/** Status-based, name-free EVENT title for a vacation notification. */
function vacationTitleForStatus(status: string): string {
  return VACATION_TITLE_BY_STATUS[status.trim().toLowerCase()] ?? "";
}

/** "2026-05-22 → 2026-05-24" from start/end (matches the live producers). */
function formatNotificationPeriod(start: string, end: string): string {
  const from = start.trim();
  const to = end.trim();
  if (from && to) return `${from} → ${to}`;
  return from || to;
}

/** Pull the employee name from a producer "Employee" detail row ("Name (HR-ID)"). */
function employeeNameFromDetails(details: unknown): string {
  if (!Array.isArray(details)) return "";
  for (const entry of details) {
    if (!entry || typeof entry !== "object") continue;
    const label = detailValue((entry as { label?: unknown }).label);
    if (label.toLowerCase() !== "employee") continue;
    const value = detailValue((entry as { value?: unknown }).value);
    return value.replace(/\s*\([^)]*\)\s*$/, "").trim();
  }
  return "";
}

/**
 * CONSERVATIVE employee-name extraction from a vacation message — used ONLY as a
 * fallback when requestId enrichment is unavailable (e.g. the underlying request
 * was deleted). It relies on the deterministic shapes the vacation producers
 * emit and never guesses:
 *   - "{Employee}'s vacation request ..."            (possessive owns the request)
 *   - "{Actor} approved {Employee}'s vacation request"
 *   - "{Employee} submitted ..."
 * The possessive form identifies the EMPLOYEE (the request's owner) regardless of
 * who acted, so it is reliable rather than a wrong-person guess.
 */
function employeeNameFromVacationMessage(message: string): string {
  const text = message.trim();
  if (!text || text.length > 160) return "";
  // Highest priority: the employee owns the "vacation request" (possessive).
  const possessive = text.match(
    /([\p{Lu}][\p{L}.'’-]*(?:\s+[\p{Lu}][\p{L}.'’-]*){0,3})['’]s\s+vacation\s+request/u,
  );
  if (possessive?.[1]) return possessive[1].trim();
  // Otherwise the leading name in a "{Employee} submitted ..." sentence.
  const submitted = text.match(/^([\p{Lu}][\p{L}.'’-]*(?:\s+[\p{Lu}][\p{L}.'’-]*){0,3})\s+submitted\b/u);
  if (submitted?.[1]) return submitted[1].trim();
  return "";
}

/** Resolve the prominent subject name (producer → enrichment → details → message). */
function resolvePrimaryText(
  metadata: Record<string, unknown>,
  category: string,
  enrichment: NotificationEnrichmentRecord | undefined,
  message: string,
): string {
  // 1. Producer-provided subject name takes precedence.
  const explicit = detailValue(metadata.primaryText) || detailValue(metadata.subjectEmployeeName);
  if (explicit) return explicit;
  // 2. Authoritative enrichment from the source record.
  const enriched = detailValue(enrichment?.employeeName);
  if (enriched) return enriched;
  // 3. Structured producer details[] (new-style notifications).
  const fromDetails = employeeNameFromDetails(metadata.details);
  if (fromDetails) return fromDetails;
  // 4. Conservative message parse (vacation only) — clearly marked fallback.
  if (category.trim().toLowerCase() === "vacation_request") {
    return employeeNameFromVacationMessage(message);
  }
  return "";
}

/** Authoritative vacation detail rows built from the resolved request record. */
function buildEnrichedVacationDetails(
  enrichment: NotificationEnrichmentRecord,
  statusLabel: string,
  actionLabel: string,
): InAppNotificationDetail[] {
  const rows: InAppNotificationDetail[] = [];
  const name = detailValue(enrichment.employeeName);
  const hrId = detailValue(enrichment.employeeHrId);
  if (name) rows.push({ label: "Employee", value: hrId ? `${name} (${hrId})` : name });
  const type = detailValue(enrichment.typeLabel);
  if (type) rows.push({ label: "Type", value: type });
  const period = formatNotificationPeriod(detailValue(enrichment.startDate), detailValue(enrichment.endDate));
  if (period) rows.push({ label: "Period", value: period });
  if (statusLabel) rows.push({ label: "Status", value: statusLabel });
  if (actionLabel) rows.push({ label: "Action", value: actionLabel });
  return rows;
}

/**
 * Build the normalized, subject-first display for one notification. Works for
 * BOTH old (sparse metadata + requestId enrichment) and new (rich producer
 * details[]) notifications. Never renders raw UUIDs or sensitive fields.
 */
function buildNotificationDisplay(input: {
  category: string;
  enrichment: NotificationEnrichmentRecord | undefined;
  metadata: Record<string, unknown>;
  subject: string;
}): {
  actionLabel?: string;
  details: InAppNotificationDetail[];
  message: string;
  primaryText?: string;
  statusLabel?: string;
  title: string;
} {
  const { category, enrichment, metadata, subject } = input;
  const categoryLc = category.trim().toLowerCase();

  const message = typeof metadata.message === "string" && metadata.message.trim()
    ? metadata.message
    : subject;

  const rawStatus =
    detailValue(enrichment?.status) ||
    detailValue(metadata.status) ||
    detailValue(metadata.workflowStatus);
  const statusLabel = rawStatus ? humanizeNotificationStatus(rawStatus) : "";
  const actionLabel = deriveNotificationAction(category, rawStatus);

  const primaryText = resolvePrimaryText(metadata, category, enrichment, message);

  let title = typeof metadata.title === "string" && metadata.title.trim() ? metadata.title : subject;
  if (categoryLc === "vacation_request") {
    // Title is the name-free EVENT; the employee name lives in primaryText.
    const eventTitle = vacationTitleForStatus(rawStatus);
    if (eventTitle) title = eventTitle;
  }

  // Details: prefer authoritative enrichment for vacation rows; otherwise reuse
  // the existing render-time builder (producer details[] + status/action polish).
  const details = enrichment
    ? buildEnrichedVacationDetails(enrichment, statusLabel, actionLabel)
    : notificationDetails(metadata, category);

  return {
    actionLabel: actionLabel || undefined,
    details,
    message,
    primaryText: primaryText || undefined,
    statusLabel: statusLabel || undefined,
    title,
  };
}

function notificationDetails(metadata: Record<string, unknown>, category = ""): InAppNotificationDetail[] {
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
    ["Request", ["requestNo", "request_no"]],
    ["Employee", ["employee", "employeeName", "employee_name"]],
    ["Manager", ["manager", "managerName", "manager_name"]],
    ["Type", ["type", "vacationType", "vacation_type", "expenseType", "expense_type"]],
    ["Period", ["period", "dateRange", "date_range"]],
    ["Status", ["status", "workflowStatus", "workflow_status"]],
    ["Amount", ["amount", "total"]],
    ["Date", ["date", "createdAt", "created_at", "submittedAt", "submitted_at"]],
  ];
  const details: InAppNotificationDetail[] = [];
  const used = new Set<string>();

  for (const [label, keys] of preferred) {
    const key = keys.find((candidate) => detailValue(metadata[candidate]));
    if (!key) continue;
    let value = detailValue(metadata[key]);
    if (isUuidLike(value)) { used.add(key); continue; } // never show raw UUIDs
    if (label === "Status") value = humanizeNotificationStatus(value); // render-time polish
    used.add(key);
    details.push({ label, value });
  }

  // Render-time polish: append a clear Action derived from category + status, so
  // even EXISTING (pre-change) notifications show what to do next.
  const derivedAction = deriveNotificationAction(category, detailValue(metadata.status ?? metadata.workflowStatus));
  if (derivedAction && !details.some((detail) => detail.label === "Action")) {
    details.push({ label: "Action", value: derivedAction });
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
    if (!text || isUuidLike(text)) continue; // skip empty + raw UUID identifiers
    details.push({
      label: key.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2"),
      value: text,
    });
  }

  return details.slice(0, 8);
}
