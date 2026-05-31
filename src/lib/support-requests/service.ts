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

import { normalizeHrId, type AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";

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
  return rowToView(data as Record<string, unknown>);
}
