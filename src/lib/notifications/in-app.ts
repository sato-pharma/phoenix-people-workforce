import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { AccessContext } from "@/lib/auth/permissions";
import { normalizeHrId, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { mapInAppNotificationRows, type InAppNotificationDetail, type NotificationEnrichmentRecord } from "@/lib/communication/metrics";
import { canViewerSeeNotification, isPersonalBellCategory, PERSONAL_BELL_CATEGORIES } from "@/lib/notifications/recipients";
import { fetchVacationNotificationEnrichments } from "@/lib/vacation/notification-enrichment";

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

export type InAppNotificationView = {
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

type InAppNotificationEventRow = {
  category?: string | null;
  created_at?: string | null;
  employee_hr_id?: string | null;
  id?: string | number | null;
  metadata?: unknown;
  recipients?: unknown;
  scheduled_for?: string | null;
  sent_at?: string | null;
  status?: string | null;
  subject?: string | null;
};

function cleanHrId(value: string | null | undefined) {
  return String(value ?? "").trim().toUpperCase();
}

function cleanText(value: string | null | undefined) {
  return String(value ?? "").trim();
}

function isDuplicateNotificationError(error: unknown) {
  const text = error instanceof Error ? error.message : JSON.stringify(error);
  return text.includes("23505") || text.toLowerCase().includes("duplicate key");
}

function notificationSchemaMissing(error: unknown) {
  const text = (error instanceof Error ? error.message : `${String(error)} ${JSON.stringify(error)}`).toLowerCase();
  return (
    text.includes("notification_events") ||
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
    const supabase = getSupabaseAdmin();
    const boundedLimit = Math.max(1, Math.min(limit, 20));
    const selectColumns = "id,category,subject,scheduled_for,sent_at,status,metadata,recipients,employee_hr_id,created_at";

    const allowedCategories = Array.from(PERSONAL_BELL_CATEGORIES);

    const employeeResult = await supabase
      .from("notification_events")
      .select(selectColumns)
      .ilike("employee_hr_id", employeeHrId)
      .in("category", allowedCategories)
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
      .in("category", allowedCategories)
      .order("created_at", { ascending: false })
      .limit(boundedLimit);

    if (!recipientResult.error) {
      for (const row of (recipientResult.data ?? []) as InAppNotificationEventRow[]) {
        const id = String(row.id ?? "");
        if (id) rowsById.set(id, row);
      }
    }

    const rows = Array.from(rowsById.values())
      // Personal-bell category allowlist: hide legacy/orphaned categories (e.g.
      // "leave") that may carry mis-assigned recipients. Defense-in-depth on top
      // of the SQL .in("category", ...) filter. See src/lib/notifications/recipients.ts.
      .filter((row) => isPersonalBellCategory(row.category))
      // Fail-closed recipient isolation applied AFTER the DB query — never rely on
      // the SQL employee/overlap filters alone. See src/lib/notifications/recipients.ts.
      .filter((row) =>
        canViewerSeeNotification(employeeHrId, {
          employeeHrId: row.employee_hr_id,
          recipients: Array.isArray(row.recipients) ? row.recipients : [],
        }),
      )
      .sort((left, right) => String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")))
      .slice(0, boundedLimit);

    const mappedRows = rows.map((row) => {
      const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? row.metadata as Record<string, unknown>
        : {};

      return {
        category: String(row.category ?? "general"),
        employeeHrId: row.employee_hr_id ?? null,
        id: String(row.id ?? ""),
        metadata,
        recipients: Array.isArray(row.recipients) ? row.recipients : [],
        scheduledFor: row.scheduled_for ? new Date(String(row.scheduled_for)).toISOString() : null,
        sentAt: row.sent_at ? new Date(String(row.sent_at)).toISOString() : null,
        status: String(row.status ?? "pending"),
        subject: String(row.subject ?? "Notification"),
      };
    });

    // Read-time enrichment: resolve the (non-sensitive) subject/type/period for
    // vacation notifications so OLD rows display subject-first like new ones.
    // Best-effort and fail-soft — never blocks the bell.
    const vacationRequestIds = mappedRows
      .filter((row) => row.category === "vacation_request")
      .map((row) => (typeof row.metadata.requestId === "string" ? row.metadata.requestId : ""))
      .filter((value) => value.length > 0);

    let enrichmentByRequestId: ReadonlyMap<string, NotificationEnrichmentRecord> = new Map();
    if (vacationRequestIds.length > 0) {
      try {
        enrichmentByRequestId = await fetchVacationNotificationEnrichments(vacationRequestIds);
      } catch {
        enrichmentByRequestId = new Map();
      }
    }

    return mapInAppNotificationRows(mappedRows, employeeHrId, enrichmentByRequestId);
  } catch (error) {
    if (notificationSchemaMissing(error)) return [];
    throw error;
  }
}
