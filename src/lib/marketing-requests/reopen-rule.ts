import type { PhoenixRole } from "@/lib/auth/permissions";
import type { MarketingRequestStatus } from "@/lib/marketing-requests/types";

// ─────────────────────────────────────────────────────────────────────────────
// Who may reopen a refused marketing request, and when.
//
// ── WHY THIS IS ITS OWN MODULE ───────────────────────────────────────────────
//
// Two callers need this answer and they must never disagree: the service, which REFUSES the write,
// and buildViewer, which decides whether the button is drawn at all. The Case File already carries
// a warning about paying for a second copy of a rule ("two definitions of overdue on the same money
// path"), and `case-file-decision-bar.ts` lives apart from its service for the same reason — the
// service module reaches Supabase, so a test could otherwise only assert over source text.
//
// Everything here is pure. The rule is enforced server-side in
// `reopenRejectedMarketingRequest`; anything this module returns is an AFFORDANCE and never an
// authorisation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reopening is a Super Admin action. The owner's answer, 2026-09-06: "the reopen is only a super
 * admin feature."
 *
 * NO `scope === "system"` bypass, deliberately — and this is where it differs from
 * `assertMarketingFinanceHoldAccess`, which does allow one. Two reasons:
 *
 *  * the owner named a ROLE, and a scope bypass would silently widen it to every system-scoped
 *    role, which is the trap `canSeeConfidentialProducts` documents ("the locked rule is
 *    role-based, and a scope bypass would reopen it for every system-scoped role");
 *  * reopening reverses a decision a human recorded and then re-notifies them. Nothing automated
 *    should ever be able to do that — a cron with system scope undoing a CEO refusal at 3am is not
 *    a feature.
 *
 * Worth knowing operationally: the CEO seat (`AA`) holds role **CEO**, not Super Admin. So the
 * person who refuses a request at `ceo_approval` is NOT the person who can reopen it from that
 * account — the owner reopens from his Super Admin identity (`B-10`) and the CEO rung is then
 * re-notified. That separation is intentional under this rule, not an accident of it.
 */
export function viewerMayReopenMarketingRequests(role: PhoenixRole): boolean {
  return role === "Super Admin";
}

/**
 * Only a refusal can be reopened.
 *
 * NOT `returned` — that already has its own path home (`resubmitReturnedMarketingRequest`), driven
 * by the requester after they edit, and routing it through here would skip the edit entirely.
 * NOT `finance_hold` — a hold is paused, not refused, and is released by its own control.
 */
export function isMarketingRequestReopenable(status: MarketingRequestStatus | string | null | undefined): boolean {
  return String(status ?? "").trim().toLowerCase() === "rejected";
}

/** The affordance the Case File draws its control from. Both halves must hold. */
export function canReopenRejectedMarketingRequest(params: {
  role: PhoenixRole;
  status: MarketingRequestStatus | string | null | undefined;
}): boolean {
  return viewerMayReopenMarketingRequests(params.role) && isMarketingRequestReopenable(params.status);
}

/**
 * Is this `skipped` rung one that a REFUSAL closed out — the only kind a reopen may restore?
 *
 * `skipped` means three different things on `marketing_request_approval_steps`, and restoring the
 * wrong one is not cosmetic:
 *
 *  1. a CC row (`isCc`) — never a gate;
 *  2. a self-approval rung — the assignee raised the request, so it was skipped at SUBMIT time and
 *     carries the explanatory `decisionNote`. Restoring it to `pending` DEADLOCKS the request: it
 *     becomes the current rung and the one person who holds it is the one person
 *     `phx_decide_marketing_request_step` refuses to let decide it;
 *  3. a rung a refusal terminalised — status and `updated_at` only, so `decisionNote` is null.
 *
 * The SQL in `phx_reopen_rejected_marketing_request` filters on exactly this predicate. This copy
 * exists so the rule is executable in a test rather than only assertable as source text.
 */
export function isRungClosedOutByRefusal(step: {
  decisionNote?: string | null;
  isCc: boolean;
  status: string;
}): boolean {
  if (step.isCc) return false;
  if (step.status !== "skipped") return false;
  return !String(step.decisionNote ?? "").trim();
}
