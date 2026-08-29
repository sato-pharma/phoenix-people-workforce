import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { resolveEmployeeIdentityId, type AccessContext } from "@/lib/auth/permissions";
import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Finance hold — the status the lifecycle declared for three months and could never enter.
 *
 * `marketing_requests.status` permits `finance_hold`, five screens carry a label for it, and
 * `approvedMarketingRequestStatuses` counts it as approved. Nothing anywhere could WRITE it:
 * measured in production 2026-08-29, zero rows had ever held it, and the rebuild spec had left it
 * out deliberately — "whether the module should have a settlement lifecycle at all is the one
 * genuine business question".
 *
 * #2680 answered the part that made it decidable. It created the first invoice obligations that had
 * ever existed (4, one already 18 days late), so "approved, money committed, invoice not delivered"
 * became a real detectable condition rather than a hypothetical one.
 *
 * The owner's rule for what to do with it, 2026-08-29, is the same rule expenses run under: the
 * system FLAGS, a human decides. So nothing here moves a request on its own. `classify` and
 * `loadMarketingFinanceHoldQueue` only ever REPORT that an invoice is late; the status changes only
 * when a Super Admin places the hold by hand, and only back when he releases it. Do not add a cron,
 * a trigger, or an "auto-hold once overdue" convenience — that is precisely the shape he rejected.
 */
export const MARKETING_FINANCE_HOLD_STATUS = "finance_hold";

/**
 * The statuses a request may be held FROM, and the ones it may be released back TO.
 *
 * Only states that mean "approved and the money is committed". A rejected or archived request has
 * no obligation to hold, and holding a `closed` one would reopen a settled record.
 */
export const marketingFinanceHoldableStatuses: ReadonlySet<string> = new Set(["approved", "active"]);

/**
 * Invoice states that mean the invoice is still OWED.
 *
 * `submitted` and `cleared` are delivered; `not_required` was never owed. Deliberately a set of the
 * outstanding states rather than `!== "submitted"`: the vocabulary has six values, and a negation
 * would silently treat a future seventh as outstanding and hold requests over it.
 */
const outstandingInvoiceStatuses: ReadonlySet<string> = new Set(["pending", "overdue"]);

export function canPlaceMarketingRequestOnFinanceHold(status: string | null | undefined): boolean {
  return marketingFinanceHoldableStatuses.has(String(status ?? "").trim().toLowerCase());
}

export function canReleaseMarketingRequestFromFinanceHold(status: string | null | undefined): boolean {
  return String(status ?? "").trim().toLowerCase() === MARKETING_FINANCE_HOLD_STATUS;
}

export type MarketingInvoiceOverdue = { daysOverdue: number };

/**
 * Pure: is this request's invoice late, and by how many days?
 *
 * Both dates are YYYY-MM-DD in Africa/Cairo and `today` is a parameter, never `new Date()`, so the
 * rule is testable without a database and cannot drift with the runtime's timezone. Same shape as
 * `classifyMarketingSla`.
 *
 * Returns null — not `{ daysOverdue: 0 }` — when nothing is owed, so a caller cannot accidentally
 * treat "not late" as a falsy-but-present overdue record.
 */
export function classifyMarketingInvoiceOverdue(input: {
  invoiceDeadlineDate: string | null | undefined;
  invoiceRequired: boolean | null | undefined;
  invoiceStatus: string | null | undefined;
  today: string;
}): MarketingInvoiceOverdue | null {
  if (!input.invoiceRequired) return null;
  if (!outstandingInvoiceStatuses.has(String(input.invoiceStatus ?? "").trim().toLowerCase())) return null;

  const deadline = Date.parse(`${String(input.invoiceDeadlineDate ?? "").trim()}T00:00:00Z`);
  const today = Date.parse(`${String(input.today ?? "").trim()}T00:00:00Z`);
  if (!Number.isFinite(deadline) || !Number.isFinite(today)) return null;

  const daysOverdue = Math.round((today - deadline) / 86_400_000);
  return daysOverdue > 0 ? { daysOverdue } : null;
}

/**
 * Placing or releasing a hold is a Super Admin action.
 *
 * The owner's answer 2026-08-29 named exactly this role. Finance Manager is the terminal
 * `finance_execution` rung and attaches the transfer proof, so he is the obvious candidate to widen
 * this to later — but widening a grant on a money module is a decision to take, not one to assume,
 * so this stays where the owner put it.
 */
function assertMarketingFinanceHoldAccess(access: AccessContext) {
  if (access.role !== "Super Admin" && access.scope !== "system") {
    throw forbiddenError(`Forbidden: ${access.role} cannot place or release a marketing finance hold.`);
  }
}

function assertHoldActor(access: AccessContext): string {
  const actorHrId = resolveEmployeeIdentityId(access);
  if (!actorHrId) {
    throw validationError("A linked HR ID is required to place or release a finance hold.", "missing_actor_hr_id");
  }
  return actorHrId;
}

export type MarketingFinanceHoldCandidate = {
  approvedAt: string | null;
  daysOverdue: number;
  invoiceDeadlineDate: string | null;
  onHold: boolean;
  requestCode: string | null;
  requestId: string;
  status: string;
};

/**
 * The flag: approved requests whose invoice is late, plus the ones already held.
 *
 * Read-only by construction. Requests already on `finance_hold` are included so the queue is the
 * whole picture the admin acts on — holding and releasing are decided from the same list.
 */
export async function loadMarketingFinanceHoldQueue(input: {
  access: AccessContext;
  today: string;
}): Promise<MarketingFinanceHoldCandidate[]> {
  assertMarketingFinanceHoldAccess(input.access);

  const supabase = getSupabaseAdmin();
  const statuses = [...marketingFinanceHoldableStatuses, MARKETING_FINANCE_HOLD_STATUS];
  const { data, error } = await supabase
    .from("marketing_requests")
    .select("id, request_code, status, approved_at")
    .in("status", statuses);
  if (error) throw error;

  const rows = (data ?? []) as Array<{
    approved_at?: string | null;
    id?: string | null;
    request_code?: string | null;
    status?: string | null;
  }>;
  const requestIds = rows.map((row) => String(row.id ?? "")).filter(Boolean);
  if (requestIds.length === 0) return [];

  const finance = await supabase
    .from("marketing_request_finance_requirements")
    .select("request_id, invoice_required, invoice_status, invoice_deadline_date")
    .in("request_id", requestIds);
  if (finance.error) throw finance.error;

  const obligationByRequestId = new Map(
    ((finance.data ?? []) as Array<{
      invoice_deadline_date?: string | null;
      invoice_required?: boolean | null;
      invoice_status?: string | null;
      request_id?: string | null;
    }>).map((row) => [String(row.request_id ?? ""), row]),
  );

  const candidates: MarketingFinanceHoldCandidate[] = [];
  for (const row of rows) {
    const requestId = String(row.id ?? "");
    if (!requestId) continue;
    const status = String(row.status ?? "").trim().toLowerCase();
    const obligation = obligationByRequestId.get(requestId);
    const overdue = classifyMarketingInvoiceOverdue({
      invoiceDeadlineDate: obligation?.invoice_deadline_date ?? null,
      invoiceRequired: obligation?.invoice_required ?? false,
      invoiceStatus: obligation?.invoice_status ?? null,
      today: input.today,
    });
    const onHold = status === MARKETING_FINANCE_HOLD_STATUS;
    if (!overdue && !onHold) continue;
    candidates.push({
      approvedAt: row.approved_at ?? null,
      daysOverdue: overdue?.daysOverdue ?? 0,
      invoiceDeadlineDate: obligation?.invoice_deadline_date ?? null,
      onHold,
      requestCode: row.request_code ?? null,
      requestId,
      status,
    });
  }

  candidates.sort((a, b) => b.daysOverdue - a.daysOverdue);
  return candidates;
}

async function loadRequestForHold(requestId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("marketing_requests")
    .select("id, request_code, status")
    .eq("id", requestId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw notFoundError("Marketing request was not found.", "request_not_found");
  return data as { id: string; request_code: string | null; status: string };
}

/**
 * Write the REASON before the status, never the other way round.
 *
 * A Supabase client request that times out at 15s still commits, so a two-write mutation can
 * half-apply with no error. Ordered this way the only reachable half-state is a recorded reason on
 * a request that was never held — inert, and visible. The reverse order would leave a request held
 * with nobody able to say why, on a module that commits real money.
 */
async function recordHoldReason(input: {
  actorHrId: string;
  reason: string;
  requestId: string;
}) {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("marketing_request_finance_requirements")
    .update({
      finance_reviewer_hr_id: input.actorHrId,
      notes: input.reason,
      reviewed_at: now,
      updated_at: now,
    })
    .eq("request_id", input.requestId);
  if (error) throw error;
}

/**
 * Flip the status, attributing it so `phx_capture_marketing_request_event` records WHO.
 *
 * That AFTER UPDATE trigger writes the `request_status_changed` event itself — actor, from, to and
 * occurred_at — reading `updated_by_hr_id` and `updated_at` off the new row. So the audit trail is
 * automatic here, and stamping those two columns is what makes it truthful rather than anonymous.
 *
 * The `.eq("status", expectedCurrentStatus)` is a compare-and-set, not decoration: two admins acting
 * on the same queue would otherwise both "succeed", and the second would silently overwrite the
 * first's decision.
 */
async function applyHoldStatus(input: {
  actorHrId: string;
  expectedCurrentStatus: string;
  nextStatus: string;
  requestId: string;
}) {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("marketing_requests")
    .update({ status: input.nextStatus, updated_at: now, updated_by_hr_id: input.actorHrId })
    .eq("id", input.requestId)
    .eq("status", input.expectedCurrentStatus)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw conflictError(
      "The request changed status while this hold was being applied. Reload and try again.",
      "marketing_finance_hold_conflict",
    );
  }
}

export async function placeMarketingRequestOnFinanceHold(params: {
  access: AccessContext;
  reason: string;
  requestId: string;
}): Promise<{ requestCode: string | null; requestId: string; status: string }> {
  assertMarketingFinanceHoldAccess(params.access);
  const actorHrId = assertHoldActor(params.access);

  const requestId = String(params.requestId ?? "").trim();
  if (!requestId) throw validationError("Request ID is required.");
  const reason = String(params.reason ?? "").trim();
  if (!reason) throw validationError("A reason is required to place a finance hold.", "missing_hold_reason");

  const request = await loadRequestForHold(requestId);
  if (!canPlaceMarketingRequestOnFinanceHold(request.status)) {
    throw conflictError(
      `A request with status "${request.status}" cannot be placed on finance hold.`,
      "marketing_finance_hold_not_allowed",
    );
  }

  await recordHoldReason({ actorHrId, reason, requestId });
  await applyHoldStatus({
    actorHrId,
    expectedCurrentStatus: request.status,
    nextStatus: MARKETING_FINANCE_HOLD_STATUS,
    requestId,
  });

  await writeRequiredAuditLog({
    actorLoginId: params.access.loginId ?? params.access.hrId,
    entityId: requestId,
    entityType: "marketing_request",
    newValues: { status: MARKETING_FINANCE_HOLD_STATUS },
    oldValues: { status: request.status },
    summary:
      `Marketing request ${request.request_code ?? requestId} placed on finance hold `
      + `(was "${request.status}"). Reason: ${reason}`,
  });

  return { requestCode: request.request_code, requestId, status: MARKETING_FINANCE_HOLD_STATUS };
}

/**
 * Where a release puts the request back.
 *
 * The event log is the source of truth: the trigger recorded `from_status` when the hold was
 * applied, so the exact prior state is recoverable rather than guessed. `approved` is the fallback
 * when no such event exists — the base approved state, and never one that skips work.
 */
export async function resolveMarketingFinanceHoldReleaseStatus(requestId: string): Promise<string> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("marketing_request_events")
    .select("from_status, occurred_at")
    .eq("request_id", requestId)
    .eq("to_status", MARKETING_FINANCE_HOLD_STATUS)
    .order("occurred_at", { ascending: false })
    .limit(1);
  if (error) throw error;

  const priorStatus = String((data ?? [])[0]?.from_status ?? "").trim().toLowerCase();
  return canPlaceMarketingRequestOnFinanceHold(priorStatus) ? priorStatus : "approved";
}

export async function releaseMarketingRequestFromFinanceHold(params: {
  access: AccessContext;
  reason: string;
  requestId: string;
}): Promise<{ requestCode: string | null; requestId: string; status: string }> {
  assertMarketingFinanceHoldAccess(params.access);
  const actorHrId = assertHoldActor(params.access);

  const requestId = String(params.requestId ?? "").trim();
  if (!requestId) throw validationError("Request ID is required.");
  const reason = String(params.reason ?? "").trim();
  if (!reason) throw validationError("A reason is required to release a finance hold.", "missing_release_reason");

  const request = await loadRequestForHold(requestId);
  if (!canReleaseMarketingRequestFromFinanceHold(request.status)) {
    throw conflictError(
      `A request with status "${request.status}" is not on finance hold.`,
      "marketing_finance_hold_not_held",
    );
  }

  const nextStatus = await resolveMarketingFinanceHoldReleaseStatus(requestId);

  await recordHoldReason({ actorHrId, reason, requestId });
  await applyHoldStatus({
    actorHrId,
    expectedCurrentStatus: request.status,
    nextStatus,
    requestId,
  });

  await writeRequiredAuditLog({
    actorLoginId: params.access.loginId ?? params.access.hrId,
    entityId: requestId,
    entityType: "marketing_request",
    newValues: { status: nextStatus },
    oldValues: { status: request.status },
    summary:
      `Marketing request ${request.request_code ?? requestId} released from finance hold `
      + `back to "${nextStatus}". Reason: ${reason}`,
  });

  return { requestCode: request.request_code, requestId, status: nextStatus };
}
