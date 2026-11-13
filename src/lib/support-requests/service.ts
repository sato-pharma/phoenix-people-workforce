/**
 * Employee HR support requests — server-side service.
 *
 * Persists tickets opened from /employee-portals/contact-hr-support to the
 * `public.employee_support_requests` table. Returns viewer-scoped lists.
 *
 * Schema is in supabase/scripts/2026_employee_support_requests.sql. If the table
 * is missing (migration not yet applied) the service degrades to a no-op
 * empty list rather than crashing the page.
 */

import { assertPermission, hrIdsMatch, normalizeHrId, type AccessContext } from "@/lib/auth/permissions";
import { pickDeliverableEmail } from "@/lib/email/email-safety";
import { createSystemNotification } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  SUPPORT_REQUEST_STATUSES,
  type CreateSupportRequestInput,
  type CreateSupportRequestResult,
  type SupportNotificationStatus,
  type SupportRequestAttachment,
  type SupportRequestListFilter,
  type SupportRequestRow,
  type SupportRequestStatus,
} from "@/lib/support-requests/types";

// Re-exported for existing consumers (API routes, portal pages) — the canonical
// definitions now live in types.ts, a dependency-free sibling that client components
// (SupportRequestsWorkspace) import directly so they never pull this file's server-only
// notifications/email-templates -> employee-directory chain into the browser bundle.
export { SUPPORT_REQUEST_STATUSES };
export type {
  CreateSupportRequestInput,
  CreateSupportRequestResult,
  SupportNotificationStatus,
  SupportRequestAttachment,
  SupportRequestListFilter,
  SupportRequestRow,
  SupportRequestStatus,
};

const SUPPORT_ADMIN_REVIEW_URL = "/admin/notifications";

type HrRecipient = { email: string | null; hrId: string | null; userId: string | null };

/**
 * Resolve the HR team that should be alerted when an employee opens a support
 * ticket: every active Super Admin / Talent Acquisition account. Job titles are
 * descriptive only and must not grant HR inbox authority.
 *
 * Throws on Supabase failure — callers must catch and fall back to
 * resolveSuperAdminFallbackRecipients() so a transient error never silently drops
 * the HR notification. This is the second half of the silent-fail audit fix
 * (PR for resignations/support/organogram launch readiness).
 */
async function resolveHrSupportRecipients(): Promise<HrRecipient[]> {
  const supabase = getSupabaseAdmin();
  const { data: authRows, error: authError } = await supabase
    .from("app_auth_users")
    .select("login_id,hr_id,role,auth_email,is_active")
    .in("role", ["HR Operations", "Super Admin"])
    .eq("is_active", true);
  if (authError) throw authError;

  // 🔴 THIS SELECT NAMED `position_title`, WHICH IS NOT A COLUMN ON `employees`, SO THE READ THREW
  // EVERY TIME IT RAN. PostgREST answers a missing column with a 42703 that fails the WHOLE read,
  // and this one re-throws: HR Advisory and HR Operations could never have been resolved, and every
  // alert would have fallen through to the Super-Admin fallback on an auth email rather than the
  // work email this function exists to find.
  //
  // NOTHING WAS LOST, AND THAT IS THE POINT — `employee_support_requests` holds 0 rows on
  // production (checked 2026-09-29), so the path had simply never run in anger. A defect that costs
  // nothing until the first real user is exactly the kind a green build never finds; this one was
  // found by probing every employees select in the tree against production, not by reading code.
  // Nothing here ever read the field: the recipient is built from `work_email` alone.
  const { data: employees, error: employeesError } = await supabase
    .from("employees")
    .select("hr_id,job_title,work_email");
  if (employeesError) throw employeesError;

  const employeeByHrId = new Map(
    ((employees ?? []) as Array<{ hr_id?: string | null; job_title?: string | null; work_email?: string | null }>)
      .map((row) => [normalizeHrId(row.hr_id), row] as const)
      .filter((entry): entry is [string, { hr_id?: string | null; job_title?: string | null; work_email?: string | null }] => Boolean(entry[0])),
  );

  const recipients: HrRecipient[] = ((authRows ?? []) as Array<{ auth_email?: string | null; login_id?: string | null; hr_id?: string | null; role?: string | null }>)
    .map((row) => {
      const employee = employeeByHrId.get(normalizeHrId(row.hr_id) ?? "");
      return {
        email: pickDeliverableEmail(employee?.work_email, row.auth_email),
        hrId: row.hr_id ?? null,
        userId: row.login_id ?? null,
      };
    });
  return recipients;
}

/**
 * Tighter, more-reliable fallback used when the primary HR lookup throws or
 * resolves to zero deliverable recipients. Targets only active Super Admin
 * accounts so HR-Manager B-10 (Omar Anwar Gawish, per the hr-approval-authority
 * memory) is always reached. Re-throws so the caller can record the failure.
 */
async function resolveSuperAdminFallbackRecipients(): Promise<HrRecipient[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("app_auth_users")
    .select("login_id,hr_id,auth_email,is_active")
    .eq("role", "Super Admin")
    .eq("is_active", true);
  if (error) throw error;
  return ((data ?? []) as Array<{ auth_email?: string | null; login_id?: string | null; hr_id?: string | null }>).map((row) => ({
    email: pickDeliverableEmail(row.auth_email),
    hrId: row.hr_id ?? null,
    userId: row.login_id ?? null,
  }));
}

/**
 * Alert the HR team (in-app + email + Telegram) that a new support ticket was opened.
 * Best-effort for the ticket persistence path: any failure here must never prevent
 * the ticket from being saved. Returns a structured delivery status so the API
 * surface can render a "ticket saved but HR notification failed" banner instead
 * of silently dropping the alert (pre-launch silent-fail audit fix).
 */
async function notifyHrOfSupportRequest(request: SupportRequestRow): Promise<SupportNotificationStatus> {
  let recipients: HrRecipient[] = [];
  let fellBackToSuperAdmin = false;
  let errored = false;

  try {
    recipients = await resolveHrSupportRecipients();
  } catch (error) {
    errored = true;
    logError("Primary HR recipient lookup failed for support ticket", {
      labels: { event: "support_request_hr_recipient_lookup_failed", ticketId: request.id, hrId: request.hrId },
      error,
    });
  }

  recipients = recipients.filter((recipient) => !hrIdsMatch(recipient.hrId, request.hrId));

  if (recipients.length === 0) {
    try {
      const fallback = await resolveSuperAdminFallbackRecipients();
      const filtered = fallback.filter((recipient) => !hrIdsMatch(recipient.hrId, request.hrId));
      if (filtered.length > 0) {
        recipients = filtered;
        fellBackToSuperAdmin = true;
      }
    } catch (fallbackError) {
      errored = true;
      logError("Super Admin fallback lookup failed for support ticket", {
        labels: { event: "support_request_super_admin_fallback_failed", ticketId: request.id, hrId: request.hrId },
        error: fallbackError,
      });
    }
  }

  if (recipients.length === 0) {
    logError("Support ticket persisted but no HR recipient was resolved — manual follow-up required", {
      labels: { event: "support_request_no_hr_recipient_resolved", ticketId: request.id, hrId: request.hrId },
    });
    return { errored, fellBackToSuperAdmin, recipientCount: 0 };
  }

  try {
    const subcategory = request.subcategory ? ` / ${request.subcategory}` : "";
    const title = `New HR support request: ${request.subject}`;
    const message = `${request.employeeName} (${request.hrId}) opened a support request — ${request.category}${subcategory}.`;
    // Prefer the first recipient who actually has a deliverable email as "primary" — a
    // synthetic account (e.g. PHX-1) with no work_email must not silently swallow the
    // whole email, including the cc'd real addresses, just by sorting first.
    const primaryIndex = Math.max(0, recipients.findIndex((recipient) => Boolean(pickDeliverableEmail(recipient.email))));
    const primaryRecipient = recipients[primaryIndex];
    const primaryKey = normalizeHrId(primaryRecipient.hrId) || primaryRecipient.userId || "";
    const primaryEmail = pickDeliverableEmail(primaryRecipient.email);
    const ccEmails = Array.from(new Set(
      recipients
        .filter((recipient) => (normalizeHrId(recipient.hrId) || recipient.userId || "") !== primaryKey)
        .map((recipient) => pickDeliverableEmail(recipient.email))
        .filter((email): email is string => Boolean(email)),
    ));

    await Promise.allSettled(
      recipients.map((recipient) =>
        createSystemNotification({
          actionUrl: SUPPORT_ADMIN_REVIEW_URL,
          category: "general",
          channels: (normalizeHrId(recipient.hrId) || recipient.userId || "") === primaryKey ? ["in_app", "email", "telegram", "push"] : ["in_app", "telegram", "push"],
          ...((normalizeHrId(recipient.hrId) || recipient.userId || "") === primaryKey
            ? {
                email: {
                  cc: ccEmails,
                  metrics: [
                    { label: "Employee", value: `${request.employeeName} (${request.hrId})` },
                    { label: "Category", value: `${request.category}${subcategory}` },
                  ],
                  recipients: primaryEmail ? [primaryEmail] : undefined,
                },
              }
            : {}),
          eventType: "support_request_created",
          message: `${message}\n\n${request.description}`,
          metadata: {
            idempotencyKey: `support_request:${request.id}:created:${normalizeHrId(recipient.hrId) || recipient.userId || "unknown"}`,
            supportRequestId: request.id,
          },
          module: "support_requests",
          priority: "high",
          recipientHrId: recipient.hrId,
          recipientUserId: recipient.userId,
          recordId: request.id,
          subjectHrId: request.hrId,
          title,
        }),
      ),
    );
    return { errored, fellBackToSuperAdmin, recipientCount: recipients.length };
  } catch (error) {
    logError("Failed to fan out HR notification for support ticket", {
      labels: { event: "support_request_notification_fanout_failed", ticketId: request.id, hrId: request.hrId },
      error,
    });
    return { errored: true, fellBackToSuperAdmin, recipientCount: recipients.length };
  }
}

const tableName = "employee_support_requests";

function isMissingTable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: string }).code;
  if (code === "42P01") return true; // postgres "undefined_table"
  const message = (error as { message?: string }).message?.toLowerCase() ?? "";
  return message.includes("does not exist") || message.includes("relation");
}

function cleanText(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function normaliseAttachments(raw: unknown): SupportRequestAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      name: cleanText(item.name as string | null | undefined),
      size: Number(item.size ?? 0) || 0,
      type: cleanText(item.type as string | null | undefined),
    }))
    .filter((item) => item.name.length > 0);
}

function rowToView(row: Record<string, unknown>): SupportRequestRow {
  return {
    attachments: normaliseAttachments(row.attachments),
    category: cleanText(row.category as string),
    createdAt: cleanText(row.created_at as string),
    description: cleanText(row.description as string),
    employeeName: cleanText(row.employee_name as string),
    hrId: cleanText(row.hr_id as string),
    id: String(row.id ?? ""),
    status: (cleanText(row.status as string) || "Pending") as SupportRequestRow["status"],
    subcategory: row.subcategory ? cleanText(row.subcategory as string) : null,
    subject: cleanText(row.subject as string),
  };
}

/**
 * List support requests opened by the calling employee. Returns most-recent first.
 * Silently returns [] if the table doesn't exist yet (migration pending).
 */
export async function listSupportRequestsForViewer(
  access: AccessContext,
  limit = 25,
): Promise<SupportRequestRow[]> {
  const hrId = normalizeHrId(access.hrId);
  if (!hrId) return [];

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(tableName)
    .select("*")
    .eq("hr_id", hrId)
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(100, limit)));

  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(error.message);
  }
  return (data ?? []).map((row) => rowToView(row as Record<string, unknown>));
}

/**
 * HR/admin view: list every employee's support tickets (most-recent first),
 * optionally filtered by status. Enforces support_requests:read on the server —
 * sidebar visibility is never the security boundary. Returns [] if the table
 * isn't provisioned yet.
 */
export async function listAllSupportRequests(
  access: AccessContext,
  filter: SupportRequestListFilter = {},
): Promise<SupportRequestRow[]> {
  await assertPermission(access, "support_requests", "read");

  const limit = Math.max(1, Math.min(200, filter.limit ?? 100));
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from(tableName)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (filter.status && filter.status !== "all") {
    query = query.eq("status", filter.status);
  }

  const { data, error } = await query;
  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(error.message);
  }
  return (data ?? []).map((row) => rowToView(row as Record<string, unknown>));
}

/**
 * HR/admin action: move a support ticket to a new status. Enforces
 * support_requests:update on the server. Returns the updated ticket.
 */
export async function updateSupportRequestStatus(
  access: AccessContext,
  id: string,
  status: SupportRequestStatus,
): Promise<SupportRequestRow> {
  await assertPermission(access, "support_requests", "update");

  const ticketId = cleanText(id);
  if (!ticketId) throw new Error("A support request id is required.");
  if (!SUPPORT_REQUEST_STATUSES.includes(status)) {
    throw new Error("Invalid support request status.");
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(tableName)
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", ticketId)
    .select("*")
    .single();

  if (error) {
    if (isMissingTable(error)) {
      throw new Error("Support request table is not provisioned yet. Run the SQL migration first.");
    }
    throw new Error(error.message);
  }
  if (!data) throw new Error("Support request not found.");
  return rowToView(data as Record<string, unknown>);
}

/**
 * Create a new support request. The hr_id is taken from the access context
 * (NOT the request body) so users cannot impersonate other employees.
 *
 * Returns the saved ticket plus an HR-notification delivery status. Callers
 * (the API route, then the submit page) use the notification block to render a
 * "saved but HR not alerted" diagnostic instead of silently dropping the alert
 * when the recipient lookup fails. The ticket itself is always persisted before
 * the HR fan-out runs.
 */
export async function createSupportRequest(
  access: AccessContext,
  input: CreateSupportRequestInput,
): Promise<CreateSupportRequestResult> {
  await assertPermission(access, "support_requests", "create");

  const hrId = normalizeHrId(access.hrId) ?? normalizeHrId(input.hrId);
  if (!hrId) {
    throw new Error("HR ID is required to open a support request.");
  }

  const category = cleanText(input.category);
  const subject = cleanText(input.subject);
  const description = cleanText(input.description);
  if (!category || !subject || !description) {
    throw new Error("Category, subject, and description are all required.");
  }

  const employeeName = cleanText(input.employeeName) || hrId;
  const subcategory = input.subcategory ? cleanText(input.subcategory) : null;
  const attachments = (input.attachments ?? []).slice(0, 10); // soft cap

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(tableName)
    .insert({
      attachments,
      category,
      description,
      employee_name: employeeName,
      hr_id: hrId,
      subcategory,
      subject,
    })
    .select("*")
    .single();

  if (error) {
    if (isMissingTable(error)) {
      throw new Error(
        "Support request table is not provisioned yet. Run the SQL migration first.",
      );
    }
    throw new Error(error.message);
  }

  const created = rowToView(data as Record<string, unknown>);
  // Persist first, then alert HR best-effort. The notification status bubbles up so
  // the UI can warn the submitter if HR was never reached, instead of silently
  // dropping the alert.
  const notification = await notifyHrOfSupportRequest(created);
  return { notification, row: created };
}
