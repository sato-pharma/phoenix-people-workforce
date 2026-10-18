import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { resolveCanonicalActorHrId } from "@/lib/auth/canonical-actor";
import { resolveEmployeeIdentityId, type AccessContext } from "@/lib/auth/permissions";
import { bumpCustomer360Cache } from "@/lib/cache/namespaces";
import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { resolveMarketingInvoiceObligation } from "@/lib/marketing-requests/invoice-obligation";
import type { MarketingInvoiceStatus } from "@/lib/marketing-requests/types";
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
 * became a real detectable condition rather than a hypothetical one. #2686 then made that condition
 * VISIBLE, deriving lateness live in `invoice-obligation.ts`.
 *
 * This module is the third step, and the only one that writes: what a human may DO about it.
 *
 * The owner's rule, 2026-08-29, is the rule expenses run under: the system FLAGS, a human decides.
 * So nothing here moves a request on its own. `loadMarketingFinanceHoldQueue` only ever REPORTS;
 * the status changes when a Super Admin places the hold by hand, and back when he releases it. Do
 * not add a cron, a trigger, or an "auto-hold once overdue" convenience — that is precisely the
 * shape he rejected.
 *
 * LATENESS IS NOT DEFINED HERE. `resolveMarketingInvoiceObligation` is the one definition of
 * overdue, shared with the Approved Requests tab and the report export. A second copy in this file
 * would drift: the queue an admin acts on would eventually disagree with the screen he read it on,
 * and neither would be obviously wrong.
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
 * Invoice states a hold may PAUSE — the ones where the invoice is still owed.
 *
 * Deliberately a set of the outstanding states rather than `!== "submitted"`: the vocabulary has
 * six values, and a negation would silently treat a future seventh as outstanding.
 *
 * `overdue` is here defensively. Nothing writes it to the column today and #2686 keeps it that way
 * on purpose — lateness is derived, never stored — but a row carrying it would still mean "owed".
 */
const pausableInvoiceStatuses: ReadonlySet<string> = new Set(["pending", "overdue"]);

export function canPlaceMarketingRequestOnFinanceHold(status: string | null | undefined): boolean {
  return marketingFinanceHoldableStatuses.has(String(status ?? "").trim().toLowerCase());
}

export function canReleaseMarketingRequestFromFinanceHold(status: string | null | undefined): boolean {
  return String(status ?? "").trim().toLowerCase() === MARKETING_FINANCE_HOLD_STATUS;
}

/**
 * What a hold does to the invoice obligation, and what a release undoes.
 *
 * A hold means "a human has deliberately paused this one", which is exactly the state
 * `invoice-obligation.ts` already excludes from going overdue: nagging about a pause someone chose
 * is how a marker earns itself ignored. So placing a hold silences the Overdue marker on the tab
 * and in the export, and releasing it lets the marker resume — one mechanism, and no screen left
 * saying "18d late" about a request whose lateness is the acknowledged reason it is frozen.
 *
 * `null` means LEAVE IT ALONE, and that is the half that matters. Production carries an `active`
 * request whose invoice is already `submitted` (measured 2026-08-29), so a hold placed for some
 * other reason must not mark a delivered invoice as paused — and the release must not then set it
 * back to `pending`, which would manufacture a debt that had already been settled. The pause is a
 * strict `pending ⇄ hold` toggle; every other state passes through untouched in both directions.
 */
export function nextInvoiceStatusOnHold(current: string | null | undefined): MarketingInvoiceStatus | null {
  return pausableInvoiceStatuses.has(String(current ?? "").trim().toLowerCase()) ? "hold" : null;
}

export function nextInvoiceStatusOnRelease(current: string | null | undefined): MarketingInvoiceStatus | null {
  return String(current ?? "").trim().toLowerCase() === "hold" ? "pending" : null;
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

/**
 * The actor written to both columns must be the hr_id AS STORED, not the normalized key.
 *
 * `finance_reviewer_hr_id` and `updated_by_hr_id` both carry a foreign key to `employees(hr_id)`,
 * and that column is MIXED CASE in production — 178 of 179 rows carry an uppercase letter.
 * `resolveEmployeeIdentityId` lowercases, so writing its result matched essentially nobody and the
 * database refused the write outright.
 *
 * That is not a hypothetical. Running this exact path against production on 2026-08-29 failed with
 * `23503 ... Key (finance_reviewer_hr_id)=(b-10) is not present in table "employees"` — the
 * owner's own id, stored `B-10`. The feature was reachable by nobody until this line existed.
 *
 * `resolveCanonicalActorHrId` is the repo's answer and its docblock says so: the single source of
 * truth every workflow decision write-path funnels through. It also maps a login token such as the
 * shared `admin-HR` to the real employee behind it, which a normalized id cannot do.
 */
async function assertHoldActor(access: AccessContext): Promise<string> {
  const identity = resolveEmployeeIdentityId(access);
  if (!identity) {
    throw validationError("A linked HR ID is required to place or release a finance hold.", "missing_actor_hr_id");
  }
  return resolveCanonicalActorHrId(String(access.hrId ?? access.loginId ?? identity));
}

export type MarketingFinanceHoldCandidate = {
  approvedAt: string | null;
  daysOverdue: number;
  invoiceDeadlineDate: string | null;
  /** What the invoice status IS today — `overdue` where the column still says `pending`. */
  invoiceStatus: MarketingInvoiceStatus;
  onHold: boolean;
  requestCode: string | null;
  requestId: string;
  status: string;
};

/**
 * The flag: approved requests whose invoice is late, plus the ones already held.
 *
 * Read-only by construction. Requests already on `finance_hold` are included so the queue is the
 * whole picture the admin acts on — holding and releasing are decided from the same list. A held
 * request reports `daysOverdue: 0` because its obligation is paused, which is why `onHold`, not the
 * day count, is what tells the two groups apart.
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
    const onHold = status === MARKETING_FINANCE_HOLD_STATUS;

    // `invoice_required` is filtered here rather than passed down. The shared resolver answers "is
    // this obligation late", and a request that owes no invoice has no obligation to be late on.
    // Every production row reads true today, so this guards the column's meaning rather than a
    // case that currently occurs.
    const owesInvoice = obligation?.invoice_required !== false;
    const resolved = resolveMarketingInvoiceObligation(
      {
        invoiceDeadlineDate: obligation?.invoice_deadline_date ?? null,
        invoiceStatus: obligation?.invoice_status ?? null,
      },
      input.today,
    );
    const overdue = owesInvoice && resolved.isOverdue;
    if (!overdue && !onHold) continue;

    candidates.push({
      approvedAt: row.approved_at ?? null,
      daysOverdue: overdue ? resolved.daysOverdue : 0,
      invoiceDeadlineDate: obligation?.invoice_deadline_date ?? null,
      invoiceStatus: resolved.effectiveStatus,
      onHold,
      requestCode: row.request_code ?? null,
      requestId,
      status,
    });
  }

  candidates.sort((a, b) => b.daysOverdue - a.daysOverdue);
  return candidates;
}

type HoldTarget = {
  invoiceStatus: string;
  requestCode: string | null;
  requestId: string;
  status: string;
};

/**
 * Read the request AND its obligation together, because both are decided from.
 *
 * A holdable request with no obligation row is refused rather than held. The reason a hold was
 * placed is recorded ON that row, so holding without one would silently discard the only durable
 * record of why a request was frozen — and a request carrying no invoice obligation has nothing to
 * be held over in the first place. All four holdable requests in production have one (measured
 * 2026-08-29); this guards that staying true, it is not a case being worked around.
 */
async function loadHoldTarget(requestId: string): Promise<HoldTarget> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("marketing_requests")
    .select("id, request_code, status")
    .eq("id", requestId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw notFoundError("Marketing request was not found.", "request_not_found");
  const request = data as { id: string; request_code: string | null; status: string };

  const finance = await supabase
    .from("marketing_request_finance_requirements")
    .select("invoice_status")
    .eq("request_id", requestId)
    .maybeSingle();
  if (finance.error) throw finance.error;
  if (!finance.data) {
    throw conflictError(
      "This request has no invoice obligation, so there is nothing to hold it against.",
      "marketing_finance_hold_no_obligation",
    );
  }

  const invoiceStatus = String(
    (finance.data as { invoice_status?: string | null }).invoice_status ?? "",
  ).trim().toLowerCase();

  return { invoiceStatus, requestCode: request.request_code, requestId: request.id, status: request.status };
}

/**
 * Write the REASON before the status, never the other way round.
 *
 * A Supabase client request that times out at 15s still commits, so a two-write mutation can
 * half-apply with no error at all. Ordered this way the only reachable half-state is a recorded
 * reason on a request that was never held — inert, and visible. The reverse order would leave a
 * request frozen with nobody able to say why, on a module that commits real money.
 *
 * The invoice pause travels in this SAME statement rather than a third write, so it cannot
 * half-apply against the reason. `.eq("invoice_status", …)` makes it a compare-and-set: if the
 * invoice arrived between the queue being read and the admin acting on it, this throws instead of
 * overwriting. That is the right outcome and not merely the safe one — an invoice that has just
 * landed changes the decision he was about to make, so he should look again.
 */
async function recordFinanceReview(input: {
  actorHrId: string;
  expectedInvoiceStatus: string;
  nextInvoiceStatus: MarketingInvoiceStatus | null;
  reason: string;
  requestId: string;
}) {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("marketing_request_finance_requirements")
    .update({
      finance_reviewer_hr_id: input.actorHrId,
      notes: input.reason,
      reviewed_at: now,
      updated_at: now,
      ...(input.nextInvoiceStatus ? { invoice_status: input.nextInvoiceStatus } : {}),
    })
    .eq("request_id", input.requestId)
    .eq("invoice_status", input.expectedInvoiceStatus)
    .select("request_id")
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw conflictError(
      "The invoice changed while this hold was being applied. Reload and try again.",
      "marketing_finance_hold_invoice_conflict",
    );
  }
}

/**
 * Flip the status, attributing it so `phx_capture_marketing_request_event` records WHO.
 *
 * That AFTER UPDATE trigger writes the `request_status_changed` event itself — actor, from, to and
 * occurred_at — reading `updated_by_hr_id` and `updated_at` off the new row. So the audit trail is
 * automatic here, and stamping those two columns is what makes it truthful rather than anonymous.
 *
 * The `.eq("status", expectedCurrentStatus)` is a compare-and-set, not decoration: two admins
 * acting on the same queue would otherwise both "succeed", and the second would silently overwrite
 * the first's decision.
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
  const actorHrId = await assertHoldActor(params.access);

  const requestId = String(params.requestId ?? "").trim();
  if (!requestId) throw validationError("Request ID is required.");
  const reason = String(params.reason ?? "").trim();
  if (!reason) throw validationError("A reason is required to place a finance hold.", "missing_hold_reason");

  const request = await loadHoldTarget(requestId);
  if (!canPlaceMarketingRequestOnFinanceHold(request.status)) {
    throw conflictError(
      `A request with status "${request.status}" cannot be placed on finance hold.`,
      "marketing_finance_hold_not_allowed",
    );
  }

  await recordFinanceReview({
    actorHrId,
    expectedInvoiceStatus: request.invoiceStatus,
    nextInvoiceStatus: nextInvoiceStatusOnHold(request.invoiceStatus),
    reason,
    requestId,
  });
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
      `Marketing request ${request.requestCode ?? requestId} placed on finance hold `
      + `(was "${request.status}"). Reason: ${reason}`,
  });

  bumpCustomer360Cache("marketing request placed on finance hold");
  return { requestCode: request.requestCode, requestId, status: MARKETING_FINANCE_HOLD_STATUS };
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
  const actorHrId = await assertHoldActor(params.access);

  const requestId = String(params.requestId ?? "").trim();
  if (!requestId) throw validationError("Request ID is required.");
  const reason = String(params.reason ?? "").trim();
  if (!reason) throw validationError("A reason is required to release a finance hold.", "missing_release_reason");

  const request = await loadHoldTarget(requestId);
  if (!canReleaseMarketingRequestFromFinanceHold(request.status)) {
    throw conflictError(
      `A request with status "${request.status}" is not on finance hold.`,
      "marketing_finance_hold_not_held",
    );
  }

  const nextStatus = await resolveMarketingFinanceHoldReleaseStatus(requestId);

  await recordFinanceReview({
    actorHrId,
    expectedInvoiceStatus: request.invoiceStatus,
    nextInvoiceStatus: nextInvoiceStatusOnRelease(request.invoiceStatus),
    reason,
    requestId,
  });
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
      `Marketing request ${request.requestCode ?? requestId} released from finance hold `
      + `back to "${nextStatus}". Reason: ${reason}`,
  });

  bumpCustomer360Cache("marketing request released from finance hold");
  return { requestCode: request.requestCode, requestId, status: nextStatus };
}
