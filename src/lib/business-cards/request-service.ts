/**
 * Employee business-card requests — server-side service.
 *
 * Persists requests opened from /employee-portals/business-cards to the
 * `public.business_card_requests` table, notifies the owner (B-10) and whoever
 * holds the HR Generalist seat by in-app + email + Telegram, and serves the
 * consolidated HR queue at /business-card-requests.
 *
 * Schema is in supabase/2026_business_card_requests.sql. If the table is missing
 * (migration not yet applied) the service degrades to a no-op empty list rather
 * than crashing the page.
 *
 * The card's title, line·area and email are resolved from the employee register
 * server-side — never from the request body — so the employee can only ever
 * correct the two lines they own (name and mobile). Nothing here writes back to
 * the `employees` record.
 */

import { assertPermission, hrIdsMatch, normalizeHrId, type AccessContext } from "@/lib/auth/permissions";
import { cardFieldsFor, CARD_FIELD_MAX_LENGTH } from "@/lib/business-cards/card-content";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { hrIdForStorage, hrIdLookupKeys } from "@/lib/hr-id";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { HR_GENERALIST_SEAT, onePerPerson, resolveSeatOrStandInHrIds } from "@/lib/notifications/vacant-seat";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  BUSINESS_CARD_REQUEST_STATUSES,
  type BusinessCardRequestListFilter,
  type BusinessCardRequestNotificationStatus,
  type BusinessCardRequestRow,
  type BusinessCardRequestStatus,
  type CreateBusinessCardRequestInput,
  type CreateBusinessCardRequestResult,
  type OwnBusinessCard,
} from "@/lib/business-cards/request-types";

// Re-exported for existing consumers (API routes, pages). The canonical definitions
// live in request-types.ts, a dependency-free sibling the client components import
// directly so they never pull this file's server-only chain into the browser bundle.
export { BUSINESS_CARD_REQUEST_STATUSES };
export type {
  BusinessCardRequestListFilter,
  BusinessCardRequestNotificationStatus,
  BusinessCardRequestRow,
  BusinessCardRequestStatus,
  CreateBusinessCardRequestInput,
  CreateBusinessCardRequestResult,
  OwnBusinessCard,
};

const tableName = "business_card_requests";

// Who every business-card request is announced to. Owner, 2026-09-30: himself and the HR
// Generalist of the day, by name. Owner, 2026-10-20, when she moved to her own seat: "Both to you
// until the hire" — so the second recipient is now the SEAT, resolved at send time, and while it is
// empty its stand-in is the Super Admin (src/lib/notifications/vacant-seat.ts), who is the owner
// already on this list; the two collapse into one copy. A named HR id strands the notice the day the
// chair changes hands, which is exactly what happened here.
const BUSINESS_CARD_REQUEST_OWNER_HR_ID = "B-10";
const BUSINESS_CARD_REQUEST_SEAT = HR_GENERALIST_SEAT;

/**
 * The people a request is announced to: the owner and the seat's people, each person once (the
 * console login PHX-1 is B-10), minus the requester. Pure — the seat is resolved by the caller.
 * A seat that could not be read leaves the owner's copy standing on its own.
 */
export function businessCardRequestRecipients(
  seatHrIds: readonly string[],
  requesterHrId: string,
): string[] {
  return onePerPerson([BUSINESS_CARD_REQUEST_OWNER_HR_ID, ...seatHrIds]).filter(
    (hrId) => !hrIdsMatch(hrId, requesterHrId),
  );
}

const BUSINESS_CARD_ADMIN_URL = "/admin/business-card-requests";

function isMissingTable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: string }).code;
  if (code === "42P01") return true; // postgres "undefined_table"
  const message = (error as { message?: string }).message?.toLowerCase() ?? "";
  return message.includes("does not exist") || message.includes("relation");
}

function clean(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** Trim, collapse whitespace and cap at the card's own line length. */
function cleanLine(value: string | null | undefined): string {
  return clean(value).slice(0, CARD_FIELD_MAX_LENGTH);
}

function rowToView(row: Record<string, unknown>): BusinessCardRequestRow {
  return {
    cardEmail: clean(row.card_email as string),
    cardLineArea: clean(row.card_line_area as string),
    cardMobile: clean(row.card_mobile as string),
    cardName: clean(row.card_name as string),
    cardTitle: clean(row.card_title as string),
    createdAt: clean(row.created_at as string),
    employeeName: clean(row.employee_name as string),
    hrId: clean(row.hr_id as string),
    id: String(row.id ?? ""),
    note: row.note ? clean(row.note as string) : null,
    status: (clean(row.status as string) || "Pending") as BusinessCardRequestStatus,
  };
}

/**
 * The card the signed-in employee should see and edit — their name, job title,
 * line·area, mobile and email as the printed card would render them, taken from the
 * employee register. Returns null when the caller has no directory row.
 */
export async function getOwnBusinessCard(access: AccessContext): Promise<OwnBusinessCard | null> {
  const hrId = normalizeHrId(access.hrId);
  if (!hrId) return null;

  const rows = await getEmployeeDirectoryRows({ includeInactive: true });
  const me = rows.find((row) => hrIdsMatch(row.hrId, hrId));
  if (!me) return null;

  return cardFieldsFor({
    areaName: me.areaName,
    displayName: me.displayName || me.fullName,
    jobTitle: me.jobTitle,
    lineName: me.lineName,
    mobileNumber: me.mobileNumber,
    workEmail: me.workEmail,
  });
}

/**
 * List the requests opened by the calling employee (most-recent first). No permission
 * assertion — it is scoped to the caller's own hr_id, exactly like the support-request
 * viewer list. Returns [] if the table isn't provisioned yet.
 *
 * MATCHED ON EVERY SPELLING, never a bare `.eq` on one. `access.hrId` is the lowercase COMPARISON
 * key (`canonicalHrIdKey`), while `hr_id` is now PERSISTED uppercase like every other actor column
 * (see `hrIdForStorage` in src/lib/hr-id.ts) — so a single `.eq` would read nothing at all rather
 * than something wrong, and would also strand any row written before that fix.
 */
export async function listBusinessCardRequestsForViewer(
  access: AccessContext,
  limit = 25,
): Promise<BusinessCardRequestRow[]> {
  const keys = hrIdLookupKeys(access.hrId);
  if (keys.length === 0) return [];

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(tableName)
    .select("*")
    .in("hr_id", keys)
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(100, limit)));

  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(error.message);
  }
  return (data ?? []).map((row) => rowToView(row as Record<string, unknown>));
}

/**
 * HR/admin view: every employee's business-card request (most-recent first), optionally
 * filtered by status. Enforces business_card_requests:read on the server — sidebar
 * visibility is never the security boundary. Returns [] if the table isn't provisioned.
 */
export async function listAllBusinessCardRequests(
  access: AccessContext,
  filter: BusinessCardRequestListFilter = {},
): Promise<BusinessCardRequestRow[]> {
  await assertPermission(access, "business_card_requests", "read");

  const limit = Math.max(1, Math.min(500, filter.limit ?? 200));
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
 * HR/admin action: move a request to a new status. Enforces
 * business_card_requests:update on the server. Returns the updated row.
 */
export async function updateBusinessCardRequestStatus(
  access: AccessContext,
  id: string,
  status: BusinessCardRequestStatus,
): Promise<BusinessCardRequestRow> {
  await assertPermission(access, "business_card_requests", "update");

  const requestId = clean(id);
  if (!requestId) throw new Error("A business card request id is required.");
  if (!BUSINESS_CARD_REQUEST_STATUSES.includes(status)) {
    throw new Error("Invalid business card request status.");
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(tableName)
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", requestId)
    .select("*")
    .single();

  if (error) {
    if (isMissingTable(error)) {
      throw new Error("Business card requests table is not provisioned yet. Run the SQL migration first.");
    }
    throw new Error(error.message);
  }
  if (!data) throw new Error("Business card request not found.");
  return rowToView(data as Record<string, unknown>);
}

/**
 * Alert the owner (B-10) and the HR Generalist seat that an employee asked for
 * business cards — in-app + email + Telegram. Best-effort: any failure here must
 * never prevent the request from being saved. Email is consolidated into ONE
 * envelope (primary To + cc), and no `email` block is passed so each recipient's
 * own work address resolves rather than the shared HR inbox standing in.
 */
async function notifyBusinessCardRecipients(
  request: BusinessCardRequestRow,
): Promise<BusinessCardRequestNotificationStatus> {
  const seat = await resolveSeatOrStandInHrIds(BUSINESS_CARD_REQUEST_SEAT, "Business card request recipients");
  const recipients = businessCardRequestRecipients(seat.hrIds, request.hrId);
  if (recipients.length === 0) {
    return { errored: false, recipientCount: 0 };
  }

  const lines = [
    `${request.employeeName} (${request.hrId}) requested printed business cards.`,
    `Name: ${request.cardName || "—"}`,
    `Mobile: ${request.cardMobile || "—"}`,
    `Job title: ${request.cardTitle || "—"}`,
    `Line · Area: ${request.cardLineArea || "—"}`,
  ];
  if (request.note) lines.push(`Note: ${request.note}`);

  try {
    await createSystemNotificationForRecipients(
      {
        actionUrl: BUSINESS_CARD_ADMIN_URL,
        category: "general",
        channels: ["in_app", "email", "telegram"],
        eventType: "business_card_request_created",
        message: lines.join("\n"),
        metadata: {
          businessCardRequestId: request.id,
          idempotencyKey: `business_card_request:${request.id}:created`,
        },
        module: "business_card_requests",
        priority: "normal",
        recordId: request.id,
        subjectHrId: request.hrId,
        title: `New business card request: ${request.employeeName}`,
      },
      [...recipients],
    );
    return { errored: false, recipientCount: recipients.length };
  } catch (error) {
    logError("Failed to notify HR of a business card request", {
      labels: { event: "business_card_request_notification_failed", requestId: request.id, hrId: request.hrId },
      error,
    });
    return { errored: true, recipientCount: recipients.length };
  }
}

/**
 * Create a business-card request. The hr_id comes from the access context (never the
 * body). The employee may correct only the name and mobile; the title, line·area and
 * email are resolved from the register here, so a request can never carry an email the
 * employee typed. The request is persisted before the HR notification fans out.
 */
export async function createBusinessCardRequest(
  access: AccessContext,
  input: CreateBusinessCardRequestInput,
): Promise<CreateBusinessCardRequestResult> {
  await assertPermission(access, "business_card_requests", "create");

  const hrId = normalizeHrId(access.hrId);
  if (!hrId) {
    throw new Error("HR ID is required to request a business card.");
  }
  // THE FORM THE ID IS STORED IN — uppercase, never the lowercase comparison key. `access.hrId` is
  // `canonicalHrIdKey`, which is right for matching and wrong for persisting: writing it is what left
  // ~37,000 lowercase actor ids across 52 columns (src/lib/hr-id.ts). This table was written with the
  // comparison key, so the first request ever sent would have stored `ph-0123` where `employees.hr_id`
  // holds `PH-0123`, and any exact-match join to the register would have found nothing at all.
  const storedHrId = hrIdForStorage(access.hrId);

  // Resolve the register-owned lines server-side; the employee never sets these.
  const own = await getOwnBusinessCard(access);
  if (!own) {
    throw new Error("Your employee record could not be found, so a card cannot be prepared.");
  }

  const cardName = cleanLine(input.cardName) || own.name;
  if (!cardName) {
    throw new Error("A name is required on the card.");
  }
  const cardMobile = cleanLine(input.cardMobile);
  const note = input.note ? clean(input.note).slice(0, 500) : null;
  const employeeName = own.name || storedHrId || hrId;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(tableName)
    .insert({
      card_email: own.email || null,
      card_line_area: own.lineArea || null,
      card_mobile: cardMobile || null,
      card_name: cardName,
      card_title: own.title || null,
      employee_name: employeeName,
      hr_id: storedHrId,
      note,
    })
    .select("*")
    .single();

  if (error) {
    if (isMissingTable(error)) {
      throw new Error("Business card requests table is not provisioned yet. Run the SQL migration first.");
    }
    throw new Error(error.message);
  }

  const created = rowToView(data as Record<string, unknown>);
  // Persist first, then alert HR best-effort. The notification status bubbles up so the
  // UI can warn the employee if HR was never reached, instead of silently dropping it.
  const notification = await notifyBusinessCardRecipients(created);
  return { notification, row: created };
}
