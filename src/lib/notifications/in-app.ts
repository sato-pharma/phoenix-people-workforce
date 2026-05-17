import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { AccessContext } from "@/lib/auth/permissions";
import { normalizeHrId, resolveEmployeeIdentityId } from "@/lib/auth/permissions";

export type InAppNotificationCategory = "coaching_report" | "general";

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
  category: string;
  href: string | null;
  id: string;
  message: string;
  scheduledFor: string | null;
  sentAt: string | null;
  status: string;
  title: string;
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
    const { data, error } = await getSupabaseAdmin()
      .from("notification_events")
      .select("id,category,subject,scheduled_for,sent_at,status,metadata,recipients")
      .or(`employee_hr_id.ilike.${employeeHrId},recipients.cs.["${employeeHrId.toUpperCase()}"]`)
      .order("created_at", { ascending: false })
      .limit(Math.max(1, Math.min(limit, 20)));

    if (error) throw error;

    return (data ?? []).filter((row) => {
      const record = row as Record<string, unknown>;
      if (String(record.category ?? "").toLowerCase() !== "probation") return true;
      const recipients = Array.isArray(record.recipients) ? record.recipients : [];
      return recipients.some((recipient) => normalizeHrId(String(recipient)) === employeeHrId);
    }).map((row) => {
      const record = row as Record<string, unknown>;
      const metadata = record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
        ? record.metadata as Record<string, unknown>
        : {};

      return {
        category: String(record.category ?? "general"),
        href: typeof metadata.href === "string" ? metadata.href : null,
        id: String(record.id ?? ""),
        message: typeof metadata.message === "string" ? metadata.message : String(record.subject ?? "Notification"),
        scheduledFor: record.scheduled_for ? new Date(String(record.scheduled_for)).toISOString() : null,
        sentAt: record.sent_at ? new Date(String(record.sent_at)).toISOString() : null,
        status: String(record.status ?? "pending"),
        title: typeof metadata.title === "string" ? metadata.title : String(record.subject ?? "Notification"),
      };
    });
  } catch (error) {
    if (notificationSchemaMissing(error)) return [];
    throw error;
  }
}
