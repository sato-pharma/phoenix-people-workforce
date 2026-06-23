import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { AccessContext } from "@/lib/auth/permissions";
import { normalizeHrId, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import {
  mapInAppNotificationRows,
  type InAppNotificationDetail,
  type InAppNotificationMetricRow,
  type NotificationEnrichmentRecord,
} from "@/lib/communication/metrics";
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
  isRead: boolean;
  message: string;
  module: string | null;
  primaryText?: string;
  priority: string;
  readAt: string | null;
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
  module?: string | null;
  priority?: string | null;
  action_url?: string | null;
  recipients?: unknown;
  scheduled_for?: string | null;
  sent_at?: string | null;
  status?: string | null;
  subject?: string | null;
};

type NotificationUserStateRow = {
  archived_at?: string | null;
  hr_id?: string | null;
  notification_event_id?: string | null;
  read_at?: string | null;
  user_id?: string | null;
};

type InAppNotificationListRow = Omit<InAppNotificationMetricRow, "id" | "metadata"> & {
  id: string;
  metadata: Record<string, unknown>;
  module: string | null;
  priority: string;
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

function stateSchemaMissing(error: unknown) {
  const text = (error instanceof Error ? error.message : `${String(error)} ${JSON.stringify(error)}`).toLowerCase();
  return (
    text.includes("notification_user_states") ||
    text.includes("schema cache") ||
    text.includes("does not exist") ||
    text.includes("could not find the table")
  );
}

function viewerIdentity(access: AccessContext) {
  return {
    hrId: normalizeHrId(resolveEmployeeIdentityId(access)),
    userId: access.loginId ?? null,
  };
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
  const identity = viewerIdentity(access);
  const employeeHrId = identity.hrId;
  if (!employeeHrId) return [];

  try {
    const supabase = getSupabaseAdmin();
    const boundedLimit = Math.max(1, Math.min(limit, 20));
    const selectColumns = "id,category,subject,scheduled_for,sent_at,status,metadata,recipients,employee_hr_id,created_at,module,priority,action_url";

    const allowedCategories = Array.from(PERSONAL_BELL_CATEGORIES);

    const employeeResult = await supabase
      .from("notification_events")
      .select(selectColumns)
      .eq("employee_hr_id", employeeHrId.toUpperCase())
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

    const rowIds = rows.map((row) => String(row.id ?? "")).filter(Boolean);
    const stateByEventId = new Map<string, NotificationUserStateRow>();
    if (rowIds.length > 0) {
      try {
        let stateQuery = supabase
          .from("notification_user_states")
          .select("notification_event_id,user_id,hr_id,read_at,archived_at")
          .in("notification_event_id", rowIds);
        stateQuery = identity.userId
          ? stateQuery.or(`user_id.eq.${identity.userId},hr_id.eq.${employeeHrId}`)
          : stateQuery.eq("hr_id", employeeHrId);
        const { data: stateRows, error: stateError } = await stateQuery;
        if (stateError) throw stateError;
        for (const state of (stateRows ?? []) as NotificationUserStateRow[]) {
          const id = String(state.notification_event_id ?? "");
          if (id) stateByEventId.set(id, state);
        }
      } catch (error) {
        if (!stateSchemaMissing(error)) throw error;
      }
    }

    const mappedRows: InAppNotificationListRow[] = rows.map((row) => {
      const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? row.metadata as Record<string, unknown>
        : {};

      return {
        category: String(row.category ?? "general"),
        employeeHrId: row.employee_hr_id ?? null,
        id: String(row.id ?? ""),
        metadata: {
          ...metadata,
          href: metadata.href ?? row.action_url ?? null,
        },
        module: row.module ?? null,
        priority: row.priority ?? "normal",
        recipients: Array.isArray(row.recipients) ? row.recipients : [],
        scheduledFor: row.scheduled_for ? new Date(String(row.scheduled_for)).toISOString() : null,
        sentAt: row.sent_at ? new Date(String(row.sent_at)).toISOString() : null,
        status: String(row.status ?? "pending"),
        subject: String(row.subject ?? "Notification"),
      };
    });

    const archivedEventIds = new Set(
      mappedRows
        .filter((row) => stateByEventId.get(row.id)?.archived_at)
        .map((row) => row.id),
    );

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

    const views = mapInAppNotificationRows(mappedRows, employeeHrId, enrichmentByRequestId);
    return views.filter((view) => !archivedEventIds.has(view.id)).map((view) => {
      const state = stateByEventId.get(view.id);
      const source = mappedRows.find((row) => row.id === view.id);
      return {
        ...view,
        isRead: Boolean(state?.read_at),
        module: source?.module ?? null,
        priority: source?.priority ?? "normal",
        readAt: state?.read_at ?? null,
      };
    });
  } catch (error) {
    if (notificationSchemaMissing(error)) return [];
    throw error;
  }
}

export async function markInAppNotificationRead(access: AccessContext, notificationId: string) {
  const identity = viewerIdentity(access);
  if (!identity.hrId && !identity.userId) return { skipped: true };

  const now = new Date().toISOString();
  try {
    const payload = {
      hr_id: identity.hrId || null,
      notification_event_id: notificationId,
      read_at: now,
      updated_at: now,
      user_id: identity.userId,
    };
    const { error } = await getSupabaseAdmin()
      .from("notification_user_states")
      .upsert(payload, { onConflict: identity.userId ? "notification_event_id,user_id" : "notification_event_id,hr_id" });
    if (error) throw error;
    return { skipped: false };
  } catch (error) {
    if (stateSchemaMissing(error)) return { reason: "notification_user_states unavailable", skipped: true };
    throw error;
  }
}

export async function markAllInAppNotificationsRead(access: AccessContext) {
  const notifications = await listInAppNotificationsForViewer(access, 20);
  const unread = notifications.filter((notification) => !notification.isRead);
  // allSettled so a single failing row can't sink the whole "mark all read" batch
  // (one bad upsert previously failed the entire request with a 500).
  const results = await Promise.allSettled(
    unread.map((notification) => markInAppNotificationRead(access, notification.id)),
  );
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length > 0) {
    console.error(
      `markAllInAppNotificationsRead: ${failures.length}/${unread.length} notification(s) failed to mark read`,
      failures[0].reason,
    );
  }
  return { marked: unread.length - failures.length };
}
