/**
 * Employee HR support requests — server-side service.
 *
 * Persists tickets opened from /employee-portals/contact-hr-support to the
 * `public.employee_support_requests` table. Returns viewer-scoped lists.
 *
 * Schema is in supabase/2026_employee_support_requests.sql. If the table
 * is missing (migration not yet applied) the service degrades to a no-op
 * empty list rather than crashing the page.
 */

import { assertPermission, normalizeHrId, type AccessContext } from "@/lib/auth/permissions";
import { pickDeliverableEmail } from "@/lib/email/email-safety";
import { createSystemNotification } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const SUPPORT_REQUEST_STATUSES = ["Pending", "In Progress", "Resolved", "Closed"] as const;
export type SupportRequestStatus = (typeof SUPPORT_REQUEST_STATUSES)[number];

const SUPPORT_ADMIN_REVIEW_URL = "/admin/notifications";

type HrRecipient = { email: string | null; hrId: string | null; userId: string | null };

function sameHrId(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = normalizeHrId(left);
  const b = normalizeHrId(right);
  return Boolean(a) && a === b;
}

/**
 * Resolve the HR team that should be alerted when an employee opens a support
 * ticket: every Super Admin / HR Specialist account, plus any employee whose title
 * marks them as an HR Manager / Admin HR. Best-effort — a failed lookup returns an
 * empty list so a ticket is never blocked from being saved.
 */
async function resolveHrSupportRecipients(): Promise<HrRecipient[]> {
  const supabase = getSupabaseAdmin();
  try {
    const { data: authRows } = await supabase
      .from("app_auth_users")
      .select("login_id,hr_id,role,auth_email")
      .in("role", ["HR Specialist", "Super Admin"]);
    const { data: employees } = await supabase
      .from("employees")
      .select("hr_id,job_title,position_title,work_email");

    const employeeByHrId = new Map(
      ((employees ?? []) as Array<{ hr_id?: string | null; job_title?: string | null; position_title?: string | null; work_email?: string | null }>)
        .map((row) => [normalizeHrId(row.hr_id), row] as const)
        .filter((entry): entry is [string, { hr_id?: string | null; job_title?: string | null; position_title?: string | null; work_email?: string | null }] => Boolean(entry[0])),
    );

    const hrTitledIds = new Set(
      Array.from(employeeByHrId.values())
        .filter((row) => /HR Manager|Admin HR/i.test(`${row.job_title ?? ""} ${row.position_title ?? ""}`))
        .map((row) => normalizeHrId(row.hr_id))
        .filter((hrId): hrId is string => Boolean(hrId)),
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
    for (const hrId of hrTitledIds) {
      if (!recipients.some((recipient) => sameHrId(recipient.hrId, hrId))) {
        recipients.push({ email: pickDeliverableEmail(employeeByHrId.get(hrId)?.work_email), hrId, userId: null });
      }
    }
    return recipients;
  } catch (error) {
    console.error("Failed to resolve HR support recipients", error);
    return [];
  }
}

/**
 * Alert the HR team (in-app + email + Telegram) that a new support ticket was opened.
 * Best-effort and fully isolated: any failure here must never prevent the ticket from
 * being persisted or surface as an error to the submitting employee.
 */
async function notifyHrOfSupportRequest(request: SupportRequestRow): Promise<void> {
  try {
    const recipients = (await resolveHrSupportRecipients())
      .filter((recipient) => !sameHrId(recipient.hrId, request.hrId));
    if (recipients.length === 0) return;

    const subcategory = request.subcategory ? ` / ${request.subcategory}` : "";
    const title = `New HR support request: ${request.subject}`;
    const message = `${request.employeeName} (${request.hrId}) opened a support request — ${request.category}${subcategory}.`;
    const primaryRecipient = recipients[0];
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
          channels: (normalizeHrId(recipient.hrId) || recipient.userId || "") === primaryKey ? ["in_app", "email", "telegram"] : ["in_app", "telegram"],
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
  } catch (error) {
    console.error("Failed to notify HR of support request", error);
  }
}

export type SupportRequestAttachment = {
  name: string;
  size: number;
  type: string;
};

export type SupportRequestRow = {
  attachments: SupportRequestAttachment[];
  category: string;
  createdAt: string;
  description: string;
  employeeName: string;
  hrId: string;
  id: string;
  status: "Pending" | "In Progress" | "Resolved" | "Closed";
  subcategory: string | null;
  subject: string;
};

export type CreateSupportRequestInput = {
  attachments?: SupportRequestAttachment[];
  category: string;
  description: string;
  employeeName: string;
  hrId: string;
  subcategory?: string | null;
  subject: string;
};

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

export type SupportRequestListFilter = {
  limit?: number;
  status?: SupportRequestStatus | "all";
};

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
 */
export async function createSupportRequest(
  access: AccessContext,
  input: CreateSupportRequestInput,
): Promise<SupportRequestRow> {
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
  // Best-effort: alert the HR team. Never let a notification failure break ticket creation.
  await notifyHrOfSupportRequest(created);
  return created;
}
