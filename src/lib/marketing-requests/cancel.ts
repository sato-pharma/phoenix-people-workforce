import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { resolveCanonicalActorHrId } from "@/lib/auth/canonical-actor";
import { resolveEmployeeIdentityId, type AccessContext, type PhoenixRole } from "@/lib/auth/permissions";
import { bumpCustomer360Cache } from "@/lib/cache/namespaces";
import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import type { MarketingRequestStatus } from "@/lib/marketing-requests/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Cancel — call off a marketing request that entered the chain but is no longer wanted.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * `cancelled` became a real status on 2026-09-22 (#4237) because the owner needed to call off an
 * approved, finance-executed request (`MKT-REQ-20260825-AADD59CE`) and the column could not store
 * the word — it was parked in `archived` as a stand-in, and the status itself was flipped by hand
 * in the database. A capability reachable only through hand-written SQL is indistinguishable from
 * one that does not exist, which is the lesson the finance-hold and reopen controls both record.
 * This module is what a human may DO about it, from the Case File.
 *
 * ── WHAT CANCELLING MEANS, AND WHAT IT DOES NOT ──────────────────────────────
 * A cancelled request is terminal and its money is NEVER committed — it is excluded from
 * `approvedMarketingRequestStatuses`, and its ROI lifecycle stage stays `cancelled` even with a pay
 * date (both pinned since #4237). So this reverses nothing that was paid and moves no money on its
 * own: it records that the request was deliberately abandoned, and the overdue/committed surfaces
 * stop counting it. If money actually changed hands, that reversal happens on the finance screen —
 * this only sets the state.
 *
 * ── WHO MAY DO IT ────────────────────────────────────────────────────────────
 * Super Admin only, with NO `scope === "system"` bypass — the same choice `reopen-rule.ts` makes
 * and for the same reason: calling off a request that a human raised and approvers acted on must
 * never be something an automated, system-scoped caller can do. `finance_hold` allows a scope
 * bypass because a hold merely pauses; cancelling ends. The owner reverses from his Super Admin
 * identity (`B-10`).
 */

/**
 * The statuses a request may be cancelled FROM.
 *
 * A live request that entered the workflow but is not already finished:
 *   * `draft` is EXCLUDED — it never entered the chain, so it is abandoned by deletion, not called
 *     off. There is nothing recorded to cancel.
 *   * `rejected`, `closed`, `archived`, `cancelled` are EXCLUDED — each is already terminal.
 *     Reopening a refusal is a separate control; a settled or filed record is not re-decided here.
 *
 * A set of the allowed states rather than a negation, so a future thirteenth status is not silently
 * assumed cancellable.
 */
export const marketingCancellableStatuses: ReadonlySet<string> = new Set([
  "pending_validation",
  "pending_approval",
  "returned",
  "approved",
  "active",
  "roi_tracking",
  "finance_hold",
]);

/**
 * Cancelling is a Super Admin action. No scope bypass — see the module header.
 *
 * Kept as its own predicate, imported by both `buildViewer` (which decides whether the control is
 * drawn) and the write below (which refuses), so the affordance and the enforcement can never
 * disagree about who may press it — the split `reopen-rule.ts` exists to guarantee.
 */
export function viewerMayCancelMarketingRequests(role: PhoenixRole): boolean {
  return role === "Super Admin";
}

export function isMarketingRequestCancellable(
  status: MarketingRequestStatus | string | null | undefined,
): boolean {
  return marketingCancellableStatuses.has(String(status ?? "").trim().toLowerCase());
}

/** The affordance the Case File draws its control from. Both halves must hold. */
export function canCancelMarketingRequest(params: {
  role: PhoenixRole;
  status: MarketingRequestStatus | string | null | undefined;
}): boolean {
  return viewerMayCancelMarketingRequests(params.role) && isMarketingRequestCancellable(params.status);
}

export const MARKETING_CANCELLED_STATUS = "cancelled";

type CancelTarget = {
  requestCode: string | null;
  requestId: string;
  status: string;
};

async function loadCancelTarget(requestId: string): Promise<CancelTarget> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("marketing_requests")
    .select("id, request_code, status")
    .eq("id", requestId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw notFoundError("Marketing request was not found.", "marketing_request_not_found");
  const request = data as { id: string; request_code: string | null; status: string };
  return { requestCode: request.request_code, requestId: request.id, status: request.status };
}

/**
 * The actor written to `updated_by_hr_id` must be the hr_id AS STORED, not the normalized key.
 *
 * That column is a foreign key to `employees(hr_id)`, which is MIXED CASE in production, and one of
 * the two Super Admins is the shared `admin-HR` login whose `hr_id` is NULL. `resolveEmployeeIdentityId`
 * lowercases, so writing its result matched nobody and the database refused the write — the exact
 * `23503 ... Key (…)=(b-10) is not present` that made the finance hold reachable by nobody until it
 * was fixed there. `resolveCanonicalActorHrId` is the repo's single answer and also maps a login
 * token to the real employee behind it.
 */
async function resolveCancelActor(access: AccessContext): Promise<string> {
  const identity = resolveEmployeeIdentityId(access);
  if (!identity) {
    throw forbiddenError("Forbidden: a linked Phoenix HR identity is required to cancel a marketing request.");
  }
  return resolveCanonicalActorHrId(String(access.hrId ?? access.loginId ?? identity));
}

/**
 * Call off a marketing request.
 *
 * The status flip is a compare-and-set against the status read here (inside
 * `phx_cancel_marketing_request`, under the request's row lock): two admins acting on the same
 * request would otherwise both "succeed", and the second would overwrite the first. It
 * stamps `updated_by_hr_id` and `updated_at`, which is what makes the `AFTER UPDATE`
 * `phx_capture_marketing_request_event` trigger record WHO cancelled it and from which state — the
 * timeline entry is automatic, exactly as it is for a finance hold. The reason is written to the
 * audit log, the durable record of why an in-flight request was abandoned.
 */
export async function cancelMarketingRequest(params: {
  access: AccessContext;
  reason: string;
  requestId: string;
}): Promise<{ requestCode: string | null; requestId: string; status: string }> {
  if (!viewerMayCancelMarketingRequests(params.access.role)) {
    throw forbiddenError(`Forbidden: ${params.access.role} cannot cancel a marketing request.`);
  }

  const requestId = String(params.requestId ?? "").trim();
  if (!requestId) throw validationError("Marketing request ID is required.");
  const reason = String(params.reason ?? "").trim();
  if (!reason) {
    throw validationError(
      "A reason is required to cancel a marketing request.",
      "marketing_cancel_reason_required",
    );
  }

  const actorHrId = await resolveCancelActor(params.access);
  const request = await loadCancelTarget(requestId);
  if (!isMarketingRequestCancellable(request.status)) {
    throw conflictError(
      `A request with status "${request.status}" cannot be cancelled.`,
      "marketing_cancel_not_allowed",
    );
  }

  // ONE transaction (F-MKT-006): phx_cancel_marketing_request locks the request, compare-and-sets its
  // status against the one read above, flips it to `cancelled` and closes every approval rung still
  // `current` or `pending` as `skipped` — the status a reject already gives the rungs it ends. A
  // cancel that left its `current` rung open let that approver decide it afterwards, and the decision
  // wrote the cancelled request back to approved or rejected. phx_decide_marketing_request_step now
  // also refuses any request that is no longer `pending_approval`, under the same lock, so the two
  // guards hold each other up.
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { data, error } = await supabase.rpc("phx_cancel_marketing_request", {
    p_actor_hr_id: actorHrId,
    p_cancelled_at: now,
    p_expected_status: request.status,
    p_request_id: requestId,
  });
  if (error) {
    const text = String(error.message ?? "");
    if (text.includes("marketing_cancel_conflict")) {
      throw conflictError(
        "The request changed status while it was being cancelled. Reload and try again.",
        "marketing_cancel_conflict",
      );
    }
    if (text.includes("marketing_request_not_found")) {
      throw notFoundError("Marketing request was not found.", "marketing_request_not_found");
    }
    throw error;
  }
  const closedApprovalSteps = Number((data as { closedSteps?: number } | null)?.closedSteps ?? 0);

  await writeRequiredAuditLog({
    actorLoginId: params.access.loginId ?? params.access.hrId,
    entityId: requestId,
    entityType: "marketing_request",
    newValues: { status: MARKETING_CANCELLED_STATUS, closedApprovalSteps },
    oldValues: { status: request.status },
    summary:
      `Marketing request ${request.requestCode ?? requestId} cancelled `
      + `(was "${request.status}"). Reason: ${reason}`,
  });

  bumpCustomer360Cache("marketing request cancelled");
  return { requestCode: request.requestCode, requestId, status: MARKETING_CANCELLED_STATUS };
}
