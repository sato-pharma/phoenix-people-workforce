import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { AccessContext } from "@/lib/auth/permissions";
import { normalizeHrId, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { mapInAppNotificationRows, type InAppNotificationDetail } from "@/lib/communication/metrics";

export type InAppNotificationCategory = "coaching_report" | "general" | "internal_message";

export type InAppNotificationInput = {
  category: InAppNotificationCategory | string;
  dedupeKey: string;
  href?: string | null;
  message: string;
  metadata?: Record<string, unknown>;
  recipientHrId: string;
  title: string;
};

export type InAppNotificationResult =
  | { eventId?: string; skipped?: false }
  | { reason: string; skipped: true };

export type InAppNotificationSummary = {
  name: string | null;
  reference: string | null;
  requestDate: string | null;
  requestType: string | null;
  status: string | null;
};

export type InAppNotificationView = {
  category: string;
  createdAt: string | null;
  details: InAppNotificationDetail[];
  href: string | null;
  id: string;
  isRead: boolean;
  message: string;
  readAt: string | null;
  scheduledFor: string | null;
  sentAt: string | null;
  status: string;
  summary: InAppNotificationSummary;
  summaryLine: string;
  title: string;
};

type InAppNotificationEventRow = {
  category?: string | null;
  created_at?: string | null;
  id?: string | number | null;
  metadata?: unknown;
  recipients?: unknown;
  scheduled_for?: string | null;
  sent_at?: string | null;
  status?: string | null;
  subject?: string | null;
};

type InAppNotificationReadRow = {
  notification_event_id?: string | null;
  read_at?: string | null;
};

type NotificationMetadata = Record<string, unknown>;

const readNotificationRetentionMs = 7 * 24 * 60 * 60 * 1000;

function shouldShowNotificationInHistory(notification: { isRead: boolean; readAt: string | null }) {
  if (!notification.isRead) return true;
  if (!notification.readAt) return true;

  const readAtMs = new Date(notification.readAt).getTime();
  if (Number.isNaN(readAtMs)) return true;

  return Date.now() - readAtMs <= readNotificationRetentionMs;
}

function cleanHrId(value: string | null | undefined) {
  return String(value ?? "").trim().toUpperCase();
}

function cleanText(value: string | null | undefined) {
  return String(value ?? "").trim();
}

function metadataText(metadata: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = metadata[key];
    if (value === null || typeof value === "undefined") continue;
    if (typeof value === "object") continue;
    const text = cleanText(String(value));
    if (text) return text;
  }
  return null;
}

function humanize(value: string | null | undefined) {
  const text = cleanText(value).replace(/[_-]+/g, " ");
  if (!text) return null;
  return text.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function dateRangeSummary(metadata: Record<string, unknown>) {
  const explicitDate = metadataText(metadata, [
    "requestDate",
    "request_date",
    "date",
    "excuseDate",
    "excuse_date",
    "submittedAt",
    "submitted_at",
    "createdAt",
    "created_at",
  ]);
  if (explicitDate) return explicitDate;

  const startDate = metadataText(metadata, ["startDate", "start_date", "fromDate", "from_date"]);
  const endDate = metadataText(metadata, ["endDate", "end_date", "toDate", "to_date"]);
  if (startDate && endDate && startDate !== endDate) return `${startDate} to ${endDate}`;
  return startDate ?? endDate ?? null;
}

function parseMessageSummary(message: string) {
  const result: InAppNotificationSummary = {
    name: null,
    reference: null,
    requestDate: null,
    requestType: null,
    status: null,
  };
  const submittedMatch = message.match(/^(.+?) submitted (?:a |an )?(.+?)(?: for | from | on |\.|$)/i);
  if (submittedMatch) {
    result.name = cleanText(submittedMatch[1]);
    result.requestType = humanize(submittedMatch[2]);
  }

  const reviewedPossessiveMatch = message.match(/\b(?:approved|rejected)\s+(.+?)'s\s+(.+?)(?:\.|$)/i);
  if (!result.name && reviewedPossessiveMatch) {
    result.name = cleanText(reviewedPossessiveMatch[1]);
    result.requestType = humanize(reviewedPossessiveMatch[2]);
  }

  const passivePossessiveMatch = message.match(/^(.+?)'s\s+(.+?)\s+was\s+(approved|rejected|submitted)\b/i);
  if (!result.name && passivePossessiveMatch) {
    result.name = cleanText(passivePossessiveMatch[1]);
    result.requestType = humanize(passivePossessiveMatch[2]);
  }

  const dateRangeMatch = message.match(/\bfrom\s+(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/i);
  if (dateRangeMatch) {
    result.requestDate = dateRangeMatch[1] === dateRangeMatch[2]
      ? dateRangeMatch[1]
      : `${dateRangeMatch[1]} to ${dateRangeMatch[2]}`;
  } else {
    const dateMatch = message.match(/\b(?:for|on)\s+(\d{4}-\d{2}-\d{2})/i);
    if (dateMatch) result.requestDate = dateMatch[1];
  }

  const statusMatch = message.match(/\b(approved|rejected|pending|submitted)\b/i);
  if (statusMatch) result.status = humanize(statusMatch[1]);
  return result;
}

function buildNotificationSummary(input: {
  category: string;
  metadata: Record<string, unknown>;
  message: string;
  scheduledFor: string | null;
  sentAt: string | null;
  status: string;
}) {
  const parsed = parseMessageSummary(input.message);
  const requestType =
    metadataText(input.metadata, ["requestType", "request_type", "workflowType", "workflow_type", "vacationTypeLabel", "vacation_type_label"]) ??
    humanize(metadataText(input.metadata, ["vacationType", "vacation_type", "excuseType", "excuse_type", "type"])) ??
    parsed.requestType ??
    humanize(input.category);
  const summary: InAppNotificationSummary = {
    name: metadataText(input.metadata, [
      "requesterName",
      "requester_name",
      "employeeName",
      "employee_name",
      "candidateName",
      "candidate_name",
      "senderName",
      "sender_name",
      "sender",
      "coachName",
      "coach_name",
      "employee",
    ]) ?? parsed.name,
    reference: metadataText(input.metadata, [
      "requestId",
      "request_id",
      "reportId",
      "report_id",
      "reportNumber",
      "report_number",
      "messageId",
      "message_id",
      "offerCode",
      "offer_code",
    ]),
    requestDate: dateRangeSummary(input.metadata) ?? parsed.requestDate ?? input.sentAt ?? input.scheduledFor,
    requestType,
    status: humanize(metadataText(input.metadata, [
      "status",
      "workflowStatus",
      "workflow_status",
      "managerDecision",
      "manager_decision",
      "hrDecision",
      "hr_decision",
    ])) ?? parsed.status ?? humanize(input.status),
  };
  const summaryParts = [summary.name, summary.requestType, summary.requestDate].filter(Boolean);

  return {
    summary,
    summaryLine: summaryParts.length ? summaryParts.join(" - ") : input.message,
  };
}

function missingText(metadata: NotificationMetadata, key: string, value: unknown) {
  if (metadataText(metadata, [key])) return metadata;
  if (value === null || typeof value === "undefined" || cleanText(String(value)) === "") return metadata;
  return { ...metadata, [key]: value };
}

function mergeMissingMetadata(metadata: NotificationMetadata, enrichment: NotificationMetadata | undefined) {
  if (!enrichment) return metadata;
  return Object.entries(enrichment).reduce(
    (current, [key, value]) => missingText(current, key, value),
    metadata,
  );
}

function vacationTypeText(value: unknown) {
  const normalized = cleanText(String(value ?? "")).toLowerCase();
  if (normalized === "annual") return "Annual vacation";
  if (normalized === "emergency") return "Emergency vacation";
  if (normalized === "sick") return "Sick vacation";
  if (normalized === "compensatory") return "Compensatory day";
  if (normalized === "other") return "Other vacation";
  return humanize(normalized) ?? "Vacation request";
}

function requestDateText(startDate: unknown, endDate: unknown) {
  const start = cleanText(String(startDate ?? ""));
  const end = cleanText(String(endDate ?? ""));
  if (start && end && start !== end) return `${start} to ${end}`;
  return start || end || null;
}

function requestIdFromMetadata(metadata: NotificationMetadata) {
  return metadataText(metadata, ["requestId", "request_id"]);
}

async function enrichNotificationMetadata(
  rows: InAppNotificationEventRow[],
  metadataByEventId: Map<string, NotificationMetadata>,
) {
  const enrichedByEventId = new Map<string, NotificationMetadata>();
  const vacationRequestIds = new Set<string>();
  const excuseRequestIds = new Set<string>();

  for (const row of rows) {
    const eventId = String(row.id ?? "");
    const metadata = metadataByEventId.get(eventId) ?? {};
    const requestId = requestIdFromMetadata(metadata);
    if (!requestId) continue;
    const category = String(row.category ?? "").toLowerCase();
    if (category === "vacation_request") vacationRequestIds.add(requestId);
    if (category === "excuse_request") excuseRequestIds.add(requestId);
  }

  const vacationById = await fetchVacationNotificationMetadata(Array.from(vacationRequestIds));
  const excuseById = await fetchExcuseNotificationMetadata(Array.from(excuseRequestIds));

  for (const row of rows) {
    const eventId = String(row.id ?? "");
    if (!eventId) continue;
    const metadata = metadataByEventId.get(eventId) ?? {};
    const requestId = requestIdFromMetadata(metadata);
    const category = String(row.category ?? "").toLowerCase();
    const enrichment = category === "vacation_request"
      ? vacationById.get(String(requestId ?? ""))
      : category === "excuse_request"
        ? excuseById.get(String(requestId ?? ""))
        : undefined;
    enrichedByEventId.set(eventId, mergeMissingMetadata(metadata, enrichment));
  }

  return enrichedByEventId;
}

async function fetchVacationNotificationMetadata(requestIds: string[]) {
  const metadataById = new Map<string, NotificationMetadata>();
  const ids = requestIds.map((id) => cleanText(id)).filter(Boolean);
  if (!ids.length) return metadataById;

  const supabase = getSupabaseAdmin();
  const { data: v2Rows } = await supabase
    .from("v2_vacation_requests")
    .select("id,employee_hr_id,employee_name,start_date,end_date,vacation_type,status,manager_hr_id,manager_name")
    .in("id", ids);

  for (const row of (v2Rows ?? []) as Array<Record<string, unknown>>) {
    const id = cleanText(String(row.id ?? ""));
    if (!id) continue;
    metadataById.set(id, {
      employeeHrId: row.employee_hr_id,
      employeeName: row.employee_name,
      endDate: row.end_date,
      managerHrId: row.manager_hr_id,
      managerName: row.manager_name,
      requestDate: requestDateText(row.start_date, row.end_date),
      requestType: vacationTypeText(row.vacation_type),
      startDate: row.start_date,
      status: row.status,
      vacationType: row.vacation_type,
    });
  }

  const missingIds = ids.filter((id) => !metadataById.has(id));
  if (!missingIds.length) return metadataById;

  const { data: legacyRows } = await supabase
    .from("leave_requests")
    .select("id,employee_hr_id,employee_name,start_date,end_date,vacation_type,request_type,status,direct_manager_hr_id,direct_manager")
    .in("id", missingIds);

  for (const row of (legacyRows ?? []) as Array<Record<string, unknown>>) {
    const id = cleanText(String(row.id ?? ""));
    if (!id) continue;
    metadataById.set(id, {
      employeeHrId: row.employee_hr_id,
      employeeName: row.employee_name,
      endDate: row.end_date,
      managerHrId: row.direct_manager_hr_id,
      managerName: row.direct_manager,
      requestDate: requestDateText(row.start_date, row.end_date),
      requestType: vacationTypeText(row.vacation_type ?? row.request_type),
      startDate: row.start_date,
      status: row.status,
      vacationType: row.vacation_type ?? row.request_type,
    });
  }

  return metadataById;
}

async function fetchExcuseNotificationMetadata(requestIds: string[]) {
  const metadataById = new Map<string, NotificationMetadata>();
  const ids = requestIds.map((id) => cleanText(id)).filter(Boolean);
  if (!ids.length) return metadataById;

  const { data } = await getSupabaseAdmin()
    .from("v2_excuse_requests")
    .select("id,employee_hr_id,employee_name,excuse_date,excuse_type,duration_hours,status,manager_hr_id,manager_name")
    .in("id", ids);

  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const id = cleanText(String(row.id ?? ""));
    if (!id) continue;
    const excuseType = cleanText(String(row.excuse_type ?? ""));
    metadataById.set(id, {
      durationHours: row.duration_hours,
      employeeHrId: row.employee_hr_id,
      employeeName: row.employee_name,
      excuseType,
      managerHrId: row.manager_hr_id,
      managerName: row.manager_name,
      requestDate: row.excuse_date,
      requestType: `${excuseType === "morning" ? "Morning" : "Afternoon"} excuse`,
      status: row.status,
    });
  }

  return metadataById;
}

function isDuplicateNotificationError(error: unknown) {
  const text = error instanceof Error ? error.message : JSON.stringify(error);
  return text.includes("23505") || text.toLowerCase().includes("duplicate key");
}

function notificationSchemaMissing(error: unknown) {
  const text = (error instanceof Error ? error.message : `${String(error)} ${JSON.stringify(error)}`).toLowerCase();
  return (
    text.includes("notification_events") ||
    text.includes("notification_event_reads") ||
    text.includes("could not find the table") ||
    text.includes("schema cache") ||
    (text.includes("relation") && text.includes("does not exist"))
  );
}

export async function enqueueInAppNotification(input: InAppNotificationInput): Promise<InAppNotificationResult> {
  const recipientHrId = cleanHrId(input.recipientHrId);
  const eventKey = cleanText(input.dedupeKey);
  const title = cleanText(input.title);
  const message = cleanText(input.message);

  if (!recipientHrId) return { reason: "In-app notification skipped: recipient HR_ID is missing.", skipped: true };
  if (!eventKey) return { reason: "In-app notification skipped: dedupe key is missing.", skipped: true };
  if (!title) return { reason: "In-app notification skipped: title is missing.", skipped: true };

  const now = new Date();
  const metadata = {
    ...(input.metadata ?? {}),
    href: input.href ?? null,
    message,
    title,
  };

  try {
    const { data, error } = await getSupabaseAdmin()
      .from("notification_events")
      .insert({
        category: input.category,
        employee_hr_id: recipientHrId,
        event_key: eventKey,
        metadata,
        recipients: [recipientHrId],
        scheduled_for: now.toISOString().slice(0, 10),
        sent_at: now.toISOString(),
        status: "sent",
        subject: title,
        updated_at: now.toISOString(),
      })
      .select("id")
      .single();

    if (error) {
      if (isDuplicateNotificationError(error)) {
        return { reason: "In-app notification already exists.", skipped: true };
      }
      throw error;
    }

    return { eventId: String(data?.id ?? ""), skipped: false };
  } catch (error) {
    if (notificationSchemaMissing(error)) {
      return { reason: "In-app notification skipped: notification_events table is unavailable.", skipped: true };
    }
    throw error;
  }
}

export async function listInAppNotificationsForViewer(
  access: AccessContext,
  limit = 8,
): Promise<InAppNotificationView[]> {
  const employeeHrId = normalizeHrId(resolveEmployeeIdentityId(access));
  if (!employeeHrId) return [];

  try {
    const requestedLimit = Math.max(1, Math.min(limit, 200));
    const fetchLimit = Math.min(200, Math.max(requestedLimit * 3, requestedLimit + 50));
    const rows = await fetchNotificationRowsForViewer(employeeHrId, fetchLimit);
    const readByEventId = await fetchNotificationReadsForViewer(employeeHrId, rows.map((row) => String(row.id ?? "")));
    const createdAtByEventId = new Map(rows.map((row) => {
      const id = String(row.id ?? "");
      const createdAt = row.created_at ? new Date(String(row.created_at)).toISOString() : null;
      return [id, createdAt] as const;
    }));

    const metadataByEventId = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? row.metadata as Record<string, unknown>
        : {};
      metadataByEventId.set(String(row.id ?? ""), metadata);
    }
    const enrichedMetadataByEventId = await enrichNotificationMetadata(rows, metadataByEventId);

    return mapInAppNotificationRows(rows.map((row) => {
      const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? enrichedMetadataByEventId.get(String(row.id ?? "")) ?? (row.metadata as Record<string, unknown>)
        : {};
      metadataByEventId.set(String(row.id ?? ""), metadata);

      return {
        category: String(row.category ?? "general"),
        id: String(row.id ?? ""),
        metadata,
        recipients: Array.isArray(row.recipients) ? row.recipients : [],
        scheduledFor: row.scheduled_for ? new Date(String(row.scheduled_for)).toISOString() : null,
        sentAt: row.sent_at ? new Date(String(row.sent_at)).toISOString() : null,
        status: String(row.status ?? "pending"),
        subject: String(row.subject ?? "Notification"),
      };
    }), employeeHrId).map((notification) => {
      const readAt = readByEventId.get(notification.id) ?? null;
      const notificationSummary = buildNotificationSummary({
        category: notification.category,
        metadata: metadataByEventId.get(notification.id) ?? {},
        message: notification.message,
        scheduledFor: notification.scheduledFor,
        sentAt: notification.sentAt,
        status: notification.status,
      });
      return {
        ...notification,
        createdAt: createdAtByEventId.get(notification.id) ?? null,
        isRead: Boolean(readAt),
        readAt,
        summary: notificationSummary.summary,
        summaryLine: notificationSummary.summaryLine,
      };
    })
      .filter(shouldShowNotificationInHistory)
      .slice(0, requestedLimit);
  } catch (error) {
    if (notificationSchemaMissing(error)) return [];
    throw error;
  }
}

export async function markInAppNotificationRead(access: AccessContext, notificationId: string) {
  const employeeHrId = normalizeHrId(resolveEmployeeIdentityId(access));
  const eventId = String(notificationId ?? "").trim();
  if (!employeeHrId || !eventId) return false;

  try {
    const visibleRows = await fetchNotificationRowsForViewer(employeeHrId, 200);
    const isVisible = visibleRows.some((row) => String(row.id ?? "") === eventId);
    if (!isVisible) return false;

    const now = new Date().toISOString();
    const { error } = await getSupabaseAdmin()
      .from("notification_event_reads")
      .upsert({
        created_at: now,
        employee_hr_id: employeeHrId,
        notification_event_id: eventId,
        read_at: now,
      }, {
        onConflict: "notification_event_id,employee_hr_id",
      });

    if (error) throw error;
    return true;
  } catch (error) {
    if (notificationSchemaMissing(error)) return false;
    throw error;
  }
}

async function fetchNotificationRowsForViewer(employeeHrId: string, limit: number) {
  const supabase = getSupabaseAdmin();
  const boundedLimit = Math.max(1, Math.min(limit, 200));
  const selectColumns = "id,category,subject,scheduled_for,sent_at,status,metadata,recipients,created_at";

  const employeeResult = await supabase
    .from("notification_events")
    .select(selectColumns)
    .ilike("employee_hr_id", employeeHrId)
    .order("created_at", { ascending: false })
    .limit(boundedLimit);

  if (employeeResult.error) throw employeeResult.error;

  const rowsById = new Map<string, InAppNotificationEventRow>();
  for (const row of (employeeResult.data ?? []) as InAppNotificationEventRow[]) {
    const id = String(row.id ?? "");
    if (id) rowsById.set(id, row);
  }

  const recipientResult = await supabase
    .from("notification_events")
    .select(selectColumns)
    .overlaps("recipients", [employeeHrId])
    .order("created_at", { ascending: false })
    .limit(boundedLimit);

  if (!recipientResult.error) {
    for (const row of (recipientResult.data ?? []) as InAppNotificationEventRow[]) {
      const id = String(row.id ?? "");
      if (id) rowsById.set(id, row);
    }
  }

  return Array.from(rowsById.values())
    .sort((left, right) => String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")))
    .slice(0, boundedLimit);
}

async function fetchNotificationReadsForViewer(employeeHrId: string, eventIds: string[]) {
  const ids = eventIds.map((id) => String(id ?? "").trim()).filter(Boolean);
  const readByEventId = new Map<string, string>();
  if (ids.length === 0) return readByEventId;

  try {
    const { data, error } = await getSupabaseAdmin()
      .from("notification_event_reads")
      .select("notification_event_id,read_at")
      .eq("employee_hr_id", employeeHrId)
      .in("notification_event_id", ids);

    if (error) throw error;

    for (const row of (data ?? []) as InAppNotificationReadRow[]) {
      const eventId = String(row.notification_event_id ?? "");
      if (!eventId) continue;
      readByEventId.set(eventId, row.read_at ? new Date(String(row.read_at)).toISOString() : new Date().toISOString());
    }
  } catch (error) {
    if (!notificationSchemaMissing(error)) throw error;
  }

  return readByEventId;
}
