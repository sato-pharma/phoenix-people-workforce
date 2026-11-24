/**
 * "Save amounts" — the Super Admin's own figures for one expense claim, written and proved.
 *
 * Owner, 24 Nov 2026: "i want to be able to edit in expense value" — "All of these": each part, on a
 * waiting and on a decided claim, any figure including above the claim, until a payroll takes it.
 *
 *   1. a REAL signed-in session (never the development preview or View as Seat);
 *   2. the claim as it stands NOW (`loadDeskClaims`) and the pure plan (`planDeskAmounts`);
 *   3. an APPROVED claim is also asked of its payout month's payroll run, exactly as a changed
 *      decision is (`decidedChangeRunRefusal`): a frozen or published run is never moved under;
 *   4. the edit is written onto the request, pinned to the version he saw — a claim that moved in
 *      between is refused, never overwritten;
 *   5. a claim waiting for the next payroll has its payroll row re-written from the edit
 *      (`rewriteOutstationRequestPayrollFigures`); a held one has none yet, and pays the edit when
 *      it is released; a waiting one pays it when approved;
 *   6. an audit row, then the claim read again: it is called saved only when it now pays the
 *      figure he set.
 *
 * Nothing is sent to the employee: a changed figure is told the way a reduced one is — not at all
 * (owner, 23 Nov: "stay silent as today"; only a rejection is told).
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { resolveEmployeeIdentityId, type AccessContext } from "@/lib/auth/permissions";
import { hrIdForStorage } from "@/lib/hr-id";
import { assertRealSessionForDecision } from "@/lib/auth/preview-session-guard";
import { afterResponse } from "@/lib/http/after-response";
import { logError } from "@/lib/observability/log";
import { planDeskAmounts } from "@/lib/outstation/approvals/amounts-plan";
import { readPayoutRun } from "@/lib/outstation/approvals/decide";
import { decidedChangeRunRefusal } from "@/lib/outstation/approvals/decided-change";
import { loadDeskClaims } from "@/lib/outstation/approvals/queue";
import type { DeskAmountsRequest, DeskDecisionOutcome } from "@/lib/outstation/approvals/types";
import { OUTSTATION_CLAIM_CHANGED_MESSAGE, outstationClaimRevision } from "@/lib/outstation/claim-revision";
import { expenseClaimsReadEnabled } from "@/lib/outstation/claims-read-flag";
import { refreshExpenseClaims } from "@/lib/outstation/claims-refresh";
import { rewriteOutstationRequestPayrollFigures } from "@/lib/outstation/service";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const egp = (value: number) => `EGP ${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export async function editDeskClaimAmounts(
  access: AccessContext,
  request: DeskAmountsRequest,
  now: Date = new Date(),
): Promise<DeskDecisionOutcome> {
  assertRealSessionForDecision(access, "edit an expense claim's amounts");
  const { requestId } = request;

  const claim = (await loadDeskClaims(access, [requestId], now)).get(requestId) ?? null;
  const plan = planDeskAmounts({ by: hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? null, claim, now, request });
  if (!plan.ok || !claim) {
    return { claim, code: plan.ok ? "refused" : plan.code, message: plan.ok ? null : plan.message, requestId };
  }

  const approved = claim.standing === "approved_held" || claim.standing === "approved_queued";
  if (approved) {
    const { payoutMonth, payoutYear } = claim;
    const run = payoutMonth && payoutYear ? await readPayoutRun(payoutMonth, payoutYear) : null;
    const refusal = decidedChangeRunRefusal({ payoutMonth, payoutYear, run });
    if (refusal) return { claim, code: "refused", message: refusal, requestId };
  }

  // Pinned to the version he saw: the stored stamp must still read as that revision.
  const { data: current, error: readError } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .select("updated_at")
    .eq("id", requestId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  const storedStamp = (current as { updated_at?: unknown } | null)?.updated_at;
  if (!current || outstationClaimRevision(storedStamp) !== request.revision) {
    return { claim, code: "changed", message: OUTSTATION_CLAIM_CHANGED_MESSAGE, requestId };
  }

  const { data: written, error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .update({ hr_amounts: plan.next, updated_at: now.toISOString() })
    .eq("id", requestId)
    .eq("updated_at", storedStamp as string)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!written) return { claim, code: "changed", message: OUTSTATION_CLAIM_CHANGED_MESSAGE, requestId };

  // The edit is stored; a payroll row that could not be re-written is not thrown away as an error
  // page — the re-read below finds the claim not paying the figure and says so in words.
  let payrollRow: "written" | "no_payroll_row" | "not_needed" | "failed" = "not_needed";
  if (claim.standing === "approved_queued") {
    try {
      payrollRow = await rewriteOutstationRequestPayrollFigures(requestId, access);
    } catch (rewriteError) {
      payrollRow = "failed";
      logError("An approved expense claim's payroll row was not re-written after its amounts were edited", {
        labels: { event: "expense_desk_amounts_payroll_rewrite_failed", requestId: String(requestId) },
        error: rewriteError instanceof Error ? rewriteError : new Error(String(rewriteError)),
      });
    }
  }

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? resolveEmployeeIdentityId(access) ?? "system",
    entityId: String(requestId),
    entityType: "outstation_request",
    newValues: { hrAmounts: plan.next, payable: plan.total, payrollRow },
    oldValues: { parts: plan.before, payable: claim.payable },
    summary: plan.next
      ? `Outstation request ${requestId}: amounts set to ${egp(plan.total)} from Expense Approvals. Reason: ${plan.next.reason}`
      : `Outstation request ${requestId}: amounts set back to the claim (${egp(plan.total)}) from Expense Approvals. Reason: ${String(request.reason).trim()}`,
  });

  const after = (await loadDeskClaims(access, [requestId], now)).get(requestId) ?? null;

  if (expenseClaimsReadEnabled()) {
    await afterResponse("expense_claims_refresh:desk_amounts", async () => {
      const refresh = await refreshExpenseClaims();
      if (refresh.status === "blocked") {
        logError("Expense claims refresh after an amounts edit was refused by an interlock", {
          labels: { event: "expense_claims_refresh_after_save_blocked" },
          error: new Error(refresh.reason),
        });
      }
    });
  }

  // Saved only when the claim now pays what he set. A rejected claim pays nothing whatever its
  // parts say, so its figure is read from the claim's own total.
  const paysNow = after ? (after.standing === "rejected" ? after.total : after.payable) : null;
  if (!after || paysNow === null || Math.abs(paysNow - plan.total) >= 0.005) {
    logError("An expense claim's edited amounts were stored, but the claim does not pay them", {
      labels: { event: "expense_desk_amounts_not_landed", requestId: String(requestId) },
      error: new Error(`set ${plan.total}, pays ${paysNow ?? "unread"}`),
    });
    return {
      claim: after,
      code: "amount_not_saved",
      message:
        paysNow === null
          ? "The amounts were saved, but the claim could not be read again. Read the list again before deciding it."
          : `The amounts were saved, but the claim pays ${egp(paysNow)}, not ${egp(plan.total)}. Read the list again before deciding it.`,
      requestId,
    };
  }
  return { claim: after, code: "saved", message: null, requestId };
}
